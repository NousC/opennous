// Decide the per-member identity + scope for a newly minted API key.
// See PRIVACY_MODEL.md. A key acts AS the member who created it, so the agent
// reading through it is scoped to that member's raw content — unless the member
// is an owner/admin (they see all raw) or the caller explicitly asks for a
// shared workspace key (an automation key not tied to a person).
//
// Returns { owner_user_id, scope } to spread into the api_keys insert.
export function apiKeyScopeFor(req, opts = {}) {
  // Explicit shared/workspace key: no owner, admin scope (sees all). Use for a
  // cron/automation identity that isn't a person.
  if (opts.workspaceKey) return { owner_user_id: null, scope: 'admin' };

  const ownerUserId = req.internalUserId ?? req.memberUserId ?? null;
  // No resolved user (shouldn't happen on an authed frontend route): fall back to
  // a legacy admin key so we never mint a broken member key with a null owner.
  if (!ownerUserId) return { owner_user_id: null, scope: 'admin' };

  const role = req.workspaceRole;
  const scope = (role === 'owner' || role === 'admin') ? 'admin' : 'member';
  return { owner_user_id: ownerUserId, scope };
}
