import { createClerkClient, verifyToken } from '@clerk/backend';

// Single Clerk Backend client for the API. Used for token verification and for
// the admin user operations (delete / fetch / sign-in tokens) that used to go
// through supabase.auth.admin.
const secretKey = process.env.CLERK_SECRET_KEY;

if (!secretKey) {
  // Fail loud at startup rather than 500-ing every authed request later.
  console.warn('[clerk] CLERK_SECRET_KEY is not set — authentication will reject all requests.');
}

export const clerkClient = createClerkClient({ secretKey });

// Verify a Clerk-issued session token and return its claims. Throws on an
// invalid/expired token. `sub` is the Clerk user id; email/name/image are only
// present when the instance's session token is customized to include them (see
// nous.env.example) — callers must tolerate their absence.
export async function verifyClerkToken(token) {
  return verifyToken(token, { secretKey });
}

// Find a Clerk user by email, or null. Tolerates both the paginated
// ({ data }) and bare-array return shapes getUserList has had across versions.
export async function findClerkUserByEmail(email) {
  const res = await clerkClient.users.getUserList({ emailAddress: [email], limit: 1 });
  const list = Array.isArray(res) ? res : res?.data ?? [];
  return list[0] || null;
}

// Pull the profile fields ensureUserAndTeam needs. Prefers the (cheap) session
// token claims; falls back to a Backend API fetch when the token doesn't carry
// email — so provisioning a brand-new user still works even if session-token
// customization hasn't been configured.
export async function resolveClerkProfile(claims) {
  let email = claims.email || null;
  let name = claims.name || claims.full_name || null;
  let avatarUrl = claims.image_url || claims.picture || null;

  if (!email) {
    const u = await clerkClient.users.getUser(claims.sub);
    email = u.primaryEmailAddress?.emailAddress
      || u.emailAddresses?.[0]?.emailAddress
      || null;
    name = name || [u.firstName, u.lastName].filter(Boolean).join(' ') || u.username || null;
    avatarUrl = avatarUrl || u.imageUrl || null;
  }

  return { email, name, avatarUrl };
}
