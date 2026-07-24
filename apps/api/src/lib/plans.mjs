/**
 * Nous Pricing — server-side mirror of apps/frontend/src/config/plans.ts.
 *
 * Rewritten 2026-07-13 on measured cost.
 *
 * THE BILLED UNIT IS ACTIVE ACCOUNTS. Nothing else meters.
 *
 * An active account is a COMPANY we have actually had a conversation with — a
 * reply, a meeting, a DM. Not a row, not a lead, not a person. Counted by the
 * team_active_accounts() SQL function (see supabase/migrations/2026_07_13_active_accounts.sql),
 * which deliberately counts the same set the signal extractor fires on, so the
 * meter cannot drift away from the cost.
 *
 * Everything else is unlimited, on every plan, because everything else is free
 * for us to serve:
 *
 *   - retrievals   — get_context / get_account / query / attention. Deterministic
 *                    Postgres reads, no model in the path, $0. The old retrieval
 *                    meter billed this and nobody came near the cap, so it is now
 *                    unlimited (includedOpsPerMonth: null).
 *   - records      — people, companies, lead imports. A 2,000-lead import runs
 *                    ZERO model calls. Unlimited (recordsLimit: null).
 *   - seats        — never metered. Every self-serve winner in this category
 *                    (Clay, Day.ai, Smartlead) abandoned seat pricing.
 *
 * What actually costs money is Haiku turning an interaction into structured
 * context, and that only happens once somebody replies. So: import your list for
 * free, pay for the accounts that answer.
 *
 * The in-app agent runs Sonnet and is the one genuinely expensive surface. It is
 * NOT on the self-serve tiers — an operator in Claude Code brings their own agent
 * and their own tokens. It lives on 'custom', which is sales-led and unpriced on
 * purpose: we price it against observed usage (llm_usage table), not a forecast.
 *
 * Enrichment is not a product we sell. enrichmentsPerMonth stays 0 on every plan
 * (requireEnrichmentQuota passes through at 0), and the platform-funded Prospeo
 * fallback is now opt-in behind ENRICHMENT_BUILTIN_FALLBACK — see enrichment.mjs.
 *
 * Grandfathering: 'growth' and 'scale' are RETIRED from the ladder but kept as
 * plan ids so existing subscriptions (which key on plan_id from checkout
 * metadata) don't silently fall back to Free. They are not sellable.
 *
 * Self-hosted (SELF_HOSTED=true) bypasses all gating and metering — see access.mjs.
 * That is architecture, not charity: on self-host the customer brings their own
 * ANTHROPIC_API_KEY, so they pay their own extraction bill. Cloud means we pay it.
 */

export const PLAN_IDS = ['free', 'starter', 'pro', 'custom', 'growth', 'scale'];

/** The ladder we actually sell. 'growth'/'scale' are retired, see below. */
export const SELLABLE_PLAN_IDS = ['free', 'starter', 'pro', 'custom'];

