// The customer-success payload, assembled once for the page and for the agent (GET-416).
//
// The CS route used to hold this inline. The agent's `customer_success_data` tool needs the
// same lists with the same reasons, and two copies of "who is at risk" is how a report and a
// page come to disagree. One builder; the route adds auth and the viewer, the tool adds a
// window and the shape `present_document` wants.

import {
  loadCustomerRows, healthOf, classifyCustomers, loadConversationSignals, loadSaidReasons,
  loadPromises, loadMetricHistory, activeUsersTrend, trendWindow, upcomingRenewal, ROW_COLS,
} from './csHealth.mjs';
import { csBookMatcher } from './ownerScope.mjs';

const DAY = 86_400_000;
// The "Renewing soon" window: the Customers page's own (RENEWAL_WINDOW_DAYS in its types.ts).
export const RENEWAL_WINDOW_DAYS = 60;

// `viewer` narrows the lists to one book; null reads everyone's. `strict` is scope=mine: the CS
// owner only, never the AE, and an unowned customer is not in anyone's book (ownerScope.mjs).
export async function buildCustomerSuccess(supabase, workspaceId, { viewer = null, strict = false } = {}) {
  const { rows, healthColumn } = await loadCustomerRows(workspaceId, supabase);
  if (!rows.length) {
    return { accounts: [], expansionIds: [], atRiskIds: [], churned: [], counts: EMPTY_COUNTS(), totals: EMPTY_TOTALS(), healthReady: false, healthColumn, cs_owner_recorded: false };
  }

  const now = Date.now();
  const health = new Map();
  const spine = rows.map(r => {
    const bag = healthOf(r);
    if (Object.keys(bag).length) health.set(r.entity_id, bag);
    return spineOf(r, now);
  });
  // "Ready" means the health fields have actually landed, not merely that the column exists.
  // The page says so on screen, because a CS lead reading "450 customers" needs to know whether
  // that came from their own account_status field or from our guess at it.
  const hasHealth = [...health.values()].some(h => h.status != null);

  // What was said. Two readers, both best-effort on purpose: the customer list is the floor of
  // this page and must render when neither has ever run. A page that 500s teaches nobody
  // anything.
  //
  //   loadSaidReasons        extracted claims, the Gmail/Fellow half (was csAccounts loadCsReasons)
  //   loadConversationSignals what the miner found in the CRM's own conversation corpus
  //   loadPromises           what we owe them ("We promised"), its own list, never a risk
  //   loadMetricHistory      last month's active users, for the trend (cs_metric_snapshots)
  //
  // Only for the CUSTOMER COHORT: the accounts classifyCustomers can put on a list (active, at
  // risk, expansion) or count as churned. loadCustomerRows returns every row with a health bag,
  // and on the first customer's workspace that is tens of thousands of rows, nearly all of them
  // prospects whose bag holds one word. Reading reasons for all of them cost almost the whole
  // page load (measured 2026-10-02) to produce reasons nothing shows. The health map still covers every row, because
  // `hasHealth` and `cs_owner_recorded` are questions about the workspace, not the cohort.
  const cohort = spine.filter(a => inCustomerCohort(a, health.get(a.companyId), hasHealth));
  const ids = cohort.map(a => a.companyId);
  const [reasons, said, promises, usersThen] = await Promise.all([
    loadSaidReasons(workspaceId, supabase, ids)
      .catch(e => { console.error('[cs/reasons]', e?.message || e); return new Map(); }),
    loadConversationSignals(workspaceId, supabase, ids)
      .catch(e => { console.error('[cs/said]', e?.message || e); return new Map(); }),
    loadPromises(workspaceId, supabase, ids, now)
      .catch(e => { console.error('[cs/promised]', e?.message || e); return new Map(); }),
    loadMetricHistory(workspaceId, supabase, 'active_users_30d', trendWindow(now))
      .catch(e => { console.error('[cs/trend]', e?.message || e); return new Map(); }),
  ]);
  for (const a of cohort) {
    a.reasons = reasons.get(a.companyId) ?? [];
    const bag = health.get(a.companyId) ?? {};
    // Both off the bag the sync keeps; neither is a score of ours. The trend is null until a month
    // of snapshots exists, the renewal null for a month-to-month customer (term_months 1).
    a.renewalDate = upcomingRenewal(bag, now);
    a.termMonths = numOrNull(bag.term_months);
    a.activeUsersTrend = activeUsersTrend(bag.active_users_30d, usersThen.get(a.companyId) ?? [], now);
  }

  let { active, expansion, atRisk, churned } = classifyCustomers(cohort, health, { hasHealth, said, promises });

  // Whose book. On this page ownership means the CS owner, which is its own field in the CRM
  // and a different person from the AE on nearly every account here — so scoping by the AE would
  // hand a CS rep somebody else's customers. Where the workspace records no CS owner at all we
  // fall back to the account owner, and an unresolved viewer sees everything (ownerScope.mjs).
  const csOwned = [...health.values()].some(h => h.owner_email || h.owner_name);
  if (viewer) {
    // The rule lives in ownerScope.mjs so the default and the strict (scope=mine) reading sit side
    // by side and are tested together; the default is the one this route always had.
    const mine = csBookMatcher(viewer, { csOwned, strict });
    active = active.filter(mine); expansion = expansion.filter(mine);
    atRisk = atRisk.filter(mine); churned = churned.filter(mine);
  }

  const sum = (arr, pick) => Math.round(arr.reduce((t, r) => t + (Number(pick(r)) || 0), 0));
  // Most urgent first; the client re-sorts when a button is pressed, but the top of an
  // unfiltered page should already be the account somebody needs to ring today.
  const rank = (r) => (r.riskReasons[0]?.tier ?? 9);
  active.sort((x, y) => rank(x) - rank(y) || (Number(y.mrr) || 0) - (Number(x.mrr) || 0));

return {
    accounts: active.map(slim),
    expansionIds: expansion.map(r => r.companyId),
    atRiskIds: atRisk.map(r => r.companyId),
    churned: churned.map(slim),
    counts: {
      active: active.length, expansion: expansion.length, atRisk: atRisk.length, churned: churned.length,
      // Not lists of their own: "We promised" is context on a row, and renewals are a date filter.
      promised: active.filter(r => r.promisedTotal > 0).length,
      renewingSoon: active.filter(r => renewsWithin(r.renewalDate, RENEWAL_WINDOW_DAYS, now)).length,
    },
    totals: {
      mrr: sum(active, r => r.mrr),
      expansionValue: sum(expansion, r => r.health?.upgrade_value),
      atRiskMrr: sum(atRisk, r => r.mrr),
      churnedMrr: sum(churned, r => r.mrr),
    },
    healthReady: hasHealth,
    healthColumn,
    // Whether this CRM records a CS owner at all. "My book" on this page is scoped by the CS
    // owner, so without one it is empty for everybody, and the page can say why.
    cs_owner_recorded: csOwned,
    // Has the conversation corpus been mined yet, and what did it buy us. Shown on the page:
    // a CS lead deciding whether to trust "they asked about Insights" needs to know it came from a
    // real sentence somebody said, and how many rows would vanish without it.
    minedReady: [...said.values()].some(v => v.asked.length || v.risks.length || v.declined.length),
    fromConversation: {
      expansion: expansion.filter(r => r.expansionReasons[0]?.evidence === 'said').length,
      atRisk: atRisk.filter(r => r.riskReasons.some(x => x.kind === 'they_said')).length,
      suppressed: [...said.values()].reduce((n, v) => n + v.declined.length, 0),
    },
  };
}

