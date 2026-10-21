import { Router } from 'express';
import crypto from 'crypto';
import { captureProductEvent } from '../../lib/productEvents.mjs';
import { getSupabaseClient } from '@nous/core';
import { verifySupabaseAuth } from '../../middleware/supabaseAuth.mjs';
import { ensureUserAndTeam } from '../../lib/auth.mjs';
import { auditFromReq } from '../../lib/audit.mjs';
import { checkTeamMembership, createTeamInvitation, removeTeamMember } from '../../lib/teamMembership.mjs';
import { JOB_ROLES } from './me.mjs';
import { emailConfirmedWithoutRoundTrip } from '../../lib/authProvider/index.mjs';
import { isSelfHosted } from '../../lib/plans.mjs';
import { publicApiBase } from '../../lib/publicApiBase.mjs';

// The command a teammate runs. The CLI talks to Nous Cloud unless told otherwise, so a
// self-hosted instance names its own API. Cloud's command is unchanged.
export function joinCommand(token, { selfHosted = isSelfHosted(), apiBase = publicApiBase } = {}) {
  return selfHosted ? `npx @opennous/cli join ${token} --url ${apiBase()}` : `npx @opennous/cli join ${token}`;
}

export const teamsRouter = Router();

// PATCH /api/teams/:teamId
teamsRouter.patch('/:teamId', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { teamId } = req.params;
    const { name } = req.body;
    const { user, team } = await ensureUserAndTeam(req.user);
    if (!name?.trim()) return res.status(400).json({ error: 'name is required' });
    // Your home team, as before — or a team you administer, which is how an operator renames a
    // client's team from inside the client's workspace (GET-241).
    if (team.id !== teamId && !(await checkTeamMembership(user.id, teamId, ['founder', 'owner', 'admin']))) {
      return res.status(403).json({ error: 'team_not_found_or_unauthorized' });
    }
    const { data: updatedTeam, error } = await supabase.from('teams').update({ name: name.trim() }).eq('id', teamId).select().single();
    if (error) throw error;
    return res.json({ team: updatedTeam });
  } catch (err) {
    return res.status(500).json({ error: 'internal_error', ...(process.env.NODE_ENV !== 'production' && { detail: String(err.message) }) });
  }
});

// GET /api/teams/:teamId/members
teamsRouter.get('/:teamId/members', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { teamId } = req.params;
    const { user } = await ensureUserAndTeam(req.user);
    const membership = await checkTeamMembership(user.id, teamId);
    if (!membership) return res.status(403).json({ error: 'team_not_found_or_unauthorized' });

    const { data: members } = await supabase.from('team_members')
      .select('*, users:user_id(id, name, email, profile_picture_url)')
      .eq('team_id', teamId)
      .order('joined_at', { ascending: true });

    return res.json({ members: members || [] });
  } catch (err) {
    return res.status(500).json({ error: 'internal_error', ...(process.env.NODE_ENV !== 'production' && { detail: String(err.message) }) });
  }
});

// DELETE /api/teams/:teamId/members/:userId
teamsRouter.delete('/:teamId/members/:userId', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { teamId, userId } = req.params;
    const { user } = await ensureUserAndTeam(req.user);

    const membership = await checkTeamMembership(user.id, teamId, ['founder', 'owner', 'admin']);
    if (!membership) return res.status(403).json({ error: 'insufficient_permissions' });

    const { data: target } = await supabase.from('team_members').select('role').eq('team_id', teamId).eq('user_id', userId).maybeSingle();
    if (target?.role === 'founder') return res.status(400).json({ error: 'cannot_remove_founder' });
    if (userId === user.id) return res.status(400).json({ error: 'cannot_remove_self' });

    await removeTeamMember(supabase, teamId, userId);
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: 'internal_error', ...(process.env.NODE_ENV !== 'production' && { detail: String(err.message) }) });
  }
});

