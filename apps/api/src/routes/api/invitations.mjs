import { Router } from 'express';
import { getSupabaseClient, recogniseTeamMembers, adoptCrmOwnership } from '@nous/core';
import { verifySupabaseAuth } from '../../middleware/supabaseAuth.mjs';
import { ensureUserAndTeam } from '../../lib/auth.mjs';
import { invalidateAuthCache } from '../../lib/auth.mjs';
import { canJoinByInvitedEmail, authProviderName, emailConfirmedWithoutRoundTrip } from '../../lib/authProvider/index.mjs';

export const invitationsRouter = Router();

// GET /api/invitations/:token — public, no auth
invitationsRouter.get('/:token', async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { token } = req.params;
    if (!token || token.length > 100) return res.status(400).json({ error: 'invalid_token_format' });

    const { data: invitation, error } = await supabase
      .from('team_invitations')
      .select('*, teams:team_id(id, name), invited_by:invited_by_user_id(id, name, email)')
      .eq('token', token)
      .maybeSingle();
    if (error) throw error;
    if (!invitation) return res.status(404).json({ error: 'invitation_not_found' });
    if (new Date(invitation.expires_at) < new Date()) return res.status(400).json({ error: 'invitation_expired' });
    if (invitation.status !== 'pending') return res.status(400).json({ error: 'invitation_already_processed', status: invitation.status });

    return res.json({ invitation: { id: invitation.id, email: invitation.email, role: invitation.role, team: invitation.teams, invited_by: invitation.invited_by, expires_at: invitation.expires_at } });
  } catch (err) {
    return res.status(500).json({ error: 'internal_error', ...(process.env.NODE_ENV !== 'production' && { detail: String(err.message) }) });
  }
});

