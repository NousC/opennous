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

export type OnboardingStep = 'data_source' | 'integrations' | 'welcome' | 'agent_setup' | 'complete';

export interface OnboardingStatus {
  /** THE gate. True once the user has finished the connect wizard and clicked Get Started
   *  — the app unlocks here, BEFORE the ICP exists (the in-app agent writes it after). */
  activated: boolean;
  /** V1: is self-serve COMPANY onboarding switched on? Off means an operator sets the
   *  workspace up before the customer ever signs in. Does not affect seats. */
  selfServe: boolean;
  /** Should this person be greeted with a setup conversation? Answered by the server: a new
   *  MEMBER always is (only they can connect their own notetaker and mailbox); an owner only
   *  when self-serve company onboarding is on. */
  shouldGreet: boolean;
  /** The agent has finished setup (ICP + model + mapping). Not a gate — for surfacing state. */
  completed: boolean;
  /** Which wizard step the user is on, derived server-side. */
  onboardingStep: OnboardingStep;
  /** Wizard step 1: a data source (CRM or CSV) is connected. */
  hasDataSource: boolean;
  /** How many sources are connected across both tables (providers + LinkedIn). */
  sourceCount: number;
  /** Legacy gate. True once the workspace has an ICP. No longer gates entry. */
  onboarded: boolean;
  hasIcp: boolean;
  /** Something is feeding the graph. An ICP with no source is a workspace that stays empty. */
  hasSource: boolean;
  /** Setup checklist step 2: a webhook subscription exists. */
  hasWebhook: boolean;
  /** Setup checklist step 3: this member connected a raw-evidence git repo. */
  hasRepo: boolean;
  /** Their agent has actually called in — a workspace key has been used at least once. */
  connected: boolean;
  website: string | null;
}

const UNSET: OnboardingStatus = {
  activated: false, selfServe: false, shouldGreet: false, completed: false, onboardingStep: 'data_source', hasDataSource: false,
  sourceCount: 0, onboarded: false, hasIcp: false, hasSource: false, hasWebhook: false,
  hasRepo: false, connected: false, website: null,
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

  // Keyed on token presence, NOT the token VALUE. Clerk rotates the JWT every ~60s;
  // if this re-ran (and re-flipped `loading` true) on every rotation, the router's
  // `loading` gate in AppRoutes would unmount the WHOLE app to a blank loader and
  // remount it a microtask later — a full-screen flash every minute that also wiped
  // page state (open account tabs, scroll). Onboarding status does not change when a
  // token rotates, so it must not refetch on rotation. `v` still forces a refetch after
  // setup writes the ICP (invalidateOnboarding). Mirrors usePlan, which is safe for the
  // same reason: it never re-flips `loading` on a re-run.
  const hasToken = !!token;
  useEffect(() => {
    if (!hasToken) { setLoading(false); return; }
    let alive = true;
    // Only block the router on the very first load — never on an invalidation refetch,
    // where the previous (stale) status is shown until the new one lands rather than
    // blanking the app.
    if (data === null) setLoading(true);
    load(token).then(res => {
      if (!alive) return;
      setData(res);
      setLoading(false);
    });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasToken, v]);

  return { ...(data ?? UNSET), loading };
}
