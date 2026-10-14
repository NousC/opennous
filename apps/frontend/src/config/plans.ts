/**
 * Nous Pricing — frontend mirror of apps/api/src/lib/plans.mjs.
 * Rewritten 2026-07-13.
 *
 * THE BILLED UNIT IS ACTIVE ACCOUNTS — companies we've actually had a conversation
 * with (a reply, a meeting, a DM). Retrievals, records, lead imports and seats are
 * ALL unlimited on every plan, because they all cost us nothing to serve.
 *
 * Features do NOT differ between Free / Start / Pro. Those are one product at three
 * sizes, separated only by the account cap. The split that matters is by AUDIENCE:
 *
 *   GRAPH  (every plan)  — operators in Claude Code. They bring their own agent and
 *                          their own tokens. They want the graph and an API.
 *   TEAM   (Custom only) — internal GTM teams. They have no agent, and that is what
 *                          they're buying. Runs on our Sonnet bill.
 *
 * This file is UI truth only. The server enforces (plans.mjs + access.mjs); hiding a
 * nav item is a courtesy, not a security boundary.
 */

export type PlanId = 'api' | 'custom';

// Every id we ever sold, pointed at the plan it became (GET-480). Live rows still carry
// these, so deleting them without a map would resolve real customers to the default.
// Mirrors LEGACY_PLAN_IDS in apps/api/src/lib/plans.mjs — the two must move together.
const LEGACY_PLAN_IDS: Record<string, PlanId> = {
  free: 'api', starter: 'api', pro: 'api', scale: 'api',
  growth: 'custom', headless: 'custom', enterprise: 'custom', workspace: 'custom',
};

export interface PlanFeatures {
  // ── The graph. Every plan, including Free and self-host. ──
  activities: boolean;
  accounts: boolean;
  icp: boolean;
  graph: boolean;
  integrations: boolean;
  install: boolean;
  webhooks: boolean;
  contextualization: boolean;
  icpScoring: boolean;
  forecasting: boolean;
  linkedinEngagement: boolean;
  publicSignalExtraction: boolean;
  /**
   * The Vault — icp, positioning, voice, messaging.
   *
   * Ungated 2026-07-14. It was Custom-only, which meant a Free user completed setup,
   * produced an ICP, and could never see or edit it again: the one artifact onboarding
   * exists to create sat behind the paywall. The Vault IS the context layer, the context
   * layer is the product, and serving it is a deterministic Postgres read — the same
   * argument that makes retrieval free.
   */
  foundations: boolean;
  /** Ungated 2026-07-14 alongside the Vault. Reads over the customer's own data. */
  adoption: boolean;
  /** Insights — the workspace's self-knowledge learned from calls, on its own page.
   *  The first capability gate above the account cap: Pro+ only, off on Free and Start. */
  insights: boolean;

  // ── Headless. On for every plan, but NOT product surface. ──
  // No nav item, no plan bullet, no pricing line. Primitives an agent calls, kept alive
  // because the AIOS prospecting skills write into them. See internal/ONBOARDING.md §2.
  leadLists: boolean;
  crmSync: boolean;
  /** The obligations the extractor already wrote, as a page. Graph, not team (GET-426). */
  tasks: boolean;
  /** Automations — trigger, artifact, destination. Every run lands on Home. How MANY a
   *  workspace may keep is the plan's `automationLimit`; this is only whether the surface
   *  exists at all, and it exists everywhere. */
  automations: boolean;
  revboxes: boolean;

  // ── The team layer. Headless only. The surfaces that run on OUR Sonnet bill —
  //    which is the entire reason this block exists. ──
  /** Threads — the in-app chat agent. Runs Sonnet; this IS the expensive surface. */
  inAppAgent: boolean;
  skills: boolean;
  /** Workflows — scheduled agent runs (cron + before-meeting). The Routines engine,
   *  resurfaced as a nav item. Needs the agent, so it rides with the team layer. */
  workflows: boolean;
  ownPostgres: boolean;
  /** The Slack connector and agent. HubSpot and Salesforce connect on every plan (GET-517, GET-576). */
  slack: boolean;

  supportTier: 'community' | 'email' | 'priority';
}