// POST /api/invitations/:token/accept — requires auth
invitationsRouter.post('/:token/accept', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { token } = req.params;

    const { data: invitation, error: inviteError } = await supabase
      .from('team_invitations')
      .select('*, teams:team_id(id, name)')
      .eq('token', token)
      .maybeSingle();
    if (inviteError) throw inviteError;
    if (!invitation) return res.status(404).json({ error: 'invitation_not_found' });
    if (new Date(invitation.expires_at) < new Date()) {
      await supabase.from('team_invitations').update({ status: 'expired', updated_at: new Date().toISOString() }).eq('id', invitation.id);
      return res.status(400).json({ error: 'invitation_expired' });
    }

    let { user } = await ensureUserAndTeam(req.user, true);
    // Supabase Auth (self-host): a new invitee may have no Nous user yet. Under
    // autoconfirm an invite is never joined by matching the email, because anyone can
    // sign up as any address; and with DISABLE_SIGNUPS, /me never makes them a user of
    // their own. The token is the proof: provision them straight into the invited team,
    // provided the invite is still pending and addressed to this sign-in's email.
    // Never reached on Clerk, where /me provisions the invitee by email as before.
    if (!user && authProviderName() === 'supabase') {
      if ((req.user?.email || '').toLowerCase() !== invitation.email.toLowerCase()) return res.status(403).json({ error: 'email_mismatch' });
      if (invitation.status !== 'pending') return res.status(400).json({ error: 'invitation_already_processed', status: invitation.status });
      // Same proof as below, checked BEFORE provisioning, so a refused invitee is never left
      // with a users row already pointing at the invited team.
      if (!emailConfirmedWithoutRoundTrip() && !(await canJoinByInvitedEmail(req.user?.id, req.user?.email))) {
        return res.status(403).json({ error: 'email_unverified' });
      }
      ({ user } = await ensureUserAndTeam(req.user, false, { invitation }));
    }
    // A just-signed-up / just-returned-from-Google user may not be provisioned in
    // our DB yet (that happens lazily on /api/users/me). Return a retryable 409
    // instead of throwing a scary 500 — the client retries once the row exists.
    if (!user) return res.status(409).json({ error: 'provisioning', retry: true });
    if (user.email.toLowerCase() !== invitation.email.toLowerCase()) return res.status(403).json({ error: 'email_mismatch' });
    // The invite is addressed to an email; only someone who has proved they own it may take
    // it. Always true on Clerk (Cloud unchanged); on Supabase Auth it requires the address to
    // be proven by a confirmation email (see emailProvenByRoundTrip). Under autoconfirm no
    // address ever is, so there the invite link's token (sent to that address) is the only
    // proof there can be, and the email-equality check above is what remains.
    if (!emailConfirmedWithoutRoundTrip() && !(await canJoinByInvitedEmail(req.user?.id, user.email))) {
      return res.status(403).json({ error: 'email_unverified' });
    }

    const memberRole = invitation.role || 'member';

    // Idempotent accept. The frictionless flow can fire accept more than once (an
    // auto-accept effect + a returning-from-OAuth render + a manual click can all
    // race), so "already a member" or "already accepted by THIS user" must succeed,
    // not 500/400 — otherwise the winner joins the user but the loser shows an error
    // screen. Only a link already used by SOMEONE ELSE is a real failure.
    const { data: existingMember } = await supabase.from('team_members').select('id, role').eq('team_id', invitation.team_id).eq('user_id', user.id).maybeSingle();
    if (existingMember) {
      await supabase.from('team_invitations').update({ status: 'accepted', accepted_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('id', invitation.id);
      return res.json({ success: true, team: invitation.teams, role: existingMember.role || memberRole, onboarding_completed: true });
    }
    if (invitation.status !== 'pending') return res.status(400).json({ error: 'invitation_already_processed', status: invitation.status });

    // Tolerate a concurrent insert: the racing call gets a 23505 (already a member),
    // which is success, not an error.
    const { error: tmErr } = await supabase.from('team_members').insert({ team_id: invitation.team_id, user_id: user.id, role: memberRole });
    if (tmErr && tmErr.code !== '23505') throw tmErr;

    const { data: allWorkspaces } = await supabase.from('workspaces').select('id').eq('team_id', invitation.team_id);
    if (allWorkspaces?.length) {
      const wsRole = ['founder', 'owner', 'admin'].includes(memberRole) ? 'admin' : memberRole === 'member' ? 'member' : 'viewer';
      // Auto-assign the pre-picked department, but only on the workspace it belongs to
      // (departments are per-workspace) — so the member lands in the right team on join.
      let deptWorkspaceId = null;
      if (invitation.department_id) {
        const { data: d } = await supabase.from('company_departments').select('workspace_id').eq('id', invitation.department_id).maybeSingle();
        deptWorkspaceId = d?.workspace_id ?? null;
      }
      await Promise.allSettled(allWorkspaces.map(ws => supabase.from('workspace_members').insert({
        workspace_id: ws.id, user_id: user.id, role: wsRole,
        department_id: (deptWorkspaceId && ws.id === deptWorkspaceId) ? invitation.department_id : null,
      }).select().single()));
      // A new teammate is an operator, not a prospect. Flag them internal on every
      // workspace they just joined so their emails and your internal meetings are
      // never treated as leads. Best-effort: a hiccup here must not fail the accept.
      await Promise.allSettled(allWorkspaces.map(ws => recogniseTeamMembers(supabase, ws.id)));
      // And the records that were already theirs in the CRM become theirs here: imported rows
      // carry the owner's EMAIL and no user id until that person exists (GET-284).
      await Promise.allSettled(allWorkspaces.map(ws => adoptCrmOwnership(supabase, ws.id, user.id)));
    }

    if (user.team_id !== invitation.team_id) {
      try { await supabase.from('users').update({ team_id: invitation.team_id }).eq('id', user.id); } catch { /* best-effort */ }
      // Their team just changed; the 30s identity cache must not serve the old one (GET-312).
      invalidateAuthCache(req.user?.id);
    }

    if (!user.onboarding_completed_at) {
      try { await supabase.from('users').update({ onboarding_completed_at: new Date().toISOString() }).eq('id', user.id); } catch { /* best-effort */ }
    }

    await supabase.from('team_invitations').update({ status: 'accepted', accepted_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('id', invitation.id);

    return res.json({ success: true, team: invitation.teams, role: memberRole, onboarding_completed: true });
  } catch (err) {
    return res.status(500).json({ error: 'internal_error', ...(process.env.NODE_ENV !== 'production' && { detail: String(err.message) }) });
  }
});