// ── Features ────────────────────────────────────────────────────────────────
//
// Features do NOT differ between Free, Start and Pro. Those three are one product
// at three sizes, and the ONLY thing that separates them is the active-account
// cap. An agent that hits "upgrade to use this tool" mid-task is a broken product,
// so within a tier ladder we never gate capability, only quantity.
//
// The real split is between the two AUDIENCES, and it falls exactly where the cost
// does:
//
//   ICP I — operators in Claude Code. They already have an agent and they pay for
//   their own tokens. They want the graph: the accounts, the activities, the ICP,
//   the integrations, and an API to read it all from. Everything below in GRAPH.
//
//   ICP II — internal GTM teams. They do NOT have an agent, and that is precisely
//   what they are buying. Everything in TEAM runs on our Sonnet bill: Threads, the
//   routines, the briefs, Tasks, Skills. Sales-led, on Custom, priced against what
//   they actually burn.
//
// So the gate is not "a bigger plan unlocks more". It is "a different audience
// buys a different thing".
const GRAPH = {
  // The graph itself — every plan, including Free.
  activities: true,
  accounts: true,
  icp: true,
  graph: true,
  integrations: true,
  install: true,
  webhooks: true,
  // The Vault (icp, positioning, voice, messaging) and Adoption. Ungated 2026-07-14.
  // The Vault was Custom-only, which meant a Free user finished setup, produced an ICP,
  // and could never see or edit it again — the one artifact onboarding exists to create,
  // locked behind the paywall. Serving it is a deterministic Postgres read, the same
  // argument that makes retrieval free.
  foundations: true,
  adoption: true,
  // The intelligence under it. Deterministic or sub-cent Haiku, so it costs us
  // ~nothing and it is never a paywall. It is also the moat; charging for it would
  // be the Octave mistake.
  contextualization: true,
  icpScoring: true,
  linkedinEngagement: true,
  publicSignalExtraction: true,
  // Headless: on for every plan and reachable over the API and MCP, but no longer
  // product surface — no nav item, no plan bullet, no pricing line. The AIOS
  // prospecting skills write into lead lists, so the backend stays alive.
  // See internal/ONBOARDING.md §2.
  leadLists: true,
  crmSync: true,
};

const TEAM = {
  // Threads. The in-app agent runs Sonnet and is the single most expensive surface
  // we ship. That cost is the ENTIRE reason this block exists, and it is the only
  // principled line between a $99 plan and a sales call.
  inAppAgent: true,
  tasks: true,
  skills: true,
  ownPostgres: true,
  enterpriseIntegrations: true, // Salesforce · HubSpot · Slack
};

const TEAM_OFF = Object.fromEntries(Object.keys(TEAM).map(k => [k, false]));

/**
 * Integrations that only exist on the sales (Custom) plan. The named CRMs — Salesforce,
 * HubSpot and Attio — are where sales TEAMS live, so they gate to the sales plan; Slack
 * likewise. Pipedrive stays open: it is the CRM a self-serve operator actually runs, and
 * gating it would block the exact audience the free tier is FOR.
 */
export const CUSTOM_ONLY_INTEGRATIONS = new Set(['salesforce', 'hubspot', 'attio', 'slack']);

