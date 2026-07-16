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

export type PlanId = 'free' | 'starter' | 'pro' | 'custom' | 'growth' | 'scale';

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
  playbooks: boolean;
  /** Ungated 2026-07-14 alongside the Vault. Reads over the customer's own data. */
  adoption: boolean;

  // ── Headless. On for every plan, but NOT product surface. ──
  // No nav item, no plan bullet, no pricing line. Primitives an agent calls, kept alive
  // because the AIOS prospecting skills write into them. See internal/ONBOARDING.md §2.
  leadLists: boolean;
  crmSync: boolean;

  // ── The team layer. Custom only. The surfaces that run on OUR Sonnet bill —
  //    which is the entire reason this block exists. ──
  /** Threads — the in-app chat agent. Runs Sonnet; this IS the expensive surface. */
  inAppAgent: boolean;
  tasks: boolean;
  skills: boolean;
  ownPostgres: boolean;
  /** Salesforce · HubSpot · Slack. */
  enterpriseIntegrations: boolean;

  supportTier: 'community' | 'email' | 'priority';
}

export interface Plan {
  id: PlanId;
  name: string;
  /** null = negotiated (Custom). */
  monthlyPriceUsd: number | null;
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
  linkedinEngagement: true,
  publicSignalExtraction: true,
  playbooks: true,   // the Vault
  adoption: true,
  // Headless — on everywhere, but not product surface. See PlanFeatures.
  leadLists: true,
  crmSync: true,
} as const;

const TEAM_ON = {
  inAppAgent: true,
  tasks: true,
  skills: true,
  ownPostgres: true,
  enterpriseIntegrations: true,
} as const;

const TEAM_OFF = {
  inAppAgent: false,
  tasks: false,
  skills: false,
  ownPostgres: false,
  enterpriseIntegrations: false,
} as const;

/** Integrations only available on the sales (Custom) plan. Mirror of the API's set in
 *  apps/api/src/lib/plans.mjs — keep the two in step. */
export const CUSTOM_ONLY_INTEGRATIONS = new Set(['salesforce', 'hubspot', 'attio', 'slack']);

/**
 * Hidden on self-host in the UI. Mostly mirrors CLOUD_ONLY_FEATURES in
 * apps/api/src/lib/access.mjs — with ONE deliberate exception: `activities`.
 *
 * `activities` (2026-07-15) is a FRONTEND-ONLY gate: self-host hides the Activities log from
 * the nav and route, but its API stays open (the system-log endpoints are shared with the
 * Health widget, and the operator's own instance has no reason to 403 its own logs). So this
 * one is intentionally NOT in access.mjs — the UI hides it, the backend does not block it.
 *
 * Everything else here also has a real backend gate: crmSync / leadLists / icpScoring are the
 * cloud-managed layer, and the Team-layer entries (inAppAgent, tasks, skills,
 * enterpriseIntegrations) run on our Sonnet bill. crmSync / leadLists have no frontend anyway
 * (headless), so their entry here is a no-op that keeps this list honest against the API.
 */
export const SELF_HOST_BLOCKED: (keyof PlanFeatures)[] = [
  'crmSync',
  'leadLists',
  // icpScoring is FULLY OPEN on self-host (2026-07-15): the learned model runs on the
  // operator's own Anthropic key, so it costs us nothing and there's no reason to gate it.
  'inAppAgent',
  'tasks',
  'skills',
  'enterpriseIntegrations',
  'activities', // frontend-only — see note above
];