// PATCH /api/teams/:teamId/members/:userId — change a member's role (admin <-> member).
// Only an admin/owner/founder can. The founder's role is fixed, and you can't change
// your own (so the last admin can't lock themselves out). Mirrors the new role onto
// workspace_members so the visibility/governance axis stays in sync.
teamsRouter.patch('/:teamId/members/:userId', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { teamId, userId } = req.params;
    const { role } = req.body || {};
    const { user } = await ensureUserAndTeam(req.user);

    if (!['admin', 'member'].includes(role)) return res.status(400).json({ error: 'invalid_role' });

    const membership = await checkTeamMembership(user.id, teamId, ['founder', 'owner', 'admin']);
    if (!membership) return res.status(403).json({ error: 'insufficient_permissions' });

    const { data: target } = await supabase.from('team_members').select('role').eq('team_id', teamId).eq('user_id', userId).maybeSingle();
    if (!target) return res.status(404).json({ error: 'member_not_found' });
    if (target.role === 'founder') return res.status(400).json({ error: 'cannot_change_founder' });
    if (userId === user.id) return res.status(400).json({ error: 'cannot_change_own_role' });

    await supabase.from('team_members').update({ role }).eq('team_id', teamId).eq('user_id', userId);

    // Keep workspace_members in step — the visibility/governance role axis reads it.
    const { data: workspaces } = await supabase.from('workspaces').select('id').eq('team_id', teamId);
    const wsIds = (workspaces || []).map(w => w.id);
    if (wsIds.length) {
      await supabase.from('workspace_members').update({ role }).in('workspace_id', wsIds).eq('user_id', userId);
    }

    auditFromReq(req, {
      action: 'member.role_changed',
      target_type: 'user',
      target_id: userId,
      target_workspace_id: wsIds[0] ?? null,
      metadata: { role, from: target.role },
    });

    return res.json({ success: true, role });
  } catch (err) {
    return res.status(500).json({ error: 'internal_error', ...(process.env.NODE_ENV !== 'production' && { detail: String(err.message) }) });
  }
});

// GET /api/teams/:teamId/workspaces
teamsRouter.get('/:teamId/workspaces', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { teamId } = req.params;
    const { user } = await ensureUserAndTeam(req.user);
    const membership = await checkTeamMembership(user.id, teamId, ['founder', 'owner', 'admin']);
    if (!membership) return res.status(403).json({ error: 'insufficient_permissions' });

    const { data: workspaces } = await supabase.from('workspaces').select('*').eq('team_id', teamId).order('created_at', { ascending: false });
    const { data: teamMembers } = await supabase.from('team_members').select('*, users:user_id(id, name, email, profile_picture_url)').eq('team_id', teamId);
    const workspaceIds = (workspaces || []).map(w => w.id);
    let wsMembers = [];
    if (workspaceIds.length) {
      const { data } = await supabase.from('workspace_members').select('workspace_id, user_id, role').in('workspace_id', workspaceIds);
      wsMembers = data || [];
    }

    const workspacesWithAccess = (workspaces || []).map(ws => ({
      ...ws,
      members: (teamMembers || []).map(m => ({
        ...m,
        has_workspace_access: wsMembers.some(wm => wm.workspace_id === ws.id && wm.user_id === m.user_id),
        workspace_role: wsMembers.find(wm => wm.workspace_id === ws.id && wm.user_id === m.user_id)?.role || null,
      })),
    }));

    return res.json({ workspaces: workspacesWithAccess });
  } catch (err) {
    return res.status(500).json({ error: 'internal_error', ...(process.env.NODE_ENV !== 'production' && { detail: String(err.message) }) });
  }
});

// POST /api/teams/:teamId/invitations — the shared invite (lib/teamMembership.mjs), which
// /v2/members uses too. The error bodies below are the ones this route has always sent.
const LEGACY_INVITE_ERRORS = { email_required: 'email is required' };
teamsRouter.post('/:teamId/invitations', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { teamId } = req.params;
    const { email, role = 'member', department_id = null } = req.body;
    const { user } = await ensureUserAndTeam(req.user);

    const out = await createTeamInvitation(supabase, {
      teamId, inviter: user, email, role, departmentId: department_id,
      authorize: async () => !!(await checkTeamMembership(user.id, teamId, ['founder', 'owner', 'admin'])),
    });
    if (!out.ok) {
      const { ok: _ok, status, code, supported: _s, ...extra } = out;
      return res.status(status).json({ error: LEGACY_INVITE_ERRORS[code] ?? code, ...extra });
    }

    captureProductEvent({ distinctId: user.id, event: 'invite_sent', properties: { role: role ?? null } });
    return res.json({
      invitation: out.invitation,
      emailSent: out.email.sent,
      inviteLink: out.email.link,
      ...(out.email.error ? { emailError: out.email.error } : {}),
    });
  } catch (err) {
    return res.status(500).json({ error: 'internal_error', ...(process.env.NODE_ENV !== 'production' && { detail: String(err.message) }) });
  }
});

