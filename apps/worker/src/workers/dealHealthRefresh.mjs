// Nous deal health on every open deal row (2026-10-02).
//
// A deal's health was only ever computed when someone opened that one deal, so the lists that show
// many deals at once (the Pipeline board, Home's "deals at risk", /api/companies/deals) had no number
// to show: the API carried `health_score: null` on every row. A board is hundreds of deals, and
// computing each on read is the wall the account list already hit (GET-296). So this job computes
// every open deal on a schedule and stores the score and its one-line reason on the deal's
// entity_list_rows row, where the lists already read.
//
// The number is the deal page's number: the same slice of the account and the same computeDealHealth
// (core dealHealthSlice.mjs), read as the whole team may read it, because a stored score is shown to
// everyone (GET-253). No LLM; health is arithmetic over facts already extracted.
//
// Bounded three ways, because a schedule must never become the slow query everyone waits behind:
//   - a per-run cap on deals, and a per-run time budget;
//   - a per-workspace time budget, so one large CRM cannot starve the rest;
//   - a few accounts at a time, never the whole workspace at once.
// What a run does not reach it reaches next run, with no cursor: never-scored and stalest deals go
// first, so the order itself is the resume point.

import { getSupabaseClient, dealHealthForAccount, logWorkerRun } from '@nous/core';

const envNum = (name, fallback) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

// A large customer workspace holds a few hundred open deals, nearly all of them on an account;
// the cap leaves room for several workspaces that size per run.
const RUN_DEAL_CAP = envNum('DEAL_HEALTH_RUN_CAP', 2000);
const RUN_BUDGET_MS = envNum('DEAL_HEALTH_RUN_BUDGET_MS', 20 * 60_000);
const WORKSPACE_BUDGET_MS = envNum('DEAL_HEALTH_WORKSPACE_BUDGET_MS', 8 * 60_000);
const CONCURRENCY = envNum('DEAL_HEALTH_CONCURRENCY', 3);
const PAGE = 1000;

class MissingColumns extends Error {}
const isMissingColumn = (e) => /deal_health_(score|reason|at)|42703|PGRST204/i.test(String(e?.message ?? e) + String(e?.code ?? ''));

/**
 * Which deals this run scores, grouped by account (one set of account reads covers every open deal
 * on it). Pure.
 *
 * Never-scored deals first, then the stalest, so an interrupted run resumes where it stopped without
 * a remembered cursor; an account sorts by its stalest deal. A deal with no account is skipped and
 * counted: the deal page opens a deal through its account, so there is no page number to match.
 * The cap stops at the first account that would overflow it (never skipping ahead to a fresher one),
 * except that the first account is always taken, so a cap smaller than one account still moves.
 *
 * @param rows  [{ entity_id, company_id, deal_health_at }]
 * @returns { batches: [{ companyId, dealIds }], deals, deferred, noAccount }
 */
export function planDealHealthBatches(rows, { cap = Infinity } = {}) {
  const byAccount = new Map();
  let noAccount = 0;
  for (const r of rows || []) {
    if (!r?.entity_id) continue;
    if (!r.company_id) { noAccount += 1; continue; }
    const at = r.deal_health_at ? Date.parse(r.deal_health_at) : NaN;
    const stamp = Number.isFinite(at) ? at : -Infinity;
    const b = byAccount.get(r.company_id) ?? { companyId: r.company_id, dealIds: [], stalest: Infinity };
    if (!b.dealIds.includes(r.entity_id)) b.dealIds.push(r.entity_id);
    b.stalest = Math.min(b.stalest, stamp);
    byAccount.set(r.company_id, b);
  }
  // Compared, not subtracted: two never-scored accounts are -Infinity each, and their difference is NaN.
  const ordered = [...byAccount.values()].sort((a, b) =>
    (a.stalest === b.stalest ? 0 : a.stalest < b.stalest ? -1 : 1) || a.companyId.localeCompare(b.companyId));

  const batches = [];
  let deals = 0;
  let deferred = 0;
  let full = false;
  for (const b of ordered) {
    if (!full && cap > 0 && (batches.length === 0 || deals + b.dealIds.length <= cap)) {
      batches.push({ companyId: b.companyId, dealIds: [...b.dealIds].sort() });
      deals += b.dealIds.length;
    } else {
      full = true;
      deferred += b.dealIds.length;
    }
  }
  return { batches, deals, deferred, noAccount };
}

/** The row each deal gets: its score and reason when the page reads it as open, else empty. */
export function healthPatch(result, nowIso) {
  const open = result && result.status === 'open' && result.score != null;
  return {
    deal_health_score: open ? Math.round(result.score) : null,
    deal_health_reason: open ? (result.reason ?? null) : null,
    // Stamped either way, so a deal we cannot score stops jumping the queue on every run.
    deal_health_at: nowIso,
  };
}

async function readOpenDealRows(supabase, ws) {
  const rows = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase.from('entity_list_rows')
      .select('entity_id, company_id, deal_health_at')
      .eq('workspace_id', ws).eq('kind', 'deal').eq('status', 'open')
      .order('entity_id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) {
      if (isMissingColumn(error)) throw new MissingColumns(error.message);
      throw new Error(error.message);
    }
    rows.push(...(data ?? []));
    if (!data || data.length < PAGE) return rows;
  }
}

