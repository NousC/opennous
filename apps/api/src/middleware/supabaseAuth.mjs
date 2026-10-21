import { getSupabaseClient } from '@nous/core';
import { setUser } from 'useleak';
import { isSelfHosted } from '../lib/plans.mjs';
import { getAuthProvider, identityColumn, canBindEmailIdentity, findUserByAuthId } from '../lib/authProvider/index.mjs';
import { noteActive } from '../lib/productEvents.mjs';

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

// Verify a session token with the configured auth provider (Clerk on Cloud,
// Supabase Auth on self-host — see lib/authProvider), resolve the internal user,
// and attach the request identity. Exported as `verifySupabaseAuth` (the name the
// many routers import) and `verifyClerkAuth` (the name used while Cloud was the
// only path). The contract (req.user, req.internalUserId, req.workspaceId,
// req.viewerScope) is the same for every provider.
export async function verifyAuth(req, res, next) {
  const token = req.headers.authorization?.startsWith('Bearer ')
    ? req.headers.authorization.slice(7)
    : null;

  if (!token) return res.status(401).json({ error: 'auth_required' });

  const workspaceId = req.query.workspaceId || req.query.workspace_id || req.body?.workspaceId || req.body?.workspace_id;

  // Verify FIRST, then look in the cache by WHO the token says they are (GET-315).
  //
  // This cache was keyed by the token string, and Clerk rotates a session token about once a
  // minute — so a 60-second cache almost never hit, and nearly every request paid the full path:
  // profile resolution, the users lookup, the membership check. That was the ~1.3s floor under
  // every endpoint in the app, list pages included.
  //
  // Verification stays on every request (signature and expiry, checked locally against a cached
  // JWKS), so a rotated token is still checked and an expired one is still rejected. Only the
  // lookups that depend on the IDENTITY, not on the token string, are reused.
  let provider;
  try {
    provider = await getAuthProvider();
  } catch (err) {
    console.error('[auth] auth provider failed to load:', err?.message || err);
    return res.status(500).json({ error: 'auth_unavailable' });
  }
  let verified;
  try {
    verified = await provider.verifyToken(token);
  } catch {
    return res.status(401).json({ error: 'invalid_token' });
  }
  const subject = verified?.authUserId;
  if (!subject) return res.status(401).json({ error: 'invalid_token' });

  const cacheKey = `${subject}:${workspaceId || ''}`;
  const cached = authCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
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
    noteActive(cached.internalUserId, cached.user?.email, workspaceId);
    return next();
  }

  const authUserId = subject;
  const idColumn = identityColumn(provider.name);

  // Resolve email/name/avatar (from the token claims when they carry them, else
  // one provider API fetch). Only actually needed for provisioning/fallback,
  // but kept on req.user so downstream ensureUserAndTeam() has the same shape it
  // had with the Supabase user object.
  let profile;
  try {
    profile = await provider.getProfile(verified);
  } catch {
    profile = { email: null, name: null, avatarUrl: null };
  }

  const user = {
    id: authUserId,
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
  const { data: internalUser } = await findUserByAuthId(supabase, authUserId, `id, ${idColumn}`, provider.name);

  let internalUserId = internalUser?.id;

  // Email fallback for imported users whose auth id column may not be set yet.
  // Backfill it so future lookups hit the fast path above.
  if (!internalUserId && user.email) {
    const { data: byEmail } = await supabase
      .from('users')
      .select(`id, ${idColumn}`)
      // Escape LIKE metachars (%/_/\) so a Clerk email like "a_min@x.com" can't
      // wildcard-match a different user's row and bind onto it.
      .ilike('email', user.email.replace(/[\\%_]/g, '\\$&'))
      .maybeSingle();
    // Only bind an auth identity onto an existing internal user when its email is
    // VERIFIED. Otherwise signing up as victim@corp.com with an unverified address would
    // inherit the victim's team, workspaces, and role — account takeover. Unverified falls
    // through to a fresh, unlinked identity (internalUserId = authUserId below).
    if (byEmail && await canBindEmailIdentity(authUserId, user.email)) {
      internalUserId = byEmail.id;
      if (!byEmail[idColumn]) {
        try {
          await supabase.from('users')
            .update({ [idColumn]: authUserId })
            .eq('id', byEmail.id);
        } catch { /* best-effort backfill */ }
      }
    }
  }

  if (!internalUserId) internalUserId = authUserId;
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

  noteActive(req.internalUserId, req.user?.email, workspaceId);
  next();
}

// Back-compat aliases: routers import { verifySupabaseAuth }; requireAdmin's
// comments and older code say verifyClerkAuth. All three are the same middleware.
export const verifySupabaseAuth = verifyAuth;
export const verifyClerkAuth = verifyAuth;
