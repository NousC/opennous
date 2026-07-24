import { createContext, useContext, useEffect, useState, useRef, useCallback, ReactNode } from 'react';
import { useAuth as useClerkAuth, useUser, useSignIn, useSignUp } from '@clerk/react';

// Minimal auth types. The app only ever reads `session.access_token`,
// `session.user.email`, `user.id`, and `user.email` off these — so we keep the
// same shape the Supabase User/Session exposed, without the Supabase dependency.
type AuthUser = { id: string | null; email: string | null } | null;
type AuthSession = { access_token: string; user: { id: string | null; email: string | null } } | null;

interface AuthContextType {
  user: AuthUser;
  session: AuthSession;
  loading: boolean;
  userDataLoading: boolean; // true while /me is in-flight after auth
  signIn: (email: string, password: string) => Promise<{ error: any; data?: any }>;
  signUp: (email: string, password: string, name?: string, newsletterConsent?: boolean) => Promise<{ error: any; data?: any }>;
  signInWithGoogle: (redirectPath?: string) => Promise<{ error: any }>;
  signOut: () => Promise<void>;
  verifyOtp: (email: string, token: string) => Promise<{ error: any; data?: any }>;
  isAuthenticated: boolean;
  userData: any | null; // User data from /me endpoint
  onboardingCompleted: boolean;
  refreshUserData: () => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

// Normalize a thrown Clerk error into the `{ message }` shape the pages expect
// from the old Supabase `error` object.
function clerkError(err: any) {
  return {
    message:
      err?.errors?.[0]?.longMessage ||
      err?.errors?.[0]?.message ||
      err?.message ||
      'Something went wrong. Please try again.',
  };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const { isLoaded, isSignedIn, getToken, signOut: clerkSignOut } = useClerkAuth();
  const { user: clerkUser } = useUser();
  const { isLoaded: signInLoaded, signIn: signInResource, setActive: setActiveSignIn } = useSignIn();
  const { isLoaded: signUpLoaded, signUp: signUpResource, setActive: setActiveSignUp } = useSignUp();

  // `token` mirrors the current Clerk session JWT for the ~50 call sites that read
  // `session.access_token` synchronously. Clerk tokens are short-lived (~60s), so
  // we refresh proactively below; hot paths that need a guaranteed-fresh token use
  // freshAccessToken() (lib/freshToken) which calls getToken() directly.
  const [token, setToken] = useState<string | null>(null);
  const [userData, setUserData] = useState<any | null>(null);
  const [onboardingCompleted, setOnboardingCompleted] = useState(false);
  const [userDataLoading, setUserDataLoading] = useState(false);

  const fetchingUserDataRef = useRef(false);
  const meFetchedRef = useRef(false);

  // Keep `token` fresh while signed in: prime it immediately, then refresh every
  // 30s and whenever the tab regains focus, so a synchronous `session.access_token`
  // read is never more than ~30s old (well inside the ~60s token lifetime).
  useEffect(() => {
    if (!isLoaded) return;
    if (!isSignedIn) {
      setToken(null);
      return;
    }
    let active = true;
    const refresh = async () => {
      try {
        const t = await getToken();
        if (active && t) setToken(t);
      } catch { /* transient — next tick retries */ }
    };
    refresh();
    const id = setInterval(refresh, 30_000);
    const onVisible = () => { if (document.visibilityState === 'visible') refresh(); };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      active = false;
      clearInterval(id);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [isLoaded, isSignedIn, getToken]);

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
          setToken(fresh);
          response = await fetch(url, { headers: { Authorization: `Bearer ${fresh}` } });
        }
      }