/** A few at a time, and stop starting new work once the deadline passes. */
async function eachUntil(items, limit, deadline, fn) {
  let next = 0;
  const lane = async () => {
    while (next < items.length && Date.now() < deadline) await fn(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
  return Math.min(next, items.length);
}

/**
 * One workspace: score its open deals (up to `cap`, until `deadline`) and empty the score on any
 * deal that is no longer open.
 */
export async function refreshWorkspaceDealHealth(supabase, ws, { cap = RUN_DEAL_CAP, deadline = Date.now() + WORKSPACE_BUDGET_MS } = {}) {
  const rows = await readOpenDealRows(supabase, ws);
  const plan = planDealHealthBatches(rows, { cap });
  const out = { open: rows.length, accounts: 0, scored: 0, unscored: 0, failed: 0, deferred: plan.deferred, no_account: plan.noAccount, attempted: 0 };

  const started = await eachUntil(plan.batches, CONCURRENCY, deadline, async ({ companyId, dealIds }) => {
    out.attempted += dealIds.length;
    let results;
    try {
      results = await dealHealthForAccount(supabase, ws, companyId, { dealIds });
    } catch (err) {
      // Nothing written: the deals keep their old score and stay stalest, so they go first next run.
      out.failed += dealIds.length;
      console.warn('[DEAL_HEALTH] ws=%s account=%s: %s', ws, companyId, err?.message || err);
      return;
    }
    out.accounts += 1;
    const nowIso = new Date().toISOString();
    for (const id of dealIds) {
      const patch = healthPatch(results.get(id), nowIso);
      const { error } = await supabase.from('entity_list_rows').update(patch)
        .eq('workspace_id', ws).eq('entity_id', id).eq('kind', 'deal');
      if (error) { out.failed += 1; console.warn('[DEAL_HEALTH] ws=%s deal=%s write: %s', ws, id, error.message); continue; }
      if (patch.deal_health_score != null) out.scored += 1; else out.unscored += 1;
    }
  });
  // Whatever the deadline cut off is deferred too, and goes first next run.
  for (const b of plan.batches.slice(started)) out.deferred += b.dealIds.length;

  // A closed deal's last score describes a deal that no longer exists. The reader ignores it
  // already; emptying it keeps anyone reading the raw row from showing it.
  const { error: clearErr } = await supabase.from('entity_list_rows')
    .update({ deal_health_score: null, deal_health_reason: null })
    .eq('workspace_id', ws).eq('kind', 'deal')
    .not('deal_health_score', 'is', null)
    .or('status.is.null,status.neq.open');
  if (clearErr) console.warn('[DEAL_HEALTH] ws=%s clear closed: %s', ws, clearErr.message);

  return out;
}

async function allWorkspaceIds(supabase) {
  const ids = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase.from('workspaces').select('id').order('id').range(from, from + PAGE - 1);
    if (error) { console.warn('[DEAL_HEALTH] workspace list: %s', error.message); break; }
    for (const r of data ?? []) ids.push(r.id);
    if (!data || data.length < PAGE) break;
  }
  return ids;
}

export async function runDealHealthRefresh({ workspaceIds = null } = {}) {
  const supabase = getSupabaseClient();
  const runDeadline = Date.now() + RUN_BUDGET_MS;
  let remaining = RUN_DEAL_CAP;
  const totals = { workspaces: 0, scored: 0, unscored: 0, failed: 0, deferred: 0 };

  for (const ws of workspaceIds ?? await allWorkspaceIds(supabase)) {
    if (Date.now() >= runDeadline || remaining <= 0) break;
    const startedAt = new Date();
    try {
      const r = await refreshWorkspaceDealHealth(supabase, ws, {
        cap: remaining,
        deadline: Math.min(runDeadline, Date.now() + WORKSPACE_BUDGET_MS),
      });
      remaining -= r.attempted;
      if (!r.open) continue;
      totals.workspaces += 1;
      totals.scored += r.scored; totals.unscored += r.unscored; totals.failed += r.failed; totals.deferred += r.deferred;
      const secs = Math.round((Date.now() - startedAt.getTime()) / 1000);
      console.log('[DEAL_HEALTH] ws=%s %s in %ds', ws, JSON.stringify(r), secs);
      await logWorkerRun(supabase, {
        worker: 'deal_health', workspaceId: ws, status: r.failed ? 'error' : 'success',
        summary: `${r.scored} open deals scored on ${r.accounts} accounts${r.deferred ? `, ${r.deferred} left for next run` : ''}`,
        details: r, error: r.failed ? `${r.failed} deals could not be scored or written` : null, startedAt,
      });
    } catch (err) {
      if (err instanceof MissingColumns) {
        // supabase/migrations/2026_10_02_deal_health_rows.sql is applied by hand; until it is, there
        // is nowhere to write, and that is the same answer for every workspace.
        console.warn('[DEAL_HEALTH] skipped: entity_list_rows has no deal_health columns yet (apply 2026_10_02_deal_health_rows.sql)');
        return totals;
      }
      console.error('[DEAL_HEALTH] ws=%s: %s', ws, err?.message || err);
    }
  }
  console.log(`[DEAL_HEALTH] done: ${totals.scored} deals scored across ${totals.workspaces} workspaces${totals.deferred ? `, ${totals.deferred} left for next run` : ''}${totals.failed ? `, ${totals.failed} failed` : ''}`);
  return totals;
}
