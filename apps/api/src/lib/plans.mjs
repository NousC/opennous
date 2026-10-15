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

import { AI_CREDIT_FEATURES, AI_TELEMETRY_FEATURES, costToCredits } from './llmUsage.mjs';
import { customPlanFor } from './customPlans.mjs';
import { cachedConversationCredits, conversationCredits } from '@nous/core';
import { backfillAllowanceForPlan } from './backfillBudget.mjs';
import { HAS_CLOUD } from './cloud.mjs';

export const PLAN_IDS = ['api', 'custom', 'free'];

// Every id we ever sold, pointed at the plan it became (GET-480). Live rows still carry
// these — dozens of workspaces on `free`, a few on `scale` and `starter` — so deleting the ids
// without a map would resolve real customers to the default and change what they can do.
// Nothing writes a legacy id any more; this exists so what is already written keeps
// meaning what it meant.
export const LEGACY_PLAN_IDS = {
  starter: 'api', pro: 'api', scale: 'api',
  // The operated family, including the retired middle plan. They bought the surface Custom
  // sells — the in-app agent, insights, tasks — so they resolve there rather than losing it.
  growth: 'custom', headless: 'custom', enterprise: 'custom', workspace: 'custom',
};

/**
 * The plans we sell (2026-09-07, tiers reset 2026-09-13 in GET-209), all metered on
 * ACTIVE ACCOUNTS:
 *   Free   — 100 accounts, where every new signup lands (auth.mjs).
 *   Pro    — 250 / 500 / 1,000 / 1,500 accounts at $49 / $99 / $149 / $199 (PRO_TIERS).
 *   Custom — sales-led, unlimited, the run-it-for-you team layer.
 * 'api' and 'headless' (the 07-31 two-plan model) are retired along with starter / growth /
 * scale — kept resolvable so an existing subscription never falls back to Free.
 */
/**
 * THE FOUR PLANS (2026-09-23). Everything a customer sees is one of these names:
 *
 *   Starter   $29   self-serve. 1,000 credits, 1 workspace. Bring your own agent.
 *   Pro       $79   self-serve. 5,000 credits, 5 workspaces. Account + call summaries.
 *   Scale     $199  self-serve. 15,000 credits, unlimited workspaces. Scoring + coaching.
 *   Workspace  —    sales-led. We operate the engine. Unlimited everything, base + seats.
 *
 * The IDS below are older than the names and are deliberately NOT being renamed yet: a plan
 * id is written into Stripe metadata, subscription rows and every team's record, so moving
 * one is a migration, not an edit. Until that migration, an id is an alias of a plan:
 *
 *   starter ← api, starter            scale ← scale
 *   pro     ← pro                     workspace ← headless, custom, growth, enterprise
 *
 * FREE IS A PLAN AGAIN (GET-682, reversing GET-532). A new signup lands on Free: the CRM import,
 * new conversations read from today up to 500 credits a month (a hard stop, no overage), one
 * automation, and NO history backfill — that runs the moment they pay. It is not sold: nobody
 * checks out for $0, so it is absent from SELLABLE_PLAN_IDS.
 */
export const PLAN_FAMILY = {
  // Two families, because there are two plans. The retired ids keep resolving to the family
  // they were sold as, so an error message never names a plan we no longer offer.
  api: 'Self-serve', starter: 'Self-serve', pro: 'Self-serve', scale: 'Self-serve',
  custom: 'Workspace', headless: 'Workspace', growth: 'Workspace', enterprise: 'Workspace',
  workspace: 'Workspace',
  free: 'Free',
};

/** What to call this plan in front of a customer. One of the four, or the lapsed state. */
export function planName(planId) {
  return PLAN_FAMILY[String(planId ?? '').toLowerCase()] ?? 'Trial ended';
}

/**
 * HOW MANY AUTOMATIONS a workspace may keep enabled, by plan. null = unlimited.
 *
 * This is a COUNT, not a capability: what an automation may MAKE is gated separately, by
 * artifact, because an operator writing their own prompt should not be stopped by a ladder
 * built for the presets. Two guard rails doing two jobs — this one caps how much runs without
 * you, and the credit allowance caps how often it runs.
 *
 * It does NOT vary by bundle. Self-serve is one plan at five volumes; making the count climb
 * with the price would turn a volume ladder back into a feature ladder, which is the thing we
 * just removed. Five is the count, and what they cost is already metered.
 */
export const AUTOMATION_LIMIT = { 'Self-serve': 5, Free: 1, Workspace: null, 'Trial ended': 0 };

/** The artifacts a plan may choose from. Custom (your own prompt) is on every plan. */
export const ARTIFACTS_BY_PLAN = {
  'Self-serve': ['account_summary', 'call_summary'],
  Free:         ['account_summary', 'call_summary'],
  Workspace:    ['account_summary', 'call_summary', 'call_score'],
  'Trial ended': [],
};

/** How many automations this plan id may have, on or off. null = unlimited. */
export function automationLimit(planId) {
  const family = planName(planId);
  return family in AUTOMATION_LIMIT ? AUTOMATION_LIMIT[family] : 0;
}

/** Whether this plan id may build an automation that makes `artifact`. */
export function canMakeArtifact(planId, artifact) {
  if (!artifact) return true;                    // custom — your prompt, every plan
  return (ARTIFACTS_BY_PLAN[planName(planId)] ?? []).includes(artifact);
}

export const SELLABLE_PLAN_IDS = ['api', 'custom'];

/**
 * Per-plan HISTORY BACKFILL WINDOW, in days — how far back a backfill READS conversations
 * (emails, meetings, calls). Three months on every plan (GET-514): the CRM import reaches twelve
 * months of records, but those are imported, not read; tasks come only from the last thirty days
 * (writesTasks in packages/core/src/services/meetingPolicy.ts). Enforced in the worker's history
 * enricher (apps/worker/src/services/contactHistoryEnricher.mjs), which keeps its own copy —
 * KEEP THE TWO IN SYNC. null = unlimited (self-host).
 */