export interface Plan {
  id: PlanId;
  name: string;
  /** null = negotiated (Custom). On self-serve, the ENTRY bundle — the subscribed tier wins. */
  monthlyPriceUsd: number | null;
  /** Conversation credits a month. null = unlimited / quoted. Entry bundle on self-serve. */
  aiCreditsPerMonth: number | null;
  /** Deterministic ops (reads, queries). null = unlimited — which is every plan today. */
  includedOpsPerMonth: number | null;
  recordsLimit: number | null;
  enrichmentsPerMonth: number;
  /** Seats. null = unlimited, which is every plan: we meter credits, not people. */
  memberLimit: number | null;
  /** THE meter. null = unlimited. */
  activeAccountsLimit: number | null;
  linkedinProfiles: number | null;
  workspaceLimit: number | null;
  features: PlanFeatures;
  stripePriceEnv: string | null;
  retired?: boolean;
}

const GRAPH = {
  activities: true,
  accounts: true,
  icp: true,
  graph: true,
  integrations: true,
  install: true,
  webhooks: true,
  contextualization: true,
  icpScoring: true,
  forecasting: true,
  linkedinEngagement: true,
  publicSignalExtraction: true,
  foundations: true,   // the Vault
  // Headless — on everywhere, but not product surface. See PlanFeatures.
  leadLists: true,
  crmSync: true,
  // Tasks and Automations joined the graph 2026-09-23 (GET-426). They were in the team
  // layer because that is where the in-app agent lives, but neither one needs it: a task is
  // a claim the extractor already wrote, and an automation is a trigger plus a template. The
  // Sonnet bill is the only thing the team layer was ever drawing, and these do not touch it.
  tasks: true,
  automations: true,
  revboxes: false,
} as const;

// The team layer. Adoption + Insights joined it 2026-07-31: on the API plan the
// sidebar is Accounts · ICP Model · Activities, and Adoption/Insights are the
// Headless "Workspace" group. So they gate with the rest of the run-it-for-you
// surfaces, not with the graph.
const TEAM_ON = {
  inAppAgent: true,
  skills: true,
  workflows: true,
  adoption: true,
  insights: true,
  ownPostgres: true,
  slack: true,
} as const;

// What the API plan does NOT have (GET-480). GRAPH turned tasks and automations on for
// everyone in GET-426, on the argument that neither needs the in-app agent. True of the
// cost; not true of the product. The API plan's whole shape is "we read your tools and you
// work the result in your own agent" — a task list and an automations builder are the app
// doing the work for you, which is the Workspace plan. Insights is already off in TEAM_OFF.
//
// Applied to the api-tier plans only (free · api · starter · pro · scale); Workspace and
// Custom keep the GRAPH defaults.
const API_TIER_OFF = {
  // Insights (GET-522) and automations (GET-523) are ON for self-serve now. Extraction
  // already runs on every plan, so the insight board is a READ of what we produced; and an
  // automation is a schedule over the same reads, which is the thing an operator running their
  // own agent most wants us to hold. Tasks stay off: a worklist is the app deciding what you
  // should do next, which is what Custom sells.
  tasks: true,
} as const;

const TEAM_OFF = {
  inAppAgent: false,
  skills: false,
  workflows: false,
  adoption: false,
  insights: false,
  ownPostgres: false,
  slack: false,
} as const;

/** Integrations only available on the sales (Custom) plan. Mirror of the API's set in
 *  apps/api/src/lib/plans.mjs — keep the two in step. */
// CRMs are open to every plan (GET-517); Slack stays a team integration.
export const CUSTOM_ONLY_INTEGRATIONS = new Set(['slack']);

/**
 * Hidden on self-host in the UI. Self-host is the Self-serve plan (GET-576, 2026-10-01): CRM
 * sync, lead lists, webhooks, automations and Activities are all on. What is hidden is the
 * Workspace layer, which runs on our Sonnet bill. Mirrors CLOUD_ONLY_FEATURES in
 * apps/api/src/lib/access.mjs.
 */
export const SELF_HOST_BLOCKED: (keyof PlanFeatures)[] = [
  'inAppAgent',
  'tasks',
  'skills',
  'workflows',
  'slack',
];

