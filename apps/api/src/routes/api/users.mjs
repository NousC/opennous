import { Router } from 'express';
import { getSupabaseClient } from '@nous/core';
import { verifySupabaseAuth } from '../../middleware/supabaseAuth.mjs';
import { ensureUserAndTeam } from '../../lib/auth.mjs';
import { getAuthProvider } from '../../lib/authProvider/index.mjs';
import { revokeConnectionTokens } from '../../providers/revoke.mjs';
import { auditFromReq, recordConnectionRemovals, connectionsOfWorkspaces } from '../../lib/audit.mjs';

export const usersRouter = Router();

// PATCH /api/users/me
usersRouter.patch('/me', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { name, profile_picture_url, first_name, last_name, how_heard_about_us, use_cases, product_email_consent } = req.body;
    const { user } = await ensureUserAndTeam(req.user);

    const updateData = {};
    if (name !== undefined) {
      if (!name?.trim()) return res.status(400).json({ error: 'name cannot be empty' });
      updateData.name = name.trim();
    }
    if (profile_picture_url !== undefined) updateData.profile_picture_url = profile_picture_url || null;
    if (first_name !== undefined) updateData.first_name = first_name?.trim() || null;
    if (last_name !== undefined) updateData.last_name = last_name?.trim() || null;
    if (how_heard_about_us !== undefined) {
      const valid = ['youtube', 'linkedin', 'x', 'google', 'referral', 'email', 'other', null];
      if (!valid.includes(how_heard_about_us)) return res.status(400).json({ error: 'invalid how_heard_about_us value' });
      updateData.how_heard_about_us = how_heard_about_us;
    }
    if (use_cases !== undefined) {
      if (!Array.isArray(use_cases)) return res.status(400).json({ error: 'use_cases must be an array' });
      updateData.use_cases = use_cases;
    }
    if (product_email_consent !== undefined) updateData.product_email_consent = Boolean(product_email_consent);
    if (!Object.keys(updateData).length) return res.status(400).json({ error: 'no_updates_provided' });

    const { data: updatedUser, error } = await supabase.from('users').update(updateData).eq('id', user.id).select().single();
    if (error) throw error;
    return res.json({ user: updatedUser });
  } catch (err) {
    return res.status(500).json({ error: 'internal_error', ...(process.env.NODE_ENV !== 'production' && { detail: String(err.message) }) });
  }
});

// POST /api/users/me/default-signature
usersRouter.post('/me/default-signature', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { default_signature, default_signature_type } = req.body;
    const { user } = await ensureUserAndTeam(req.user);
    if (!default_signature) return res.status(400).json({ error: 'default_signature is required' });

    const { data: updatedUser, error } = await supabase.from('users')
      .update({ default_signature, default_signature_type: default_signature_type || 'type' })
      .eq('id', user.id).select().single();
    if (error) throw error;
    return res.json({ user: updatedUser });
  } catch (err) {
    return res.status(500).json({ error: 'internal_error', ...(process.env.NODE_ENV !== 'production' && { detail: String(err.message) }) });
  }
});

// GET /api/users/me/export (GDPR Art. 15/20)
//
// A real DSAR export of the personal data Nous holds ABOUT THIS USER (the data
// subject): their profile, memberships, the workspaces they belong to, the
// integrations/keys they own (metadata only — never the encrypted secrets), the
// routines and playground chats they created, and any feedback they submitted.
// It deliberately does NOT dump the whole workspace's CRM/contact data — that is
// the workspace's controlled data (about third parties), not this subject's.
usersRouter.get('/me/export', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { user } = await ensureUserAndTeam(req.user);
    const uid = user.id;

    // Best-effort per section so a missing table/column can't fail the whole export.
    const pull = async (fn) => { try { return await fn(); } catch { return null; } };

    const [profile, teamMemberships, workspaceMemberships, apiKeys, connections, routines, threads, feedback] = await Promise.all([
      pull(async () => (await supabase.from('users').select('*').eq('id', uid).single()).data),
      pull(async () => (await supabase.from('team_members').select('team_id, role, created_at').eq('user_id', uid)).data),
      pull(async () => (await supabase.from('workspace_members').select('workspace_id, role').eq('user_id', uid)).data),
      pull(async () => (await supabase.from('api_keys').select('id, name, scope, created_at, last_used_at').eq('owner_user_id', uid)).data),
      pull(async () => (await supabase.from('workflow_provider_connections').select('id, provider_id, name, created_at, last_used_at, is_verified').eq('owner_user_id', uid)).data),
      pull(async () => (await supabase.from('agent_routines').select('id, name, prompt, trigger_kind, frequency, created_at').eq('user_id', uid)).data),
      pull(async () => (await supabase.from('playground_threads').select('id, title, created_at, updated_at').eq('user_id', uid)).data),
      pull(async () => (await supabase.from('feedback').select('id, message, created_at').eq('user_id', uid)).data),
    ]);

    // Workspace names for context (the ones they're a member of).
    const wsIds = [...new Set((workspaceMemberships || []).map(m => m.workspace_id).filter(Boolean))];
    const workspaces = wsIds.length
      ? await pull(async () => (await supabase.from('workspaces').select('id, name, created_at').in('id', wsIds)).data)
      : [];

    const exportData = {
      export_date: new Date().toISOString(),
      user_id: uid,
      note: 'This export contains the personal data Nous holds about you. Integration credentials and other members\' data are excluded by design.',
      personal_data: {
        profile: profile || {},
        team_memberships: teamMemberships || [],
        workspace_memberships: workspaceMemberships || [],
        workspaces: workspaces || [],
        integration_connections: connections || [],   // metadata only — no secrets
        api_keys: apiKeys || [],                        // metadata only — no key material
        agent_routines: routines || [],
        playground_threads: threads || [],
        feedback: feedback || [],
      },
    };

    res.setHeader('Content-Disposition', `attachment; filename="nous-export-${uid}.json"`);
    res.setHeader('Content-Type', 'application/json');
    return res.json(exportData);
  } catch (err) {
    return res.status(500).json({ error: 'internal_error', ...(process.env.NODE_ENV !== 'production' && { detail: String(err.message) }) });
  }
});

