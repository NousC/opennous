import { roleTags } from '../../lib/roleProfiles.mjs';
import { Router } from 'express';
import { getSupabaseClient } from '@nous/core';
import { verifySupabaseAuth } from '../../middleware/supabaseAuth.mjs';
import { ensureUserAndTeam } from '../../lib/auth.mjs';
import { getCountryFromRequest } from '../../lib/geo.mjs';
import { isAdminEmail } from '../../utils/adminAccess.js';
import { isSelfHosted } from '../../lib/plans.mjs';
import { integrationStatus } from '../../lib/instanceSetup.mjs';
import { buildMemoryOverview } from '../../lib/memoryExtract.mjs';

export const meRouter = Router();

const userActiveWorkspace = new Map();

// ─── Agent personalization, per member ──────────────────────────────────────
//
// The agent works off the same verified record for everyone, but the job on top
// of it differs: a founder wants the deal, an SDR wants the opener, RevOps wants
// the pattern. So each member tells their agent who they are and what they care
// about, and that rides along in the system prompt for their chats only.
//
// Scoped to (workspace, member) — the same person can be a founder in their own
// workspace and a consultant in a client's.

// The jobs we offer in the dropdown. Kept in lockstep with JOB_ROLES in the
// frontend Settings page; the agent turns the value into a sentence.
export const JOB_ROLES = [
  'founder', 'sales', 'sdr', 'account_executive', 'revops',
  'marketing', 'customer_success', 'agency', 'engineer', 'other',
];

// The role values, in the words a person would use. Mirrors JOB_ROLE_OPTIONS in the
// frontend Settings page.
const JOB_ROLE_LABEL = {
  founder: 'Founder', sales: 'Sales', account_executive: 'Account executive', sdr: 'SDR',
  revops: 'RevOps', marketing: 'Marketing', customer_success: 'Customer success',
  agency: 'Agency / consultant', engineer: 'Engineer', other: 'Other',
};

// Structured prefs. `format` and `length` are legacy: they belonged to the Behaviour surface
// and nothing reads them any more — answer shape is learned now. They stay in the whitelist so
// an old stored value round-trips instead of being silently dropped from someone's row.
// `memory_enabled` is the one that matters: a consent switch, not a behaviour instruction.
const PREF_VALUES = {
  format: ['bullets', 'prose'],
  length: ['brief', 'standard', 'thorough'],
};
// Keep only known pref keys with allowed values.
function sanitizePrefs(input) {
  if (input === null) return null;
  if (typeof input !== 'object' || Array.isArray(input)) return undefined; // invalid
  const out = {};
  for (const [k, allowed] of Object.entries(PREF_VALUES)) {
    if (input[k] != null && allowed.includes(input[k])) out[k] = input[k];
  }
  return Object.keys(out).length ? out : null;
}

// GET /api/me/agent-profile?workspaceId=…
// GET /api/me/roles — the role catalogue, served rather than duplicated.
//
// The Reporting page used to carry its own hand-kept copy of the role tags, with a "keep the
// two in sync" comment on it. The frontend has no build dependency on the API, so the honest
// way to share one table is to serve it — the same shape the provider catalogue already uses.
// No auth beyond a session: this is static product vocabulary, not workspace data.
meRouter.get('/roles', verifySupabaseAuth, async (_req, res) => {
  res.set('Cache-Control', 'private, max-age=300');
  return res.json({ roles: roleTags() });
});