/**
 * Kept ON for self-host even though the api plan turns them OFF (2026-07-31).
 *
 * Adoption + Insights moved to the Headless team layer so the CLOUD api plan shows
 * them locked. But self-host derives its feature set from the api plan, and on
 * self-host both run on the operator's own model key at no cost to us — so there's
 * no reason to take them away there. usePlan ORs this in for self-host only.
 */
export const SELF_HOST_EXTRA: (keyof PlanFeatures)[] = ['adoption', 'insights'];

// Keep in step with SELF_SERVE_TIERS in apps/api/src/lib/plans.mjs — the API is the source
// of truth (it resolves the tier from the Stripe price); this copy is what the UI prices from.
export const SELF_SERVE_TIERS: { credits: number; priceUsd: number }[] = [
  { credits: 960,    priceUsd: 49 },
  { credits: 2_000,  priceUsd: 99 },
  { credits: 4_000,  priceUsd: 199 },
  { credits: 6_000,  priceUsd: 299 },
  { credits: 10_000, priceUsd: 499 },
];

export const PLANS: Record<PlanId, Plan> = {
  // Self-serve — $49 to $499, one plan at five volumes (SELF_SERVE_TIERS). Bring your own
  // agent: we read the tools and resolve the graph, the operator works the result in their own
  // runner. No in-app agent, no insights, tasks or automations — those are the app doing the
  // work for you, which is Custom. The numbers here are the ENTRY bundle; the subscribed tier
  // overrides them (getPlanFromSubscription in the API).
  api: {
    id: 'api',
    name: 'Nous',
    monthlyPriceUsd: 49,
    aiCreditsPerMonth: 960,
    activeAccountsLimit: 10_000,
    includedOpsPerMonth: null,
    recordsLimit: null,
    linkedinProfiles: 3,
    enrichmentsPerMonth: 0,
    workspaceLimit: 5,
    memberLimit: null,
    stripePriceEnv: 'STRIPE_SELF_SERVE_49_PRICE_ID',
    features: { ...GRAPH, ...TEAM_OFF, ...API_TIER_OFF, insights: true, revboxes: true, supportTier: 'priority' },
  },

  custom: {
    id: 'custom',
    name: 'Custom',
    monthlyPriceUsd: null,
    aiCreditsPerMonth: null,
    activeAccountsLimit: null,
    includedOpsPerMonth: null,
    recordsLimit: null,
    linkedinProfiles: null,
    enrichmentsPerMonth: 0,
    workspaceLimit: null,
    memberLimit: null,
    stripePriceEnv: null,
    // RevBoxes on Workspace too (GET-864); mirrors the revboxes flag in apps/api/src/lib/plans.mjs.
    features: { ...GRAPH, ...TEAM_ON, insights: true, revboxes: true, supportTier: 'priority' },
  },
};

/** The sold plans, cheapest first: Free (100 accounts) · Pro (250–1,500, PRO_TIERS) · Custom
 *  (sales-led, unlimited). Mirror of SELLABLE_PLAN_IDS in apps/api/src/lib/plans.mjs. api /
 *  headless / starter / growth / scale are retired — resolvable, never offered. */
export const SELLABLE_PLAN_IDS: PlanId[] = ['api', 'custom'];

/** Pro is ONE plan sold at four account tiers. Mirror of PRO_TIERS in apps/api/src/lib/plans.mjs. */
// Retired with the Pro plan (GET-480): the product is three plans priced on credits, not
// an accounts-tiered ladder. Kept as an empty export so the billing page still compiles
// while its tier selector is removed.
export const PRO_TIERS: { accounts: number; priceUsd: number }[] = [];

/**
 * Per-plan history backfill READ window, in days: three months on every plan (GET-514). The CRM
 * import reaches twelve months of records; tasks come from the last thirty days only.
 * Mirror of BACKFILL_WINDOW_DAYS in apps/api/src/lib/plans.mjs. Display-only here.
 */
export const BACKFILL_WINDOW_DAYS: Record<string, number> = {
  api: 90, custom: 90,
  starter: 90, growth: 90, enterprise: 90, free: 90, pro: 90, headless: 90, scale: 90,
};

const PLAN_ID_SET = new Set<PlanId>(['api', 'custom']);