      if (response.ok) {
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
  }, [getToken]);

  // Load /me once per sign-in. Clerk rotates the token every ~30s; we deliberately
  // do NOT refetch on rotation — only on sign-in, and on explicit refreshUserData().
  useEffect(() => {
    if (!isLoaded) return;
    if (!isSignedIn) {
      meFetchedRef.current = false;
      setUserData(null);
      setOnboardingCompleted(false);
      return;
    }
    if (meFetchedRef.current) return;
    meFetchedRef.current = true;
    fetchUserData(true);
  }, [isLoaded, isSignedIn, fetchUserData]);

  const refreshUserData = useCallback(() => { fetchUserData(true); }, [fetchUserData]);

  const signIn = async (email: string, password: string) => {
    if (!signInLoaded) return { error: { message: 'Auth is still loading — try again in a moment.' } };
    try {
      const res = await signInResource.create({ identifier: email, password });
      if (res.status === 'complete') {
        await setActiveSignIn({ session: res.createdSessionId });
        return { error: null, data: {} };
      }
      return { error: { message: 'Additional verification is required to sign in.' } };
    } catch (err) {
      return { error: clerkError(err) };
    }
  };

  const signUp = async (email: string, password: string, name?: string, _newsletterConsent?: boolean) => {
    if (!signUpLoaded) return { error: { message: 'Auth is still loading — try again in a moment.' }, data: null };
    try {
      // Resend path: a signup is already in flight for this email — just re-send
      // the email code instead of re-creating (which Clerk would reject).
      if (signUpResource.id) {
        await signUpResource.prepareEmailAddressVerification({ strategy: 'email_code' });
        return { error: null, data: { session: null } };
      }
      await signUpResource.create({ emailAddress: email, password, ...(name ? { firstName: name } : {}) });
      await signUpResource.prepareEmailAddressVerification({ strategy: 'email_code' });
      // No session yet — the page moves to its email-code step, which calls verifyOtp.
      return { error: null, data: { session: null } };
    } catch (err) {
      return { error: clerkError(err), data: null };
    }
  };

  const verifyOtp = async (_email: string, code: string) => {
    if (!signUpLoaded) return { error: { message: 'Auth is still loading — try again in a moment.' }, data: null };
    try {
      const res = await signUpResource.attemptEmailAddressVerification({ code });
      if (res.status === 'complete') {
        await setActiveSignUp({ session: res.createdSessionId });
        return { error: null, data: { session: {} } };
      }
      return { error: { message: 'That code did not verify. Please try again.' }, data: null };
    } catch (err) {
      return { error: clerkError(err), data: null };
    }
  };

  const signInWithGoogle = async (redirectPath?: string) => {
    if (!signInLoaded) return { error: { message: 'Auth is still loading — try again in a moment.' } };
    try {
      const origin = window.location.origin;
      // OAuth returns to /sso-callback (which finalizes the flow), then Clerk
      // forwards to redirectUrlComplete — so the CLI/invite return path survives
      // the Google round-trip.
      await signInResource.authenticateWithRedirect({
        strategy: 'oauth_google',
        redirectUrl: `${origin}/sso-callback`,
        redirectUrlComplete: `${origin}${redirectPath ?? '/'}`,
      });
      return { error: null };
    } catch (err) {
      return { error: clerkError(err) };
    }
  };

  const signOut = async () => {
    try {
      await clerkSignOut();
    } catch { /* already signed out */ }
    // Wipe per-user browser state so the next person on this browser doesn't
    // inherit a stale workspace pointer.
    try { localStorage.removeItem('selectedWorkspaceId'); } catch { /* sandbox / private mode */ }
    setUserData(null);
    setOnboardingCompleted(false);
    setUserDataLoading(false);
  };

  const email = clerkUser?.primaryEmailAddress?.emailAddress ?? null;
  const user: AuthUser = isSignedIn ? { id: clerkUser?.id ?? null, email } : null;
  const session: AuthSession = isSignedIn && token
    ? { access_token: token, user: { id: clerkUser?.id ?? null, email } }
    : null;

  return (
    <AuthContext.Provider
      value={{
        user,
        session,
        loading: !isLoaded,
        userDataLoading,
        signIn,
        signUp,
        signInWithGoogle,
        signOut,
        verifyOtp,
        isAuthenticated: !!isSignedIn,
        userData,
        onboardingCompleted,
        refreshUserData,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