/** One customer row as the classifier reads it, from its `entity_list_rows` row. */
function spineOf(r, now) {
  const last = r.last_activity_at ? Date.parse(r.last_activity_at) : NaN;
  return {
    companyId: r.entity_id,
    name: r.name ?? null,
    domain: r.domain ?? null,
    industry: r.industry ?? null,
    peopleCount: r.people_count ?? 0,
    openDeals: r.open_deals ?? 0,
    wonDeals: r.won_deals ?? 0,
    wonValue: Number(r.won_value ?? 0) || null,
    childDeals: r.child_deals ?? 0,
    ownerName: r.owner_name ?? null,
    ownerEmail: r.owner_email ?? null,
    lastActivityAt: r.last_activity_at ?? null,
    daysQuiet: Number.isFinite(last) ? Math.round((now - last) / DAY) : null,
    products: [],
    reasons: [],
  };
}

/**
 * One account's health, for its own page (GET-692): the same classifier, reasons and thresholds
 * as the Customers page, run on one row, so the record and the list can never disagree.
 *
 * `state` is which list the Customers page puts it on — at_risk, expansion, healthy (a customer on
 * neither) or churned — and null for an account that is not a customer at all, where the page
 * keeps deal health. No score: every reason is a CRM field or something the customer said.
 */
