/**
 * The current team's plan, and what it can see.
 *
 * One fetch of /api/usage, cached at module level, shared by every caller — the
 * sidebar, the route guards and the billing page all ask the same question and
 * there is no reason to ask the server three times on a cold load.
 *
 * Hiding a nav item is a COURTESY, not a security boundary. The server enforces
 * (plans.mjs + access.mjs); this only decides what's worth showing.
 */

import { useEffect, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { getPlan, hasFeature, normalizePlanId, SELF_HOST_BLOCKED, SELF_HOST_EXTRA, type PlanFeatures, type PlanId, type Plan } from '@/config/plans';

const apiUrl = import.meta.env.VITE_API_URL ?? '';

export interface ActiveAccountsUsage {
  used: number;
  /** null = unlimited (Custom, self-host). */
  included: number | null;
  remaining: number | null;
  percentUsed: number;
  state: 'ok' | 'warn' | 'grace' | 'restricted';
  graceUntil: string | null;
  /** Length of the over-cap grace window (server's OPS_GRACE_DAYS). */
  graceDays?: number;
}

interface UsageResponse {
  plan: string;
  planName: string;
  activeAccounts?: ActiveAccountsUsage;
  selfHosted?: boolean;
}

// Keyed by workspace: the plan belongs to the team that owns the workspace you're in, which is
// not your own team when you're a member of another company's workspace (GET-241).
let cache: Promise<UsageResponse | null> | null = null;
let cacheWorkspace = '';

// The last resolved plan id, remembered across page loads. Without this the first
// paint uses the default (full app) until /api/usage returns, so an API-plan user
// briefly sees the Growth layout flash before it collapses to the control plane.
// Seeding the initial state from here removes that flash on every load after the first.
const LAST_PLAN_KEY = 'nous.lastPlan';
function readLastPlan(): string | null {
  try { return localStorage.getItem(LAST_PLAN_KEY); } catch { return null; }
}
function rememberPlan(plan?: string) {
  try { if (plan) localStorage.setItem(LAST_PLAN_KEY, plan); } catch { /* ignore */ }
}

function load(token: string, workspaceId: string): Promise<UsageResponse | null> {
  if (!cache || cacheWorkspace !== workspaceId) {
    cacheWorkspace = workspaceId;
    const qs = workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : '';
    cache = fetch(`${apiUrl}/api/usage${qs}`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => (r.ok ? r.json() : null))
      .then(res => { rememberPlan(res?.plan); return res; })
      .catch(() => null);
  }
  return cache;
}

/** Drop the cache after a plan change (upgrade, or an operator flipping someone to Custom). */
export function invalidatePlan() {
  cache = null;
}

/**
 * What to DO about a feature, which is a different question from whether the plan has it.
 *
 *   open   — the plan has it, or we don't know yet.
 *   locked — a plan they could buy has it. Show it, grey it, sell it.
 *   hidden — nobody could buy it here. On self-host Threads / Tasks / Skills / Activities
 *            are not for sale at any price, so a greyed tab pointing at an upgrade page
 *            is a dead end that misrepresents the product. Those stay gone.
 *
 * This is why the gate is three-state and not `can`: "you don't have it" splits into
 * "buy it" and "not here", and the two want opposite UI.
 */
export type FeatureAccess = 'open' | 'locked' | 'hidden';

export interface UsePlanResult {
  planId: PlanId;
  plan: Plan;
  /** True until the first response lands. Gate on this before hiding anything, or
   *  the sidebar flickers items away from a Custom customer on every cold load. */
  loading: boolean;
  /** Self-host has no plans at all — everything is on. */
  selfHosted: boolean;
  activeAccounts: ActiveAccountsUsage | null;
  can: (feature: keyof PlanFeatures) => boolean;
  /** `can`, but it also tells you whether to hide or to sell. See FeatureAccess. */
  access: (feature: keyof PlanFeatures) => FeatureAccess;
}

export function usePlan(): UsePlanResult {
  const { session, userData } = useAuth();
  const token = session?.access_token ?? '';
  const workspaceId = (userData as { workspace?: { id?: string } } | null)?.workspace?.id ?? '';

  // Seed from the remembered plan so the first paint already matches (no flash).
  const [data, setData] = useState<UsageResponse | null>(() => {
    const p = readLastPlan();
    return p ? ({ plan: p, planName: p } as UsageResponse) : null;
  });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!token) { setLoading(false); return; }
    let alive = true;
    load(token, workspaceId).then(res => {
      if (!alive) return;
      setData(res);
      setLoading(false);
    });
    return () => { alive = false; };
  }, [token, workspaceId]);

  // /api/me is the authority on this and it has already loaded by the time anything
  // asks. Trusting only /api/usage would mean a failed fetch silently demotes a
  // self-hoster to Free and hides half their product from them.
  const selfHosted =
    (userData as { self_hosted?: boolean } | null)?.self_hosted === true ||
    data?.selfHosted === true;

  // Self-host is the graph, uncapped: Accounts, Activities, the ICP file, the Graph,
  // the integrations, webhooks. Unmetered, because extraction runs on the operator's
  // own model key and costs us nothing.
  //
  // It is NOT "everything unlocked", which is what this used to claim. Both the
  // cloud managed layer (CRM sync, lead lists, the learned ICP model) and the agent
  // team layer (Threads, Adoption, Foundations, Tasks, Skills) are held back — and
  // showing a self-hoster a tab that 403s on the API is worse than not showing it at
  // all. SELF_HOST_BLOCKED mirrors CLOUD_ONLY_FEATURES in access.mjs.
  // Preview override — courtesy only, never a security boundary. Visit any page with
  // ?viewAs=api to see the app AS the API plan (persists); ?viewAs= clears it. Lets an
  // admin on a full plan sanity-check the control-plane layout without changing billing.
  // The server still enforces the real plan on every API call.
  let viewAs = '';
  try {
    const p = new URLSearchParams(window.location.search).get('viewAs');
    if (p !== null) { p ? localStorage.setItem('nous.viewAsPlan', p) : localStorage.removeItem('nous.viewAsPlan'); }
    viewAs = localStorage.getItem('nous.viewAsPlan') || '';
  } catch { /* ignore */ }
  const resolvedPlanId = selfHosted ? 'api' : normalizePlanId(data?.plan);
  const planId = (viewAs && viewAs === normalizePlanId(viewAs)) ? normalizePlanId(viewAs) : resolvedPlanId;
  const plan = getPlan(planId);

  const activeAccounts = data?.activeAccounts ?? null;

  return {
    planId,
    plan,
    loading,
    selfHosted,
    // No cap on self-host, whatever the plan row happens to say.
    activeAccounts: activeAccounts && selfHosted
      ? { ...activeAccounts, included: null, remaining: null, percentUsed: 0, state: 'ok' as const }
      : activeAccounts,
    can: (feature) =>
      selfHosted
        ? !SELF_HOST_BLOCKED.includes(feature) && (hasFeature('api', feature) || SELF_HOST_EXTRA.includes(feature))
        : hasFeature(planId, feature),
    access: (feature) => {
      // Before the first /api/usage response, everything is open — the same rule `can`
      // uses. Locking first and unlocking later is the same flicker as hiding first,
      // except a Custom customer watches their own product get paywalled on the way.
      if (loading) return 'open';
      // Self-host never says 'locked': there is no plan to move to.
      if (selfHosted) {
        return !SELF_HOST_BLOCKED.includes(feature) && (hasFeature('api', feature) || SELF_HOST_EXTRA.includes(feature))
          ? 'open'
          : 'hidden';
      }
      return hasFeature(planId, feature) ? 'open' : 'locked';
    },
  };
}
