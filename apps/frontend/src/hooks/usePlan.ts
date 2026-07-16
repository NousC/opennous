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
import { getPlan, hasFeature, normalizePlanId, SELF_HOST_BLOCKED, type PlanFeatures, type PlanId, type Plan } from '@/config/plans';

const apiUrl = import.meta.env.VITE_API_URL ?? '';

export interface ActiveAccountsUsage {
  used: number;
  /** null = unlimited (Custom, self-host). */
  included: number | null;
  remaining: number | null;
  percentUsed: number;
  state: 'ok' | 'warn' | 'grace' | 'restricted';
  graceUntil: string | null;
}

interface UsageResponse {
  plan: string;
  planName: string;
  activeAccounts?: ActiveAccountsUsage;
  selfHosted?: boolean;
}

let cache: Promise<UsageResponse | null> | null = null;

function load(token: string): Promise<UsageResponse | null> {
  if (!cache) {
    cache = fetch(`${apiUrl}/api/usage`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => (r.ok ? r.json() : null))
      .catch(() => null);
  }
  return cache;
}

/** Drop the cache after a plan change (upgrade, or Bennet flipping someone to Custom). */
export function invalidatePlan() {
  cache = null;
}

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
}

export function usePlan(): UsePlanResult {
  const { session, userData } = useAuth();
  const token = session?.access_token ?? '';

  const [data, setData] = useState<UsageResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!token) { setLoading(false); return; }
    let alive = true;
    load(token).then(res => {
      if (!alive) return;
      setData(res);
      setLoading(false);
    });
    return () => { alive = false; };
  }, [token]);

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
  // team layer (Threads, Adoption, Playbooks, Tasks, Skills) are held back — and
  // showing a self-hoster a tab that 403s on the API is worse than not showing it at
  // all. SELF_HOST_BLOCKED mirrors CLOUD_ONLY_FEATURES in access.mjs.
  const planId = selfHosted ? 'pro' : normalizePlanId(data?.plan);
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
        ? !SELF_HOST_BLOCKED.includes(feature) && hasFeature('pro', feature)
        : hasFeature(planId, feature),
  };
}