export const BACKFILL_WINDOW_DAYS = {
  api: 90,
  custom: 90,
};

/** The backfill cutoff (ms epoch) for a plan id, or null = no limit. */
export function backfillCutoffMsForPlan(planId) {
  const days = BACKFILL_WINDOW_DAYS[normalizePlanId(planId)];
  if (!days) return null;
  return Date.now() - days * 86_400_000;
}

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
  // The learned ICP scorer. Every plan has it on Cloud; an open-source build has no learned
  // scorer at all (GET-754 slice 8, lib/icpScorer.mjs), whatever this flag says.
  icpScoring: true,
  // Revenue forecasting. Same argument as icpScoring above and held to the same line:
  // it is pure arithmetic over the workspace's own pipeline, no model and no LLM call,
  // so it costs us nothing to serve and putting it behind a paywall would be the Octave
  // mistake again. The flag exists so this is a one-line decision to revisit rather than
  // a code change: set it false on the plans that should not have it.
  forecasting: true,
  linkedinEngagement: true,
  publicSignalExtraction: true,
  // Headless: on for every plan and reachable over the API and MCP, but no longer
  // product surface — no nav item, no plan bullet, no pricing line. The AIOS
  // prospecting skills write into lead lists, so the backend stays alive.
  // See internal/ONBOARDING.md §2.
  leadLists: true,
  crmSync: true,
  // Tasks and Automations joined the graph 2026-09-23 (GET-426). Neither draws the Sonnet
  // bill the team layer exists to price: a task is a claim the extractor already wrote, and
  // an automation is a trigger plus a template. Keep in step with GRAPH_ON in plans.ts.
  tasks: true,
  automations: true,
  revboxes: false,
};

const TEAM = {
  // Threads. The in-app agent runs Sonnet and is the single most expensive surface
  // we ship. That cost is the ENTIRE reason this block exists, and it is the only
  // principled line between a $99 plan and a sales call.
  inAppAgent: true,
  skills: true,
  ownPostgres: true,
  slack: true, // the Slack connector. HubSpot and Salesforce connect on every plan (GET-517, GET-576).
};

const TEAM_OFF = Object.fromEntries(Object.keys(TEAM).map(k => [k, false]));

// What the API plan does not have. GRAPH turned tasks and automations on for everyone in
// GET-426, on the argument that neither needs the in-app agent — true of the cost, not of
// the product: a task list and an automations builder are the app doing the work for you,
// which is what Workspace sells.
const API_TIER_OFF = {
  // Insights (GET-522) and automations (GET-523) are ON for self-serve now. Extraction
  // already runs on every plan, so the insight board is a READ of what we produced; and an
  // automation is a schedule over the same reads, which is the thing an operator running their
  // own agent most wants us to hold. Tasks stay off: a worklist is the app deciding what you
  // should do next, which is what Custom sells. That worklist is the Inbox, so no Inbox either (GET-908).
  tasks: false,
};

/**
 * Integrations gated to the team plans. Only Slack now: the CRMs were gated here too, which left
 * the API plan unable to connect the one tool its onboarding starts with (GET-517).
 */
// The CRMs are open to every plan (GET-517): connecting one is the first onboarding step on the
// API plan as much as on Workspace. Slack stays a team integration.
export const CUSTOM_ONLY_INTEGRATIONS = new Set(['slack']);

export const PLANS = {
  // ── API — $99. Bring your own agent. We read the tools and resolve the graph; the
  //    operator works the result in Claude Code, Codex or their own runner. No in-app
  //    agent, no insights, tasks or automations: those are the app doing the work for
  //    you, which is what Workspace sells. 2,000 credits a month (GET-480). ──
  api: {
    id: 'api',
    name: 'Nous',
    // The ENTRY bundle. Self-serve is one plan at five volumes, so the real price and
    // allowance come from the tier the subscription's Stripe price names — see
    // SELF_SERVE_TIERS and getPlanFromSubscription. These two are the floor.
    monthlyPriceUsd: 49,
    aiCreditsPerMonth: 960,
    memberLimit: null,          // metered by credits, not seats
    activeAccountsLimit: 10_000, // abuse backstop, not a tier
    includedOpsPerMonth: null,
    recordsLimit: null,
    linkedinProfiles: 3,
    enrichmentsPerMonth: 0,
    workspaceLimit: 5,
    stripePriceEnv: 'STRIPE_SELF_SERVE_49_PRICE_ID',
    // No RevBoxes on the API plan (GET-908): a box of jobs is the app doing the work, which Workspace sells.
    features: { ...GRAPH, ...TEAM_OFF, ...API_TIER_OFF, insights: true, supportTier: 'priority' },
  },

  // ── Free — $0 (GET-682). The self-serve product with a small, hard allowance: new
  //    conversations from today, 500 credits a month, and no history backfill until they pay.
  //    About $4 a month of model work at the worst case. ──
  free: {
    id: 'free',
    name: 'Free',
    monthlyPriceUsd: 0,
    aiCreditsPerMonth: 500,
    hardCreditCap: true,        // a stop at 500, not the 120% band
    memberLimit: null,
    activeAccountsLimit: 10_000,
    includedOpsPerMonth: null,
    recordsLimit: null,
    linkedinProfiles: 1,
    enrichmentsPerMonth: 0,
    workspaceLimit: 1,
    stripePriceEnv: null,
    features: { ...GRAPH, ...TEAM_OFF, ...API_TIER_OFF, insights: true, supportTier: 'standard' },
  },

  // ── Custom — quoted against the account's own volume, and shaped per account.
  //    Anything past Workspace's 5,000 credits lands here; a heavy workspace can use several times that a month.
  //    No hard credit cap on purpose: cutting off a contract customer's agent mid-month
  //    over an allowance is a conversation, not a 402. The number makes spend VISIBLE
  //    before it makes it billable. ──
  custom: {
    id: 'custom',
    name: 'Custom',
    monthlyPriceUsd: null,      // negotiated
    aiCreditsPerMonth: null,    // unlimited — priced into the contract
    memberLimit: null,
    activeAccountsLimit: null,
    includedOpsPerMonth: null,
    recordsLimit: null,
    linkedinProfiles: null,
    enrichmentsPerMonth: 0,
    workspaceLimit: null,
    stripePriceEnv: null,
    // RevBoxes are Workspace only (GET-864, GET-908).
    features: { ...GRAPH, ...TEAM, insights: true, revboxes: true, supportTier: 'priority' },
  },
};

