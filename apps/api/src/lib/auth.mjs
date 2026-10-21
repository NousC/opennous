import { getSupabaseClient } from '@nous/core';
import { claimPendingSeat } from './pendingSeats.mjs';
import { canBindEmailIdentity, canClaimByEmailMatch, identityColumn, findUserByAuthId, getAuthProvider } from './authProvider/index.mjs';
import { assertMayCreateOwnTeam, SETUP_TOKEN_METADATA_KEY } from './instanceOwner.mjs';
import { PLANS } from './plans.mjs';
import { captureProductEvent } from './productEvents.mjs';

// Who is this request, and which team — cached briefly in process (GET-312).
//
// This cache was declared here long ago and never used, so every one of ~108 call sites paid the
// full lookup on every request. That matters more than it looks: this database answers even a
// trivial query in ~130ms (measured: 16ms to connect, ~130ms to first byte), so a handful of
// round trips IS the page wait. /api/workspaces spent 1.3s and /api/usage 2.2s mostly here.
//
// Cached only on the settled path — an existing user with a team. Signup, invitation claiming and
// the email-backfill branch all run in full, because those are the paths that WRITE. Thirty
// seconds is short enough that a seat or team change shows up on the next navigation, and long
// enough that a page's parallel calls share one lookup.
const authCache = new Map();
const AUTH_CACHE_TTL_MS = 30_000;

function cachedAuth(key) {
  const hit = authCache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expires) { authCache.delete(key); return null; }
  return hit.value;
}

function cacheAuth(key, value) {
  // Bounded: one entry per signed-in user, and a long-running API would otherwise keep every user
  // it has ever seen.
  if (authCache.size > 5000) authCache.clear();
  authCache.set(key, { value, expires: Date.now() + AUTH_CACHE_TTL_MS });
}

/**
 * Forget a user's cached identity — call after anything that changes their team or seat.
 * Takes the AUTH provider's user id (req.user.id, or users[identityColumn()]), not users.id.
 */
export function invalidateAuthCache(authUserId) {
  if (!authUserId) return;
  for (const key of authCache.keys()) if (key.startsWith(`${authUserId}|`)) authCache.delete(key);
}

/**
 * What a new team starts on: THE FREE PLAN (GET-682, reversing GET-532).
 *
 * New conversations read from today up to 500 credits a month, no history backfill until they
 * pay. A paid bundle goes through Stripe, and stripeWebhook.mjs moves this row to the paid plan.
 */
function newFreeSubscription(teamId) {
  return {
    team_id: teamId,
    plan_id: 'free',
    plan_name: 'free',
    status: 'active',
    current_period_start: new Date().toISOString(),
  };
}

/**
 * @param authUser          { id, email, user_metadata } from the auth middleware
 * @param skipTeamCreation  true: never provision; return { user: null } for a new identity
 * @param opts.invitation   { team_id } of an invite the CALLER has already matched by its
 *                          token (a pending team invitation addressed to authUser.email,
 *                          or a redeemable CLI join token). A new identity is provisioned
 *                          straight into that team, with no email-match check and past the
 *                          DISABLE_SIGNUPS gate: holding the token is the proof. Used on the
 *                          Supabase provider by invite-accept and the CLI join approve.
 */
