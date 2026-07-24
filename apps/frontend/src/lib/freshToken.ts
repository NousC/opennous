// Returns a valid, freshly-minted access token, or null when signed out.
// Clerk's session tokens are short-lived; getToken() transparently refreshes,
// so this avoids the stale-token race where React state still holds a rotated-out
// token at fetch time. Reads the Clerk singleton off `window` (set by clerk-js)
// so non-React callers outside the provider tree can still get a token.
export async function freshAccessToken(): Promise<string | null> {
  const clerk = (window as any).Clerk;
  if (!clerk?.session) return null;
  try {
    return await clerk.session.getToken();
  } catch {
    return null;
  }
}