export function normalizePlanId(input) {
  const s = typeof input === 'string' ? input.toLowerCase() : '';
  if (PLAN_IDS.includes(s)) return s;
  // A retired id still in the database resolves to what it became, not to the default.
  return LEGACY_PLAN_IDS[s] ?? 'api';
}

// ── The three plans, as the product sells them ───────────────────────────────
//
// Mirrors planTier() in apps/frontend/src/config/plans.ts. The app used to split two ways
// across nine billing ids; the product is now three plans — API $99, Workspace $249 and
// Custom — and the surfaces key off THESE rather than off the ids.
//
// The nine ids stay as they are. Renaming them is a billing migration; this is a product
// shape. When GET-457 reconciles the code with the pricing page, this map and its frontend
// twin are the two places to edit, and they must move together.
const TIER_BY_PLAN_ID = {
  api: 'api', custom: 'custom',
  // Free is the self-serve surface at a small allowance (GET-682).
  free: 'api',
};

/** Which of the two plans this is: 'api' (self-serve, any volume) | 'custom'. */
export function planTier(planOrId) {
  const id = (planOrId && typeof planOrId === 'object' && 'id' in planOrId) ? planOrId.id : planOrId;
  return TIER_BY_PLAN_ID[normalizePlanId(id)] ?? 'api';
}

/** The API plan: no in-app agent, no insights, tasks or automations. */
export function isApiTier(planOrId) {
  return planTier(planOrId) === 'api';
}

export function getPlan(planId) {
  return PLANS[normalizePlanId(planId)];
}

/**
 * Resolve a Stripe price id back to our plan id, using the env-configured price of
 * each plan (stripePriceEnv). This is the SOURCE OF TRUTH for what a subscription is
 * on, because the Stripe price is what actually gets billed. The webhook prefers this
 * over subscription.metadata.plan_id — metadata is only set at our checkout and does
 * NOT change when a customer switches plans in the Stripe Customer Portal, so trusting
 * metadata would leave plan_id stuck on the old plan after a portal change.
 * Returns null when no plan's configured price matches (caller falls back to metadata).
 */
export function planIdFromPriceId(priceId) {
  if (!priceId) return null;
  for (const id of PLAN_IDS) {
    const envName = PLANS[id]?.stripePriceEnv;
    if (envName && process.env[envName] && process.env[envName] === priceId) return id;
  }
  return null;
}

/**
 * Resolve a Supabase `subscriptions` row to a Plan. There are two: the self-serve plan, sold
 * at five volumes, and Custom. A dead subscription resolves to self-serve, which is the floor
 * of the product rather than a free tier — what it can actually READ is decided by the
 * allowance, and `needsPlan` takes that to zero for a workspace that has not bought one.
 */

/**
 * A workspace that has never bought a bundle (GET-532).
 *
 * A new signup is written 'unpaid' and stays there until a Stripe subscription exists. It is
 * NOT the same as a dead subscription — older rows on status 'active' with no Stripe id
 * predate this, and closing them is a business decision, not a side effect of this predicate.
 */
export function needsPlan(subscription) {
  if (!subscription) return true;
  if (subscription.stripe_subscription_id) return false;
  return subscription.status === 'unpaid';
}

/**
 * How long a failed payment keeps working (GET-539). Cards decline for reasons that have
 * nothing to do with intent — an expiry, a bank's fraud heuristic, a travel block — and Stripe
 * retries over about two weeks. Cutting at the first decline punishes the wrong people; seven
 * days from the failure is long enough for a retry to land and short enough that nobody reads a
 * month for free on a dead card.
 *
 * FROM THE FAILURE, NOT THE PERIOD (GET-698). A renewal invoice fails AFTER Stripe has already
 * advanced current_period_end a month, so "seven days past the period end" was about five weeks.
 * The webhook stamps `past_due_since` on the first failure (pastDueSincePatch); a row without
 * it (the column not migrated yet, or a status written before the stamp existed) falls back to
 * the period end, which is the old behaviour.
 */
export const PAST_DUE_GRACE_DAYS = 7;

/**
 * IS THIS WORKSPACE PAYING? (GET-539)
 *
 * The one question underneath all of it: a workspace reads while it is paying and stops when it
 * is not. Cancel, let a card fail, never subscribe — the answer is the same, and so is the
 * behaviour, because three different ways of stopping should not be three different bugs.
 *
 *   comped            → live. We decided to carry them.
 *   active / trialing → live.
 *   past_due          → live for PAST_DUE_GRACE_DAYS past the period that was paid for.
 *   canceled, unpaid, incomplete, incomplete_expired → not live.
 *
 * A row with no subscription at all is not live either. The handful of accounts on 'active' with
 * no Stripe id stay live on purpose — closing them is a business decision, not a predicate's.
 */
