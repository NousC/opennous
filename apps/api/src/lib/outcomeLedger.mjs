// The outcome ledger — what closed, and what we knew about the account at the time.
//
// This is Phase 1 of fitting the ICP scoring model to evidence instead of to prose. Today the
// scorecard's weights come from one LLM call over the ICP and positioning notes; no deal
// outcome touches them, so a workspace with a brilliant win/loss read and a mediocre ICP
// paragraph gets the paragraph. This module builds the labelled dataset that lets lift be
// MEASURED. Nothing here changes scoring yet, on purpose: look at the numbers on real
// workspaces before betting anything on them.
//
// ── The one rule that makes it honest ──────────────────────────────────────
//
// Features are read as of `opened_at`, never as of now. An account that closed-won in June
// has, by September, acquired a pile of attributes it only has BECAUSE it became a customer:
// an owner, a health score, a lifecycle stage of "client", enrichment we only paid for once
// it mattered. Fit on those and the model's proud finding is "our ICP is companies who are
// already our customers" — the textbook leak, and it looks like a great model right up until
// it scores a stranger.
//
// We can do this properly because claims are temporal: `valid_from` / `invalid_at` mean the
// graph can answer "what did we know about Acme in March". A CRM cannot; it only holds now.

import { isMeeting, isEmail, oneEach } from './activityKinds.mjs';
import { getSupabaseClient, crmDealState } from '@nous/core';
import { pageAll } from './pageAll.mjs';

// Stage values that mean a deal ENDED, mapped to the three outcomes the model cares about.
// Stored stage strings vary by workspace (we adopt their CRM's own labels), so this matches on
// the canonical value and falls back to a normalised form of the label.
const WON = new Set(['closed_won', 'won', 'client', 'customer']);
const LOST = new Set(['closed_lost', 'lost', 'churned']);
// A deal nobody decided on failed differently from one lost to a competitor. The win/loss
// skill already keeps them apart; folding them together here would teach the model that
// indecision is rejection.
const NO_DECISION = new Set(['disqualified', 'no_decision', 'went_dark', 'stalled']);

const norm = (v) => String(v ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');

function outcomeOf(stageValue) {
  const v = norm(stageValue);
  if (WON.has(v)) return 'won';
  if (LOST.has(v)) return 'lost';
  if (NO_DECISION.has(v)) return 'no_decision';
  return null;
}

// The firmographic claims worth carrying. Deliberately a short list of things that are true
// about a company BEFORE it buys — anything we only learn by selling to them is leakage
// wearing a feature's name (owner, health score, lifecycle, plan, MRR).
const FIRMOGRAPHIC = [
  'industry', 'sub_industry', 'employee_count', 'employee_range', 'revenue_range',
  'country', 'region', 'company_type', 'business_model', 'funding_stage', 'tech_stack',
  'source', 'first_touch_channel', 'segment', 'icp_tier',
];

// Person-level attributes, which turn out to matter as much as firmographics and are often
// the only thing we have. Real workspaces put the pipeline stage on the PERSON — the deal is
// with Sarah at Acme, not with Acme — so the entity that closed is frequently a contact, and
// their seniority and buying role are the strongest thing on it.
//
// "Did we reach an economic buyer" is the finding every win/loss study lands on, and it lives
// in exactly these two properties.
const PERSONAL = ['seniority', 'buying_role', 'job_title', 'department'];

// Continuous values are useless to a lift calculation and dangerous to a small sample — 47
// employees and 52 employees are the same company and would be two features. Bucketing is
// what turns them into something 40 deals can actually speak to.
function bucketEmployees(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return null;
  if (v < 10) return '1-9';
  if (v < 50) return '10-49';
  if (v < 200) return '50-199';
  if (v < 1000) return '200-999';
  return '1000+';
}

function bucketDays(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 0) return null;
  if (v <= 1) return '0-1d';
  if (v <= 3) return '2-3d';
  if (v <= 7) return '4-7d';
  if (v <= 21) return '8-21d';
  return '22d+';
}

function bucketCount(n, name) {
  const v = Number(n);
  if (!Number.isFinite(v)) return null;
  if (v === 0) return `${name}:0`;
  if (v === 1) return `${name}:1`;
  if (v <= 3) return `${name}:2-3`;
  if (v <= 6) return `${name}:4-6`;
  return `${name}:7+`;
}

