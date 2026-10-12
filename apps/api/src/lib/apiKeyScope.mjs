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