export function planIsLive(subscription, now = Date.now()) {
  if (!subscription) return false;
  if (subscription.is_comp) return true;
  const status = subscription.status;
  if (status === 'active' || status === 'trialing' || status === 'trial') return true;
  if (status === 'past_due') {
    const from = pastDueGraceFrom(subscription);
    // No date to grace from is not a reason to keep reading for nothing.
    if (!Number.isFinite(from)) return false;
    return now <= from + PAST_DUE_GRACE_DAYS * 86_400_000;
  }
  return false;
}

/** When a past_due grace started (ms epoch): the stamped failure, else the period end. NaN when neither. */
function pastDueGraceFrom(subscription) {
  const since = subscription?.past_due_since ? Date.parse(subscription.past_due_since) : NaN;
  if (Number.isFinite(since)) return since;
  return subscription?.current_period_end ? Date.parse(subscription.current_period_end) : NaN;
}

/** When a failed card stops reading (ISO), or null when the subscription is not in grace. */
export function pastDueGraceUntil(subscription, now = Date.now()) {
  if (subscription?.status !== 'past_due' || subscription?.is_comp || !planIsLive(subscription, now)) return null;
  return new Date(pastDueGraceFrom(subscription) + PAST_DUE_GRACE_DAYS * 86_400_000).toISOString();
}

/**
 * The `past_due_since` write that goes with a status (GET-698): stamped on the first failure and
 * kept through Stripe's retries, cleared once the subscription is anything else. Returns the patch
 * and the filter it needs, so the webhook can apply it as its own update — the column may not be
 * migrated yet, and a missing column must never fail the status write itself.
 */
export function pastDueSincePatch(status, now = new Date()) {
  return status === 'past_due'
    ? { patch: { past_due_since: now.toISOString() }, onlyIfNull: true }
    : { patch: { past_due_since: null }, onlyIfNull: false };
}

/**
 * MAY THIS WORKSPACE RUN A HISTORY BACKFILL? (GET-682) Reading and backfilling used to be one
 * question. Free reads new conversations but its history waits until it pays, so they are two:
 * live AND paid (or comped). Billing-off deployments are answered by the caller.
 */
export function planMayBackfill(subscription) {
  if (!planIsLive(subscription)) return false;
  if (subscription?.is_comp) return true;
  return normalizePlanId(subscription?.plan_id) !== 'free';
}

/** Why a workspace is not reading, for the message it gets. Null when it is. */
export function notLiveReason(subscription) {
  if (planIsLive(subscription)) return null;
  if (needsPlan(subscription)) return 'no_plan';
  const status = subscription?.status;
  if (status === 'past_due') return 'payment_failed';
  if (status === 'canceled' || subscription?.cancel_at_period_end) return 'canceled';
  return 'no_plan';
}
// SELF-SERVE IS ONE PLAN SOLD AT FIVE VOLUMES (GET-520).
//
// Two things to buy: this ladder, and a Custom quote. The old middle plan is gone — it sold a
// different PRODUCT at a higher price, which meant a customer outgrowing their credits had to
// change what they were using in order to buy more of it. Now volume is the only axis below
// Custom: every tier is the same surface, and the bundle is the decision.
//
// SIZED AT AN 80% FLOOR against what a credit ACTUALLY COSTS on this surface: $0.0167 per
// CONVERSATION measured on one customer's current period with insights and automations running,
// halved to $0.00835 per credit by the denomination (CREDIT_SCALE = 2 in packages/core). That number is not the cost of the
// read — it is every model call the API surface makes divided by the credits it bills, which
// is the only honest denominator, because extraction and topic work bill nothing and still
// arrive on our invoice. Custom carries more ($0.0199) because the operated features —
// scoring, the insight board, clustering, the in-app agent — run there and bill nothing either.
//
// After Stripe's 2.9% + 30¢ that lands the ladder at a nearly flat ~7.7¢ a credit. Model cost
// scales linearly with credits and Stripe takes a fixed share, so there is no room for a volume
// discount without going through the floor. One rate, pick your bundle.
//
// The env name carries the PRICE, so re-sizing a bundle (900 → 1,000 at $49) is an env swap
// onto the same Stripe price rather than a new one.
export const SELF_SERVE_TIERS = [
  { credits: 960,    priceUsd: 49,  priceEnv: 'STRIPE_SELF_SERVE_49_PRICE_ID' },
  { credits: 2_000,  priceUsd: 99,  priceEnv: 'STRIPE_SELF_SERVE_99_PRICE_ID' },
  { credits: 4_000,  priceUsd: 199, priceEnv: 'STRIPE_SELF_SERVE_199_PRICE_ID' },
  { credits: 6_000,  priceUsd: 299, priceEnv: 'STRIPE_SELF_SERVE_299_PRICE_ID' },
  { credits: 10_000, priceUsd: 499, priceEnv: 'STRIPE_SELF_SERVE_499_PRICE_ID' },
];
/** The entry tier — what a subscription with no recognisable price falls back to. */
export const ENTRY_TIER = SELF_SERVE_TIERS[0];
/** The self-serve tier for a credit allowance (defaults to the entry tier). */
export function tierForCredits(credits) {
  const n = Number(credits) || 0;
  return SELF_SERVE_TIERS.find((t) => t.credits === n) || ENTRY_TIER;
}
/** The next bundle up from an allowance, or null at the top of the ladder. */
export function nextTierAfter(credits) {
  const n = Number(credits) || 0;
  return SELF_SERVE_TIERS.find((t) => t.credits > n) ?? null;
}

/** The self-serve tier a Stripe price id belongs to (null if not one of ours). */
export function tierForPriceId(priceId) {
  if (!priceId) return null;
  return SELF_SERVE_TIERS.find((t) => process.env[t.priceEnv] === priceId) || null;
}

