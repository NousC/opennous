import { createContext, useContext, useEffect, useState, useRef, ReactNode } from 'react';
import { User, Session } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabase';

interface AuthContextType {
  user: User | null;
  session: Session | null;
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

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [userData, setUserData] = useState<any | null>(null);
  const [onboardingCompleted, setOnboardingCompleted] = useState(false);
  const [userDataLoading, setUserDataLoading] = useState(false);

  // Refs to prevent race conditions in production
  const fetchingUserDataRef = useRef(false);
  const lastFetchedTokenRef = useRef<string | null>(null);

  useEffect(() => {
    let isMounted = true;

    // Clean up OAuth hash if present (after Supabase has read it)
    const cleanupHash = () => {
      if (window.location.hash) {
        window.history.replaceState({}, document.title, window.location.pathname);
      }
    };

    // Timeout fallback — cleared on success, fires only if init hangs
    let timeout: ReturnType<typeof setTimeout>;

    // Initialize auth
    const initAuth = async () => {
      try {
        const { data: { session: currentSession }, error } = await supabase.auth.getSession();

        if (!isMounted) return;

        if (error) {
          console.error('[AUTH] Error getting session:', error);
          setLoading(false);
          clearTimeout(timeout);
          return;
        }

        setSession(currentSession);
        setUser(currentSession?.user ?? null);
        setLoading(false);
        clearTimeout(timeout);

        cleanupHash();

        if (currentSession) {
          fetchUserData(currentSession.access_token);
        }
      } catch (err) {
        console.error('[AUTH] Init error:', err);
        if (isMounted) setLoading(false);
        clearTimeout(timeout);
      }
    };

    // Start auth initialization
    initAuth();

    timeout = setTimeout(() => {
      if (isMounted) {
        console.warn('[AUTH] Init timeout');
        setLoading(false);
      }
    }, 10000);

    // Listen for auth state changes
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, newSession) => {
      if (!isMounted) return;

      // Update state
      setSession(newSession);
      setUser(newSession?.user ?? null);

      // Handle session changes
      if (newSession) {
        cleanupHash();
        fetchUserData(newSession.access_token);
      } else {
        setUserData(null);
        setOnboardingCompleted(false);
      }
    });

    return () => {
      isMounted = false;
      clearTimeout(timeout);
      subscription.unsubscribe();
    };
  }, []);

  const fetchUserData = async (accessToken: string, force: boolean = false): Promise<boolean> => {
    // Prevent concurrent fetches with the same token (race condition fix for production)
    if (fetchingUserDataRef.current && lastFetchedTokenRef.current === accessToken && !force) {
      return false;
    }

    // Prevent fetching with the same token twice (SIGNED_IN + INITIAL_SESSION events)
    // Skip this check if force=true (for workspace switching)
    if (!force && lastFetchedTokenRef.current === accessToken && userData) {
      return !!onboardingCompleted;
    }

    fetchingUserDataRef.current = true;
    lastFetchedTokenRef.current = accessToken;
    setUserDataLoading(true);

    try {
      const apiUrl = import.meta.env.VITE_API_URL ?? '';
      // Check for selected workspace in localStorage
      const selectedWorkspaceId = localStorage.getItem('selectedWorkspaceId');
      const url = selectedWorkspaceId
        ? `${apiUrl}/me?workspace_id=${selectedWorkspaceId}`
        : `${apiUrl}/me`;

      let response = await fetch(url, {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
        },
      });

      // Stale selectedWorkspaceId (leftover from a previous user in this browser)
      // gives a 403. Drop it and retry with the bare /me so the server picks
      // a workspace this user actually belongs to.
      if (response.status === 403 && selectedWorkspaceId) {
        console.warn('[AUTH] Stored selectedWorkspaceId 403d — clearing and retrying');
        localStorage.removeItem('selectedWorkspaceId');
        response = await fetch(`${apiUrl}/me`, {
          headers: { 'Authorization': `Bearer ${accessToken}` },
        });
      }

      if (response.ok) {
        const data = await response.json();

        // If cached workspace doesn't belong to this user, clear it and use the one from /me
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
      } else if (response.status === 401) {
        // Token may be stale — try refreshing the Supabase session once
        const { data: refreshed } = await supabase.auth.refreshSession();
        if (refreshed?.session?.access_token && refreshed.session.access_token !== accessToken) {
          lastFetchedTokenRef.current = refreshed.session.access_token;
          const retry = await fetch(url, {
            headers: { 'Authorization': `Bearer ${refreshed.session.access_token}` },
          });
          if (retry.ok) {
            const data = await retry.json();
            if (data.workspace) {
              const cached = localStorage.getItem('selectedWorkspaceId');
              if (!cached || cached !== data.workspace.id) {
                localStorage.setItem('selectedWorkspaceId', data.workspace.id);
              }
            }
            setUserData(data);
            setOnboardingCompleted(!!data.onboarding_completed);
            return !!data.onboarding_completed;
          }
        }
        return false;
      } else {
        if (response.status === 429) {
          console.warn('[AUTH] Rate limit hit for /me endpoint, will retry later');
          return false;
        }
        return false;
      }
    } catch (error) {
      console.error('Error fetching user data:', error);
      return false;
    } finally {
      fetchingUserDataRef.current = false;
      setUserDataLoading(false);
    }
  };

  // Expose refresh function for components to call after onboarding or workspace switching
  const refreshUserData = async () => {
    if (session?.access_token) {
      await fetchUserData(session.access_token, true); // Force refresh
    }
  };

  const signIn = async (email: string, password: string) => {
    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });
    return { error, data };
  };

  const signUp = async (email: string, password: string, name?: string, newsletterConsent?: boolean) => {
    // Ensure we use the frontend URL, not backend
    const frontendUrl = window.location.origin;
    // Redirect to dashboard - onboarding modals will handle setup
    const redirectUrl = `${frontendUrl}/`;

    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: {
          name,
          full_name: name,
          newsletter_consent: newsletterConsent ?? false,
        },
        emailRedirectTo: redirectUrl,
      },
    });

    // If session exists (email confirmation disabled), fetch user data immediately
    if (data.session) {
      // Small delay to ensure state updates
      setTimeout(() => {
        fetchUserData(data.session.access_token);
      }, 100);
    }

    return { error, data };
  };

  const verifyOtp = async (email: string, token: string) => {
    const { data, error } = await supabase.auth.verifyOtp({
      email,
      token,
      type: 'signup',
    });

    if (data.session) {
      await fetchUserData(data.session.access_token);
    }

    return { error, data };
  };

  const signInWithGoogle = async (redirectPath?: string) => {
    // Ensure we use the frontend URL, not backend
    const frontendUrl = window.location.origin;
    // Default to the dashboard; callers (e.g. invite accept) can pass a path to
    // return to — critical so the invite token survives the Google round-trip and
    // the accept can auto-fire on return.
    const redirectUrl = `${frontendUrl}${redirectPath ?? "/"}`;

    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: redirectUrl,
        queryParams: {
          access_type: 'offline',
          prompt: 'consent',
        },
      },
    });
    return { error };
  };

  const signOut = async () => {
    await supabase.auth.signOut();
    // Wipe per-user browser state so the next person signing in on this
    // browser doesn't inherit a stale workspace pointer.
    try {
      localStorage.removeItem('selectedWorkspaceId');
    } catch { /* sandbox / private mode */ }
    setUserData(null);
    setOnboardingCompleted(false);
    setUserDataLoading(false);
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        session,
        loading,
        userDataLoading,
        signIn,
        signUp,
        signInWithGoogle,
        signOut,
        verifyOtp,
        isAuthenticated: !!user,
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

