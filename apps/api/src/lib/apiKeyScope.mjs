// Decide the per-member identity + scope for a newly minted API key.
// See PRIVACY_MODEL.md. A key acts AS the member who created it, so the agent
// reading through it is scoped to that member's raw content — unless the member
// is an owner/admin (they see all raw) or the caller explicitly asks for a
// shared workspace key (an automation key not tied to a person).
//
// Returns { owner_user_id, scope } to spread into the api_keys insert.
export function apiKeyScopeFor(req, opts = {}) {
  const role = req.workspaceRole;
  const isAdmin = role === 'owner' || role === 'admin';

  // Explicit shared/workspace key: no owner, admin scope (sees ALL raw). ADMINS
  // ONLY — a member requesting this must never receive an admin-scoped key, or
  // they could read every other member's private raw content (breaks the
  // per-member privacy model in PRIVACY_MODEL.md). A non-admin who asks falls
  // through to a member-scoped key below rather than being elevated.
  if (opts.workspaceKey && isAdmin) return { owner_user_id: null, scope: 'admin' };

  const ownerUserId = req.internalUserId ?? req.memberUserId ?? null;
  // Fail CLOSED. A null-owner key is admin-scoped (sees ALL raw content), so silently
  // falling back to one when we couldn't resolve the caller is a privilege escalation —
  // an unauthenticated or half-resolved request must never yield an admin key. The only
  // legitimate null-owner key is the explicit admin workspace key handled above. Throw so
  // the route refuses to mint anything rather than mint the most powerful thing.
  if (!ownerUserId) {
    const e = new Error('Cannot mint an API key without a resolved user.');
    e.code = 'no_resolved_user';
    throw e;
  }

  const scope = isAdmin ? 'admin' : 'member';
  return { owner_user_id: ownerUserId, scope };
}

/** How long a new key lives unless someone chooses otherwise (GET-1061). */
export const DEFAULT_KEY_DAYS = 90;
/** The longest a key can be asked to last. Longer than this is what no expiry is for. */
export const MAX_KEY_DAYS = 365;

/** When a key made in Settings expires. 0 asks for no expiry, which only an admin can choose. */
export function keyExpiry(body, { isAdmin, now = Date.now() }) {
  const asked = Number(body?.expires_in_days);
  if (body?.expires_in_days === 0 && isAdmin) return null;
  const days = body?.expires_in_days != null && Number.isFinite(asked) && asked > 0
    ? Math.min(asked, MAX_KEY_DAYS) : DEFAULT_KEY_DAYS;
  return new Date(now + days * 86_400_000).toISOString();
}

/** What a grant may do. Read/write unless the person chose read-only on the consent screen. */
export const grantCapability = (body) => (body?.capability === 'read_only' ? 'read_only' : 'read_write');

// Revoke a person's live API keys, and the OAuth tokens minted on them, when they lose access
// (GET-1058): removed from a team or workspace, or deleted by a platform admin. Pass workspaceIds
// to limit it to the workspaces they left; omit it to revoke everywhere. Returns the revoked key
// ids. Best-effort: the key middleware already refuses a key whose owner is no longer a member, so
// a failure here leaves a dead row behind, never a working key. It logs and returns [] instead of
// failing the removal.
export async function revokeMemberKeys(supabase, userId, { workspaceIds } = {}) {
  if (!userId) return [];
  if (Array.isArray(workspaceIds) && !workspaceIds.length) return [];
  try {
    const now = new Date().toISOString();
    let q = supabase.from('api_keys').update({ revoked_at: now })
      .eq('owner_user_id', userId).is('revoked_at', null);
    if (workspaceIds) q = q.in('workspace_id', workspaceIds);
    const { data: keys, error } = await q.select('id');
    if (error) throw error;
    const ids = (keys || []).map((k) => k.id);
    if (ids.length) {
      const { error: tokErr } = await supabase.from('oauth_tokens').update({ revoked_at: now })
        .in('api_key_id', ids).is('revoked_at', null);
      if (tokErr) throw tokErr;
    }
    return ids;
  } catch (err) {
    console.error('[api-keys] revokeMemberKeys failed', { userId, error: err?.message || String(err) });
    return [];
  }
}