export function getPlanFromSubscription(subscription) {
  // No subscription, a dead one, or a lapsed trial all land on API — the entry plan, and
  // since GET-480 the floor of the product rather than a separate Free tier. Everything
  // above it is a paid surface, so falling to API is the safe direction.
  if (!subscription) return PLANS.api;
  const status = subscription.status;
  if (status === 'canceled' || status === 'incomplete_expired') return PLANS.api;
  // A failed card inside its grace keeps WHAT IT BOUGHT (GET-698). It used to fall to the bare
  // entry plan here, so a $499 / 10,000-credit customer was held to 960 during the grace week
  // and stopped with an upgrade message when the fix was their card. Past the grace it is not
  // live, and lands on the floor like any other workspace that stopped paying.
  if (status === 'past_due' && !planIsLive(subscription)) return PLANS.api;
  return withTier(getPlan(subscription.plan_id ?? subscription.plan_name), subscription);
}

/**
 * Self-serve is one plan at five volumes, so WHICH volume is a property of the subscription,
 * not of the plan. The Stripe price the customer is actually billed on decides it — the same
 * rule planIdFromPriceId follows, and for the same reason: a price is what they pay, and it is
 * the one thing that changes when they move up or down.
 *
 * A subscription on a price we do not recognise keeps the plan's own (entry) numbers rather
 * than inventing an allowance. Every other plan passes through untouched.
 */
function withTier(plan, subscription) {
  if (plan?.id !== 'api') return plan;
  const tier = tierForPriceId(subscription?.stripe_price_id);
  if (!tier) return plan;
  return { ...plan, monthlyPriceUsd: tier.priceUsd, aiCreditsPerMonth: tier.credits };
}

/**
 * Pre-revenue: there is no paywall. We are building the product and nobody is
 * paying for it, so every feature is on for every plan.
 *
 * The per-plan `features` maps above are deliberately left INTACT — set PAYWALL
 * back to true and per-plan gating is live again with no other change anywhere.
 * Both `requireFeature` (the Express middleware) and `assertFeature` (the
 * in-handler check) route through hasFeature, so this is the single switch.
 *
 * NOT affected, on purpose:
 *  - CLOUD_ONLY_FEATURES in access.mjs — a self-host/cloud boundary, not a price.
 *  - requireOpsBalance — already a no-op, every plan has includedOpsPerMonth: null.
 */
const PAYWALL = false;