// GET /api/teams/:teamId/invitations
teamsRouter.get('/:teamId/invitations', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { teamId } = req.params;
    const { user } = await ensureUserAndTeam(req.user);
    const membership = await checkTeamMembership(user.id, teamId, ['founder', 'owner', 'admin']);
    if (!membership) return res.status(403).json({ error: 'insufficient_permissions' });

    // Only PENDING invites belong in the "Pending invitations" list. Without this
    // filter, cancelled/accepted/expired rows kept coming back and the UI (which
    // hardcodes a "Pending" label) showed them as still pending — so a cancel
    // looked like it did nothing even though the status had flipped to cancelled.
    const { data: invitations } = await supabase.from('team_invitations')
      .select('*, invited_by:invited_by_user_id(id, name, email)')
      .eq('team_id', teamId).eq('status', 'pending').order('created_at', { ascending: false });
    return res.json({ invitations: invitations || [] });
  } catch (err) {
    return res.status(500).json({ error: 'internal_error', ...(process.env.NODE_ENV !== 'production' && { detail: String(err.message) }) });
  }
});

// DELETE /api/teams/:teamId/invitations/:invitationId
teamsRouter.delete('/:teamId/invitations/:invitationId', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { teamId, invitationId } = req.params;
    const { user } = await ensureUserAndTeam(req.user);
    const membership = await checkTeamMembership(user.id, teamId, ['founder', 'owner', 'admin']);
    if (!membership) return res.status(403).json({ error: 'insufficient_permissions' });

    const { data: invitation } = await supabase.from('team_invitations').select('id, status').eq('id', invitationId).eq('team_id', teamId).maybeSingle();
    if (!invitation) return res.status(404).json({ error: 'invitation_not_found' });
    if (invitation.status !== 'pending') return res.status(400).json({ error: 'invitation_already_processed' });

    await supabase.from('team_invitations').update({ status: 'cancelled', updated_at: new Date().toISOString() }).eq('id', invitationId);
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: 'internal_error', ...(process.env.NODE_ENV !== 'production' && { detail: String(err.message) }) });
  }
});

// ── Join tokens ──────────────────────────────────────────────────────────────
// Reusable, owner-issued tokens a teammate redeems over the CLI (`nous join <token>`)
// to self-provision a member-scoped identity — no per-email invite. See
// docs/api-plan-cli-join.md. Owner/admin only, same guard as invitations.

// POST /api/teams/:teamId/join-tokens  { role?, domain?, max_uses?, expires_in_days?, member_credit_budget? }
teamsRouter.post('/:teamId/join-tokens', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { teamId } = req.params;
    const { role = 'member', domain, max_uses, expires_in_days, member_credit_budget, department_id = null,
            job_role = null, invitee_name = null, invitee_email = null } = req.body || {};
    const { user } = await ensureUserAndTeam(req.user);

    const membership = await checkTeamMembership(user.id, teamId, ['founder', 'owner', 'admin']);
    if (!membership) return res.status(403).json({ error: 'insufficient_permissions' });
    if (!['member', 'viewer', 'admin'].includes(role)) return res.status(400).json({ error: 'invalid_role', detail: 'Join tokens grant member, admin, or viewer.' });

    // Pre-assign the invitee's GTM role so they land already scoped — role-report works on
    // their first onboarding, no "set your role later". Unknown roles are dropped, not rejected.
    const jobRole = typeof job_role === 'string' && JOB_ROLES.includes(job_role) ? job_role : null;
    const inviteeName  = typeof invitee_name === 'string' && invitee_name.trim() ? invitee_name.trim() : null;
    const inviteeEmail = typeof invitee_email === 'string' && invitee_email.trim() ? invitee_email.trim().toLowerCase() : null;

    // Optional: pre-assign a department (parity with the email-invite path). It must be a
    // real department in one of THIS team's workspaces (never another team's).
    let departmentId = null;
    if (department_id) {
      const { data: dept } = await supabase
        .from('company_departments').select('id, workspace_id').eq('id', department_id).maybeSingle();
      const { data: ws } = dept
        ? await supabase.from('workspaces').select('id').eq('id', dept.workspace_id).eq('team_id', teamId).maybeSingle()
        : { data: null };
      if (!dept || !ws) return res.status(400).json({ error: 'invalid_department' });
      departmentId = department_id;
    }

    const cleanDomain = typeof domain === 'string' && domain.trim()
      ? domain.trim().toLowerCase().replace(/^@/, '')
      : null;
    // Self-host with autoconfirm: any address can be signed up without proof, so a
    // domain lock would only look like protection. Refuse it up front (redeeming one is
    // refused too, see cliAuth approveJoin). Never true on Clerk.
    if (cleanDomain && emailConfirmedWithoutRoundTrip()) {
      return res.status(400).json({
        error: 'domain_lock_unavailable',
        message: 'This instance confirms email addresses without sending an email (no SMTP), so it cannot check a domain. Create the join link without one, or set up SMTP first.',
      });
    }
    const expiresAt = Number.isFinite(Number(expires_in_days)) && Number(expires_in_days) > 0
      ? new Date(Date.now() + Number(expires_in_days) * 86_400_000).toISOString()
      : null;

    const token = `tj_${crypto.randomBytes(24).toString('hex')}`;
    const { data: row, error } = await supabase.from('team_join_tokens')
      .insert({
        team_id: teamId,
        token,
        role,
        domain: cleanDomain,
        max_uses: Number.isFinite(Number(max_uses)) && Number(max_uses) > 0 ? Math.floor(Number(max_uses)) : null,
        member_credit_budget: Number.isFinite(Number(member_credit_budget)) && Number(member_credit_budget) > 0 ? Math.floor(Number(member_credit_budget)) : null,
        department_id: departmentId,
        job_role: jobRole,
        invitee_name: inviteeName,
        invitee_email: inviteeEmail,
        created_by: user.id,
        expires_at: expiresAt,
      })
      .select().single();
    if (error) throw error;

    auditFromReq(req, { action: 'team.join_token_created', target_type: 'join_token', target_id: row.id, metadata: { role, job_role: jobRole, domain: cleanDomain } });
    return res.json({ join_token: publicJoinToken(row), command: joinCommand(token) });
  } catch (err) {
    return res.status(500).json({ error: 'internal_error', ...(process.env.NODE_ENV !== 'production' && { detail: String(err.message) }) });
  }
});