export async function buildAccountHealth(supabase, workspaceId, companyId) {
  const { data: row, error } = await supabase.from('entity_list_rows').select(ROW_COLS)
    .eq('workspace_id', workspaceId).eq('kind', 'account').eq('entity_id', companyId).maybeSingle();
  if (error) throw new Error(error.message);
  if (!row) return { state: null };

  const now = Date.now();
  const bag = healthOf(row);
  const health = new Map(Object.keys(bag).length ? [[companyId, bag]] : []);
  // "Does this workspace keep a customer status at all" is a question about the workspace, not
  // this row: with one, a missing status means not a customer; without, a won deal does.
  const hasHealth = bag.status != null || await supabase.from('entity_list_rows').select('entity_id')
    .eq('workspace_id', workspaceId).eq('kind', 'account').not('cs->>status', 'is', null).limit(1)
    .then(({ data }) => (data ?? []).length > 0, () => false);
  const account = spineOf(row, now);
  if (!inCustomerCohort(account, bag, hasHealth)) return { state: null };

  const group = typeof bag.group === 'string' && bag.group.trim() ? bag.group.trim() : null;
  const [reasons, said, promises, usersThen, groupClients] = await Promise.all([
    loadSaidReasons(workspaceId, supabase, [companyId]).catch(() => new Map()),
    loadConversationSignals(workspaceId, supabase, [companyId]).catch(() => new Map()),
    loadPromises(workspaceId, supabase, [companyId], now).catch(() => new Map()),
    loadMetricHistory(workspaceId, supabase, 'active_users_30d', { ...trendWindow(now), entityIds: [companyId] }).catch(() => new Map()),
    group
      ? supabase.from('entity_list_rows').select('entity_id', { count: 'exact', head: true })
          .eq('workspace_id', workspaceId).eq('kind', 'account').eq('cs->>group', group).eq('cs->>status', 'client')
          .then(({ count }) => count ?? 0, () => 0)
      : Promise.resolve(0),
  ]);
  account.reasons = reasons.get(companyId) ?? [];
  account.renewalDate = upcomingRenewal(bag, now);
  account.termMonths = numOrNull(bag.term_months);
  account.activeUsersTrend = activeUsersTrend(bag.active_users_30d, usersThen.get(companyId) ?? [], now);

  const groupBuyers = new Map(group ? [[group, groupClients]] : []);
  const { active, expansion, atRisk, churned } = classifyCustomers([account], health, { hasHealth, said, promises, groupBuyers });
  const r = active[0] ?? churned[0];
  if (!r) return { state: null };
  const state = churned.length ? 'churned' : atRisk.length ? 'at_risk' : expansion.length ? 'expansion' : 'healthy';
  return { state, ...slim(r) };
}

const EMPTY_COUNTS = () => ({ active: 0, expansion: 0, atRisk: 0, churned: 0, promised: 0, renewingSoon: 0 });
const EMPTY_TOTALS = () => ({ mrr: 0, expansionValue: 0, atRiskMrr: 0, churnedMrr: 0 });

const numOrNull = (v) => (v == null || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);

/**
 * Can classifyCustomers put this account on any list, or count it as churned? Mirrors its own
 * rule: with health data a customer is `status` client and churned is cancelled; without, a
 * customer is anyone with a won deal. The group-sibling count it also takes only counts clients,
 * which are all in here, so classifying the cohort gives exactly what classifying every row did.
 */
