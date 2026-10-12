// Keep the flattened lists current (GET-296, GET-297).
//
// entity_list_rows is what every list reads. This is what keeps it true.
//
// The first version called refresh_entity_list_rows(ws) — one statement for a whole workspace — and
// on one customer's many thousands of accounts and people that statement took far longer than the eight
// seconds PostgREST allows any single call. So it was killed, every time, and the lists it was
// meant to fill stayed empty. That is why the app kept saying "no accounts".
//
// Three properties make the replacement safe to run continuously against a live database:
//
//   - A chunk that changes nothing writes nothing (the SQL compares before it updates), so a sweep
//     over settled data costs a read and no index churn.
//   - A chunk that fails leaves its rows STALE, never missing, because the SQL upserts. A list is
//     allowed to be a few minutes behind. It is not allowed to be blank.
//   - The cursor is PERSISTED. A sweep is interrupted often — a time budget, a deploy, a slow
//     window on a shared database — and without a remembered cursor every tick would restart at
//     the first entity, refreshing the head of a big workspace forever and never once reaching the
//     tail. Quietly wrong, and invisible from the top of the list.
//
// Two ordering facts are load-bearing. An account row sums the person and deal rows beneath it, so
// KINDS is deal -> person -> account; reverse it and accounts are a sweep behind. And chunk sizes
// are deliberately conservative: this database has windows where a chunk that normally takes two
// seconds takes sixty, and it is better to take more small bites than to lose a big one.

import { getSupabaseClient } from '@nous/core';

const KINDS = ['deal', 'person', 'account'];

// Measured on a customer workspace with the database quiet: a couple of thousand people in a few seconds, a thousand accounts in about one. These are
// set well below that on purpose — the same calls took 60s during a slow window, and a chunk that
// dies wastes its whole cost. The adaptive shrink below handles the rest.
const START_LIMIT = { deal: 500, person: 500, account: 250 };
const MIN_LIMIT = 25;

// One sweep must not monopolise the database. Whatever is left is picked up next tick, from the
// cursor, so the budget costs latency and never coverage.
const SWEEP_BUDGET_MS = Number(process.env.LIST_SWEEP_BUDGET_MS ?? 3 * 60 * 1000);
// The most one workspace may take of that budget before the next one gets a turn.
const WORKSPACE_SLICE_MS = Number(process.env.LIST_SWEEP_WORKSPACE_SLICE_MS ?? 45_000);
const ZERO = '00000000-0000-0000-0000-000000000000';

const isTimeout = (e) => /statement timeout|57014|canceling statement/i.test(String(e?.message ?? e));

// The most holes one workspace may fill per kind per tick. A hole is one RPC, so this is also the
// cost ceiling; whatever is left is filled on the next tick.
const GAP_FILL_CAP = Number(process.env.LIST_SWEEP_GAP_CAP ?? 400);

/**
 * The uuid immediately before this one, as an integer.
 *
 * refresh_list_chunk selects `id > p_after ORDER BY id LIMIT n`, so passing the predecessor of X
 * with a limit of 1 refreshes exactly X and nothing else. That is how a hole is filled without a
 * second copy of the 200-line projection SQL: the chunk function already knows how to build a row,
 * it just needed to be aimed.
 */
function uuidBefore(id) {
  const hex = String(id).replace(/-/g, '');
  if (!/^[0-9a-f]{32}$/i.test(hex)) return null;
  const n = BigInt('0x' + hex);
  if (n === 0n) return null;                       // nothing precedes the zero uuid
  const p = (n - 1n).toString(16).padStart(32, '0');
  return `${p.slice(0, 8)}-${p.slice(8, 12)}-${p.slice(12, 16)}-${p.slice(16, 20)}-${p.slice(20)}`;
}

/**
 * Fill holes before crawling.
 *
 * The cursor walks entities in id order, but ids are random uuids, so a newly created account lands
 * at a random point in that order. Land behind the cursor and you wait for the cycle to wrap — and
 * on a customer workspace the account cycle has never wrapped: most of a day in, `last_completed_at` still null,
 * hundreds of accounts with no row. Those accounts were not stale on the Accounts list, they were absent from
 * it, because the read path takes the projection and never falls back.
 *
 * A hole is the one case where being behind is not "a list a few minutes old" but "a record that
 * does not exist as far as the product is concerned", so holes come first and the crawl gets what
 * time is left.
 */