/**
 * THE THREE PLANS (GET-480) — API · Workspace · Custom. Mirror of the names in
 * apps/api/src/lib/plans.mjs; keep the two in step.
 *
 * The ids and the names are finally the same word. Retired ids are kept here so a record
 * that still carries one prints as the plan it became rather than as "Trial ended".
 */
export const PLAN_FAMILY: Record<string, string> = {
  api: 'Self-serve', starter: 'Self-serve', pro: 'Self-serve', scale: 'Self-serve', free: 'Self-serve',
  custom: 'Workspace', growth: 'Workspace', headless: 'Workspace', enterprise: 'Workspace',
  workspace: 'Workspace',
};

/** What to call this plan in front of a customer. One of the four, or the lapsed state. */
export function planName(planOrId: unknown): string {
  const id = (planOrId && typeof planOrId === 'object' && 'id' in planOrId)
    ? (planOrId as { id?: unknown }).id
    : planOrId;
  return PLAN_FAMILY[String(id ?? '').toLowerCase()] ?? 'Trial ended';
}

export function normalizePlanId(input: unknown): PlanId {
  const s = typeof input === 'string' ? input.toLowerCase() : '';
  if (PLAN_ID_SET.has(s as PlanId)) return s as PlanId;
  return LEGACY_PLAN_IDS[s] ?? 'api';
}

export function getPlan(planId: unknown): Plan {
  return PLANS[normalizePlanId(planId)];
}

// The two products: CORE (the plugin — the agent runs in the operator's own coding tool)
// vs the full teams app (Custom + the legacy team tiers). Core is the default self-serve
// tier; new api signups land here. Core hides the in-app agent (Home→Install, Chat→
// Workflows, no floating agent); everything else gets the full experience.
// Core = the plugin experience (BYO agent, Install sidebar): Free + Pro (+ legacy api).
// Custom / headless are the run-it-for-you team layer — the full in-app agent surface.
// Starter · Pro · Scale are the self-serve three — bring your own agent, no in-app chat.
// Workspace (headless/custom/growth/enterprise) is the operated one and gets the full app.
// `scale` joined this list 2026-09-23: the pricing page sells it with a Get started button,
// so it is self-serve, and it was reading as a team plan only because its id predates that.
const CORE_PLAN_IDS: PlanId[] = ['api'];
export function isCorePlan(planOrId: unknown): boolean {
  // Accept either a plan id string OR a Plan object — callers pass both. Without this a
  // Plan object falls through normalizePlanId to 'free' (a core plan), so isCorePlan(plan)
  // would be ALWAYS true and every plan, including Custom/Growth, gets stuck on the Core view.
  const id = (planOrId && typeof planOrId === 'object' && 'id' in planOrId)
    ? (planOrId as { id?: unknown }).id
    : planOrId;
  return CORE_PLAN_IDS.includes(normalizePlanId(id));
}

// ── The three plans, as the product sells them ───────────────────────────────
//
// The app used to split two ways — Core (plugin) vs the teams app — across nine billing
// ids. The product is now three plans, and the UI keys off THESE, not off the ids:
//
//   api     $49–$499 — SELF-SERVE, one plan at five volumes. The operator brings their own
//                      agent. Home IS the activity ledger: what we connected to and what we
//                      read. No insights, no tasks, no automations, no in-app chat. The
//                      graph, the accounts and the brain. See SELF_SERVE_TIERS.
//   custom           — quoted, shaped per account, and the plan the app runs on: the in-app
//                      agent, insights, tasks, automations, custom integrations.
//
// The nine billing ids stay exactly as they are. Renaming them is a billing migration and
// this is a navigation change; the two should not be the same pull request. When GET-457
// reconciles the code with the pricing page, this map is the one place to edit.
export type PlanTier = 'api' | 'custom';

const TIER_BY_PLAN_ID: Record<PlanId, PlanTier> = {
  api: 'api', custom: 'custom',
};

/**
 * Which of the three plans this is. Accepts a plan id or a Plan object, like isCorePlan —
 * callers pass both, and a Plan object falling through to 'free' would put every paying
 * team on the API view.
 */