export function inCustomerCohort(account, bag, hasHealth) {
  const status = bag?.status == null ? null : (String(bag.status).trim() || null);
  if (status === 'client' || status === 'cancelled') return true;
  return !hasHealth && (account?.wonDeals ?? 0) > 0;
}

/** A YYYY-MM-DD renewal within `days` of today, today included. */
export function renewsWithin(date, days, now = Date.now()) {
  if (!date) return false;
  const t = Date.parse(String(date).slice(0, 10));
  if (!Number.isFinite(t)) return false;
  const today = Date.parse(new Date(now).toISOString().slice(0, 10));
  return t >= today && t <= today + days * DAY;
}

/** Only what the table draws. The health bag holds two dozen fields; the row shows eight. */
const slim = (r) => ({
  companyId: r.companyId, name: r.name, domain: r.domain, industry: r.industry,
  peopleCount: r.peopleCount, openDeals: r.openDeals, wonValue: r.wonValue,
  lastActivityAt: r.lastActivityAt, daysQuiet: r.daysQuiet,
  status: r.status, mrr: r.mrr, tier: r.tier,
  csOwner: r.health?.owner_name ?? null,
  activeUsers: r.activeUsers, totalUsers: r.totalUsers, lastUsedAt: r.lastUsedAt,
  products: (r.products ?? []).map(p => p.label),
  upgradeValue: r.health?.upgrade_value ?? null,
  upgradeStage: r.health?.upgrade_stage ?? null,
  riskReasons: r.riskReasons, expansionReasons: r.expansionReasons,
  // "We promised": what we owe them, its own list (csHealth.mjs promiseOf). Never a risk reason and
  // never part of atRiskIds; up to five on the row, `promised_count` says how many in all.
  promisedReasons: r.promisedReasons ?? [],
  promised_count: r.promisedTotal ?? 0,
  saidCount: [...r.riskReasons, ...r.expansionReasons].filter(x => x.evidence === 'said').length,
  // The workspace redesign's names (snake_case, the Phase 2 contract). Every one is the CRM's own
  // field off the `cs` bag (accountHealth.ts), never a score of ours: a health number on this page
  // is HubSpot's, and the page marks it so.
  crm_health_score: numOrNull(r.health?.health_score),   // cs.health_score (the CRM's own health-score property)
  active_users_30d: r.activeUsers ?? null,               // cs.active_users_30d
  // Active users now minus ~30 days ago, from our daily snapshots; null until a month exists.
  active_users_trend: r.activeUsersTrend ?? null,
  // The end of the committed subscription term that comes up next (cs.renewal_date, read from the
  // CRM's subscriptions, never guessed from close dates); null once passed or when month to month.
  renewal_date: r.renewalDate ?? null,
  term_months: r.termMonths ?? null,                     // 1 = month to month
  cs_owner_name: r.health?.owner_name ?? null,           // the CS owner, not the AE
  // The AE, kept apart from the CS owner above: the two are different people on most accounts.
  owner_name: r.ownerName ?? null,
});

/**
 * The report's read (GET-416): the same lists, cut to what a section needs — counts and money,
 * the at-risk rows with their strongest reason and the quote behind it, the expansion rows with
 * what they asked for, and the split between what the CRM said and what the customer said.
 */