async function fillGaps(supabase, ws, kind, deadline) {
  const { data, error } = await supabase.rpc('list_rows_missing_ids', { ws, p_kind: kind, p_limit: GAP_FILL_CAP });
  if (error) {
    // An older database without the function is not a reason to skip the sweep itself.
    if (!/list_rows_missing_ids|PGRST202|does not exist/i.test(String(error.message))) {
      console.warn('[LIST_ROWS] ws=%s %s gap scan: %s', ws, kind, error.message);
    }
    return 0;
  }
  let filled = 0;
  for (const row of data ?? []) {
    if (Date.now() >= deadline) break;
    const before = uuidBefore(row.id);
    if (!before) continue;
    const { error: e } = await supabase.rpc('refresh_list_chunk', { ws, p_kind: kind, p_after: before, p_limit: 1 });
    if (e) {
      if (!isTimeout(e)) console.warn('[LIST_ROWS] ws=%s %s gap fill: %s', ws, kind, e.message);
      break;
    }
    filled += 1;
  }
  return filled;
}

/**
 * Delete the rows of entities that were merged away or no longer exist.
 *
 * refresh_list_chunk walks `status = 'active'` entities only, so it upserts the living and never
 * revisits the dead: a merged account kept its row, with the people and dates it had before the
 * merge, and every list and the graph showed it beside the account it was merged into (GET-841).
 * Run after a kind's pass completes, so it costs one read of the kind's ids per full cycle. The rows
 * are a projection, so deleting one loses nothing: if the entity comes back, the gap fill rebuilds it.
 */
export async function pruneDeadListRows(supabase, ws, kind) {
  const ids = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from('entity_list_rows').select('entity_id')
      .eq('workspace_id', ws).eq('kind', kind).order('entity_id').range(from, from + 999);
    if (error) throw new Error(error.message);
    for (const r of data ?? []) ids.push(r.entity_id);
    if (!data || data.length < 1000) break;
  }
  let pruned = 0;
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    const { data, error } = await supabase.from('entities').select('id, status')
      .eq('workspace_id', ws).in('id', chunk);
    if (error) throw new Error(error.message);
    // Merged or gone only. Parked and archived are states a record can come back from, and
    // whether their rows should show is the list's call, not this sweep's.
    const status = new Map((data ?? []).map(r => [r.id, r.status]));
    const dead = chunk.filter(id => !status.has(id) || status.get(id) === 'merged');
    if (!dead.length) continue;
    const { error: e } = await supabase.from('entity_list_rows').delete()
      .eq('workspace_id', ws).eq('kind', kind).in('entity_id', dead);
    if (e) throw new Error(e.message);
    pruned += dead.length;
  }
  return pruned;
}

async function readCursor(supabase, ws, kind) {
  const { data } = await supabase.from('list_refresh_cursor')
    .select('after_id').eq('workspace_id', ws).eq('kind', kind).maybeSingle();
  return data?.after_id ?? ZERO;
}

async function writeCursor(supabase, ws, kind, afterId, { completed } = {}) {
  const row = { workspace_id: ws, kind, after_id: afterId, updated_at: new Date().toISOString() };
  if (completed) {
    // A finished pass rewinds to the start and stamps when the workspace was last fully covered.
    row.after_id = ZERO;
    row.cycle_started_at = new Date().toISOString();
    row.last_completed_at = new Date().toISOString();
  }
  const { error } = await supabase.from('list_refresh_cursor')
    .upsert(row, { onConflict: 'workspace_id,kind' });
  if (error) console.warn('[LIST_ROWS] cursor ws=%s %s: %s', ws, kind, error.message);
}

