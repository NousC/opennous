import { getSupabaseClient } from '@nous/core';

// Shared in-memory auth cache (5 min TTL)
const authCache = new Map();
const AUTH_CACHE_TTL_MS = 5 * 60 * 1000;

export async function ensureUserAndTeam(supabaseUser, skipTeamCreation = false) {
  const supabase = getSupabaseClient();
  const { id: supabaseUserId, email, user_metadata } = supabaseUser;
  const name = user_metadata?.name || user_metadata?.full_name || email?.split('@')[0] || 'User';
  const avatarUrl = user_metadata?.avatar_url || user_metadata?.picture || null;

  let { data: existingUser, error: userSelectError } = await supabase
    .from('users')
    .select('*, team:team_id(*)')
    .eq('supabase_user_id', supabaseUserId)
    .maybeSingle();

  if (userSelectError) throw new Error(`Error loading user: ${userSelectError.message}`);

  // Email fallback: migrated users may have supabase_user_id unset on their existing record.
  // Find them by email and backfill supabase_user_id so future lookups work without this fallback.
  if (!existingUser && email) {
    const { data: byEmail } = await supabase
      .from('users')
      .select('*, team:team_id(*)')
      .ilike('email', email)
      .maybeSingle();

    if (byEmail) {
      existingUser = byEmail;
      if (!byEmail.supabase_user_id) {
        try {
          await supabase.from('users')
            .update({ supabase_user_id: supabaseUserId })
            .eq('id', byEmail.id);
        } catch { /* best-effort backfill */ }
        existingUser = { ...byEmail, supabase_user_id: supabaseUserId };
      }
    }
  }

  let user = existingUser;
  let team = existingUser?.team;

  if (existingUser && !existingUser.profile_picture_url && avatarUrl) {
    supabase.from('users').update({ profile_picture_url: avatarUrl }).eq('id', existingUser.id)
      .then(({ error }) => { if (!error) existingUser.profile_picture_url = avatarUrl; });
  }

  if (!user && !skipTeamCreation) {
    const { data: pendingInvitation } = await supabase
      .from('team_invitations')
      .select('team_id, email')
      .eq('email', email.toLowerCase())
      .eq('status', 'pending')
      .maybeSingle();

    if (pendingInvitation) {
      const { data: newUser, error: createUserError } = await supabase
        .from('users')
        .insert({
          supabase_user_id: supabaseUserId,
          email,
          name,
          team_id: pendingInvitation.team_id,
          ...(avatarUrl && { profile_picture_url: avatarUrl }),
        })
        .select()
        .single();

      if (createUserError) {
        if (createUserError.code === '23505') {
          const { data: eu } = await supabase.from('users').select('*, team:team_id(*)').eq('supabase_user_id', supabaseUserId).single();
          if (!eu) throw new Error('Error loading user after race condition');
          return { user: eu, team: eu.team };
        }
        throw new Error(`Error creating user: ${createUserError.message}`);
      }

      const { data: invitedTeam } = await supabase.from('teams').select('*').eq('id', pendingInvitation.team_id).single();
      return { user: newUser, team: invitedTeam };
    }

    // Self-host registration gate: when DISABLE_SIGNUPS=true, only the very
    // first user (who becomes the owner) or an invited user may provision an
    // account. Everyone else is rejected here — they can still authenticate
    // with Supabase, but get no Nous account, so a public instance is never an
    // open free-for-all. Teammates come in through team_invitations instead.
    if (process.env.DISABLE_SIGNUPS === 'true') {
      const { count } = await supabase
        .from('users')
        .select('id', { count: 'exact', head: true });
      if ((count ?? 0) > 0) {
        const err = new Error('Registration is disabled on this instance.');
        err.code = 'SIGNUPS_DISABLED';
        throw err;
      }
    }

    // No pending invitation — create team + user (founder)
    const teamName = name ? `${name}'s Team` : 'My Team';
    const { data: newTeam, error: teamError } = await supabase.from('teams').insert({ name: teamName }).select().single();
    if (teamError) throw new Error(`Error creating team: ${teamError.message}`);
    team = newTeam;

    const { data: newUser, error: createUserError } = await supabase
      .from('users')
      .insert({
        supabase_user_id: supabaseUserId,
        email,
        name,
        team_id: team.id,
        ...(avatarUrl && { profile_picture_url: avatarUrl }),
      })
      .select()
      .single();

    if (createUserError) {
      if (createUserError.code === '23505') {
        try { await supabase.from('teams').delete().eq('id', newTeam.id); } catch { /* cleanup */ }
        const { data: eu } = await supabase.from('users').select('*, team:team_id(*)').eq('supabase_user_id', supabaseUserId).single();
        if (!eu) throw new Error('Error loading user after race condition');
        return { user: eu, team: eu.team };
      }
      throw new Error(`Error creating user: ${createUserError.message}`);
    }

    user = newUser;

    try {
      await supabase.from('team_members').insert({ team_id: team.id, user_id: user.id, role: 'founder' });
    } catch (e) {
      console.warn('[ensureUserAndTeam] Error adding founder to team_members:', e?.message || e);
    }

    const { data: newWorkspace } = await supabase
      .from('workspaces')
      .insert({ team_id: team.id, name: name || 'My Workspace', icon: null })
      .select()
      .single();

    if (newWorkspace) {
      try {
        await supabase.from('workspace_members').insert({ workspace_id: newWorkspace.id, user_id: user.id, role: 'owner' });
      } catch { /* member may already exist via trigger */ }
    }

    // Every new team starts on Free (1k ops, 25 enrichments/mo). Upgrades to a
    // paid tier go through Stripe → stripeWebhook.mjs updates this row.
    try {
      await supabase.from('subscriptions').insert({
        team_id: team.id,
        plan_id: 'free',
        plan_name: 'free',
        status: 'active',
        current_period_start: new Date().toISOString(),
      });
    } catch (e) {
      console.warn('[ensureUserAndTeam] Error creating subscription:', e?.message || e);
    }
  }

  // Self-heal: users created during the broken .catch() era may have a user
  // row + team but no workspace (or no workspace_members entry). Repair here
  // so every call site downstream can rely on the user having a workspace.
  if (user && team) {
    try {
      const { data: existingWs } = await supabase
        .from('workspaces')
        .select('id')
        .eq('team_id', team.id)
        .limit(1);

      let workspaceId = existingWs?.[0]?.id || null;

      if (!workspaceId) {
        const { data: createdWs, error: wsErr } = await supabase
          .from('workspaces')
          .insert({ team_id: team.id, name: name || user.name || 'My Workspace', icon: null })
          .select('id')
          .single();
        if (wsErr) {
          console.warn('[ensureUserAndTeam] Heal: failed to create missing workspace:', wsErr.message);
        } else {
          workspaceId = createdWs?.id || null;
          console.log(`[ensureUserAndTeam] Heal: created missing workspace ${workspaceId} for team ${team.id}`);
        }
      }

      if (workspaceId) {
        const { data: existingMember } = await supabase
          .from('workspace_members')
          .select('workspace_id')
          .eq('workspace_id', workspaceId)
          .eq('user_id', user.id)
          .maybeSingle();

        if (!existingMember) {
          try {
            await supabase
              .from('workspace_members')
              .insert({ workspace_id: workspaceId, user_id: user.id, role: 'owner' });
            console.log(`[ensureUserAndTeam] Heal: added user ${user.id} as owner of workspace ${workspaceId}`);
          } catch (e) {
            console.warn('[ensureUserAndTeam] Heal: workspace_members insert failed:', e?.message || e);
          }
        }

        // Ensure the workspace entity exists. Every workspace should have one
        // entity of type='workspace' — it's what notes/claims get attached to
        // when there's no other natural focus (ICP, company website, etc).
        // Without it, saveNote() throws "workspace entity not found".
        //
        // Use .limit(1) (not .maybeSingle()) so duplicates from earlier broken
        // runs don't blow up the heal with PGRST116. Multiple existing rows is
        // not great but means "entity exists, no work needed" — dedupe is a
        // separate one-off cleanup, not the per-request hot path.
        const { data: existingWsEntities, error: wsEntitySelectErr } = await supabase
          .from('entities')
          .select('id')
          .eq('workspace_id', workspaceId)
          .eq('type', 'workspace')
          .limit(1);
        if (wsEntitySelectErr) {
          console.warn('[ensureUserAndTeam] Heal: workspace entity select failed:', wsEntitySelectErr.message, wsEntitySelectErr.code);
        } else if (!existingWsEntities?.length) {
          const { error: wsEntityInsertErr } = await supabase
            .from('entities')
            .insert({ workspace_id: workspaceId, type: 'workspace', status: 'active' });
          if (wsEntityInsertErr) {
            console.warn('[ensureUserAndTeam] Heal: workspace entity insert failed:', wsEntityInsertErr.message, wsEntityInsertErr.code, wsEntityInsertErr.details);
          } else {
            console.log(`[ensureUserAndTeam] Heal: created missing workspace entity for ${workspaceId}`);
          }
        }
      }

      // Same belt-and-suspenders for the Free subscription row.
      const { data: existingSub } = await supabase
        .from('subscriptions')
        .select('team_id')
        .eq('team_id', team.id)
        .maybeSingle();
      if (!existingSub) {
        try {
          await supabase.from('subscriptions').insert({
            team_id: team.id,
            plan_id: 'free',
            plan_name: 'free',
            status: 'active',
            current_period_start: new Date().toISOString(),
          });
          console.log(`[ensureUserAndTeam] Heal: created missing free subscription for team ${team.id}`);
        } catch { /* duplicate is fine */ }
      }
    } catch (healErr) {
      console.warn('[ensureUserAndTeam] Heal: unexpected error:', healErr?.message || healErr);
    }
  }

  return { user, team };
}