export const PLANS = {
  free: {
    id: 'free',
    name: 'Free',
    monthlyPriceUsd: 0,
    activeAccountsLimit: 100,
    includedOpsPerMonth: null, // retrievals unlimited — they cost us $0
    recordsLimit: null,        // unlimited — the graph is given away
    linkedinProfiles: 1,
    enrichmentsPerMonth: 0,
    workspaceLimit: 1,
    stripePriceEnv: null,
    // Adoption is Pro+ on Cloud (open on self-host — see usePlan/SELF_HOST_BLOCKED).
    features: { ...GRAPH, ...TEAM_OFF, adoption: false, supportTier: 'community' },
  },
  starter: {
    id: 'starter',
    name: 'Start',
    monthlyPriceUsd: 29,
    activeAccountsLimit: 500,
    includedOpsPerMonth: null,
    recordsLimit: null,
    linkedinProfiles: 1,
    enrichmentsPerMonth: 0,
    workspaceLimit: 1,
    stripePriceEnv: 'STRIPE_STARTER_PRICE_ID',
    // Adoption is Pro+ on Cloud (open on self-host).
    features: { ...GRAPH, ...TEAM_OFF, adoption: false, supportTier: 'email' },
  },
  pro: {
    id: 'pro',
    name: 'Pro',
    monthlyPriceUsd: 99,
    activeAccountsLimit: 2_500,
    includedOpsPerMonth: null,
    recordsLimit: null,
    linkedinProfiles: 3,
    enrichmentsPerMonth: 0,
    workspaceLimit: 5,
    stripePriceEnv: 'STRIPE_PRO_PRICE_ID',
    features: { ...GRAPH, ...TEAM_OFF, supportTier: 'priority' },
  },
  // Sales-led, and unpriced on purpose. The in-app agent runs Sonnet, which is the
  // one cost line we have never measured at team scale — so we sell it on a call,
  // watch what a real team actually burns (llm_usage), and price it against that
  // instead of guessing a number onto a public page and being wrong in whichever
  // direction hurts. This is where ICP II lives: teams that do NOT have an agent,
  // which is precisely what they are buying.
  custom: {
    id: 'custom',
    name: 'Custom',
    monthlyPriceUsd: null, // negotiated
    activeAccountsLimit: null, // unlimited
    includedOpsPerMonth: null,
    recordsLimit: null,
    linkedinProfiles: null,
    enrichmentsPerMonth: 0,
    workspaceLimit: null,
    stripePriceEnv: null,
    features: { ...GRAPH, ...TEAM, supportTier: 'priority' },
  },

  // ── Retired 2026-07-13 ──────────────────────────────────────────────────────
  // Growth ($249) and Partner ($500) are gone from the ladder: Partner was an
  // agency plan, and agencies are no longer the audience (we sell to internal GTM
  // and RevOps teams). They stay here ONLY so an existing subscription keying on
  // plan_id doesn't silently normalise to Free and lose its limits. Not sellable —
  // they are absent from SELLABLE_PLAN_IDS, and checkout must never offer them.
  growth: {
    id: 'growth',
    name: 'Growth (retired)',
    monthlyPriceUsd: 249,
    activeAccountsLimit: 25_000,
    includedOpsPerMonth: null,
    recordsLimit: null,
    linkedinProfiles: 5,
    enrichmentsPerMonth: 0,
    workspaceLimit: 3,
    retired: true,
    stripePriceEnv: 'STRIPE_GROWTH_PRICE_ID',
    features: { ...GRAPH, ...TEAM, supportTier: 'priority' },
  },
  scale: {
    id: 'scale',
    name: 'Partner (retired)',
    monthlyPriceUsd: 500,
    perWorkspaceUsd: 100,
    baseWorkspaces: 5,
    activeAccountsLimit: null, // grandfathered — don't restrict a paying legacy team
    includedOpsPerMonth: null,
    recordsLimit: null,
    linkedinProfiles: 5,
    enrichmentsPerMonth: 0,
    workspaceLimit: 5,
    retired: true,
    stripePriceEnv: 'STRIPE_SCALE_PRICE_ID',
    features: { ...GRAPH, ...TEAM, supportTier: 'priority' },
  },
};

export function normalizePlanId(input) {
  const s = typeof input === 'string' ? input.toLowerCase() : '';
  return PLAN_IDS.includes(s) ? s : 'free';
}

export function getPlan(planId) {
  return PLANS[normalizePlanId(planId)];
}

/**
 * Resolve a Supabase `subscriptions` row to a Plan.
 * Past_due/canceled/incomplete fall back to Free.
 */
export function getPlanFromSubscription(subscription) {
  if (!subscription) return PLANS.free;
  const status = subscription.status;
  if (status === 'canceled' || status === 'incomplete_expired' || status === 'past_due') {
    return PLANS.free;
  }
  return getPlan(subscription.plan_id ?? subscription.plan_name);
}

export function hasFeature(planId, feature) {
  const plan = getPlan(planId);
  const v = plan.features?.[feature];
  return typeof v === 'boolean' ? v : false;
}

/**
 * The team's real workspace allowance. Flat plans use the static plan limit
 * (null = unlimited). Per-client plans (Partner) use the purchased Stripe
 * quantity, floored at the base (so a Partner who bought 8 clients gets 8, not 5).
 */
export function effectiveWorkspaceLimit(plan, subscription) {
  if (plan.workspaceLimit === null) return null; // unlimited
  if (plan.perWorkspaceUsd) {
    const base = plan.baseWorkspaces ?? plan.workspaceLimit;
    const qty = Number(subscription?.quantity) || base;
    return Math.max(base, qty);
  }
  return plan.workspaceLimit;
}

/** True when self-hosted mode is active. Bypasses all gating + metering. */
export function isSelfHosted() {
  return process.env.SELF_HOSTED === 'true';
}