async function sweepKind(supabase, ws, kind, deadline) {
  let after = await readCursor(supabase, ws, kind);
  let limit = START_LIMIT[kind] ?? 500;
  let done = 0;
  let shrinks = 0;

  while (Date.now() < deadline) {
    const { data, error } = await supabase.rpc('refresh_list_chunk', {
      ws, p_kind: kind, p_after: after, p_limit: limit,
    });

    if (error) {
      if (isTimeout(error) && limit > MIN_LIMIT) {
        // Too big for this moment — halve it and retry the same cursor. The rows are untouched.
        limit = Math.max(MIN_LIMIT, Math.floor(limit / 2));
        shrinks += 1;
        continue;
      }
      // Give up on this kind for this tick, but KEEP the cursor: the next tick resumes here
      // instead of grinding over the rows we already did.
      console.warn('[LIST_ROWS] ws=%s %s stopped at cursor: %s', ws, kind, error.message);
      await writeCursor(supabase, ws, kind, after);
      return { done, shrinks, complete: false };
    }

    const row = Array.isArray(data) ? data[0] : data;
    const processed = Number(row?.processed ?? 0);
    if (!processed) {
      await writeCursor(supabase, ws, kind, ZERO, { completed: true });
      return { done, shrinks, complete: true };
    }

    done += processed;
    after = row.last_id;
  }

  await writeCursor(supabase, ws, kind, after);
  return { done, shrinks, complete: false };
}

/**
 * Every workspace, paged.
 *
 * This used to ask `entities` for company rows and take their workspace ids — with `.limit(20000)`,
 * which PostgREST silently answers with at most 1000 ROWS. One client had many thousands of companies, so the
 * thousand rows that came back were all theirs, and every other workspace was invisible to this
 * sweep: no list rows, and the fallback read path returns `last_activity_at: null` by design, so
 * those workspaces showed no activity at all on their Accounts page. Found on the founder's own.
 *
 * Reading the workspace table instead is exact and small. A workspace with nothing in it costs one
 * empty chunk call per kind.
 */
async function allWorkspaceIds(supabase) {
  const ids = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from('workspaces')
      .select('id').order('id').range(from, from + 999);
    if (error) { console.warn('[LIST_ROWS] workspace list: %s', error.message); break; }
    for (const r of data ?? []) ids.push(r.id);
    if (!data || data.length < 1000) break;
  }
  return ids;
}

export async function runListRowsRefresh() {
  const supabase = getSupabaseClient();

  const workspaces = await allWorkspaceIds(supabase);
  const deadline = Date.now() + SWEEP_BUDGET_MS;
  let swept = 0;

  for (const ws of workspaces) {
    if (Date.now() >= deadline) break;
    const started = Date.now();
    const totals = {};
    let complete = true;
    // One workspace may not eat the whole sweep. One customer alone took several minutes of a 3-minute budget and
    // every workspace after it in the list got nothing. Each gets a slice; the persisted cursor
    // means the rest of its work resumes on the next tick rather than restarting.
    const slice = Math.min(deadline, Date.now() + WORKSPACE_SLICE_MS);
    for (const kind of KINDS) {
      try {
        // Holes first: an entity with no row is missing from the product, not merely stale.
        const gaps = await fillGaps(supabase, ws, kind, slice);
        if (gaps) totals[`${kind}_gaps`] = gaps;
        const r = await sweepKind(supabase, ws, kind, slice);
        if (r.done) totals[kind] = r.done;
        // A finished pass: the living rows are fresh, so now drop the dead ones.
        if (r.complete) {
          const pruned = await pruneDeadListRows(supabase, ws, kind);
          if (pruned) totals[`${kind}_pruned`] = pruned;
        }
        if (r.shrinks) totals[`${kind}_shrinks`] = r.shrinks;
        if (!r.complete) complete = false;
      } catch (e) {
        console.warn('[LIST_ROWS] ws=%s %s %s', ws, kind, e?.message || e);
        complete = false;
      }
    }
    swept += 1;
    const secs = Math.round((Date.now() - started) / 1000);
    if (Object.keys(totals).length) {
      console.log('[LIST_ROWS] ws=%s %s in %ds%s', ws, JSON.stringify(totals), secs, complete ? '' : ' (resumes next tick)');
    }
  }

  // The billing meter reads a remembered number rather than counting live (GET-300); this is when
  // it is remembered, right after the rows it counts were rebuilt.
  const { data: teams } = await supabase.from('teams').select('id').limit(2000);
  for (const t of teams ?? []) {
    const { error } = await supabase.rpc('refresh_team_account_usage', { t: t.id });
    if (error) console.warn('[LIST_ROWS] usage team=%s %s', t.id, error.message);
  }

  if (swept) console.log(`[LIST_ROWS] swept ${swept} workspaces`);
}
