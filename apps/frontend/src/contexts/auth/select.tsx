import { lazy, Suspense, type ReactNode } from "react";
import { Navigate } from "react-router-dom";
import { IS_CLERK } from "@/lib/authProvider";
import { cloud, type Loader } from "@/lib/cloud";
import type { SignInFormProps, SignUpFormProps, InviteSignUpProps, AccountSecurityProps } from "./slotTypes";

// The ONE place the app picks between Clerk (Cloud) and Supabase Auth
// (self-host) — GET-577. Everything provider-specific is loaded lazily, so:
//   - a Supabase build never mounts ClerkProvider and never needs its key;
//   - Cloud never downloads the Supabase auth code;
//   - an open-source export drops Clerk by deleting src/cloud/.
// The Clerk loaders come from the cloud registry (src/cloud/index.ts, GET-754), so this file
// has no import of ./clerk/* and builds without it. Clerk is used when the build asks for it
// AND the registry carries it; otherwise Supabase.
const clerk = IS_CLERK ? cloud.auth?.clerk : undefined;

const pick = <P,>(clerkLoader: Loader<P> | undefined, supabase: Loader<P>) =>
  lazy(clerkLoader ?? supabase);

const ProviderImpl = pick<{ children: ReactNode }>(
  clerk?.Provider,
  () => import("./supabase/SupabaseAuthProvider"),
);

const BootSpinner = () => (
  <div className="min-h-screen bg-background flex items-center justify-center">
    <div className="h-8 w-8 rounded-full border-2 border-primary border-t-transparent animate-spin" />
  </div>
);

export function AuthProvider({ children }: { children: ReactNode }) {
  return (
    <Suspense fallback={<BootSpinner />}>
      <ProviderImpl>{children}</ProviderImpl>
    </Suspense>
  );
}

export const SignInForm = pick<SignInFormProps>(
  clerk?.SignInForm,
  () => import("./supabase/SupabaseSignInForm"),
);

export const SignUpForm = pick<SignUpFormProps>(
  clerk?.SignUpForm,
  () => import("./supabase/SupabaseSignUpForm"),
);

export const InviteSignUp = pick<InviteSignUpProps>(
  clerk?.InviteSignUp,
  () => import("./supabase/SupabaseInviteSignUp"),
);

export const AccountSecurity = pick<AccountSecurityProps>(
  clerk?.AccountSecurity,
  () => import("./supabase/SupabaseAccountSecurity"),
);

// The OAuth return leg. Only Clerk uses /sso-callback; Supabase returns straight
// to the redirect target, so the route just goes home.
const ClerkSsoCallback = clerk ? lazy(clerk.SsoCallback) : null;
export function SsoCallback() {
  return ClerkSsoCallback ? <Suspense fallback={<BootSpinner />}><ClerkSsoCallback /></Suspense> : <Navigate to="/" replace />;
}