/**
 * Start of the current billing period for a subscription.
 * Uses Stripe's current_period_start when present; otherwise the calendar
 * month (free-plan users have no Stripe period — they reset on the 1st).
 */
export function periodStartFor(subscription) {
  if (subscription?.current_period_start) {
    return new Date(subscription.current_period_start);
  }
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/**
 * The op event_types that count toward the billed meter. Billing is RETRIEVAL
 * ONLY — the agent context pulls that deliver value: get_context, get_account,
 * query, attention. Every other op (writes/observations, scans, workspace
 * config, ingest) is still logged to workspace_system_log for visibility but is
 * NOT billed. Labels are the PATH_LABELS in middleware/opLogger.mjs.
 */
export const RETRIEVAL_EVENT_TYPES = ['v2.context', 'v2.account.get', 'v2.query', 'v2.attention'];

/**
 * Compute a team's RETRIEVAL usage for the current period off the live op log.
 * `used` = COUNT(workspace_system_log rows) since the period start whose
 * event_type is a retrieval (each retrieval row is billable_ops=1, so the count
 * equals the billed sum). Only retrievals are billed — see RETRIEVAL_EVENT_TYPES.
 * Writes, scans and ingest are logged but free.
 */
export async function getTeamOpsUsage(supabase, teamId, subscription) {
  const plan = getPlanFromSubscription(subscription);
  const periodStart = periodStartFor(subscription);

  const { data: workspaces } = await supabase
    .from('workspaces')
    .select('id')
    .eq('team_id', teamId);
  const wsIds = (workspaces ?? []).map((w) => w.id);

  let used = 0;
  if (wsIds.length) {
    const { count, error } = await supabase
      .from('workspace_system_log')
      .select('id', { count: 'exact', head: true })
      .in('workspace_id', wsIds)
      .in('event_type', RETRIEVAL_EVENT_TYPES)
      .gte('occurred_at', periodStart.toISOString());
    if (error) {
      console.error('[getTeamOpsUsage] retrieval count failed:', error.message);
    }
    used = count ?? 0;
  }
  // null on every plan now — retrievals are unlimited. Kept as a number for the
  // usage UI, which still shows "you made N retrievals this month" as a stat.
  const included = plan.includedOpsPerMonth;

  return {
    plan,
    used,
    included,
    remaining: included === null ? Infinity : Math.max(0, included - used),
    periodStart: periodStart.toISOString(),
  };
}

// ── Active accounts — THE meter ─────────────────────────────────────────────

/**
 * A team's active-account count, from the team_active_accounts() SQL function.
 *
 * Cumulative, not per-period: this is a STOCK, not a flow. The graph you hold is
 * the thing you pay for, and archiving an account is how you get back under the
 * cap (the record stays readable, it stops counting). So there is no periodStart
 * here and there shouldn't be.
 */
export async function getTeamActiveAccounts(supabase, teamId, subscription) {
  const plan = getPlanFromSubscription(subscription);

  const { data: workspaces } = await supabase
    .from('workspaces')
    .select('id')
    .eq('team_id', teamId);
  const wsIds = (workspaces ?? []).map((w) => w.id);

  // Self-host has no cap, and the reason is architectural rather than generous:
  // extraction runs on the operator's own ANTHROPIC_API_KEY, so their graph costs
  // us nothing to fill. There is no meter because there is no bill. We still COUNT
  // it, so the usage page can show them how big their graph has grown.
  if (isSelfHosted()) {
    let used = 0;
    if (wsIds.length) {
      const { data } = await supabase.rpc('team_active_accounts', { ws_ids: wsIds });
      used = Number(data) || 0;
    }
    return { plan, used, included: null, remaining: Infinity };
  }

  let used = 0;
  if (wsIds.length) {
    const { data, error } = await supabase.rpc('team_active_accounts', { ws_ids: wsIds });
    if (error) {
      // Fail OPEN. A metering bug must never take down live customer automation —
      // reporting 0 lets everything through, which is the safe direction to be
      // wrong in. Reporting a huge number would restrict a paying customer.
      console.error('[getTeamActiveAccounts] rpc failed:', error.message);
      used = 0;
    } else {
      used = Number(data) || 0;
    }
  }

  const included = plan.activeAccountsLimit; // null = unlimited

  return {
    plan,
    used,
    included,
    remaining: included === null ? Infinity : Math.max(0, included - used),
  };
}

/**
 * Active-account state + grace clock. Same shape as getTeamOpsState, own table
 * (team_accounts_grace) so the two meters never entangle.
 *
 *   'ok'          under the warn threshold
 *   'warn'        >= OPS_WARN_PCT of the cap, still under it
 *   'grace'       at/over the cap, within OPS_GRACE_DAYS of first crossing
 *   'restricted'  at/over the cap and the grace window expired
 *
 * 'restricted' gates PROACTIVE account creation only. Ingest is never blocked —
 * a reply from someone you already know still lands, and retrieval stays free in
 * every state, because it costs us nothing in every state.
 */
export async function getTeamAccountsState(supabase, teamId, subscription) {
  const usage = await getTeamActiveAccounts(supabase, teamId, subscription);
  const { used, included } = usage;

  if (included === null) {
    return { ...usage, percentUsed: 0, state: 'ok', graceUntil: null };
  }

  const percentUsed = included > 0 ? Math.round((used / included) * 100) : 0;
  const over = included > 0 && used >= included;

  const { data: graceRow } = await supabase
    .from('team_accounts_grace')
    .select('grace_started_at')
    .eq('team_id', teamId)
    .maybeSingle();
  let graceStartedAt = graceRow?.grace_started_at ? new Date(graceRow.grace_started_at) : null;

  if (!over) {
    // Back under (archived some accounts, or upgraded) — clear the stale clock so
    // the next crossing starts a fresh grace window rather than an expired one.
    if (graceStartedAt) {
      await supabase
        .from('team_accounts_grace')
        .upsert({ team_id: teamId, grace_started_at: null, updated_at: new Date().toISOString() });
      graceStartedAt = null;
    }
    return {
      ...usage,
      percentUsed,
      state: percentUsed >= OPS_WARN_PCT ? 'warn' : 'ok',
      graceUntil: null,
    };
  }

  if (!graceStartedAt) {
    const now = new Date();
    await supabase
      .from('team_accounts_grace')
      .upsert({ team_id: teamId, grace_started_at: now.toISOString(), updated_at: now.toISOString() });
    graceStartedAt = now;
  }

  const graceUntil = new Date(graceStartedAt.getTime() + OPS_GRACE_DAYS * DAY_MS);
  const restricted = Date.now() >= graceUntil.getTime();

  return {
    ...usage,
    percentUsed,
    state: restricted ? 'restricted' : 'grace',
    graceUntil: graceUntil.toISOString(),
  };
}

// ── Ops-limit enforcement (grace model) ─────────────────────────────────────
// Crossing the monthly ops allowance does NOT hard-block. The team gets a grace
// window; only after it expires (still over, not upgraded) do ACTIVE ops get
// restricted. Ingest (webhooks/pollers) is never gated. See access.mjs.
export const OPS_GRACE_DAYS = 3;
export const OPS_WARN_PCT = 80; // surface a "you're close" banner from here up.
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Derive a team's ops state and manage its grace clock (the single persisted
 * bit: `team_ops_grace.grace_started_at`).
 *
 * States:
 *   'ok'          under the warn threshold
 *   'warn'        >= OPS_WARN_PCT but still under the limit
 *   'grace'       at/over the limit, within OPS_GRACE_DAYS of first crossing
 *   'restricted'  at/over the limit and the grace window has expired
 *
 * Side effects (idempotent): stamps grace_started_at the moment usage first
 * crosses; clears it once usage drops back under (e.g. new billing period).
 */
