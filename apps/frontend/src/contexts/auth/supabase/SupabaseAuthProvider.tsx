import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { Session } from "@supabase/supabase-js";
import { AuthContext, type AuthUser, type AuthSession } from "@/contexts/AuthContext";
import { useMeLoader, type GetToken } from "@/contexts/auth/useMeLoader";
import { registerTokenGetter } from "@/lib/freshToken";
import { getSupabaseAuthClient, supabaseError } from "./client";

// Self-host auth on plain Supabase Auth (GET-577). Fills the same AuthContext
// the Clerk provider does, so every useAuth() caller works unchanged.

// getSession() refreshes an expired access token before returning it.
registerTokenGetter(async (opts) => {
  const auth = getSupabaseAuthClient().auth;
  const { data, error } = opts?.force ? await auth.refreshSession() : await auth.getSession();
  if (error) return null;
  return data.session?.access_token ?? null;
});

export default function SupabaseAuthProvider({ children }: { children: ReactNode }) {
  const supabase = getSupabaseAuthClient();
  const [sbSession, setSbSession] = useState<Session | null>(null);
  const [isLoaded, setIsLoaded] = useState(false);

  useEffect(() => {
    let active = true;
    supabase.auth.getSession().then(({ data, error }) => {
      if (!active) return;
      if (error) console.error("[AUTH] getSession failed:", error.message);
      setSbSession(data?.session ?? null);
      setIsLoaded(true);
    });
    // Fires on sign-in, sign-out and every token refresh, so session.access_token
    // is always the current one.
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, s) => {
      if (!active) return;
      setSbSession(s);
      setIsLoaded(true);
      // Drop the magic-link tokens from the address bar once Supabase has read them.
      if (s && window.location.hash.includes("access_token")) {
        window.history.replaceState({}, document.title, window.location.pathname + window.location.search);
      }
    });
    return () => {
      active = false;
      subscription.unsubscribe();
    };
  }, [supabase]);

  const getToken: GetToken = useCallback(async (opts) => {
    if (opts?.skipCache) {
      const { data, error } = await supabase.auth.refreshSession();
      if (error) return null;
      return data.session?.access_token ?? null;
    }
    const { data, error } = await supabase.auth.getSession();
    if (error) return null;
    return data.session?.access_token ?? null;
  }, [supabase]);

  const isSignedIn = !!sbSession;
  const { userData, onboardingCompleted, userDataLoading, refreshUserData, clearUserData, meError } = useMeLoader({
    isLoaded,
    isSignedIn,
    getToken,
  });

  const signIn = async (email: string, password: string) => {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    return { error: supabaseError(error), data };
  };

  const signUp = async (email: string, password: string, name?: string, newsletterConsent?: boolean, redirectPath?: string) => {
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: { name, full_name: name, newsletter_consent: newsletterConsent ?? false },
        // Where the confirmation email's link lands (when "Confirm email" is on).
        emailRedirectTo: `${window.location.origin}${redirectPath ?? "/"}`,
      },
    });
    return { error: supabaseError(error), data };
  };

  const verifyOtp = async (email: string, token: string) => {
    const { data, error } = await supabase.auth.verifyOtp({ email, token, type: "signup" });
    return { error: supabaseError(error), data };
  };

  const signInWithGoogle = async (redirectPath?: string) => {
    // Only works once Google is enabled in the Supabase project (Auth → Providers).
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: `${window.location.origin}${redirectPath ?? "/"}` },
    });
    return { error: supabaseError(error) };
  };

  const signOut = async () => {
    const { error } = await supabase.auth.signOut();
    if (error) console.warn("[AUTH] signOut:", error.message);
    try { localStorage.removeItem("selectedWorkspaceId"); } catch { /* sandbox / private mode */ }
    clearUserData();
  };

  const u = sbSession?.user;
  const user: AuthUser = u ? { id: u.id, email: u.email ?? null } : null;
  const session: AuthSession = sbSession
    ? { access_token: sbSession.access_token, user: { id: u?.id ?? null, email: u?.email ?? null } }
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
        isAuthenticated: isSignedIn,
        userData,
        onboardingCompleted,
        refreshUserData,
        meError,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}
