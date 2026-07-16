import { getSupabaseClient } from '@nous/core';
import { setUser } from 'useleak';
import { isSelfHosted } from '../lib/plans.mjs';

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
// request used to do up to 3 round-trips: supabase.auth.getUser() over the
// network, the public.users lookup, and the workspace_members membership
// check. Caching the resolved (user, internalUserId, hasMembership) tuple
// for 60s drops most requests to zero DB calls.
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

export async function verifySupabaseAuth(req, res, next) {
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
    req.supabaseUser = cached.user;
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

  const supabase = getSupabaseClient();
  const { data: { user }, error } = await supabase.auth.getUser(token);

  if (error || !user) {
    // Cache the rejection too, briefly — stops a flood of bad-token retries
    // from hammering Supabase auth.
    authCache.set(cacheKey, { expiresAt: Date.now() + 10_000, invalid: true });
    return res.status(401).json({ error: 'invalid_token' });
  }

  req.user = user;
  req.supabaseUser = user;
  identify(user);

  // workspace_members stores the internal users.id, not the auth UUID.
  // Resolve the internal user record so membership checks use the right ID.
  const { data: internalUser } = await supabase
    .from('users')
    .select('id, supabase_user_id')
    .eq('supabase_user_id', user.id)
    .maybeSingle();

  let internalUserId = internalUser?.id;

  // Email fallback for migrated users whose supabase_user_id may not be set yet.
  if (!internalUserId && user.email) {
    const { data: byEmail } = await supabase
      .from('users')
      .select('id, supabase_user_id')
      .ilike('email', user.email)
      .maybeSingle();
    if (byEmail) {
      internalUserId = byEmail.id;
      if (!byEmail.supabase_user_id) {
        try {
          await supabase.from('users')
            .update({ supabase_user_id: user.id })
            .eq('id', byEmail.id);
        } catch { /* best-effort backfill */ }
      }
    }
  }

  if (!internalUserId) internalUserId = user.id;
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
