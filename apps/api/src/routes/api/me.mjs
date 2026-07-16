import { Router } from 'express';
import { getSupabaseClient } from '@nous/core';
import { verifySupabaseAuth } from '../../middleware/supabaseAuth.mjs';
import { ensureUserAndTeam } from '../../lib/auth.mjs';
import { getCountryFromRequest } from '../../lib/geo.mjs';
import { isAdminEmail } from '../../utils/adminAccess.js';
import { isSelfHosted } from '../../lib/plans.mjs';

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

const MAX_INSTRUCTIONS = 2000;

// GET /api/me/agent-profile?workspaceId=…
meRouter.get('/agent-profile', verifySupabaseAuth, async (req, res) => {
  try {
    const workspaceId = req.query.workspaceId;
    if (!workspaceId) return res.status(400).json({ error: 'workspaceId_required' });

    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('workspace_members')
      .select('job_role, agent_instructions')
      .eq('workspace_id', workspaceId)
      .eq('user_id', req.internalUserId)
      .maybeSingle();
    if (error) throw error;

    return res.json({
      job_role:           data?.job_role ?? null,
      agent_instructions: data?.agent_instructions ?? null,
      job_roles:          JOB_ROLES,
    });
  } catch (err) {
    console.error('[GET /api/me/agent-profile]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// PATCH /api/me/agent-profile — body { workspaceId, job_role?, agent_instructions? }
// Only the fields present are written, so saving the role doesn't wipe the notes.
meRouter.patch('/agent-profile', verifySupabaseAuth, async (req, res) => {
  try {
    const { workspaceId, job_role, agent_instructions } = req.body || {};
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

    if (agent_instructions !== undefined) {
      const v = agent_instructions === null ? '' : String(agent_instructions);
      if (v.length > MAX_INSTRUCTIONS) {
        return res.status(413).json({ error: 'instructions_too_long', max: MAX_INSTRUCTIONS });
      }
      patch.agent_instructions = v.trim() || null;
    }

    if (Object.keys(patch).length === 0) return res.status(400).json({ error: 'nothing_to_update' });

    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('workspace_members')
      .update(patch)
      .eq('workspace_id', workspaceId)
      .eq('user_id', req.internalUserId)
      .select('job_role, agent_instructions')
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'membership_not_found' });

    return res.json({
      job_role:           data.job_role ?? null,
      agent_instructions: data.agent_instructions ?? null,
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

    // Get user's workspaces
    const { data: memberships, error: membershipsError } = await supabase
      .from('workspace_members')
      .select('workspace_id, workspaces:workspace_id(*)')
      .eq('user_id', user.id);

    let workspace = null;
    const workspaceId = req.query.workspace_id;

    // Default workspace picker. When a user belongs to several workspaces (e.g. an
    // invited teammate joined a team that has a real workspace plus a leftover/empty
    // one), prefer an ONBOARDED workspace (business_type set) over whatever Postgres
    // returns first — otherwise they land on a junk/not-onboarded workspace and see
    // the onboarding gate + "not a member"-flavoured failures on the real one.
    const pickDefault = () =>
      memberships.find(m => m.workspaces?.business_type)?.workspaces || memberships[0].workspaces;

    if (!membershipsError && memberships?.length > 0) {
      if (workspaceId) {
        const selected = memberships.find(m => String(m.workspaces?.id) === String(workspaceId));
        workspace = selected?.workspaces || pickDefault();
      } else {
        workspace = pickDefault();
      }
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
      self_hosted: process.env.SELF_HOSTED === 'true',
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
