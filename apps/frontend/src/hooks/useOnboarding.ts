/**
 * Is this workspace set up, and what's still missing.
 *
 * ONE definition of "onboarded", and it lives on the server: `GET /api/onboarding/status`
 * answers it, and every surface asks that endpoint. There used to be three answers — the
 * router checked `workspaces.business_type`, this endpoint checked `workspaces.icp_text`,
 * and `/v2/workspace/status` checked website AND business_type — so the app could gate a
 * user out of a workspace the API considered finished. Which is exactly what happened: you
 * completed setup, it said "you're all set", and the router dropped you straight back into
 * the setup screen on the next render, forever.
 *
 * Onboarded means the workspace has an ICP in the Vault. That is the one artifact setup
 * exists to produce and the one every other part of the product reads.
 *
 * Cached at module level and shared, same as usePlan — the router and the setup screen both
 * ask on a cold load and there's no reason to ask twice.
 *
 * The cache is SUBSCRIBED, not just nullable. Setup writes the ICP and then immediately
 * navigates into the app, so dropping the cached promise isn't enough — every live hook has
 * to know to ask again, or the router reads the stale `false` it fetched thirty seconds ago
 * and bounces the user right back to the screen they just finished.
 */

import { useEffect, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';

const apiUrl = import.meta.env.VITE_API_URL ?? '';

export interface OnboardingStatus {
  /** The gate. True once the workspace has an ICP. */
  onboarded: boolean;
  hasIcp: boolean;
  /** Something is feeding the graph. An ICP with no source is a workspace that stays empty. */
  hasSource: boolean;
  /** Their agent has actually called in — a workspace key has been used at least once. */
  connected: boolean;
  website: string | null;
}

const UNSET: OnboardingStatus = {
  onboarded: false, hasIcp: false, hasSource: false, connected: false, website: null,
};

let cache: Promise<OnboardingStatus | null> | null = null;
let version = 0;
const listeners = new Set<(v: number) => void>();

function load(token: string): Promise<OnboardingStatus | null> {
  if (!cache) {
    cache = fetch(`${apiUrl}/api/onboarding/status`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => (r.ok ? r.json() : null))
      .catch(() => null);
  }
  return cache;
}

/**
 * Call this the moment setup writes something — the ICP save, a source connecting. Drops the
 * cached answer AND tells every mounted hook to refetch.
 */
export function invalidateOnboarding() {
  cache = null;
  version += 1;
  listeners.forEach(fn => fn(version));
}

export interface UseOnboardingResult extends OnboardingStatus {
  /** Gate on this before redirecting, or a set-up workspace flashes the setup screen on
   *  every cold load. */
  loading: boolean;
}

export function useOnboarding(): UseOnboardingResult {
  const { session } = useAuth();
  const token = session?.access_token ?? '';

  const [data, setData] = useState<OnboardingStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [v, setV] = useState(version);

  useEffect(() => {
    listeners.add(setV);
    return () => { listeners.delete(setV); };
  }, []);

  useEffect(() => {
    if (!token) { setLoading(false); return; }
    let alive = true;
    setLoading(true);
    load(token).then(res => {
      if (!alive) return;
      setData(res);
      setLoading(false);
    });
    return () => { alive = false; };
  }, [token, v]);

  return { ...(data ?? UNSET), loading };
}