/** A claim's plain value — claims store either a bare scalar or `{ value: … }`. */
const claimValue = (c) => (c && typeof c.value === 'object' && c.value !== null && 'value' in c.value
  ? c.value.value
  : c?.value);

/**
 * The account's claims AS OF a moment: valid_from at or before it, and not yet invalidated
 * then. This is the whole trick — everything else in this file is bookkeeping around it.
 */
// Facts about a company that don't change with our selling to it. Everything else must carry
// WHEN it became known — a derived claim with no valid_from used to pass as known forever, so
// today's values leaked into deals that closed years ago (GET-270).
const TIME_INVARIANT = new Set(['industry', 'sub_industry', 'country', 'region', 'company_type', 'business_model']);

function claimsAsOf(claims, at) {
  const t = new Date(at).getTime();
  const chosen = new Map();
  for (const c of claims) {
    const knownAt = c.valid_from ?? (TIME_INVARIANT.has(c.property) ? null : c.computed_at);
    if (knownAt == null && !TIME_INVARIANT.has(c.property)) continue;   // never dated: not provably known then
    const from = knownAt ? new Date(knownAt).getTime() : null;
    const until = c.invalid_at ? new Date(c.invalid_at).getTime() : null;
    if (from !== null && from > t) continue;      // we didn't know it yet
    if (until !== null && until <= t) continue;   // it had already been superseded
    // Several claims can be live for one property; the most recently valid wins, which is the
    // same rule the reader uses everywhere else.
    const prev = chosen.get(c.property);
    if (!prev || (from ?? 0) >= (prev._from ?? 0)) chosen.set(c.property, { ...c, _from: from ?? 0 });
  }
  return chosen;
}

/**
 * Features that come from the GRAPH rather than the timeline, and are therefore true whatever we
 * know about when the deal ran.
 *
 * Stakeholder count is a person↔company edge. It does not depend on having captured any activity,
 * which is why it is the one behavioural finding that holds across a client's whole history —
 * measured on a customer workspace, most won deals were multithreaded against about half of lost, and
 * that separation is identical either side of their CRM migration. Everything derived from
 * observations is not (see activityAsOf).
 */
function graphFeatures(contactCount) {
  const f = {};
  const stakeholders = bucketCount(contactCount, 'stakeholders');
  if (stakeholders) f.stakeholders = stakeholders;
  // Multi-threaded is the single most repeated finding in every win/loss study ever run, so
  // it gets its own boolean rather than hiding inside a stakeholder bucket.
  f.multithreaded = contactCount >= 3 ? 'yes' : 'no';
  return f;
}

/**
 * Behaviour, from the timeline up to `at`. These are the features the revenue report already
 * computes in prose for "what a win looks like here" — same evidence, one implementation, so
 * the report and the model can never tell you different things about the same deal.
 *
 * ONLY CALLED WHEN THE WINDOW IS REAL. A deal we cannot place in time has no measurable
 * behaviour, and the honest answer is to record nothing rather than `no` — see the caller.
 */
function activityAsOf(observations, openedAt, closedAt) {
  const open = new Date(openedAt).getTime();
  const close = new Date(closedAt).getTime();
  // Only what happened while the deal was live. Activity after the close is the onboarding
  // call, and counting it would say winners talk to you more — which is true and useless.
  const window = oneEach(observations.filter(o => {
    const t = new Date(o.observed_at ?? o.created_at ?? 0).getTime();
    return t >= open && t <= close;
  }));

  // By activity TYPE (activityKinds.mjs): a CRM delivers meetings and emails under one source.
  const meetings = window.filter(isMeeting);
  const emails = window.filter(isEmail);

  const firstMeeting = meetings.length
    ? Math.min(...meetings.map(m => new Date(m.observed_at ?? m.created_at).getTime()))
    : null;

  const f = {};
  const meetingCount = bucketCount(meetings.length, 'meetings');
  if (meetingCount) f.meetings = meetingCount;
  if (firstMeeting !== null) {
    const d = bucketDays((firstMeeting - open) / 86400000);
    if (d) f.days_to_first_meeting = d;
  }
  f.had_meeting = meetings.length > 0 ? 'yes' : 'no';
  f.had_email = emails.length > 0 ? 'yes' : 'no';
  return f;
}