export const PLANS: Record<PlanId, Plan> = {
  free: {
    id: 'free',
    name: 'Free',
    monthlyPriceUsd: 0,
    activeAccountsLimit: 250,
    linkedinProfiles: 1,
    workspaceLimit: 1,
    stripePriceEnv: null,
    // Adoption is Pro+ on Cloud (open on self-host — usePlan grants it via 'pro').
    features: { ...GRAPH, ...TEAM_OFF, adoption: false, supportTier: 'community' },
  },
  starter: {
    id: 'starter',
    name: 'Start',
    monthlyPriceUsd: 29.99,
    activeAccountsLimit: 1_500,
    linkedinProfiles: 1,
    workspaceLimit: 1,
    stripePriceEnv: 'STRIPE_STARTER_PRICE_ID',
    // Adoption is Pro+ on Cloud (open on self-host).
    features: { ...GRAPH, ...TEAM_OFF, adoption: false, supportTier: 'email' },
  },
  pro: {
    id: 'pro',
    name: 'Pro',
    monthlyPriceUsd: 99,
    activeAccountsLimit: 10_000,
    linkedinProfiles: 3,
    workspaceLimit: 1,
    stripePriceEnv: 'STRIPE_PRO_PRICE_ID',
    features: { ...GRAPH, ...TEAM_OFF, supportTier: 'priority' },
  },
  // Sales-led. Unpriced on purpose: the agent runs Sonnet, the one cost line we've
  // never measured at team scale, so we price it against what a real team burns.
  custom: {
    id: 'custom',
    name: 'Custom',
    monthlyPriceUsd: null,
    activeAccountsLimit: null,
    linkedinProfiles: null,
    workspaceLimit: null,
    stripePriceEnv: null,
    features: { ...GRAPH, ...TEAM_ON, supportTier: 'priority' },
  },

  // Retired 2026-07-13. Kept ONLY so a legacy subscription doesn't normalise to
  // Free and lose its limits. Never offered.
  growth: {
    id: 'growth',
    name: 'Growth (retired)',
    monthlyPriceUsd: 249,
    activeAccountsLimit: 25_000,
    linkedinProfiles: 5,
    workspaceLimit: 3,
    stripePriceEnv: 'STRIPE_GROWTH_PRICE_ID',
    retired: true,
    features: { ...GRAPH, ...TEAM_ON, supportTier: 'priority' },
  },
  scale: {
    id: 'scale',
    name: 'Partner (retired)',
    monthlyPriceUsd: 500,
    activeAccountsLimit: null,
    linkedinProfiles: 5,
    workspaceLimit: 5,
    stripePriceEnv: 'STRIPE_SCALE_PRICE_ID',
    retired: true,
    features: { ...GRAPH, ...TEAM_ON, supportTier: 'priority' },
  },
};

/** The ladder we actually sell. */
export const SELLABLE_PLAN_IDS: PlanId[] = ['free', 'starter', 'pro', 'custom'];

const PLAN_ID_SET = new Set<PlanId>(['free', 'starter', 'pro', 'custom', 'growth', 'scale']);

export function normalizePlanId(input: unknown): PlanId {
  const s = typeof input === 'string' ? input.toLowerCase() : '';
  return PLAN_ID_SET.has(s as PlanId) ? (s as PlanId) : 'free';
}

export function getPlan(planId: unknown): Plan {
  return PLANS[normalizePlanId(planId)];
}

export function hasFeature(planId: unknown, feature: keyof PlanFeatures): boolean {
  const v = getPlan(planId).features[feature];
  return typeof v === 'boolean' ? v : false;
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
 * Plan card bullets. Lead with the ONE thing that scales (active accounts), then
 * name the things that are unlimited — because on this model that list is the
 * pitch, not the fine print.
 */
export function getPlanFeaturesForDisplay(plan: Plan): string[] {
  const accounts = plan.activeAccountsLimit === null
    ? 'Unlimited active accounts'
    : `${plan.activeAccountsLimit.toLocaleString()} active accounts`;

  const items = [
    accounts,
    'Unlimited retrievals',
    'Unlimited records and lead imports',
    'Unlimited seats',
  ];

  if (plan.features.inAppAgent) {
    items.push('Threads — the in-app agent, unmetered');
    items.push('Tasks and Skills');
    items.push('Salesforce, HubSpot and Slack');
    items.push('Bring your own Postgres');
  }
  return items;
}
