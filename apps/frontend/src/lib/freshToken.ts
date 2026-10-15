// Returns a valid, freshly-minted access token, or null when signed out.
// Session tokens are short-lived; the active auth provider's getter refreshes
// transparently, so this avoids the stale-token race where React state still
// holds a rotated-out token at fetch time. Non-React callers outside the
// provider tree can still get a token.
//
// Provider-neutral (GET-577): the active auth provider registers its getter
// here when its module loads — Clerk reads window.Clerk.session.getToken()
// exactly as this file used to, Supabase reads supabase.auth.getSession().
//
// PREVIEW is imported STATICALLY on purpose: a dynamic import() cannot be folded
// across the module boundary, so the bundler kept this whole branch — and the
// literal "preview-token" — alive in production builds. Static import lets the
// constant fold to false and the branch disappear from the shipped bundle, so
// the guarantee rests on the code being ABSENT rather than on a runtime value.
// (There is no cycle risk: lib/preview imports nothing.)
import { PREVIEW } from "@/lib/preview";

// `force` skips the provider's token cache (Clerk getToken({ skipCache }), Supabase
// refreshSession()): for the one retry after a 401, when the cached token was already rejected.
type TokenGetter = (opts?: { force?: boolean }) => Promise<string | null>;
let tokenGetter: TokenGetter | null = null;

/** Called once by the active auth provider module. */
export function registerTokenGetter(fn: TokenGetter) {
  tokenGetter = fn;
}

export async function freshAccessToken(opts?: { force?: boolean }): Promise<string | null> {
  // Preview mode has no auth provider — the stub token keeps the header
  // present so callers behave identically; the mock API ignores it.
  if (PREVIEW) return "preview-token";
  if (!tokenGetter) return null;
  try {
    return await tokenGetter(opts);
  } catch {
    return null;
  }
}
