/**
 * The three gated checkpoints of the guided tour, read from server truth.
 *
 * Same endpoint the first-run gate uses (/api/onboarding/status), which now also returns
 * accountCount and icpTrained. We poll while the tour is active so the moment the user
 * connects a source, imports accounts, or feeds the model a closed deal, the tour notices
 * and moves on — no "click Next when you're done, trust me" step.
 */

import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';

const apiUrl = import.meta.env.VITE_API_URL ?? '';

// How many sources the integration step wants before import is worth doing.
export const REQUIRED_SOURCES = 3;

export interface TourProgress {
  /** True once at least REQUIRED_SOURCES sources are connected — import needs a few
   *  (email, meeting notes, LinkedIn) to have anything to match against. */
  integrationConnected: boolean;
  /** How many sources are connected right now (for the "X/3" progress on the step). */
  sourceCount: number;
  accountsImported: boolean;
  icpTrained: boolean;
  /** Server truth: the tour was already completed/dismissed for this workspace. */
  tourCompleted: boolean;
}

const NONE: TourProgress = {
  integrationConnected: false,
  sourceCount: 0,
  accountsImported: false,
  icpTrained: false,
  tourCompleted: false,
};

export function useTourProgress(active: boolean): TourProgress & { loaded: boolean; refetch: () => void } {
  const { session, userData } = useAuth();
  const token = session?.access_token ?? '';
  // Scope the status call to the ACTIVE workspace. Without this the endpoint resolves
  // the user's default-team workspace, so a user who switched workspaces (or has more
  // than one) sees 0 connected even after connecting sources in the workspace they're
  // looking at. verifySupabaseAuth validates membership on this param before honoring it.
  const wsId = (userData as { workspace?: { id?: string } } | null)?.workspace?.id;
  const [data, setData] = useState<TourProgress>(NONE);
  // True once the first status fetch has resolved. The tour uses this to tell
  // "already done before the tour" (baseline) apart from "just done during it" — so
  // it never auto-skips a step whose checkpoint was already satisfied on entry.
  const [loaded, setLoaded] = useState(false);

  const refetch = useCallback(() => {
    if (!token) return;
    const url = wsId
      ? `${apiUrl}/api/onboarding/status?workspaceId=${encodeURIComponent(wsId)}`
      : `${apiUrl}/api/onboarding/status`;
    fetch(url, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => (r.ok ? r.json() : null))
      .then(d => {
        if (d) {
          const sourceCount = d.sourceCount ?? (d.hasSource ? 1 : 0);
          setData({
            integrationConnected: sourceCount >= REQUIRED_SOURCES,
            sourceCount,
            accountsImported: (d.accountCount ?? 0) > 0,
            icpTrained: !!d.icpTrained,
            tourCompleted: !!d.tourCompleted,
          });
        }
        setLoaded(true);
      })
      .catch(() => { setLoaded(true); /* keep last known */ });
  }, [token, wsId]);

  useEffect(() => {
    if (!token) return;
    refetch();
    if (!active) return;
    const iv = setInterval(refetch, 4000);
    return () => clearInterval(iv);
  }, [token, active, refetch]);

  return { ...data, loaded, refetch };
}
