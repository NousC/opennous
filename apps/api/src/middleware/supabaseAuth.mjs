import { getSupabaseClient } from '@nous/core';
import { setUser } from 'useleak';
import { isSelfHosted } from '../lib/plans.mjs';
import { verifyClerkToken, resolveClerkProfile } from '../lib/clerk.mjs';

// useleak cost-tracking tags each request with the end user's email + name.
// That PII must never leave a self-hosted box, so identify() is a no-op there.
function identify(u) {
  if (isSelfHosted()) return;
  setUser({
    id: String(u.id),
    email: u.email,
    name: u.user_metadata?.full_name || u.user_metadata?.name,
  });
}

// Short-TTL in-memory cache for the full middleware result. Every authed
// request used to do up to 3 round-trips: the token verification (a network
// call under Supabase; local JWKS-cached under Clerk), the public.users lookup,
// and the workspace_members membership check. Caching the resolved
// (user, internalUserId, hasMembership) tuple for 60s drops most requests to
// zero DB calls.
//
// Memory ceiling: bounded by (active tokens × active workspaces) over 60s,
// which is small even at hundreds of users. A periodic sweep clears
// expired entries so the Map doesn't grow indefinitely.
const AUTH_CACHE_TTL_MS = 60_000;
const authCache = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of authCache) {
    if (v.expiresAt < now) authCache.delete(k);
  }
}, 5 * 60_000).unref?.();

// Verify a Clerk session token, resolve the internal user, and attach the
// request identity. Exported as `verifySupabaseAuth` too for the many routers
// that import it under the old name — the token is now a Clerk JWT, but the
// contract (req.user, req.internalUserId, req.workspaceId, req.viewerScope) is
// unchanged.
export async function verifyClerkAuth(req, res, next) {
  const token = req.headers.authorization?.startsWith('Bearer ')
    ? req.headers.authorization.slice(7)
    : null;

  if (!token) return res.status(401).json({ error: 'auth_required' });

  const workspaceId = req.query.workspaceId || req.query.workspace_id || req.body?.workspaceId || req.body?.workspace_id;
  const cacheKey = `${token}:${workspaceId || ''}`;
  const cached = authCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    if (cached.invalid) return res.status(401).json({ error: 'invalid_token' });
    if (cached.notMember) return res.status(403).json({ error: 'not_a_member' });
    req.user = cached.user;
    req.internalUserId = cached.internalUserId;
    if (workspaceId) {
      req.workspaceId = workspaceId;
      // Per-member privacy (PRIVACY_MODEL.md): the logged-in user is the viewer.
      // owner/admin see all raw; member/viewer are scoped to their own content.
      req.memberUserId = cached.internalUserId;
      req.workspaceRole = cached.workspaceRole;
      req.viewerScope = (cached.workspaceRole === 'owner' || cached.workspaceRole === 'admin') ? 'admin' : 'member';
    }
    identify(cached.user);
    return next();
  }

  // Verify the Clerk-issued JWT. verifyToken checks signature + expiry against
  // Clerk's JWKS (cached locally by @clerk/backend), so this is not a per-request
  // network round-trip the way supabase.auth.getUser() was.
  let claims;
  try {
    claims = await verifyClerkToken(token);
  } catch {
    // Cache the rejection too, briefly — stops a flood of bad-token retries.
    authCache.set(cacheKey, { expiresAt: Date.now() + 10_000, invalid: true });
    return res.status(401).json({ error: 'invalid_token' });
  }

  const clerkUserId = claims.sub;
  if (!clerkUserId) {
    authCache.set(cacheKey, { expiresAt: Date.now() + 10_000, invalid: true });
    return res.status(401).json({ error: 'invalid_token' });
  }

  // Resolve email/name/avatar (from claims when the session token carries them,
  // else one Backend API fetch). Only actually needed for provisioning/fallback,
  // but kept on req.user so downstream ensureUserAndTeam() has the same shape it
  // had with the Supabase user object.
  let profile;
  try {
    profile = await resolveClerkProfile(claims);
  } catch {
    profile = { email: null, name: null, avatarUrl: null };
  }

  const user = {
    id: clerkUserId,
    email: profile.email,
    user_metadata: {
      full_name: profile.name,
      name: profile.name,
      avatar_url: profile.avatarUrl,
      picture: profile.avatarUrl,
    },
  };
  req.user = user;
  identify(user);

  // workspace_members stores the internal users.id, not the auth provider id.
  // Resolve the internal user record so membership checks use the right ID.
  const supabase = getSupabaseClient();
  const { data: internalUser } = await supabase
    .from('users')
    .select('id, clerk_user_id')
    .eq('clerk_user_id', clerkUserId)
    .maybeSingle();

  let internalUserId = internalUser?.id;

  // Email fallback for imported users whose clerk_user_id may not be set yet.
  // Backfill it so future lookups hit the fast path above.
  if (!internalUserId && user.email) {
    const { data: byEmail } = await supabase
      .from('users')
      .select('id, clerk_user_id')
      .ilike('email', user.email)
      .maybeSingle();
    if (byEmail) {
      internalUserId = byEmail.id;
      if (!byEmail.clerk_user_id) {
        try {
          await supabase.from('users')
            .update({ clerk_user_id: clerkUserId })
            .eq('id', byEmail.id);
        } catch { /* best-effort backfill */ }
      }
    }
  }

  if (!internalUserId) internalUserId = clerkUserId;
  req.internalUserId = internalUserId;

  // Resolve workspace membership when a workspace is specified
  let workspaceRole;
  if (workspaceId) {
    const { data: member } = await supabase
      .from('workspace_members')
      .select('workspace_id, role')
      .eq('workspace_id', workspaceId)
      .eq('user_id', internalUserId)
      .maybeSingle();

    if (!member) {
      authCache.set(cacheKey, { expiresAt: Date.now() + AUTH_CACHE_TTL_MS, notMember: true });
      return res.status(403).json({ error: 'not_a_member' });
    }
    req.workspaceId = workspaceId;
    workspaceRole = member.role;
    // Per-member privacy (PRIVACY_MODEL.md): the logged-in user is the viewer.
    // owner/admin see all raw; member/viewer are scoped to their own content.
    req.memberUserId = internalUserId;
    req.workspaceRole = workspaceRole;
    req.viewerScope = (workspaceRole === 'owner' || workspaceRole === 'admin') ? 'admin' : 'member';
  }

  // Cache the success path
  authCache.set(cacheKey, {
    expiresAt: Date.now() + AUTH_CACHE_TTL_MS,
    user,
    internalUserId,
    workspaceRole,
  });

  next();
}

// Back-compat alias: routers still import { verifySupabaseAuth }.
export const verifySupabaseAuth = verifyClerkAuth;