// GET /api/teams/:teamId/join-tokens — active (not revoked, not expired) tokens.
teamsRouter.get('/:teamId/join-tokens', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { teamId } = req.params;
    const { user } = await ensureUserAndTeam(req.user);
    const membership = await checkTeamMembership(user.id, teamId, ['founder', 'owner', 'admin']);
    if (!membership) return res.status(403).json({ error: 'insufficient_permissions' });

    const { data: rows } = await supabase.from('team_join_tokens')
      .select('*').eq('team_id', teamId).is('revoked_at', null)
      .order('created_at', { ascending: false });
    const now = Date.now();
    const active = (rows || []).filter((r) => !r.expires_at || new Date(r.expires_at).getTime() > now);
    return res.json({ join_tokens: active.map((r) => publicJoinToken(r, { includeToken: true })) });
  } catch (err) {
    return res.status(500).json({ error: 'internal_error', ...(process.env.NODE_ENV !== 'production' && { detail: String(err.message) }) });
  }
});

// DELETE /api/teams/:teamId/join-tokens/:id — revoke.
teamsRouter.delete('/:teamId/join-tokens/:id', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { teamId, id } = req.params;
    const { user } = await ensureUserAndTeam(req.user);
    const membership = await checkTeamMembership(user.id, teamId, ['founder', 'owner', 'admin']);
    if (!membership) return res.status(403).json({ error: 'insufficient_permissions' });

    const { data: row } = await supabase.from('team_join_tokens').select('id').eq('id', id).eq('team_id', teamId).maybeSingle();
    if (!row) return res.status(404).json({ error: 'join_token_not_found' });
    await supabase.from('team_join_tokens').update({ revoked_at: new Date().toISOString() }).eq('id', id);
    auditFromReq(req, { action: 'team.join_token_revoked', target_type: 'join_token', target_id: id });
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: 'internal_error', ...(process.env.NODE_ENV !== 'production' && { detail: String(err.message) }) });
  }
});

// Shape a join-token row for the client. The full token is a secret: returned on
// create and to the owner's active-token list (so they can re-copy the command),
// never anywhere else.
function publicJoinToken(r, { includeToken = false } = {}) {
  return {
    id: r.id,
    role: r.role,
    domain: r.domain,
    max_uses: r.max_uses,
    uses: r.uses,
    member_credit_budget: r.member_credit_budget,
    expires_at: r.expires_at,
    created_at: r.created_at,
    ...(includeToken ? { token: r.token, command: joinCommand(r.token) } : {}),
  };
}
