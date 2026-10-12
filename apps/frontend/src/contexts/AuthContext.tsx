import { createContext, useContext } from 'react';

// The app's auth context: one stable shape, whatever signs people in (GET-577).
// Cloud fills it from Clerk (cloud/auth/clerk/ClerkAuthProvider), self-host
// from Supabase Auth (contexts/auth/supabase/SupabaseAuthProvider), the
// credential-free preview from fixtures (PreviewAuthProvider). The ~140 files
// that call useAuth() and read session.access_token never know which. The
// provider is picked in contexts/auth/select.tsx — import AuthProvider from there.
//
// Minimal auth types. The app only ever reads `session.access_token`,
// `session.user.email`, `user.id`, and `user.email` off these — so we keep the
// same shape the Supabase User/Session exposed, without the SDK dependency.
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
  // Why /me gave no user, when the API said so: 'signups_disabled' on a closed
  // self-host instance (the login exists, the Nous account does not yet; a join or
  // invite token can still admit it). Supabase provider only; unset elsewhere.
  meError?: string | null;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);
// Exported for the provider implementations (Clerk, Supabase, Preview) — they
// feed the same context so useAuth() works unchanged. Not for any other use.
export { AuthContext };
export type { AuthContextType, AuthUser, AuthSession };

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