/**
 * Can this deal's activity be measured at all?
 *
 * Two ways it cannot, and both were being answered `no` instead of `unknown` (GET-353):
 *
 *   1. No usable open date. A CRM's created date is when the RECORD was made, not when the deal
 *      began. One customer migrated into their CRM in one month — thousands of their deals carry that
 *      month as their created date while closing years earlier, so the CRM itself cannot say when
 *      those deals opened. The ledger used to fall back to the ACCOUNT's first observation, which
 *      produced a window running from the migration back to the close: backwards, so the activity
 *      filter matched nothing, on most of their deals.
 *   2. The window predates anything we ever captured. We import 12 months of engagements, so a
 *      deal that closed before that has no activity to find regardless of its dates.
 *
 * In both cases every meeting and email feature came out `no`, and the model read thousands of
 * fabricated negatives as evidence. Blended, meetings looked like noise (about 6% won vs 7% lost);
 * among deals we can actually measure they separate strongly (about 45% vs 30%).
 */
export function activityMeasurable(openedAt, closedAt, coverageStart) {
  if (!openedAt) return false;                                  // no usable open date
  const open = Date.parse(openedAt);
  const close = Date.parse(closedAt);
  if (!Number.isFinite(open) || !Number.isFinite(close)) return false;
  if (open > close) return false;                               // the window runs backwards
  if (coverageStart != null && close < coverageStart) return false;  // ended before we saw anything
  return true;
}

/** Every feature on one account, as of the moment the deal opened. */
function featuresFor(claims, observations, contactCount, openedAt, closedAt, coverageStart) {
  // Firmographics as of the open when we know it, else as of the close. Slow-moving attributes
  // (industry, size) barely differ across one deal's life, so this keeps a deal with no usable
  // open date in the model for the features that ARE knowable rather than dropping it entirely.
  const asOf = claimsAsOf(claims, openedAt ?? closedAt);
  const out = {};

  for (const prop of [...FIRMOGRAPHIC, ...PERSONAL]) {
    const c = asOf.get(prop);
    if (!c) continue;
    const raw = claimValue(c);
    if (raw === null || raw === undefined || raw === '') continue;

    if (prop === 'employee_count') {
      const b = bucketEmployees(raw);
      if (b) out.employee_range = b;
      continue;
    }
    // A list-valued claim (tech_stack) becomes one feature per member — "uses Salesforce" is
    // the question, not "has this exact stack", which no two companies share.
    if (Array.isArray(raw)) {
      for (const item of raw.slice(0, 12)) {
        const v = norm(item);
        if (v) out[`${prop}:${v}`] = 'yes';
      }
      continue;
    }
    out[prop] = norm(raw);
  }

  // From the graph: always true, window or no window.
  Object.assign(out, graphFeatures(contactCount));
  // From the timeline: only when the timeline means something. A deal we cannot place in time
  // contributes NO meeting or email feature at all, rather than a fabricated `no` (GET-353).
  if (activityMeasurable(openedAt, closedAt, coverageStart)) {
    Object.assign(out, activityAsOf(observations, openedAt, closedAt));
  }
  return out;
}

/**
 * Rebuild the ledger for a workspace. Idempotent: a row is keyed by (workspace, account,
 * close date), so re-running after more history lands corrects rows rather than duplicating
 * them.
 *
 * Returns counts, so the caller can say "38 closed deals, 12 won" rather than "done".
 */
/**
 * Run `fn` over `ids` in batches and concatenate. An `.in()` filter carrying thousands of
 * uuids builds a URL long enough for PostgREST to reject outright, which the old code turned
 * into an empty result rather than an error.
 */
async function chunked(ids, fn, size = 200) {
  const out = [];
  for (let i = 0; i < ids.length; i += size) {
    out.push(...(await fn(ids.slice(i, i + size))));
  }
  return out;
}