// DELETE /api/users/me (GDPR Art. 17 — self-service erasure)
//
// SCOPE DECISION (flag for review): if the user is the SOLE member of their team,
// the team + its workspaces (and all workspace data via ON DELETE CASCADE) + the
// subscription are deleted. If OTHER members remain, only this user's membership,
// owned keys, connections, routines and chats are removed — shared team/workspace
// data is preserved (so one person leaving can't nuke a shared workspace). OAuth
// grants (Google/Slack) are revoked at the provider first, then the auth identity
// (Clerk on Cloud, Supabase Auth on self-host) is deleted. Requires an explicit { confirm: true } body.
usersRouter.delete('/me', verifySupabaseAuth, async (req, res) => {
  try {
    if (req.body?.confirm !== true) {
      return res.status(400).json({ error: 'confirmation_required', message: 'Pass { "confirm": true } to permanently delete your account.' });
    }
    const supabase = getSupabaseClient();
    const { user } = await ensureUserAndTeam(req.user);
    const uid = user.id;
    const authUserId = req.user.id;

    // 1. Revoke + delete the user's own integration connections.
    const { data: conns } = await supabase
      .from('workflow_provider_connections')
      .select('id, workspace_id, name, encrypted_credentials, workflow_providers!inner(name)')
      .eq('owner_user_id', uid);
    const erasure = { actor: { user_id: uid, email: req.user?.email ?? null, ip: req.ip ?? null }, via: 'account_erasure' };
    for (const c of conns || []) {
      await revokeConnectionTokens(c);
      await supabase.from('workflow_provider_connections').delete().eq('id', c.id);
      recordConnectionRemovals(supabase, [c], erasure);   // GET-901: who removed it, on the audit trail
    }

    // 2. Sole-member check.
    let soleMember = true;
    if (user.team_id) {
      const { count } = await supabase.from('team_members').select('user_id', { count: 'exact', head: true }).eq('team_id', user.team_id);
      soleMember = (count ?? 1) <= 1;
    }

    // 3. Remove the user's own rows everywhere.
    await supabase.from('api_keys').delete().eq('owner_user_id', uid);
    await supabase.from('workspace_members').delete().eq('user_id', uid);
    await supabase.from('team_members').delete().eq('user_id', uid);
    await supabase.from('agent_routines').delete().eq('user_id', uid);
    await supabase.from('playground_threads').delete().eq('user_id', uid);

    // 4. Tear the team down only if nobody else is on it.
    if (soleMember && user.team_id) {
      const { data: teamWorkspaces } = await supabase.from('workspaces').select('id').eq('team_id', user.team_id);
      const wsIds = (teamWorkspaces || []).map(w => w.id);
      // The workspaces' connections go with them (ON DELETE CASCADE): recorded first (GET-901).
      const cascaded = await connectionsOfWorkspaces(supabase, wsIds);
      if (wsIds.length) await supabase.from('workspaces').delete().in('id', wsIds);
      recordConnectionRemovals(supabase, cascaded, { ...erasure, via: 'workspace_deleted' });
      await supabase.from('subscriptions').delete().eq('team_id', user.team_id);
      await supabase.from('teams').delete().eq('id', user.team_id);
    }

    // Record BEFORE deleting the user row — actor_user_id references it.
    auditFromReq(req, {
      action: 'user.self_delete',
      target_type: 'user',
      target_id: uid,
      metadata: { email: user.email, team_deleted: soleMember },
    });

    // 5. The user row, then the auth identity.
    await supabase.from('users').delete().eq('id', uid);
    if (authUserId) {
      try { await (await getAuthProvider()).deleteUser(authUserId); } catch (_) { /* best-effort */ }
    }

    return res.json({ success: true, team_deleted: soleMember });
  } catch (err) {
    console.error('[DELETE /api/users/me]', err?.message);
    return res.status(500).json({ error: 'delete_failed', ...(process.env.NODE_ENV !== 'production' && { detail: String(err.message) }) });
  }
});