export function hasFeature(planId, feature) {
  if (!PAYWALL) return true;
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

/**
 * The team's member (seat) allowance for a plan. null = unlimited. Starter is a
 * single-operator plan (memberLimit: 1) — no teammate invites. Self-host is unlimited
 * (it bypasses all gating). Enforced at invite-create in routes/api/teams.mjs.
 */
export function effectiveMemberLimit(plan) {
  if (isSelfHosted()) return null;
  return plan?.memberLimit ?? null;
}

/**
 * True when self-hosted mode is active. Bypasses all gating + metering.
 * An open-source build (no src/cloud/, GET-754) is always self-hosted, whatever the env says.
 */
export function isSelfHosted() {
  return process.env.SELF_HOSTED === 'true' || !HAS_CLOUD;
}

/**
 * Start of the current billing period for a subscription.
 *
 * A period that is still running (current_period_end in the future — Stripe rewrites
 * both on every renewal) is the truth. A hand-assigned plan (Custom, comp) never gets a
 * renewal written, so its current_period_start is frozen at the day it was assigned:
 * reading it raw made "this month's" credits a running total since that day, and a
 * Custom team's 2,000/month allowance a lifetime cap (OpenNous WS: counting from
 * 2026-04-19). Those roll the anchor forward month by month, so the allowance resets on
 * the same day each month. No period at all (Free) resets on the 1st.
 */
export function periodStartFor(subscription, now = new Date()) {
  const anchor = subscription?.current_period_start ? new Date(subscription.current_period_start) : null;
  if (!anchor || Number.isNaN(anchor.getTime())) {
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  }
  const end = subscription?.current_period_end ? new Date(subscription.current_period_end) : null;
  if (end && end.getTime() > now.getTime()) return anchor;
  if (anchor.getTime() > now.getTime()) return anchor;
  // Whole months from the anchor to now, clamping the day for short months (Jan 31 → Feb 28).
  const plusMonths = (n) => {
    const y = anchor.getUTCFullYear();
    const m = anchor.getUTCMonth() + n;
    const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    const d = new Date(anchor);
    d.setUTCFullYear(y, m, Math.min(anchor.getUTCDate(), lastDay));
    return d;
  };
  let n = (now.getUTCFullYear() - anchor.getUTCFullYear()) * 12 + (now.getUTCMonth() - anchor.getUTCMonth());
  while (n > 0 && plusMonths(n).getTime() > now.getTime()) n--;
  return plusMonths(Math.max(0, n));
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

// ── Revenue-agent credits — the model-spend meter ───────────────────────────
//
// The active-account meter above bills the graph you hold (a stock). This bills
// the model tokens the revenue agent burns answering you (a flow) — the one part
// of the product with a real per-use cost. It mirrors getTeamOpsUsage: summed
// over the current billing period, reset each cycle, unlimited on the plans that
// run on our contract (Headless/Custom) or the customer's own key (self-host).
//
// The sum comes from a scalar SQL function, not a row fetch, so a busy team's
// 1,000th turn in a period still counts — a PostgREST row cap here would silently
// under-bill and let spend run past the cap.

// THE OVERAGE BAND (GET-525). Credits are a monthly allowance, not a wallet, so running out is
// not a wall you buy your way past — there are no packs. What happens instead is a band:
//
//   < 90%    ok          nothing said
//   90–99%   warn        "you are close", in the app and once by email
//   100–119% over        STILL RUNNING. Told once by email that they are over, and by how much.
//   >= 120%  restricted  stopped, and the way forward is the next bundle up
//
// Twenty per cent of room on top of the allowance, because the alternative is cutting someone
// off mid-month over a number they cannot see coming — and because a team that reads 20% more
// than they bought has outgrown the bundle, which is a sale, not a failure.
export const AI_CREDITS_WARN_PCT = 90;
export const AI_CREDITS_GRACE_PCT = 120;

/** ok | warn | over | restricted, from percent-used. `enforced` false never reaches restricted. */
export function creditState(percentUsed, { enforced = true } = {}) {
  const pct = Number(percentUsed) || 0;
  if (enforced && pct >= AI_CREDITS_GRACE_PCT) return 'restricted';
  if (pct >= 100) return 'over';
  if (pct >= AI_CREDITS_WARN_PCT) return 'warn';
  return 'ok';
}

/**
 * A team's credit state for the current period.
 * `used` = conversations read since period start (conversationCredits): a thread, a call, 10 min of a meeting.
 * `included: null` = unlimited (Headless, Custom, self-host, billing-off) — never blocks.
 * Fails OPEN: a metering error reports 0 used, which lets answers through — a billing bug
 * must never take down a customer's agent. The exception is a HARD CAP: a plan flagged
 * `hardCreditCap` enforces it even when billing is off, so a self-serve workspace cannot burn
 * unlimited credits on a deployment with no Stripe key.
 */
/**
 * When each backfill ran, as windows a read can fall in (GET-515): from its start to when it
 * finished, at most 30 days. Reads inside one are backfill credits, never the month's. One
 * definition for the meter and the billing page's chart (GET-733), so they cannot disagree.
 */
export async function backfillWindowsFor(supabase, wsIds) {
  if (!wsIds?.length) return [];
  const { data: jobs } = await supabase.from('contact_enrichment_jobs')
    .select('state, done, updated_at').in('workspace_id', wsIds)
    .not('state->>started_at', 'is', null);
  return (jobs ?? []).map(j => {
    const from = j.state.started_at;
    const cap = Date.parse(from) + 30 * 86400000;
    const end = j.done ? Date.parse(j.updated_at) : Date.now();
    return { from, to: new Date(Math.min(cap, end)).toISOString() };
  });
}

export async function getTeamAiCredits(supabase, teamId, subscription) {
  const plan = getPlanFromSubscription(subscription);
  const periodStart = periodStartFor(subscription);

  // NO TRIAL (GET-532). Two things exist: a credit bundle and a quote. A workspace that has
  // not bought a bundle has no allowance — see `needsPlan` — rather than a smaller one on a
  // clock, because a clock is a third thing and this product does not have one.
  const periodCap = planIsLive(subscription) ? plan.aiCreditsPerMonth : 0;

  // HARD CAP — enforced even when billing is off, so a self-serve workspace cannot burn
  // unlimited credits on a deployment with no Stripe key. Self-host is exempt (the operator's
  // own key) and a quote has no cap (periodCap null).
  const hardCap = periodCap != null && !isSelfHosted() && plan.hardCreditCap === true;

  // Unlimited (never blocks): self-host (operator's own key), contract plans with no credit
  // cap (Headless/Custom/Enterprise), or an instance that isn't billing at all (no Stripe /
  // BILLING_ENABLED=false) — a billing glitch must never take down a customer's agent. The
  // hard cap is the exception to billing-off.
  const billingOff = process.env.BILLING_ENABLED === 'false' || !process.env.STRIPE_SECRET_KEY;
  const unlimited = !hardCap
    && (isSelfHosted() || billingOff || plan.aiCreditsPerMonth == null);

  const { data: workspaces } = await supabase
    .from('workspaces')
    .select('id')
    .eq('team_id', teamId);
  const wsIds = (workspaces ?? []).map((w) => w.id);

  // ONE CREDIT PER CONVERSATION READ (GET-503) — an email thread, a call, ten minutes of a
  // meeting — over the current billing period. Not model spend: that is what this used to sum
  // ($0.02 a credit, whatever caused it), which billed insights, scoring and the agent, charged
  // a skipped thread its classifier and disagreed with the Activity ledger and the pricing page.
  // Background work is part of the plan. See packages/core/src/db/conversationCredits.ts.
  // THE BACKFILL IS NOT THE MONTH'S (GET-515). Reads made while a backfill ran are backfill
  // credits: shown apart on the billing page against the plan's backfill allowance, and never
  // counted here. Shown for good, not for thirty days (GET-557): it is what onboarding spent.
  const backfillWindows = await backfillWindowsFor(supabase, wsIds);
  const backfillStartedAt = backfillWindows.reduce((m, w) => (!m || w.from < m ? w.from : m), null);

  let used = 0;
  let backfillUsed = 0;
  // Whether the count failed and `used` is the fail-open 0 rather than a measurement. The worker's
  // gate treats such an answer as no answer, so a known-exhausted hard cap stays shut (GET-700).
  let meterError = false;
  if (wsIds.length) {
    try {
      // A HARD CAP COUNTS FRESH (GET-700). The cached count may be ten minutes old, and on a plan
      // that stops at its allowance ten minutes of reading is the difference between a stop and
      // an overshoot. A hard-cap workspace reads at most a few hundred conversations a month, so
      // the live count is small.
      const c = hardCap
        ? await conversationCredits(supabase, wsIds, periodStart.toISOString(), null, backfillWindows)
        : await cachedConversationCredits(supabase, wsIds, periodStart.toISOString(), backfillWindows);
      used = c.total;
      backfillUsed = c.backfill;
      // A backfill from an earlier period still has its total (GET-557).
      if (backfillStartedAt && backfillStartedAt < periodStart.toISOString()) {
        backfillUsed = (await cachedConversationCredits(supabase, wsIds, backfillStartedAt, backfillWindows)).backfill;
      }
    } catch (err) {
      // Fail open — see the note above.
      console.error('[getTeamAiCredits] conversation count failed:', err?.message);
      used = 0;
      meterError = true;
    }
  }

  // ── API plan: a monthly subscription allowance, like every other plan ──
  // It used to be a prepaid wallet (grants − all-time spend) while the page said "this month".
  // Pricing is purely a subscription: 2,000 credits a month (250 on the trial), reset each period.
  // Enforced — the API plan is the self-serve tier — except on self-host.
  if (plan.id === 'api' || plan.id === 'free') {
    // Not paying, however it happened: never subscribed, canceled, or a card that failed past
    // its grace. One state, one behaviour.
    const stopped = !planIsLive(subscription);
    // Free stops AT its allowance (GET-682): 500 is the whole of it, with no band above.
    const freeStop = plan.id === 'free' && !stopped && used >= (periodCap ?? 0);
    const stoppedReason = notLiveReason(subscription);
    // A failed card still inside its grace (GET-698): reading carries on at the plan they bought,
    // and the thing to say is "update your card" — never "upgrade".
    const graceUntil = pastDueGraceUntil(subscription);
    const cap = periodCap ?? 0;
    const remainingApi = Math.max(0, cap - used);
    // NOT capped at 100 any more: the band above 100 is the point, and a page that cannot show
    // 112% cannot tell someone how far into it they are.
    const pctApi = cap ? Math.round((used / cap) * 100) : 0;
    return {
      plan, used, included: cap,
      // Credits left before reading STOPS (GET-700): the allowance itself on a hard cap, the top
      // of the band (120%) otherwise. What the worker caps a batch to. Null when nothing stops.
      hardCap,
      untilStop: isSelfHosted() ? null : Math.max(0, (hardCap ? cap : Math.ceil(cap * AI_CREDITS_GRACE_PCT / 100)) - used),
      meterError,
      remaining: remainingApi, unlimited: isSelfHosted(), percentUsed: pctApi,
      state: isSelfHosted() ? 'ok' : (stopped || freeStop) ? 'restricted' : creditState(pctApi),
      // Not paying: the offer is the entry bundle, not the next one up from zero.
      needsPlan: stopped,
      notLiveReason: stoppedReason,
      paymentFailed: !!graceUntil,
      graceUntil,
      // Free: the offer is the first paid bundle, which also runs the history backfill.
      free: plan.id === 'free',
      nextTier: (stopped || plan.id === 'free') ? ENTRY_TIER : nextTierAfter(cap),
      periodStart: periodStart.toISOString(),
      backfill: backfillState(plan, backfillStartedAt, backfillUsed),
    };
  }

  // A quoted allowance is a NUMBER TO SHOW, NOT A GATE.
  //
  // Custom is negotiated per client — one customer bought several times the top bundle — and the
  // customer should see how much of what they bought they have used. But a quoted client
  // going over their number is a conversation with us, never a locked agent, so the
  // allowance is reported and the state never reaches 'restricted'. Enforcement on the
  // contract plans stays exactly where it was: off.
  const quote = plan.id === 'custom' ? customPlanFor(teamId) : null;
  const shownCap = quote?.credits ?? null;
  const included = unlimited ? shownCap : periodCap;
  const enforced = !unlimited;
  const remaining = included === null ? Infinity : Math.max(0, included - used);
  const percentUsed = included ? Math.round((used / included) * 100) : 0;
  const state = included === null ? 'ok' : creditState(percentUsed, { enforced });

  return {
    plan,
    used,
    included,
    remaining: remaining === Infinity ? null : remaining,
    // Unlimited means NOTHING BLOCKS, which is still true of a quoted allowance. The page
    // reads `included` to decide whether it has a number to draw a bar against.
    unlimited: !enforced,
    percentUsed,
    state, // ok | warn | over | restricted
    nextTier: null, // quoted: the next volume is a conversation, not a tier
    periodStart: periodStart.toISOString(),
    backfill: backfillState(plan, backfillStartedAt, backfillUsed),
  };
}

/**
 * The backfill-credits card: what the first backfill read, against the plan's allowance, shown for
 * the thirty days after it started (GET-515). Null when there was no backfill in that window.
 */
function backfillState(plan, startedAt, used) {
  if (!startedAt) return null;
  return { used, allowance: backfillAllowanceForPlan(plan.id), startedAt, showUntil: null };
}

/**
 * Credit state resolved from a workspace instead of a team — what the agent's
 * enforcement path has in hand. Resolves the workspace's team + subscription,
 * then defers to getTeamAiCredits. Returns unlimited (never-block) if anything
 * about the lookup is unclear, so a resolution failure can't lock a customer out.
 */
export async function getWorkspaceAiCredits(supabase, workspaceId) {
  try {
    const { data: ws } = await supabase
      .from('workspaces')
      .select('team_id')
      .eq('id', workspaceId)
      .maybeSingle();
    if (!ws?.team_id) return { unlimited: true, included: null, used: 0, remaining: null, state: 'ok' };

    const { data: subscription } = await supabase
      .from('subscriptions')
      .select('*')
      .eq('team_id', ws.team_id)
      .maybeSingle();

    return await getTeamAiCredits(supabase, ws.team_id, subscription);
  } catch (err) {
    console.error('[getWorkspaceAiCredits] resolve failed:', err?.message);
    return { unlimited: true, included: null, used: 0, remaining: null, state: 'ok' };
  }
}

/**
 * The reusable credit gate every AI ACTION calls before it runs the model. One
 * place owns the "are you out of credits" decision and the 402 shape, so the
 * agent, Studio drafts, Sequence steps and anything future all block identically.
 *
 *   const gate = await requireAiCredits(supabase, workspaceId);
 *   if (!gate.ok) return res.status(gate.status).json(gate.body);
 *   // …run the model, then trackLlmUsage() with a feature in REQUESTED_FEATURES (@nous/core).
 *
 * Unlimited plans (Headless, Custom, self-host, billing-off) always return ok, and
 * the underlying lookup fails open, so this can never wrongly lock out a customer.
 */
export async function requireAiCredits(supabase, workspaceId) {
  const credits = await getWorkspaceAiCredits(supabase, workspaceId);
  // Running out is not the wall — 20% OVER is (GET-525). Between the allowance and that line the
  // work keeps going and they are told; there is nothing to buy that would change it, because a
  // pack is not what someone who reads a fifth more than they bought actually needs.
  if (!credits.unlimited && credits.state === 'restricted') {
    const next = credits.nextTier;
    if (credits.needsPlan) {
      // Three ways to stop paying, one behaviour — but the sentence should say which it was,
      // because "choose a plan" to someone whose card just failed is the wrong instruction.
      const reason = credits.notLiveReason ?? 'no_plan';
      const priced = next ? ` ${next.credits.toLocaleString()} credits is $${next.priceUsd} a month.` : '';
      const message =
        reason === 'payment_failed'
          ? 'Your last payment did not go through, so reading has stopped. Update your card and it starts again straight away.'
          : reason === 'canceled'
            ? `Your subscription has ended, so reading has stopped. Everything is still here — pick a plan and it picks up where it left off.${priced}`
            : `Choose a plan to start reading.${priced}`;
      return {
        ok: false,
        status: 402,
        body: {
          error: reason,
          credits: { used: credits.used, included: 0, remaining: 0, nextTier: next },
          message,
        },
        credits,
      };
    }
    return {
      ok: false,
      status: 402,
      body: {
        error: 'over_credit_limit',
        credits: {
          used: credits.used,
          included: credits.included,
          remaining: 0,
          percentUsed: credits.percentUsed,
          periodStart: credits.periodStart ?? null,
          nextTier: next,
          paymentFailed: !!credits.paymentFailed,
        },
        message: credits.paymentFailed
          // The card comes first: moving up is a new charge on the card that just failed.
          ? `You have read ${credits.percentUsed}% of this month's credits, and your last payment did not go through. Update your card first; then ${next ? `move up to ${next.credits.toLocaleString()} credits and it starts again straight away.` : 'talk to us about the volume you are running.'}`
          : next
          ? `You have read ${credits.percentUsed}% of this month's credits — a fifth more than the plan carries. Move up to ${next.credits.toLocaleString()} credits at $${next.priceUsd} a month and it starts again straight away.`
          : "You have read more than this month's credits carry. Talk to us and we will quote the volume you are actually running.",
      },
      credits,
    };
  }
  return { ok: true, credits };
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
    // Self-host reads the same remembered figure: the live count is unbounded work on a request
    // path whether or not there is a bill at the end of it (GET-300).
    const { data: cached } = await supabase.from('team_account_usage')
      .select('used').eq('team_id', teamId).maybeSingle();
    return { plan, used: Number(cached?.used) || 0, included: null, remaining: Infinity };
  }

  // The REMEMBERED count (GET-300). Counting live means scanning every observation in the team's
  // workspaces and joining the contacts view — on a client-sized graph that timed out on live
  // requests, 24 times in twenty minutes, each one a page somebody was waiting on. A billing
  // meter is recomputed on a schedule (refresh_team_account_usage) and read here.
  {
    const { data: cached } = await supabase.from('team_account_usage')
      .select('used, computed_at').eq('team_id', teamId).maybeSingle();
    if (cached) {
      const included = plan.activeAccountsLimit;
      return {
        plan, used: Number(cached.used) || 0, included,
        remaining: included === null ? Infinity : Math.max(0, included - (Number(cached.used) || 0)),
      };
    }
  }

  // NO LIVE COUNT ON A REQUEST PATH (GET-300). Counting means scanning every observation the team
  // holds and joining the contacts view; on a client-sized graph it does not finish, and it sits
  // behind the plan gate, so it took ordinary pages down with it. A team with no remembered figure
  // yet reads zero — the safe direction to be wrong in, and the scheduled job fills it within the
  // quarter hour. `team_active_accounts()` is still there for that job and for a hand check.
  const used = 0;

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
 * 'restricted' gates PROACTIVE account creation on the API and locks the web app.
 * Ingest is never blocked — a reply from someone you already know still lands —
 * and retrieval (the plugin/MCP) stays open in every state.
 */
export async function getTeamAccountsState(supabase, teamId, subscription) {
  const usage = await getTeamActiveAccounts(supabase, teamId, subscription);
  const { used, included } = usage;

  // graceDays rides on every state so the UI's copy reads the one number (OPS_GRACE_DAYS).
  if (included === null) {
    return { ...usage, percentUsed: 0, state: 'ok', graceUntil: null, graceDays: OPS_GRACE_DAYS };
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
      graceDays: OPS_GRACE_DAYS,
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
    graceDays: OPS_GRACE_DAYS,
  };
}

// ── Ops-limit enforcement (grace model) ─────────────────────────────────────
// Crossing a cap does NOT hard-block. The team gets a grace window; only after it
// expires (still over, not upgraded) does the state turn 'restricted'. For the
// active-account meter that means: account creation 402s (requireAccountsBalance)
// and the web app locks behind an upgrade wall (AccountLimitWall) — ingest keeps
// running and the plugin/MCP keeps reading, so no signal is lost. See access.mjs.
// ONE number for the server, the API messages and the UI copy (GET-209: 3 days).
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
