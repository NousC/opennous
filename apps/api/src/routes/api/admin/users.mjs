import { Router } from 'express';
import { getSupabaseClient } from '@nous/core';

export const adminUsersRouter = Router();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// GET /api/admin/users
adminUsersRouter.get('/', async (req, res) => {
  try {
    const supabase = getSupabaseClient();

    const { data: users, error } = await supabase.from('users')
      .select('id, email, name, profile_picture_url, created_at, is_admin, team_id, team:team_id(id, name)')
      .order('created_at', { ascending: false });
    if (error) throw error;

    const teamIds = [...new Set((users || []).filter(u => u.team_id).map(u => u.team_id))];
    let subscriptionsMap = {};
    if (teamIds.length) {
      const { data: subs } = await supabase.from('subscriptions').select('*').in('team_id', teamIds);
      subscriptionsMap = Object.fromEntries((subs || []).map(s => [s.team_id, s]));
    }

    const formattedUsers = (users || []).map(user => {
      const sub = subscriptionsMap[user.team_id] || null;
      return {
        id: user.id,
        email: user.email,
        name: user.name,
        profile_picture_url: user.profile_picture_url,
        created_at: user.created_at,
        is_admin: user.is_admin,
        team_id: user.team_id,
        team_name: user.team?.name || null,
        subscription: sub ? {
          plan_name: sub.plan_name,
          status: sub.status,
          trial_ends_at: sub.trial_ends_at,
          current_period_end: sub.current_period_end,
          canceled_at: sub.canceled_at,
          stripe_subscription_id: sub.stripe_subscription_id,
        } : null,
      };
    });

    return res.json(formattedUsers);
  } catch (err) {
    return res.status(500).json({ error: 'fetch_failed' });
  }
});

// DELETE /api/admin/users/:userId
adminUsersRouter.delete('/:userId', async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { userId } = req.params;
    const adminUser = req.adminUser;

    if (!UUID.test(userId)) return res.status(400).json({ error: 'invalid_user_id' });
    if (userId === adminUser.id) return res.status(400).json({ error: 'cannot_delete_self' });

    const { data: targetUser, error: userError } = await supabase.from('users')
      .select('id, email, name, team_id, supabase_user_id')
      .eq('id', userId).single();
    if (userError || !targetUser) return res.status(404).json({ error: 'user_not_found' });

    const { data: memberships } = await supabase.from('workspace_members')
      .select('workspace_id, role').eq('user_id', userId);
    const ownedWorkspaceIds = (memberships || []).filter(m => m.role === 'owner').map(m => m.workspace_id);

    await supabase.from('workspace_members').delete().eq('user_id', userId);

    if (ownedWorkspaceIds.length) {
      await supabase.from('workspaces').delete().in('id', ownedWorkspaceIds);
    }

    if (targetUser.team_id) {
      await supabase.from('subscriptions').delete().eq('team_id', targetUser.team_id);
      await supabase.from('teams').delete().eq('id', targetUser.team_id);
    }

    await supabase.from('users').delete().eq('id', userId);

    if (targetUser.supabase_user_id) {
      try {
        await supabase.auth.admin.deleteUser(targetUser.supabase_user_id);
      } catch (_) {}
    }

    return res.json({
      success: true,
      message: `User ${targetUser.email} and all related data deleted`,
      deleted: { user: targetUser.email, workspaces: ownedWorkspaceIds.length },
    });
  } catch (err) {
    return res.status(500).json({ error: 'delete_failed' });
  }
});

// POST /api/admin/impersonate/:userId
adminUsersRouter.post('/impersonate/:userId', async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { userId } = req.params;

    if (!UUID.test(userId)) return res.status(400).json({ error: 'invalid_user_id' });

    const { data: targetUser, error: userError } = await supabase.from('users')
      .select('id, email, name, supabase_user_id').eq('id', userId).single();
    if (userError || !targetUser) return res.status(404).json({ error: 'user_not_found' });

    if (targetUser.supabase_user_id) {
      const { data: authUser, error: authError } = await supabase.auth.admin.getUserById(targetUser.supabase_user_id);
      if (authError || !authUser) return res.status(404).json({ error: 'user_not_in_auth' });
    }

    const redirectUrl = process.env.VITE_APP_URL || 'http://localhost:8080';
    const { data: linkData, error: linkError } = await supabase.auth.admin.generateLink({
      type: 'magiclink',
      email: targetUser.email,
      options: { redirectTo: redirectUrl },
    });

    if (linkError) return res.status(500).json({ error: 'link_generation_failed', message: linkError.message });

    const magicLink = linkData.properties?.action_link;
    if (!magicLink) return res.status(500).json({ error: 'link_generation_failed' });

    return res.json({
      magic_link: magicLink,
      target_user: { id: targetUser.id, email: targetUser.email, name: targetUser.name },
    });
  } catch (err) {
    return res.status(500).json({ error: 'impersonation_failed' });
  }
});