meRouter.get('/agent-profile', verifySupabaseAuth, async (req, res) => {
  try {
    const workspaceId = req.query.workspaceId;
    if (!workspaceId) return res.status(400).json({ error: 'workspaceId_required' });

    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('workspace_members')
      .select('job_role, job_roles, agent_prefs')
      .eq('workspace_id', workspaceId)
      .eq('user_id', req.internalUserId)
      .maybeSingle();
    if (error) throw error;

    return res.json({
      job_role:           data?.job_role ?? null,
      // The member's ASSIGNED role(s). Named member_roles to avoid colliding with the
      // job_roles field below, which is the list of ALL selectable roles for the dropdown.
      member_roles:       Array.isArray(data?.job_roles) && data.job_roles.length ? data.job_roles : (data?.job_role ? [data.job_role] : []),
      agent_prefs:        data?.agent_prefs ?? {},
      job_roles:          JOB_ROLES,
    });
  } catch (err) {
    console.error('[GET /api/me/agent-profile]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// ─── Notification preferences, per member ───────────────────────────────────
//
// Same scoping as the agent profile: (workspace, member). Stored as an opaque
// JSON blob whose shape is owned by the frontend Settings → Notifications
// section, so we can add categories/channels without a schema change. NULL means
// "never set" — the frontend applies its own all-on defaults.

const MAX_PREFS_BYTES = 8000; // a comfortable ceiling; the real payload is ~1KB

// GET /api/me/notification-prefs?workspaceId=…
meRouter.get('/notification-prefs', verifySupabaseAuth, async (req, res) => {
  try {
    const workspaceId = req.query.workspaceId;
    if (!workspaceId) return res.status(400).json({ error: 'workspaceId_required' });

    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('workspace_members')
      .select('notification_prefs')
      .eq('workspace_id', workspaceId)
      .eq('user_id', req.internalUserId)
      .maybeSingle();
    if (error) throw error;

    return res.json({ notification_prefs: data?.notification_prefs ?? null });
  } catch (err) {
    console.error('[GET /api/me/notification-prefs]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// PATCH /api/me/notification-prefs — body { workspaceId, notification_prefs }
// The whole prefs object is replaced (the frontend always sends the full shape).
meRouter.patch('/notification-prefs', verifySupabaseAuth, async (req, res) => {
  try {
    const { workspaceId, notification_prefs } = req.body || {};
    if (!workspaceId) return res.status(400).json({ error: 'workspaceId_required' });
    if (notification_prefs === undefined) return res.status(400).json({ error: 'nothing_to_update' });
    if (notification_prefs !== null && (typeof notification_prefs !== 'object' || Array.isArray(notification_prefs))) {
      return res.status(400).json({ error: 'invalid_prefs' });
    }
    if (notification_prefs !== null && JSON.stringify(notification_prefs).length > MAX_PREFS_BYTES) {
      return res.status(413).json({ error: 'prefs_too_large' });
    }

    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('workspace_members')
      .update({ notification_prefs })
      .eq('workspace_id', workspaceId)
      .eq('user_id', req.internalUserId)
      .select('notification_prefs')
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'membership_not_found' });

    return res.json({ notification_prefs: data.notification_prefs ?? null });
  } catch (err) {
    console.error('[PATCH /api/me/notification-prefs]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// PATCH /api/me/agent-profile — body { workspaceId, job_role?, agent_prefs? }
// Only the fields present are written, so saving the role doesn't wipe the notes.
meRouter.patch('/agent-profile', verifySupabaseAuth, async (req, res) => {
  try {
    const { workspaceId, job_role, agent_prefs } = req.body || {};
    if (!workspaceId) return res.status(400).json({ error: 'workspaceId_required' });

    const patch = {};

    if (job_role !== undefined) {
      // Empty string clears the role rather than storing ''.
      const v = job_role === null || job_role === '' ? null : String(job_role);
      if (v !== null && !JOB_ROLES.includes(v)) {
        return res.status(400).json({ error: 'invalid_job_role', valid: JOB_ROLES });
      }
      patch.job_role = v;
    }

    // agent_instructions / agent_name / agent_rules are deliberately NOT accepted any more.
    //
    // The Behaviour surface is gone: how someone wants to be worked with is LEARNED
    // (lib/memoryExtract.mjs), not typed into a form before they have seen a single answer.
    // Accepting a write here would let a stale client set a field nothing reads — which looks
    // like it worked and silently does nothing, the worst of both. Ignored rather than
    // rejected, so an old tab saving its whole form still saves the parts that are real.
    //
    // The columns and every existing value are untouched. Nothing is deleted on anyone's
    // behalf, and turning the surface back on would be a revert, not a recovery.

    if (agent_prefs !== undefined) {
      const v = sanitizePrefs(agent_prefs);
      if (v === undefined) return res.status(400).json({ error: 'invalid_prefs' });
      patch.agent_prefs = v;
    }

    if (Object.keys(patch).length === 0) return res.status(400).json({ error: 'nothing_to_update' });

    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('workspace_members')
      .update(patch)
      .eq('workspace_id', workspaceId)
      .eq('user_id', req.internalUserId)
      .select('job_role, agent_prefs')
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'membership_not_found' });

    return res.json({
      job_role:           data.job_role ?? null,
      agent_prefs:        data.agent_prefs ?? {},
    });
  } catch (err) {
    console.error('[PATCH /api/me/agent-profile]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// GET /api/me
meRouter.get('/', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { user, team } = await ensureUserAndTeam(req.user);

    // Auto-accept pending invitation if user is not yet in team_members
    if (team) {
      const { data: existingMember } = await supabase
        .from('team_members')
        .select('id')
        .eq('team_id', team.id)
        .eq('user_id', user.id)
        .maybeSingle();

      if (!existingMember) {
        const { data: pendingInvitation } = await supabase
          .from('team_invitations')
          .select('*')
          .eq('email', user.email.toLowerCase())
          .eq('status', 'pending')
          .eq('team_id', team.id)
          .maybeSingle();

        if (pendingInvitation && new Date(pendingInvitation.expires_at) >= new Date()) {
          const memberRole = pendingInvitation.role || 'member';

          const { error: memberError } = await supabase.from('team_members').insert({
            team_id: team.id,
            user_id: user.id,
            role: memberRole,
          });

          if (!memberError) {
            const { data: allWorkspaces } = await supabase
              .from('workspaces')
              .select('id')
              .eq('team_id', team.id);

            if (allWorkspaces?.length > 0) {
              const workspaceRole = ['founder', 'owner', 'admin'].includes(memberRole)
                ? 'admin'
                : memberRole === 'member' ? 'member' : 'viewer';

              await Promise.allSettled(
                allWorkspaces.map(ws =>
                  supabase.from('workspace_members').insert({
                    workspace_id: ws.id,
                    user_id: user.id,
                    role: workspaceRole,
                  }).select().single()
                )
              );
            }

            await supabase.from('team_invitations').update({
              status: 'accepted',
              accepted_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            }).eq('id', pendingInvitation.id);

            if (!user.onboarding_completed_at) {
              await supabase.from('users').update({
                onboarding_completed_at: new Date().toISOString(),
              }).eq('id', user.id);
            }
          }
        }
      }
    }

    // Is founder?
    let isFounder = false;
    if (team) {
      const { data: membership } = await supabase
        .from('team_members')
        .select('role')
        .eq('team_id', team.id)
        .eq('user_id', user.id)
        .eq('role', 'founder')
        .maybeSingle();
      isFounder = !!membership;
    }

    // Get user's workspaces. `role` rides along so /me can report the caller's
    // role IN the workspace they're actually viewing — the manager/rep axis the
    // role-gated surfaces (Reporting, My Studio) key off. Without it every real
    // session resolved to null and both surfaces rendered for everyone.
    const { data: memberships, error: membershipsError } = await supabase
      .from('workspace_members')
      .select('workspace_id, role, workspaces:workspace_id(*)')
      .eq('user_id', user.id);

    let workspace = null;
    let workspaceRole = null;
    const workspaceId = req.query.workspace_id;

    // Default workspace picker. When a user belongs to several workspaces (e.g. an
    // invited teammate joined a team that has a real workspace plus a leftover/empty
    // one), prefer an ONBOARDED workspace (business_type set) over whatever Postgres
    // returns first — otherwise they land on a junk/not-onboarded workspace and see
    // the onboarding gate + "not a member"-flavoured failures on the real one.
    // Picks the MEMBERSHIP (not just the workspace) so the caller's role in the
    // one they land on travels with it. A membership matched by business_type or
    // by id always carries its workspace, so this keeps the previous semantics.
    const pickDefault = () =>
      memberships.find(m => m.workspaces?.business_type) || memberships[0];

    if (!membershipsError && memberships?.length > 0) {
      let membership;
      if (workspaceId) {
        const selected = memberships.find(m => String(m.workspaces?.id) === String(workspaceId));
        membership = selected || pickDefault();
      } else {
        membership = pickDefault();
      }
      workspace = membership?.workspaces || null;
      workspaceRole = membership?.role ?? null;
      if (workspace?.id) userActiveWorkspace.set(user.id, workspace.id);

      // Lazy country backfill — first authenticated /me call after the
      // 2026_05_26_workspace_country migration populates the field for
      // existing workspaces, and captures it for new signups. Fully
      // non-blocking: failures are swallowed.
      if (workspace?.id && !workspace.country) {
        const country = getCountryFromRequest(req);
        if (country) {
          supabase
            .from('workspaces')
            .update({ country })
            .eq('id', workspace.id)
            .then(({ error }) => { if (!error) workspace.country = country; });
        }
      }
    }

    // The team that owns the workspace being viewed. `team` above is the ACCOUNT's home team,
    // and the two differ when someone is a member of another company's workspace — an operator
    // setting a client up (GET-241). Every "which team is this" surface (rail name, Members,
    // Invite, the team-name field) means this one; reading `team` there sent an invite for the
    // client's founder into the operator's own company.
    let workspaceTeam = team ? { id: team.id, name: team.name } : null;
    if (workspace?.team_id && workspace.team_id !== team?.id) {
      const { data: wt } = await supabase
        .from('teams').select('id, name').eq('id', workspace.team_id).maybeSingle();
      if (wt) workspaceTeam = { id: wt.id, name: wt.name };
    }

    // Founders complete onboarding via the wizard, which writes onboarding_completed_at.
    // Invited members skip the wizard entirely, so they're considered onboarded on first /me.
    const onboardingCompleted = isFounder ? !!user.onboarding_completed_at : true;

    // Trial status
    let trialActive = false;
    let trialEndsAt = null;
    if (team) {
      const { data: subscription } = await supabase
        .from('subscriptions')
        .select('status, trial_ends_at')
        .eq('team_id', team.id)
        .maybeSingle();

      if (subscription?.status === 'trial' && subscription?.trial_ends_at) {
        const endsAt = new Date(subscription.trial_ends_at);
        trialActive = endsAt > new Date();
        trialEndsAt = subscription.trial_ends_at;
      }
    }

    // Never report is_admin=true to the client unless the account is also on the
    // env allowlist (empty on self-host). The admin nav + routes are operator-only,
    // so a self-hoster who flips users.is_admin in their own DB still won't see the
    // admin surface. The API (requireAdmin) enforces the same allowlist server-side.
    const safeUser = user
      ? { ...user, is_admin: isAdminEmail(user.email) && user.is_admin === true }
      : user;

    return res.json({
      user: safeUser,
      team,
      workspace,
      // The team that owns `workspace` (see above). Equal to `team` unless the caller is a
      // member of a workspace another team owns. The frontend reads it via lib/activeTeam.ts.
      workspace_team: workspaceTeam,
      // The caller's role in `workspace` (owner | admin | member | viewer), read
      // straight off workspace_members. Drives the manager/rep split in the UI
      // (lib/roles.ts). Null when the user has no membership row — roleOf() then
      // resolves to null and surfaces stay visible rather than vanishing.
      // NOTE: this is a UI axis, not an access boundary — the API does not
      // enforce roles, so nothing here should be treated as a permission gate.
      workspace_role: workspaceRole,
      onboarding_completed: onboardingCompleted,
      is_founder: isFounder,
      trial: {
        is_active: trialActive,
        ends_at: trialEndsAt,
      },
      // Self-host unlocks everything: SELF_HOSTED=true turns off billing and
      // plan enforcement in the UI too, mirroring the API bypass in access.mjs.
      billing_enabled: !isSelfHosted() && process.env.BILLING_ENABLED !== 'false' && !!process.env.STRIPE_SECRET_KEY,
      plan_enforcement: !isSelfHosted() && process.env.PLAN_ENFORCEMENT !== 'false',
      self_hosted: isSelfHosted(),
      // Self-host: the integrations whose OAuth app this install has not registered yet, so the
      // Integrations page shows them as "Needs setup" instead of a Connect that can only fail (GET-837).
      ...(isSelfHosted() ? { integrations_needing_setup: integrationStatus().filter((i) => !i.ready).map((i) => i.id) } : {}),
      // Running build, for the self-host "update available" widget. Set by
      // update.sh (APP_COMMIT=$(git rev-parse --short HEAD)).
      app_commit: process.env.APP_COMMIT || null,
    });
  } catch (err) {
    if (err?.code === 'SIGNUPS_DISABLED') {
      return res.status(403).json({ error: 'signups_disabled', message: err.message });
    }
    console.error('[ME_ROUTE_ERROR]', err);
    return res.status(500).json({ error: 'internal_error', ...(process.env.NODE_ENV !== 'production' && { detail: String(err.message || err) }) });
  }
});

// ─── Memory, per member ─────────────────────────────────────────────────────
//
// What the agent has learned about THIS person: their role, how they want to be
// answered, corrections that should stick. Rows live in account_memory scoped
// entity = owner = the member, which is what makes them private — a workspace admin
// has no read path to a colleague's preferences, and that is deliberate. This is a
// team product, not a personal assistant: memory about a person belongs to them.

/** GET /api/me/memory?workspaceId= — everything remembered about you, newest first. */
meRouter.get('/memory', verifySupabaseAuth, async (req, res) => {
  try {
    const workspaceId = req.query.workspaceId;
    if (!workspaceId) return res.status(400).json({ error: 'workspaceId_required' });
    const supabase = getSupabaseClient();
    const me = req.internalUserId;
    if (!me) return res.status(401).json({ error: 'no_member' });

    const [{ data: rows }, { data: member }, { data: user }, { data: ws }] = await Promise.all([
      supabase.from('account_memory')
        .select('id, text, source, captured_at')
        .eq('workspace_id', workspaceId).eq('entity_id', me).eq('owner_user_id', me)
        .order('captured_at', { ascending: false }).limit(200),
      supabase.from('workspace_members').select('agent_prefs, job_role, job_roles')
        .eq('workspace_id', workspaceId).eq('user_id', me).maybeSingle(),
      supabase.from('users').select('name').eq('id', me).maybeSingle(),
      supabase.from('workspaces').select('name').eq('id', workspaceId).maybeSingle(),
    ]);

    // The FOUNDATION. Who you are and what you do is already on your profile and already
    // reaches the agent every turn (buildMemberBlock) — it was never something memory had
    // to overhear you say. Showing it here means the page opens as "who am I to this
    // agent" from day one, with learned facts accruing on top of it rather than from
    // nothing. Marked `profile` so the page can say it came from your settings, not a guess.
    const roleKeys = Array.isArray(member?.job_roles) && member.job_roles.length
      ? member.job_roles
      : (member?.job_role ? [member.job_role] : []);
    const roleLabel = roleKeys.map(r => JOB_ROLE_LABEL[r] ?? r).filter(Boolean).join(', ');
    const profileBullets = [
      user?.name ? { label: 'Name', value: user.name } : null,
      roleLabel ? { label: 'Role', value: roleLabel } : null,
      ws?.name ? { label: 'Company', value: ws.name } : null,
    ].filter(Boolean);

    const cached = member?.agent_prefs?.memory_overview ?? null;
    const count = (rows ?? []).length;
    // `text` is the shape the first version cached; a profile written then still renders
    // as one unnamed section instead of vanishing, and refreshes to the new shape on the
    // next rebuild.
    const profile = cached?.profile
      ?? (cached?.text ? { bullets: [], sections: [{ title: 'Overview', text: cached.text }] } : null);
    return res.json({
      enabled: member?.agent_prefs?.memory_enabled !== false,   // default ON
      memories: rows ?? [],
      profile_bullets: profileBullets,
      overview: profile,
      // The client rebuilds when this is true, so opening Settings never waits on a
      // model call — and a stale profile never outlives the facts it was drawn from.
      overview_stale: count >= 3 && cached?.fact_count !== count,
    });
  } catch (err) {
    console.error('[GET /api/me/memory]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

/** PATCH /api/me/memory — { workspaceId, enabled } turns learning on or off. Off stops
 *  new writes; it does NOT delete what's there, because "pause" and "forget" are
 *  different intentions and conflating them loses work nobody asked to lose. */
meRouter.patch('/memory', verifySupabaseAuth, async (req, res) => {
  try {
    const { workspaceId, enabled } = req.body ?? {};
    if (!workspaceId) return res.status(400).json({ error: 'workspaceId_required' });
    if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled_required' });
    const supabase = getSupabaseClient();
    const me = req.internalUserId;
    if (!me) return res.status(401).json({ error: 'no_member' });

    const { data: member } = await supabase.from('workspace_members').select('agent_prefs')
      .eq('workspace_id', workspaceId).eq('user_id', me).maybeSingle();
    const prefs = { ...(member?.agent_prefs ?? {}), memory_enabled: enabled };
    const { error } = await supabase.from('workspace_members').update({ agent_prefs: prefs })
      .eq('workspace_id', workspaceId).eq('user_id', me);
    if (error) throw error;
    return res.json({ enabled });
  } catch (err) {
    console.error('[PATCH /api/me/memory]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

/** DELETE /api/me/memory/:id — forget one thing. Scoped to your own rows on the
 *  delete itself, so a guessed id can only ever reach your own memory. */
meRouter.delete('/memory/:id', verifySupabaseAuth, async (req, res) => {
  try {
    const workspaceId = req.query.workspaceId;
    if (!workspaceId) return res.status(400).json({ error: 'workspaceId_required' });
    const supabase = getSupabaseClient();
    const me = req.internalUserId;
    if (!me) return res.status(401).json({ error: 'no_member' });

    const { error } = await supabase.from('account_memory').delete()
      .eq('id', req.params.id)
      .eq('workspace_id', workspaceId).eq('entity_id', me).eq('owner_user_id', me);
    if (error) throw error;
    return res.status(204).end();
  } catch (err) {
    console.error('[DELETE /api/me/memory/:id]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

/** POST /api/me/memory/overview — rebuild the profile from your facts and cache it. */
meRouter.post('/memory/overview', verifySupabaseAuth, async (req, res) => {
  try {
    const { workspaceId } = req.body ?? {};
    if (!workspaceId) return res.status(400).json({ error: 'workspaceId_required' });
    const supabase = getSupabaseClient();
    const me = req.internalUserId;
    if (!me) return res.status(401).json({ error: 'no_member' });

    const built = await buildMemoryOverview(supabase, workspaceId, me);
    if (!built) return res.json({ overview: null });

    const { data: member } = await supabase.from('workspace_members').select('agent_prefs')
      .eq('workspace_id', workspaceId).eq('user_id', me).maybeSingle();
    const prefs = {
      ...(member?.agent_prefs ?? {}),
      // fact_count is stamped even when the profile came back empty, so a workspace with
      // three unusable facts doesn't rebuild on every single page load.
      memory_overview: { profile: built.profile, fact_count: built.factCount, built_at: new Date().toISOString() },
    };
    await supabase.from('workspace_members').update({ agent_prefs: prefs })
      .eq('workspace_id', workspaceId).eq('user_id', me);
    return res.json({ overview: built.profile });
  } catch (err) {
    console.error('[POST /api/me/memory/overview]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});