export function planTier(planOrId: unknown): PlanTier {
  const id = (planOrId && typeof planOrId === 'object' && 'id' in planOrId)
    ? (planOrId as { id?: unknown }).id
    : planOrId;
  return TIER_BY_PLAN_ID[normalizePlanId(id)] ?? 'api';
}

/** The API plan: no in-app agent, no insights, tasks or automations. */
export function isApiTier(planOrId: unknown): boolean {
  return planTier(planOrId) === 'api';
}

/** Workspace or Custom — the full in-app experience. */
export function hasWorkspaceSurface(planOrId: unknown): boolean {
  return planTier(planOrId) !== 'api';
}

/** Pre-revenue: no paywall. Mirrors PAYWALL in apps/api/src/lib/plans.mjs — the
 *  server is the source of truth, this keeps the UI from drawing locks the API
 *  will not enforce. Flip BOTH back together when we start charging. */
const PAYWALL = false;

// CONVENTION — two kinds of gate, and only one goes through here:
//   • PAYWALL gate ("you could buy this") → use hasFeature()/usePlan().can(). Pre-revenue
//     (PAYWALL=false) these return TRUE for every plan on purpose, so nothing is locked.
//   • PRODUCT-SHAPE gate ("this plan structurally doesn't have X") → DO NOT use can().
//     Read the raw plan feature directly: `getPlan(planId).features.X` / `plan.features.X`.
//     e.g. the API plan has no Nous agent, so Slack is hidden regardless of the paywall.
// Using can() for a product-shape gate is a silent bug pre-revenue (it evaluates true).
export function hasFeature(planId: unknown, feature: keyof PlanFeatures): boolean {
  if (!PAYWALL) return true;
  const v = getPlan(planId).features[feature];
  return typeof v === 'boolean' ? v : false;
}

/**
 * The cheapest plan we still SELL that turns `feature` on — the plan we tell someone to
 * buy when they hit a locked surface. Walks the ladder in price order and skips retired
 * plans, so a legacy Growth subscriber is never pointed at something that isn't on the
 * pricing page. null = no sellable plan has it; callers fall back.
 */
export function lowestPlanWith(feature: keyof PlanFeatures): Plan | null {
  for (const id of SELLABLE_PLAN_IDS) {
    const p = PLANS[id];
    if (p.retired) continue;
    if (hasFeature(id, feature)) return p;
  }
  // Team features (Threads, Tasks, Skills, Slack/Salesforce/HubSpot, own Postgres) are on no
  // self-serve bundle — they live on the sales-led Custom plan. Point the upsell there; its
  // null price makes the CTA a talk-to-sales rather than a charge.
  if (hasFeature('custom', feature)) return PLANS.custom;
  return null;
}

// ── Display helpers ─────────────────────────────────────────────────────────

export function getPlanDisplayName(planId: unknown): string {
  return getPlan(planId).name;
}

export function getPlanById(planId: unknown): Plan {
  return getPlan(planId);
}

export function formatPrice(plan: Plan): string {
  if (plan.monthlyPriceUsd === null) return "Let's talk";
  if (plan.monthlyPriceUsd === 0) return '$0';
  return `$${plan.monthlyPriceUsd}`;
}

/**
 * Plan card bullets, matched to the two-plan model. API leads with the context layer
 * (bring your own agent); Headless is everything in API plus the team layer we run.
 */
export function getPlanFeaturesForDisplay(plan: Plan): string[] {
  // Headless / legacy team plans (custom): everything in API, plus the run-it-for-you layer.
  if (plan.features.inAppAgent) {
    return [
      'Everything in API',
      'In-app agent with Threads',
      'Adoption, Audits and Analytics',
      'Scheduled Workflows and Skills',
      'Slack',
      'Bring your own Postgres',
      'Onboarding rollout for your team',
    ];
  }

  // API and the retired self-serve tiers.
  const items = [
    'ICP model — fit scoring on every account',
    'Accounts & graph — one record per company',
    'Activities — the live log of what ran',
  ];
  if (plan.features.insights) items.push('Insights — pipeline and analytics');
  items.push('Integrations & webhooks, HubSpot and Salesforce included');
  items.push('Unlimited retrievals, records and seats');
  return items;
}