export async function getTeamOpsState(supabase, teamId, subscription) {
  const usage = await getTeamOpsUsage(supabase, teamId, subscription);
  const { used, included } = usage;
  const percentUsed = included > 0 ? Math.round((used / included) * 100) : 0;
  const over = included > 0 && used >= included;

  const { data: graceRow } = await supabase
    .from('team_ops_grace')
    .select('grace_started_at')
    .eq('team_id', teamId)
    .maybeSingle();
  let graceStartedAt = graceRow?.grace_started_at ? new Date(graceRow.grace_started_at) : null;

  if (!over) {
    // Back under (or never over) — clear a stale clock so next crossing restarts it.
    if (graceStartedAt) {
      await supabase
        .from('team_ops_grace')
        .upsert({ team_id: teamId, grace_started_at: null, updated_at: new Date().toISOString() });
      graceStartedAt = null;
    }
    return {
      ...usage,
      percentUsed,
      state: percentUsed >= OPS_WARN_PCT ? 'warn' : 'ok',
      graceUntil: null,
    };
  }

  // Over the limit — start the clock on first crossing.
  if (!graceStartedAt) {
    const now = new Date();
    await supabase
      .from('team_ops_grace')
      .upsert({ team_id: teamId, grace_started_at: now.toISOString(), updated_at: now.toISOString() });
    graceStartedAt = now;
  }
  const graceUntil = new Date(graceStartedAt.getTime() + OPS_GRACE_DAYS * DAY_MS);
  const restricted = Date.now() >= graceUntil.getTime();
  return {
    ...usage,
    percentUsed,
    state: restricted ? 'restricted' : 'grace',
    graceUntil: graceUntil.toISOString(),
  };
}