export async function buildOutcomeLedger(workspaceId, { supabase = getSupabaseClient() } = {}) {
  // One stamp for the whole pass. Per-row timestamps would leave the stale-row delete below
  // with no boundary it could trust.
  const derivedAt = new Date().toISOString();
  // Every pipeline_stage claim ever written for this workspace, live or superseded. The
  // superseded ones are the point: they are the history of how each account moved.
  // Paged: PostgREST silently caps at 1000 rows, and `.limit(50000)` did nothing but look
  // reassuring. A workspace with about five thousand stage claims built its entire ledger from the first
  // thousand — fewer deals, all of them plausible. See lib/pageAll.mjs.
  const stageClaims = await pageAll(() => supabase
    .from('claims')
    .select('entity_id, value, valid_from, invalid_at, computed_at')
    .eq('workspace_id', workspaceId)
    .eq('property', 'pipeline_stage')
    .order('valid_from', { ascending: true }));
  if (!stageClaims?.length) return { deals: 0, won: 0, lost: 0, no_decision: 0, accounts: 0 };

  // Group each account's stage history, then find the moment it ENTERED a terminal stage and
  // the moment it first became a real deal.
  const byEntity = new Map();
  for (const c of stageClaims) {
    if (!byEntity.has(c.entity_id)) byEntity.set(c.entity_id, []);
    byEntity.get(c.entity_id).push(c);
  }

  const deals = [];
  for (const [entityId, history] of byEntity) {
    const terminal = history.find(c => outcomeOf(claimValue(c)));
    if (!terminal) continue;
    const closedAt = terminal.valid_from ?? terminal.computed_at;
    if (!closedAt) continue;

    // `opened_at` is the first stage we ever recorded that wasn't a cold/identified holding
    // state — the moment this stopped being a name on a list and became a deal. Falling back
    // to the earliest claim is right for a workspace whose CRM only sent us the end state.
    const firstReal = history.find(c => {
      const v = norm(claimValue(c));
      return v && !['cold', 'identified', 'connected'].includes(v) && !outcomeOf(v);
    });
    // A CRM sync that sends only the CURRENT stage leaves one claim per account, so both of
    // the above resolve to the close itself and the observation window is zero-width — every
    // behavioural feature comes back empty and silently says "nobody ever met this account".
    // The first thing we ever observed about them is the honest start of the relationship.
    const openedAt = firstReal?.valid_from ?? history[0]?.valid_from ?? null;
    deals.push({
      entityId, outcome: outcomeOf(claimValue(terminal)),
      openedAt: (openedAt && openedAt !== closedAt) ? openedAt : null,   // resolved below
      closedAt,
    });
  }
  // ── The CRM's OWN deals, which is where the money actually is ──────────────
  //
  // ⚠️ THE GAP THIS CLOSES. The loop above builds a cohort from `pipeline_stage` claim
  // history, which in production sits on PERSON entities written by lead-list and
  // stage-derivation paths. Meanwhile `upsertDeal` writes every CRM deal as its own
  // `type: 'deal'` entity carrying `value`, `status` (the provider's explicit won/lost
  // verdict), `close_date` and a `belongs_to` edge to the company.
  //
  // The ledger never looked at those, so the two sets were disjoint and the symptom was
  // "we have no deal values": one workspace held a few dozen CRM deals — some won, some
  // lost, every one with an amount — and `buildOutcomeLedger` returned ZERO deals for it, because
  // none of its thousands of stage-carrying people had ever reached a terminal stage. The money was
  // in the graph the whole time, one table over.
  //
  // These take PRECEDENCE where they exist. A provider's own won/lost verdict on a record
  // that carries an amount beats a stage label we mapped ourselves, and the row is filed
  // against the COMPANY so the behavioural features join to the account's real activity
  // rather than to a deal entity nobody ever emailed.
  const dealEntities = await pageAll(() => supabase.from('entities')
    .select('id')
    .eq('workspace_id', workspaceId).eq('type', 'deal')
    .order('id', { ascending: true }));

  if (dealEntities.length) {
    const dealIds = dealEntities.map(e => e.id);
    const [dealClaims, dealEdges, dealObs] = await Promise.all([
      chunked(dealIds, ids => pageAll(() => supabase.from('claims')
        .select('entity_id, property, value, valid_from')
        .eq('workspace_id', workspaceId).in('entity_id', ids)
        .in('property', ['status', 'value', 'close_date', 'opened_date', 'stage'])
        .is('invalid_at', null)
        .order('valid_from', { ascending: true }))),
      chunked(dealIds, ids => pageAll(() => supabase.from('relationships')
        .select('from_entity_id, to_entity_id, type')
        .eq('workspace_id', workspaceId).in('from_entity_id', ids)
        .order('from_entity_id', { ascending: true }))),
      // When the deal OPENED, taken from the first thing we ever observed about the deal
      // record itself. The generic fallback looks for activity on the ACCOUNT, and a
      // CRM-synced company with no calls or email has none — so every cycle length came out
      // as zero days and the velocity comparison read "won and lost both closed instantly".
      // The deal entity always has observations, because the sync writes its stage and
      // amount as exactly that.
      chunked(dealIds, ids => pageAll(() => supabase.from('observations')
        .select('entity_id, observed_at, created_at')
        .eq('workspace_id', workspaceId).in('entity_id', ids)
        .order('observed_at', { ascending: true }))),
    ]);

    const firstSeen = new Map();
    for (const o of dealObs ?? []) {
      const t = new Date(o.observed_at ?? o.created_at ?? 0).getTime();
      if (!Number.isFinite(t) || !t) continue;
      const prev = firstSeen.get(o.entity_id);
      if (prev === undefined || t < prev) firstSeen.set(o.entity_id, t);
    }

    const accountOf = new Map();
    for (const e of dealEdges ?? []) {
      if (e.type === 'belongs_to' || e.type === 'works_at') accountOf.set(e.from_entity_id, e.to_entity_id);
    }
    const byDeal = new Map();
    for (const c of dealClaims ?? []) {
      const cur = byDeal.get(c.entity_id) ?? {};
      cur[c.property] = claimValue(c);
      byDeal.set(c.entity_id, cur);
    }

    // An account covered by a real CRM deal drops out of the stage-derived cohort, so one
    // closed deal is never counted twice under two different close dates.
    const covered = new Set();
    const crmDeals = [];
    for (const [dealId, f] of byDeal) {
      // ONE provider-agnostic reading of the outcome, rather than a mapping per CRM.
      //
      // `crmDealState` takes the explicit status where a provider ships one (HubSpot's
      // derived verdict, Pipedrive's open|won|lost) and otherwise matches the stage LABEL,
      // which is the only signal Attio gives — its deals object has no status field at all.
      // Demanding a literal `status` claim meant every Attio deal was invisible to the
      // ledger no matter how clearly its stage read "Won".
      const state = crmDealState({ status: f.status ?? null, stage: f.stage ?? null });
      // 'open' is not an outcome. Only decided deals become ledger rows.
      const outcome = state === 'won' ? 'won' : state === 'lost' ? 'lost' : null;
      if (!outcome) continue;

      // A decided deal with no date at all cannot be placed in a window, so it is skipped
      // rather than stamped with today. The provider adapters are responsible for supplying
      // one: HubSpot and Pipedrive have a real close date, and Attio falls back to the
      // moment the record entered its current (terminal) stage.
      const rawClose = f.close_date ?? null;
      const closedAt = rawClose && !Number.isNaN(Date.parse(rawClose))
        ? new Date(rawClose).toISOString()
        : null;
      if (!closedAt) continue;
      const account = accountOf.get(dealId) ?? dealId;
      const raw = Number(String(f.value ?? '').replace(/[^0-9.]/g, ''));
      // The CRM's own created date first. `firstSeen` is when OUR sync noticed the deal,
      // which on a fresh connection is the same afternoon as every close date in the
      // portal — a cycle length measured against it describes our infrastructure.
      const created = f.opened_date ? Date.parse(String(f.opened_date)) : NaN;
      const seen = firstSeen.get(dealId);
      const candidate = Number.isFinite(created) ? created : seen;
      const openedAt = candidate && candidate < Date.parse(closedAt)
        ? new Date(candidate).toISOString()
        : null;
      crmDeals.push({
        dealId,
        entityId: account,
        outcome,
        // null falls through to the account-activity fallback further down, which is the
        // right answer when the deal record itself tells us nothing useful.
        openedAt,
        closedAt,
        valueUsd: Number.isFinite(raw) && raw > 0 ? raw : null,
      });
      covered.add(account);
    }
    // When the CRM has decided deals, they are the WHOLE cohort — the stage-derived rows are
    // dropped rather than merged.
    //
    // Mixing them looked reasonable and produced nonsense. A `pipeline_stage` claim carries
    // the date WE RECORDED the stage, not the date the deal closed, so a sync that sends only
    // the current stage stamps every account as closing today. The first run of this on real
    // data returned more than twice the wins the CRM knew about: a dozen extra rows with no amount, all
    // "closed" on the morning the ledger happened to run, which would sit inside every
    // six-month window from now on and drag the win rate with them.
    //
    // A provider's own verdict on a record with an amount and a real close date is simply a
    // better cohort than one we inferred, and half a cohort of each is worse than either.
    // Workspaces with no CRM deals are untouched and keep the derived path, including the
    // no_decision outcome, which no CRM status expresses.
    if (crmDeals.length) {
      deals.length = 0;
      deals.push(...crmDeals);
    } else {
      for (let i = deals.length - 1; i >= 0; i--) {
        if (covered.has(deals[i].entityId)) deals.splice(i, 1);
      }
    }
  }

  if (!deals.length) return { deals: 0, won: 0, lost: 0, no_decision: 0, accounts: byEntity.size };

  const entityIds = deals.map(d => d.entityId);

  // Everything we ever knew about those accounts, and everything that happened on them.
  // Both paged, and both ordered — paging an unordered query can return a row twice and
  // miss another. `.in()` on thousands of ids also builds a URL long enough to be rejected,
  // and the old `.then(r => r, () => ({ data: [] }))` turned that rejection into an empty
  // result: the same swallowed-error shape that made the revenue report claim a workspace
  // with tens of thousands of observations had none. Chunked, so the URL stays sane.
  const [allClaims, observations] = await Promise.all([
    chunked(entityIds, ids => pageAll(() => supabase.from('claims')
      .select('entity_id, property, value, valid_from, invalid_at, computed_at')
      .eq('workspace_id', workspaceId)
      .in('entity_id', ids)
      .in('property', [...FIRMOGRAPHIC, ...PERSONAL, 'company_domain', 'deal_value', 'won_deal_value'])
      .order('valid_from', { ascending: true }))),
    chunked(entityIds, ids => pageAll(() => supabase.from('observations')
      .select('id, entity_id, property, source, kind, external_id, observed_at, created_at')
      .eq('workspace_id', workspaceId)
      .in('entity_id', ids)
      .order('observed_at', { ascending: true }).order('id', { ascending: true }))),
  ]);

  // How many people we knew at each account while the deal was live. `works_at` edges carry
  // valid_from, so this is point-in-time like everything else: someone who appeared after the
  // close is not evidence that the deal was multi-threaded.
  // Both directions. When the deal sits on a COMPANY, its contacts point at it
  // (person →works_at→ company). When it sits on a PERSON — which is how most CRMs actually
  // send it — the edge points away, at their employer. Querying one direction found nothing
  // at all on real data, which is how this was caught.
  const [edgesIn, edgesOut] = await Promise.all([
    chunked(entityIds, ids => pageAll(() => supabase.from('relationships')
      .select('from_entity_id, to_entity_id, type, valid_from')
      .eq('workspace_id', workspaceId).in('to_entity_id', ids)
      .order('valid_from', { ascending: true }))),
    chunked(entityIds, ids => pageAll(() => supabase.from('relationships')
      .select('from_entity_id, to_entity_id, type, valid_from')
      .eq('workspace_id', workspaceId).in('from_entity_id', ids)
      .order('valid_from', { ascending: true }))),
  ]);
  const edges = [...(edgesIn ?? []), ...(edgesOut ?? [])];

  const claimsByEntity = new Map();
  for (const c of allClaims ?? []) {
    if (!claimsByEntity.has(c.entity_id)) claimsByEntity.set(c.entity_id, []);
    claimsByEntity.get(c.entity_id).push(c);
  }
  const obsByEntity = new Map();
  for (const o of observations ?? []) {
    if (!obsByEntity.has(o.entity_id)) obsByEntity.set(o.entity_id, []);
    obsByEntity.get(o.entity_id).push(o);
  }

  // Fill in every deal whose stage history gave us no real start: use its earliest observation.
  //
  // Only when that observation PRECEDES the close. This fallback reads the ACCOUNT's first
  // observation, and an account is usually first seen when we sync it — which is long after a
  // historical deal closed. It was assigning deals that closed in 2020 an open date in 2025, so
  // the window ran backwards and `t >= open && t <= close` matched nothing: most of one customer's
  // deals, every one of them recording `had_meeting: no` as though we had looked (GET-353).
  //
  // A deal we cannot place in time now keeps `openedAt = null`, which says exactly that. The
  // column is nullable and both readers already fall back to the close date for display; what
  // changes is that the feature builder stops inventing behaviour for it.
  const firstObsByEntity = new Map();
  for (const o of observations ?? []) {
    const t = new Date(o.observed_at ?? o.created_at ?? 0).getTime();
    if (!Number.isFinite(t) || !t) continue;
    const prev = firstObsByEntity.get(o.entity_id);
    if (prev === undefined || t < prev) firstObsByEntity.set(o.entity_id, t);
  }
  for (const d of deals) {
    if (d.openedAt) continue;
    const t = firstObsByEntity.get(d.entityId);
    d.openedAt = (t && t <= new Date(d.closedAt).getTime()) ? new Date(t).toISOString() : null;
  }

  // The earliest activity this workspace has at all. A deal that closed before it had no
  // behaviour we could ever have observed, whatever its own dates say — we import 12 months of
  // engagements, and a deal from 2021 predates all of it.
  const coverageStart = (observations ?? []).reduce((min, o) => {
    const t = new Date(o.observed_at ?? o.created_at ?? 0).getTime();
    return Number.isFinite(t) && t > 0 && (min === null || t < min) ? t : min;
  }, null);

  const contactsByEntity = new Map();
  const dealSet = new Set(entityIds);
  // Which company each person-shaped deal works at — so firmographics are one hop away
  // instead of missing.
  const employerOf = new Map();
  for (const e of edges) {
    if (!/works_at|employed_by|contact_of/i.test(String(e.type ?? ''))) continue;
    if (dealSet.has(e.to_entity_id)) {
      // The deal is the company; this edge is one of its contacts.
      if (!contactsByEntity.has(e.to_entity_id)) contactsByEntity.set(e.to_entity_id, []);
      contactsByEntity.get(e.to_entity_id).push(e);
    }
    if (dealSet.has(e.from_entity_id)) employerOf.set(e.from_entity_id, e.to_entity_id);
  }

  // The people's CONVERSATIONS. An email or a call is filed on the person, never the company,
  // so a company-shaped deal read only on its own entity had_meeting 'no' however much was said.
  const contactIds = [...new Set([...contactsByEntity.values()].flat().map(e => e.from_entity_id))];
  const personObs = new Map();
  if (contactIds.length) {
    const po = await chunked(contactIds, ids => pageAll(() => supabase.from('observations')
      .select('id, entity_id, property, external_id, observed_at, created_at')
      .eq('workspace_id', workspaceId).in('entity_id', ids)
      .like('property', 'interaction.%')
      .order('observed_at', { ascending: true }).order('id', { ascending: true })));
    for (const o of po ?? []) {
      if (!personObs.has(o.entity_id)) personObs.set(o.entity_id, []);
      personObs.get(o.entity_id).push(o);
    }
  }

  // Pull the employers' firmographics in one go.
  const employerIds = [...new Set([...employerOf.values()])];
  const employerClaims = new Map();
  if (employerIds.length) {
    const ec = await chunked(employerIds, ids => pageAll(() => supabase.from('claims')
      .select('entity_id, property, value, valid_from, invalid_at, computed_at')
      .eq('workspace_id', workspaceId).in('entity_id', ids)
      .in('property', FIRMOGRAPHIC)
      .order('valid_from', { ascending: true })));
    for (const c of ec ?? []) {
      if (!employerClaims.has(c.entity_id)) employerClaims.set(c.entity_id, []);
      employerClaims.get(c.entity_id).push(c);
    }
  }

  // The market each of these belongs to (GET-318), read off the flattened rows in one pass so the
  // report can answer "our market" without re-deriving a country per deal. A deal row carries its
  // account's country; an account row carries its own. Unrecorded stays null, which the focus keeps.
  const countryByEntity = new Map();
  for (let from = 0; ; from += 1000) {
    // Rows without a country are skipped here rather than filtered in the query: `.not()` is one
    // more shape every caller's client has to support, and the test's fake one does not have it.
    const { data, error } = await supabase.from('entity_list_rows')
      .select('entity_id, country')
      .eq('workspace_id', workspaceId).in('kind', ['deal', 'account'])
      .order('entity_id').range(from, from + 999);
    if (error) break;
    for (const r of data ?? []) if (r.country) countryByEntity.set(r.entity_id, r.country);
    if (!data || data.length < 1000) break;
  }

  const rows = deals.map(d => {
    // The deal's own claims, plus its employer's if the deal is a person. Both are read at
    // the same moment, so a company attribute added after the close still can't leak in.
    const employer = employerOf.get(d.entityId);
    const claims = [
      ...(claimsByEntity.get(d.entityId) ?? []),
      ...(employer ? (employerClaims.get(employer) ?? []) : []),
    ];
    const closeT = new Date(d.closedAt).getTime();
    const contactCount = new Set(
      (contactsByEntity.get(d.entityId) ?? [])
        .filter(e => !e.valid_from || new Date(e.valid_from).getTime() <= closeT)
        .map(e => e.from_entity_id),
    ).size;
    // A CRM deal carries its own amount; only fall back to an account-level claim when it
    // does not. The account-level `deal_value` claim is written by a different path and, in
    // production, sits on accounts that have no closed deal at all.
    const value = claimsAsOf(claims, d.closedAt).get('deal_value')
      ?? claimsAsOf(claims, d.closedAt).get('won_deal_value');
    const raw = d.valueUsd != null
      ? d.valueUsd
      : (value ? Number(String(claimValue(value)).replace(/[^0-9.]/g, '')) : NaN);
    const conversations = [
      ...(obsByEntity.get(d.entityId) ?? []),
      ...(contactsByEntity.get(d.entityId) ?? []).flatMap(e => personObs.get(e.from_entity_id) ?? []),
    ];
    return {
      workspace_id: workspaceId,
      entity_id: d.entityId,
      // One row per DEAL (GET-270). Keyed by the account alone, two deals at one account closing
      // on the same date aborted the whole rebuild, and across upsert batches the last silently won.
      deal_id: d.dealId ?? null,
      outcome_key: d.dealId ?? d.entityId,
      outcome: d.outcome,
      opened_at: d.openedAt,
      closed_at: d.closedAt,
      value_usd: Number.isFinite(raw) && raw > 0 ? raw : null,
      features_at: featuresFor(claims, conversations, contactCount, d.openedAt, d.closedAt, coverageStart),
      // The deal's own market when it has one, else its account's.
      country: countryByEntity.get(d.dealId) ?? countryByEntity.get(d.entityId) ?? null,
      derived_at: derivedAt,
      source: 'graph',
    };
  });

  // Chunked, because a workspace with real history can produce thousands of rows and one
  // oversized upsert failing takes the whole rebuild with it.
  // Last write per key wins BEFORE the upsert: a key repeated inside one statement is a Postgres
  // error ("cannot affect row a second time"), not a merge.
  const unique = [...new Map(rows.map(r => [`${r.outcome_key}|${r.closed_at}`, r])).values()];
  for (let i = 0; i < unique.length; i += 500) {
    const { error: upErr } = await supabase
      .from('deal_outcomes')
      .upsert(unique.slice(i, i + 500), { onConflict: 'workspace_id,outcome_key,closed_at' });
    if (upErr) throw upErr;
  }

  // Rows the current derivation no longer produces are REMOVED.
  //
  // The ledger upserted and never deleted, so it accumulated sediment: switching this
  // workspace from stage-derived deals to the CRM's own left a dozen stale rows behind — no
  // amount, all stamped as closing on the morning of the old run — sitting alongside the real
  // ones and inside every six-month window from then on. A derivation that cannot
  // retract is not a derivation, it is an append-only log pretending to be one.
  //
  // Safe because every row the current pass produced was just upserted with this run's
  // `derived_at`: anything older is, by definition, no longer derivable from the graph.
  const { error: delErr } = await supabase
    .from('deal_outcomes')
    .delete()
    .eq('workspace_id', workspaceId)
    .lt('derived_at', derivedAt);
  if (delErr) throw delErr;

  const tally = (o) => rows.filter(r => r.outcome === o).length;
  return {
    deals: rows.length,
    won: tally('won'),
    lost: tally('lost'),
    no_decision: tally('no_decision'),
    accounts: byEntity.size,
  };
}
