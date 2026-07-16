import { Router } from 'express';
import { getSupabaseClient, recogniseTeamMembers } from '@nous/core';
import { verifySupabaseAuth } from '../../middleware/supabaseAuth.mjs';
import { ensureUserAndTeam } from '../../lib/auth.mjs';

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

    const { user } = await ensureUserAndTeam(req.user, true);
    // A just-signed-up / just-returned-from-Google user may not be provisioned in
    // our DB yet (that happens lazily on /api/users/me). Return a retryable 409
    // instead of throwing a scary 500 — the client retries once the row exists.
    if (!user) return res.status(409).json({ error: 'provisioning', retry: true });
    if (user.email.toLowerCase() !== invitation.email.toLowerCase()) return res.status(403).json({ error: 'email_mismatch' });

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
      await Promise.allSettled(allWorkspaces.map(ws => supabase.from('workspace_members').insert({ workspace_id: ws.id, user_id: user.id, role: wsRole }).select().single()));
      // A new teammate is an operator, not a prospect. Flag them internal on every
      // workspace they just joined so their emails and your internal meetings are
      // never treated as leads. Best-effort: a hiccup here must not fail the accept.
      await Promise.allSettled(allWorkspaces.map(ws => recogniseTeamMembers(supabase, ws.id)));
    }

    if (user.team_id !== invitation.team_id) {
      try { await supabase.from('users').update({ team_id: invitation.team_id }).eq('id', user.id); } catch { /* best-effort */ }
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
