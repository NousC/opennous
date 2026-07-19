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

export interface TourProgress {
  integrationConnected: boolean;
  accountsImported: boolean;
  icpTrained: boolean;
}

const NONE: TourProgress = {
  integrationConnected: false,
  accountsImported: false,
  icpTrained: false,
};

export function useTourProgress(active: boolean): TourProgress & { refetch: () => void } {
  const { session } = useAuth();
  const token = session?.access_token ?? '';
  const [data, setData] = useState<TourProgress>(NONE);

  const refetch = useCallback(() => {
    if (!token) return;
    fetch(`${apiUrl}/api/onboarding/status`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => (r.ok ? r.json() : null))
      .then(d => {
        if (!d) return;
        setData({
          integrationConnected: !!d.hasSource,
          accountsImported: (d.accountCount ?? 0) > 0,
          icpTrained: !!d.icpTrained,
        });
      })
      .catch(() => { /* keep last known */ });
  }, [token]);

  useEffect(() => {
    if (!token) return;
    refetch();
    if (!active) return;
    const iv = setInterval(refetch, 4000);
    return () => clearInterval(iv);
  }, [token, active, refetch]);

  return { ...data, refetch };
}