export async function buildCustomerSuccessData(supabase, workspaceId, { limit = 15 } = {}) {
  const p = await buildCustomerSuccess(supabase, workspaceId);
  const byId = new Map(p.accounts.map(a => [a.companyId, a]));
  const churnedIds = new Set(p.churned.map(a => a.companyId));
  const pick = (r) => ({
    account_id: r.companyId, account: r.name, mrr: r.mrr ?? null, cs_owner: r.csOwner,
    days_quiet: r.daysQuiet, active_users: r.activeUsers ?? null, products: r.products,
    active_users_trend: r.active_users_trend ?? null, renewal_date: r.renewal_date ?? null,
  });
  const reason = (x) => x ? ({ tier: x.tier, kind: x.kind, text: x.text, detail: x.detail ?? null, quote: x.quote ?? null, at: x.at ?? null, evidence: x.evidence }) : null;
  const atRisk = p.atRiskIds.map(id => byId.get(id)).filter(Boolean)
    .map(r => ({ ...pick(r), reason: reason(r.riskReasons[0]), reasons_n: r.riskReasons.length }))
    .sort((a, b) => (a.reason?.tier ?? 9) - (b.reason?.tier ?? 9) || (b.mrr ?? 0) - (a.mrr ?? 0));
  const expansion = p.expansionIds.map(id => byId.get(id)).filter(Boolean)
    .map(r => ({ ...pick(r), reason: reason(r.expansionReasons[0]), upgrade_value: r.upgradeValue ?? null, upgrade_stage: r.upgradeStage ?? null }))
    .sort((a, b) => (a.reason?.tier ?? 9) - (b.reason?.tier ?? 9) || (b.upgrade_value ?? 0) - (a.upgrade_value ?? 0));
  const bySaid = (rows, key) => ({ said: rows.filter(r => r.reason?.evidence === 'said').length, crm: rows.filter(r => r.reason?.evidence === 'crm').length });
  // Two cuts that are not lists of their own: what we owe customers, and who renews soon.
  const promised = p.accounts.filter(r => r.promised_count > 0)
    .map(r => ({ ...pick(r), promise: reason(r.promisedReasons[0]), overdue_days: r.promisedReasons[0]?.overdue_days ?? null, promised_n: r.promised_count }))
    .sort((a, b) => (b.overdue_days ?? 0) - (a.overdue_days ?? 0) || (b.mrr ?? 0) - (a.mrr ?? 0));
  const renewing = p.accounts.filter(r => renewsWithin(r.renewal_date, RENEWAL_WINDOW_DAYS))
    .map(r => ({ ...pick(r), at_risk: p.atRiskIds.includes(r.companyId), term_months: r.term_months ?? null }))
    .sort((a, b) => String(a.renewal_date).localeCompare(String(b.renewal_date)));
  return {
    counts: p.counts, totals: p.totals,
    health_ready: p.healthReady, mined_ready: p.minedReady,
    at_risk: { n: atRisk.length, by_evidence: bySaid(atRisk), by_tier: countByTier(atRisk), rows: atRisk.slice(0, limit) },
    expansion: { n: expansion.length, by_evidence: bySaid(expansion), rows: expansion.slice(0, limit) },
    churned: { n: p.churned.length, mrr: p.totals.churnedMrr, rows: p.churned.slice(0, limit).map(r => ({ account_id: r.companyId, account: r.name, mrr: r.mrr ?? null })) },
    promised: { n: promised.length, overdue: promised.filter(r => r.overdue_days).length, rows: promised.slice(0, limit) },
    renewing: { n: renewing.length, window_days: RENEWAL_WINDOW_DAYS, mrr: Math.round(renewing.reduce((t, r) => t + (Number(r.mrr) || 0), 0)), rows: renewing.slice(0, limit) },
    supports: {
      at_risk: p.healthReady || p.minedReady, expansion: p.healthReady || p.minedReady,
      churned: p.healthReady, evidence_split: p.minedReady,
      renewals: p.accounts.some(r => r.renewal_date || r.term_months != null),
    },
    provenance: {
      caveats: [
        ...(p.healthReady ? [] : ['The CRM keeps no account-health fields here (status, MRR, usage); the customer cohort is "has a won deal" and every reason is from conversations.']),
        ...(p.minedReady ? [] : ['The conversation corpus has not been mined for this workspace; at-risk and expansion rest on CRM fields alone.']),
        'At risk and expansion each = one tier-1 reason, or two independent tier-2 ones. Tier 3 is context on a row, never the reason for it.',
        '"We promised" (open commitments we owe, overdue or from a call) is its own list and never a risk reason.',
        'The CRM upgrade price is context, never an expansion reason: expansion rows exist because a customer asked.',
        'A renewal date is the end of a committed subscription term in the CRM; a month-to-month customer has none.',
        'A declined product suppresses that expansion row for a year.',
      ],
    },
  };
}

function countByTier(rows) {
  const m = new Map();
  for (const r of rows) { const t = r.reason?.tier ?? 9; m.set(t, (m.get(t) ?? 0) + 1); }
  return [...m.entries()].sort((a, b) => a[0] - b[0]).map(([tier, count]) => ({ tier, count }));
}