export async function ensureUserAndTeam(authUser, skipTeamCreation = false, opts = {}) {
  const supabase = getSupabaseClient();
  // authUserId is the auth provider's user id (Clerk on Cloud, Supabase Auth on
  // self-host); idColumn is where public.users stores it. See lib/authProvider.
  const { id: authUserId, email, user_metadata } = authUser;
  const idColumn = identityColumn();
  const cacheKey = `${authUserId}|${skipTeamCreation ? 'skip' : 'ensure'}`;
  const cached = cachedAuth(cacheKey);
  if (cached) return cached;
  const name = user_metadata?.name || user_metadata?.full_name || email?.split('@')[0] || 'User';
  const avatarUrl = user_metadata?.avatar_url || user_metadata?.picture || null;
  // The self-host owner names their company on the set-up form (SignUpFields). It is read from
  // the sign-up metadata with the setup token, below, and names the team and first workspace
  // instead of "<name>'s Team". Null everywhere else (Cloud, invitees, open instances).
  let companyName = null;

  let { data: existingUser, error: userSelectError } = await findUserByAuthId(supabase, authUserId, '*, team:team_id(*)');

  if (userSelectError) throw new Error(`Error loading user: ${userSelectError.message}`);

  // Email fallback: imported users may have the auth id column unset on their existing record.
  // Find them by email and backfill it so future lookups work without this fallback.
  if (!existingUser && email) {
    const { data: byEmail } = await supabase
      .from('users')
      .select('*, team:team_id(*)')
      // Escape LIKE metachars so a crafted email can't wildcard-match another row.
      .ilike('email', email.replace(/[\\%_]/g, '\\$&'))
      .maybeSingle();

    if (byEmail && await canBindEmailIdentity(authUserId, email)) {
      existingUser = byEmail;
      if (!byEmail[idColumn]) {
        try {
          await supabase.from('users')
            .update({ [idColumn]: authUserId })
            .eq('id', byEmail.id);
        } catch { /* best-effort backfill */ }
        existingUser = { ...byEmail, [idColumn]: authUserId };
      }
    }
  }

  let user = existingUser;
  let team = existingUser?.team;

  // The common case, and the only one cached: they exist and their team is loaded. Everything below
  // creates or repairs something and must run for real.
  if (user && team) {
    if (!user.profile_picture_url && avatarUrl) {
      supabase.from('users').update({ profile_picture_url: avatarUrl }).eq('id', user.id)
        .then(({ error }) => { if (!error) user.profile_picture_url = avatarUrl; });
    }
    const settled = { user, team };
    cacheAuth(cacheKey, settled);
    return settled;
  }

  if (existingUser && !existingUser.profile_picture_url && avatarUrl) {
    supabase.from('users').update({ profile_picture_url: avatarUrl }).eq('id', existingUser.id)
      .then(({ error }) => { if (!error) existingUser.profile_picture_url = avatarUrl; });
  }

  if (!user && !skipTeamCreation) {
    let pendingInvitation = opts.invitation?.team_id ? opts.invitation : null;
    if (!pendingInvitation) {
      const { data: byEmail } = await supabase
        .from('team_invitations')
        .select('team_id, email')
        .eq('email', email.toLowerCase())
        .eq('status', 'pending')
        .maybeSingle();
      // Joining a team because an invite names your email requires proof you own that
      // email. On Clerk this is always true (Cloud behaviour is unchanged: Clerk verifies
      // the address at signup). On Supabase it needs email_confirmed_at from a real
      // confirmation email, so never under autoconfirm, where anyone can sign up as the
      // invitee's address; that invitee joins through the invite link's token instead.
      // An unproven invitee falls through to the gate and, if open, a fresh team below.
      if (byEmail && await canClaimByEmailMatch(authUserId, email)) pendingInvitation = byEmail;
    }

    if (pendingInvitation) {
      const { data: newUser, error: createUserError } = await supabase
        .from('users')
        .insert({
          [idColumn]: authUserId,
          email,
          name,
          team_id: pendingInvitation.team_id,
          ...(avatarUrl && { profile_picture_url: avatarUrl }),
        })
        .select()
        .single();

      if (createUserError) {
        if (createUserError.code === '23505') {
          const { data: eu } = await supabase.from('users').select('*, team:team_id(*)').eq(idColumn, authUserId).single();
          if (!eu) throw new Error('Error loading user after race condition');
          return { user: eu, team: eu.team };
        }
        throw new Error(`Error creating user: ${createUserError.message}`);
      }

      const { data: invitedTeam } = await supabase.from('teams').select('*').eq('id', pendingInvitation.team_id).single();
      captureProductEvent({ distinctId: newUser.id, event: 'invite_accepted', set: { email, name } });
      return { user: newUser, team: invitedTeam };
    }

    // Self-host registration gate: when DISABLE_SIGNUPS=true, nobody gets a team of
    // their own except the instance owner, who claims it once, atomically, with the
    // setup token (lib/instanceOwner.mjs). Everyone else is rejected here — they can
    // still authenticate with Supabase, but get no Nous account, so a public instance
    // is never an open free-for-all. Teammates come in by join token or invite token
    // (opts.invitation above). Cloud never sets DISABLE_SIGNUPS.
    if (process.env.DISABLE_SIGNUPS === 'true') {
      await assertMayCreateOwnTeam(supabase, authUserId, {
        readPresentedToken: async () => {
          const provider = await getAuthProvider();
          const meta = provider.getUserMetadata ? await provider.getUserMetadata(authUserId) : {};
          companyName = String(meta?.company_name ?? '').trim().slice(0, 80) || null;
          return meta?.[SETUP_TOKEN_METADATA_KEY] ?? null;
        },
        afterClaim: async () => {
          const provider = await getAuthProvider();
          await provider.clearUserMetadataKeys?.(authUserId, [SETUP_TOKEN_METADATA_KEY]);
        },
      });
    }

    // No pending invitation — create team + user (founder)
    const teamName = companyName || (name ? `${name}'s Team` : 'My Team');
    const { data: newTeam, error: teamError } = await supabase.from('teams').insert({ name: teamName }).select().single();
    if (teamError) throw new Error(`Error creating team: ${teamError.message}`);
    team = newTeam;

    const { data: newUser, error: createUserError } = await supabase
      .from('users')
      .insert({
        [idColumn]: authUserId,
        email,
        name,
        team_id: team.id,
        ...(avatarUrl && { profile_picture_url: avatarUrl }),
        ...(companyName && { company_name: companyName }),
      })
      .select()
      .single();

    if (createUserError) {
      if (createUserError.code === '23505') {
        try { await supabase.from('teams').delete().eq('id', newTeam.id); } catch { /* cleanup */ }
        const { data: eu } = await supabase.from('users').select('*, team:team_id(*)').eq(idColumn, authUserId).single();
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
      .insert({ team_id: team.id, name: companyName || name || 'My Workspace', icon: null })
      .select()
      .single();

    if (newWorkspace) {
      try {
        // The workspace creator IS the founder — give them the founder GTM role up front (on
        // workspace_members, where job_roles live), so role-report + role views work immediately.
        await supabase.from('workspace_members').insert({ workspace_id: newWorkspace.id, user_id: user.id, role: 'owner', job_roles: ['founder'], job_role: 'founder' });
      } catch { /* member may already exist via trigger */ }
    }

    // Product analytics (GET-820): the signup, from the server, so cookie consent never hides it.
    // company_name when they gave one: our own PostHog source reads it to put them on that account.
    captureProductEvent({ distinctId: user.id, event: 'signed_up', set: { email, name, ...(companyName ? { company_name: companyName } : {}) }, workspaceId: newWorkspace?.id ?? null });
    if (newWorkspace) captureProductEvent({ distinctId: user.id, event: 'workspace_created', properties: { source: 'signup' }, workspaceId: newWorkspace.id });

    // Every new team starts on Free (GET-682). A paid upgrade goes through Stripe, and
    // stripeWebhook.mjs moves this row to the bundle they bought.
    try {
      await supabase.from('subscriptions').insert(newFreeSubscription(team.id));
    } catch (e) {
      console.warn('[ensureUserAndTeam] Error creating subscription:', e?.message || e);
    }

    // Grant the API plan's base credits at SIGNUP so both web- and CLI-first users
    // have a working wallet from moment one — not only those who finish the web
    // /activate wizard (which was the sole grant site and left terminal-first users
    // showing "restricted / 0 credits" on day one). The unique sentinel makes it
    // idempotent: onboarding /activate reuses the same key, so a team is granted its
    // base credits exactly once regardless of which path it takes first.
    try {
      const base = PLANS.api?.aiCreditsPerMonth || 0;
      if (base > 0) {
        const { error: grantErr } = await supabase.from('credit_grants').insert({
          team_id: team.id, credits: base, kind: 'base',
          note: `API plan — ${base} base credits at signup`,
          stripe_session_id: `signup:${team.id}`,
        });
        if (grantErr && grantErr.code !== '23505') console.warn('[ensureUserAndTeam] base credit grant failed:', grantErr.message);
      }
    } catch (e) { console.warn('[ensureUserAndTeam] base credit grant threw:', e?.message || e); }
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

      // Same belt-and-suspenders for the subscription row — a team that somehow has none
      // gets Free, like every new team.
      const { data: existingSub } = await supabase
        .from('subscriptions')
        .select('team_id')
        .eq('team_id', team.id)
        .maybeSingle();
      if (!existingSub) {
        try {
          await supabase.from('subscriptions').insert(newFreeSubscription(team.id));
          console.log(`[ensureUserAndTeam] Heal: created missing Free subscription for team ${team.id}`);
        } catch { /* duplicate is fine */ }
      }
    } catch (healErr) {
      console.warn('[ensureUserAndTeam] Heal: unexpected error:', healErr?.message || healErr);
    }
  }

  // A seat promised on a sales call, applied before they see anything. A team that was just
  // sold the Custom plan should not land on an Install page for a CLI nobody pitched them.
  // Best-effort by design: it must never block a sign-in.
  try {
    const { data: ws } = await supabase
      .from('workspaces').select('id').eq('team_id', team?.id).order('created_at', { ascending: true }).limit(1).maybeSingle();
    await claimPendingSeat(supabase, {
      email: user?.email, userId: user?.id, teamId: team?.id, workspaceId: ws?.id ?? null,
      authUserId,
    });
  } catch { /* never block a sign-in */ }

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
