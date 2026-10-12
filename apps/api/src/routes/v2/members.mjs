// /v2/members — who is on the workspace, and (admin keys only) inviting and removing people.
//
//   GET    /v2/members        the roster — the same handler as GET /v2/workspace/members
//   POST   /v2/members        { email, role? } → an email invitation, the app's invite flow
//   DELETE /v2/members/:id    take a user (by user id) off the team and its workspaces
//
// The team is the workspace's team (resolveRequestTeam), never a team the key can't reach.
// Invite and remove go through lib/teamMembership.mjs — the same code Settings → Team runs.

import { Router } from 'express';
import { getSupabaseClient } from '@nous/core';
import { listWorkspaceMembers } from './workspaceStatus.mjs';
import { resolveRequestTeam } from '../../lib/access.mjs';
import { auditLog } from '../../lib/audit.mjs';
import { ADMIN_TEAM_ROLES, checkTeamMembership, createTeamInvitation, removeTeamMember } from '../../lib/teamMembership.mjs';
import { allowQueryParams, requireAdminKey } from '../../lib/v2Query.mjs';

export const membersV2Router = Router();

// Roles an API key may hand out. The app's form also knows founder/owner; an owner seat is not
// something an API key should be able to mint, so the API stops at admin.
export const INVITE_ROLES = ['admin', 'member', 'viewer'];

membersV2Router.get('/', allowQueryParams([]), listWorkspaceMembers);

/**
 * Who the invitation is from. A key bound to a person invites as that person, and only while
 * they still administer the team. A workspace key (no person) invites as the team's founder —
 * the same person whoami acts as for that key — falling back to the workspace's owner.
 */
async function resolveInviter(supabase, req, teamId) {
  const pick = async (id) => {
    const { data } = await supabase.from('users').select('id, name, email').eq('id', id).maybeSingle();
    return data ?? null;
  };
  if (req.memberUserId) {
    const m = await checkTeamMembership(req.memberUserId, teamId, ADMIN_TEAM_ROLES);
    return { inviter: m ? await pick(req.memberUserId) : null, authorized: !!m };
  }
  const { data: founder } = await supabase.from('team_members')
    .select('user_id').eq('team_id', teamId).eq('role', 'founder').maybeSingle();
  let id = founder?.user_id ?? null;
  if (!id) {
    const { data: owners } = await supabase.from('workspace_members')
      .select('user_id, role').eq('workspace_id', req.workspaceId).eq('role', 'owner');
    id = owners?.[0]?.user_id ?? null;
  }
  return { inviter: id ? await pick(id) : null, authorized: true };
}

// POST /v2/members { email, role? = 'member' }
// 201 { invitation: { id, email, role, status, expires_at, created_at }, email_sent, invite_link, email_error? }
membersV2Router.post('/', allowQueryParams([]), requireAdminKey, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { team } = await resolveRequestTeam(req);
    const { email, role = 'member' } = req.body || {};

    const { inviter, authorized } = await resolveInviter(supabase, req, team.id);
    if (authorized && !inviter) return res.status(409).json({ error: 'no_team_owner', detail: 'This workspace has no owner to send the invitation from.' });

    const out = await createTeamInvitation(supabase, {
      teamId: team.id, inviter: inviter ?? { id: null }, email, role,
      allowedRoles: INVITE_ROLES,
      authorize: async () => authorized,
    });
    if (!out.ok) {
      const { ok: _ok, status, code, message, ...extra } = out;
      return res.status(status).json({ error: code, ...(message ? { detail: message } : {}), ...extra });
    }

    auditLog({
      actor_user_id: req.memberUserId ?? null,
      action: 'member.invited',
      target_type: 'invitation',
      target_id: out.invitation.id,
      target_workspace_id: req.workspaceId,
      metadata: { role: out.invitation.role, via: 'api_key', api_key_id: req.apiKeyId ?? null },
      ip: req.ip ?? null,
    });

    return res.status(201).json({
      invitation: out.invitation,
      email_sent: out.email.sent,
      invite_link: out.email.link,
      ...(out.email.sent ? {} : { email_error: out.email.reason ?? 'send_failed' }),
    });
  } catch (err) {
    console.error('[POST /v2/members]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// DELETE /v2/members/:id — :id is the user id (GET /v2/members → user_id).
// 200 { removed: true, user_id }
// Refuses (400) the founder, the key's own person, and the team's last founder/owner/admin —
// the app's two rules plus the one that keeps a team from ending up with nobody to run it.
membersV2Router.delete('/:id', allowQueryParams([]), requireAdminKey, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { team } = await resolveRequestTeam(req);
    const userId = String(req.params.id);

    const { data: target } = await supabase.from('team_members')
      .select('role').eq('team_id', team.id).eq('user_id', userId).maybeSingle();
    if (!target) return res.status(404).json({ error: 'member_not_found' });

    if (req.memberUserId) {
      // A person-bound admin key acts as that person — who must still administer the team.
      const m = await checkTeamMembership(req.memberUserId, team.id, ADMIN_TEAM_ROLES);
      if (!m) return res.status(403).json({ error: 'insufficient_permissions' });
    }
    if (target.role === 'founder') return res.status(400).json({ error: 'cannot_remove_founder' });
    if (req.memberUserId && userId === req.memberUserId) return res.status(400).json({ error: 'cannot_remove_self' });
    if (ADMIN_TEAM_ROLES.includes(target.role)) {
      const { data: admins } = await supabase.from('team_members')
        .select('user_id, role').eq('team_id', team.id).in('role', ADMIN_TEAM_ROLES);
      if (!(admins ?? []).some(a => a.user_id !== userId)) {
        return res.status(400).json({ error: 'cannot_remove_last_admin' });
      }
    }

    await removeTeamMember(supabase, team.id, userId);
    auditLog({
      actor_user_id: req.memberUserId ?? null,
      action: 'member.removed',
      target_type: 'user',
      target_id: userId,
      target_workspace_id: req.workspaceId,
      metadata: { role: target.role, via: 'api_key', api_key_id: req.apiKeyId ?? null },
      ip: req.ip ?? null,
    });
    return res.json({ removed: true, user_id: userId });
  } catch (err) {
    console.error('[DELETE /v2/members/:id]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});
