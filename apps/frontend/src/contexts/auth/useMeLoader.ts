import { useCallback, useEffect, useRef, useState } from "react";

// The /me load every auth provider shares (GET-577). Provider-neutral: it only
// needs to know whether someone is signed in and how to get their token. Moved
// out of the Clerk AuthProvider unchanged, so Cloud behaves exactly as before.

export type GetToken = (opts?: { skipCache?: boolean }) => Promise<string | null>;

export function useMeLoader({
  isLoaded,
  isSignedIn,
  getToken,
  onTokenRotated,
}: {
  isLoaded: boolean;
  isSignedIn: boolean;
  getToken: GetToken;
  // Called when a 401 forced a fresh token, so the provider can publish it.
  onTokenRotated?: (token: string) => void;
}) {
  const [userData, setUserData] = useState<any | null>(null);
  const [onboardingCompleted, setOnboardingCompleted] = useState(false);
  const [userDataLoading, setUserDataLoading] = useState(false);
  // Set only for a 403 { error: 'signups_disabled' } (a closed self-host instance);
  // Cloud never sends it, so there it stays null.
  const [meError, setMeError] = useState<string | null>(null);

  const fetchingUserDataRef = useRef(false);
  const meFetchedRef = useRef(false);

  const fetchUserData = useCallback(async (force: boolean = false): Promise<boolean> => {
    if (fetchingUserDataRef.current && !force) return false;
    fetchingUserDataRef.current = true;
    setUserDataLoading(true);

    try {
      const accessToken = await getToken();
      if (!accessToken) return false;

      const apiUrl = import.meta.env.VITE_API_URL ?? '';
      const selectedWorkspaceId = localStorage.getItem('selectedWorkspaceId');
      const url = selectedWorkspaceId
        ? `${apiUrl}/me?workspace_id=${selectedWorkspaceId}`
        : `${apiUrl}/me`;

      let response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });

      // Stale selectedWorkspaceId (leftover from a previous user in this browser)
      // gives a 403. Drop it and retry with the bare /me.
      if (response.status === 403 && selectedWorkspaceId) {
        console.warn('[AUTH] Stored selectedWorkspaceId 403d — clearing and retrying');
        localStorage.removeItem('selectedWorkspaceId');
        response = await fetch(`${apiUrl}/me`, { headers: { Authorization: `Bearer ${accessToken}` } });
      }

      // Token may have rotated under us — force a fresh one and retry once.
      if (response.status === 401) {
        const fresh = await getToken({ skipCache: true });
        if (fresh && fresh !== accessToken) {
          onTokenRotated?.(fresh);
          response = await fetch(url, { headers: { Authorization: `Bearer ${fresh}` } });
        }
      }

      if (response.status === 403) {
        const body = await response.clone().json().catch(() => ({}));
        if (body?.error === 'signups_disabled') setMeError('signups_disabled');
      }

      if (response.ok) {
        setMeError(null);
        const data = await response.json();
        if (data.workspace) {
          const cached = localStorage.getItem('selectedWorkspaceId');
          if (!cached || cached !== data.workspace.id) {
            localStorage.setItem('selectedWorkspaceId', data.workspace.id);
          }
        }
        setUserData(data);
        const isCompleted = !!data.onboarding_completed;
        setOnboardingCompleted(isCompleted);
        return isCompleted;
      }

      if (response.status === 429) {
        console.warn('[AUTH] Rate limit hit for /me endpoint, will retry later');
      }
      return false;
    } catch (error) {
      console.error('Error fetching user data:', error);
      return false;
    } finally {
      fetchingUserDataRef.current = false;
      setUserDataLoading(false);
    }
  }, [getToken, onTokenRotated]);

  // Load /me once per sign-in. Tokens rotate; we deliberately do NOT refetch on
  // rotation — only on sign-in, and on explicit refreshUserData().
  useEffect(() => {
    if (!isLoaded) return;
    if (!isSignedIn) {
      meFetchedRef.current = false;
      setUserData(null);
      setOnboardingCompleted(false);
      setMeError(null);
      return;
    }
    if (meFetchedRef.current) return;
    meFetchedRef.current = true;
    fetchUserData(true);
  }, [isLoaded, isSignedIn, fetchUserData]);

  const refreshUserData = useCallback(() => { fetchUserData(true); }, [fetchUserData]);

  // Sign-out wipes what this hook holds.
  const clearUserData = useCallback(() => {
    setUserData(null);
    setOnboardingCompleted(false);
    setUserDataLoading(false);
    setMeError(null);
  }, []);

  return { userData, onboardingCompleted, userDataLoading, refreshUserData, clearUserData, meError };
}