// Resolve a caller-supplied workspace_id against the caller's team. Returns the
// workspace id, or null when it does not belong to the team — callers must treat
// null as 403 rather than falling back to a team-wide query.
export async function workspaceInTeam(supabase, workspaceId, teamId) {
  if (!workspaceId || !teamId) return null;
  const { data } = await supabase
    .from('workspaces')
    .select('id')
    .eq('id', workspaceId)
    .eq('team_id', teamId)
    .maybeSingle();
  return data?.id ?? null;
}

export async function getAuthContext(req, requiredWorkspaceId = null) {
  const supabase = getSupabaseClient();
  if (req.isApiKeyAuth) {
    const workspaceId = requiredWorkspaceId || req.apiKeyWorkspaceId;
    if (!workspaceId) throw new Error('workspaceId is required when using API key authentication');

    const { data: workspace } = await supabase.from('workspaces').select('id, team_id, name').eq('id', workspaceId).single();
    if (!workspace) throw new Error('workspace_not_found');

    const { data: team } = await supabase.from('teams').select('*').eq('id', workspace.team_id).single();
    if (!team) throw new Error('team_not_found');

    if (req.apiKeyWorkspaceId !== workspaceId) throw new Error('unauthorized: API key does not have access to this workspace');

    return { user: null, team, workspaceId, teamId: team.id, isApiKeyAuth: true };
  } else {
    const { user, team } = await ensureUserAndTeam(req.user);
    const workspaceId = requiredWorkspaceId || req.workspaceId;
    return { user, team, workspaceId, teamId: team?.id, isApiKeyAuth: false };
  }
}