/**
 * Count enrichments a team has run this period. Enrichment is its own metered
 * unit, NOT ops — each enrichment writes an `enrichment_run` row to the live
 * op log (with billable_ops=0), so we count those rows.
 */
export async function getTeamEnrichmentUsage(supabase, teamId, subscription) {
  const plan = getPlanFromSubscription(subscription);
  const periodStart = periodStartFor(subscription);

  const { data: workspaces } = await supabase
    .from('workspaces')
    .select('id')
    .eq('team_id', teamId);
  const wsIds = (workspaces ?? []).map((w) => w.id);

  let used = 0;
  if (wsIds.length) {
    const { count } = await supabase
      .from('workspace_system_log')
      .select('id', { count: 'exact', head: true })
      .in('workspace_id', wsIds)
      .eq('event_type', 'enrichment_run')
      .gte('occurred_at', periodStart.toISOString());
    used = count ?? 0;
  }
  const included = plan.enrichmentsPerMonth;

  return {
    used,
    included,
    remaining: Math.max(0, included - used),
    periodStart: periodStart.toISOString(),
  };
}

// ── Dead meters ─────────────────────────────────────────────────────────────
//
// Two meters have now been retired, for the same reason: each one billed
// something that costs us nothing.
//
//   RECORDS (getTeamRecordsUsage / team_records_grace) — removed earlier. A
//   2,000-lead import runs zero model calls. Storage is a rounding error: one
//   real workspace is ~1 GB against Supabase's 8 GB included.
//
//   RETRIEVALS (includedOpsPerMonth, RETRIEVAL_EVENT_TYPES) — retired 2026-07-13.
//   get_context / get_account / query / attention are deterministic Postgres
//   reads with no model in the path, so they are free to serve. And nobody came
//   close to the cap anyway: our own workspace made 311 retrievals in a month
//   against an allowance of 5,000. A meter at 6% utilisation prices nothing.
//
// getTeamOpsUsage and getTeamOpsState are KEPT and still called — the usage UI
// shows "N retrievals this month" as a stat, and requireOpsBalance still sits in
// the middleware chain. With includedOpsPerMonth: null on every plan, they now
// always report 'ok' and never restrict. Retrieval is free, in every state.
//
// The live meter is ACTIVE ACCOUNTS: getTeamActiveAccounts / getTeamAccountsState.
//
// team_records_grace is unused and can be dropped in a later migration.
