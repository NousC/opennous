// Which auth provider this build signs people in with (GET-577).
//
// Nous Cloud uses Clerk. A self-hosted build uses plain Supabase Auth on the same
// Supabase project as the database, so it needs no Clerk key at all.
//
// Decided at BUILD time (Vite inlines import.meta.env):
//   VITE_AUTH_PROVIDER=clerk|supabase   explicit choice
//   unset                               clerk when VITE_CLERK_PUBLISHABLE_KEY is set, else supabase
// The API decides separately (AUTH_PROVIDER / SELF_HOSTED); /api/auth/config
// reports the API's choice so a mismatched build can be spotted.

export type AuthProviderName = "clerk" | "supabase";

export function resolveAuthProvider(
  explicit: string | undefined,
  clerkPublishableKey: string | undefined,
): AuthProviderName {
  const v = (explicit || "").trim().toLowerCase();
  if (v === "clerk" || v === "supabase") return v;
  return clerkPublishableKey ? "clerk" : "supabase";
}

export const AUTH_PROVIDER: AuthProviderName = resolveAuthProvider(
  import.meta.env.VITE_AUTH_PROVIDER,
  import.meta.env.VITE_CLERK_PUBLISHABLE_KEY,
);

export const IS_CLERK = AUTH_PROVIDER === "clerk";
