// Team membership — invite a member, remove a member. ONE implementation behind two doors:
// the Settings page (routes/api/teams.mjs, a signed-in admin) and the public API
// (routes/v2/members.mjs, an admin-scoped API key). Each door decides WHO may act; what the
// act does — the plan gate, the seat limit, the token, the email, which rows go — lives here.

import crypto from 'crypto';
import { getSupabaseClient } from '@nous/core';
import { getPlanFromSubscription, effectiveMemberLimit, hasFeature, isSelfHosted, isApiTier } from './plans.mjs';

export const ADMIN_TEAM_ROLES = ['founder', 'owner', 'admin'];

// Returns { sent, link, reason?, error? }. The invite link is ALWAYS returned
// so the caller can surface it even when email can't be sent (self-host with no
// Resend, or a cloud send Resend rejects). Never throws.
export async function sendInviteEmail({ to, inviterName, teamName, token }) {
  const appDomain = process.env.APP_DOMAIN || 'app.opennous.cloud';
  const link = `https://${appDomain}/accept-invitation?token=${token}`;
  const key = process.env.RESEND_API_KEY;
  // No email provider configured (typical self-host) — caller shares the link.
  if (!key) return { sent: false, reason: 'not_configured', link };
  const from = process.env.RESEND_FROM_EMAIL || 'Nous <noreply@opennous.cloud>';
  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        from,
        to: [to],
        subject: `You've been invited to join ${teamName} on Nous`,
        html: `
          <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;color:#111">
            <p style="margin:0 0 16px">Hi,</p>
            <p style="margin:0 0 24px"><strong>${inviterName}</strong> has invited you to join <strong>${teamName}</strong> on Nous — the AI-powered CRM.</p>
            <a href="${link}" style="display:inline-block;background:#0d9488;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-size:14px;font-weight:600">Accept Invitation</a>
            <p style="margin:24px 0 0;color:#666;font-size:13px">This link expires in 7 days. If you weren't expecting this email, you can safely ignore it.</p>
          </div>
        `,
      }),
    });
    // fetch does NOT throw on 4xx/5xx — check explicitly, or a Resend rejection
    // (unverified sender domain, test-mode key, etc.) is silently swallowed and
    // we'd wrongly report the email as sent.
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      console.error(`[INVITE_EMAIL] Resend rejected (${resp.status}): ${body}`);
      return { sent: false, reason: 'send_failed', error: `Resend ${resp.status}: ${body.slice(0, 300)}`, link };
    }
    return { sent: true, link };
  } catch (err) {
    console.error('[INVITE_EMAIL] Failed to send:', err.message);
    return { sent: false, reason: 'exception', error: err.message, link };
  }
}

/** The caller's role on a team, or null when they are not on it (or not in `requiredRoles`). */
export async function checkTeamMembership(userId, teamId, requiredRoles = ['founder', 'owner', 'admin', 'member', 'viewer']) {
  const supabase = getSupabaseClient();
  const { data: membership } = await supabase.from('team_members').select('role').eq('team_id', teamId).eq('user_id', userId).maybeSingle();
  if (!membership) {
    const { data: u } = await supabase.from('users').select('team_id').eq('id', userId).single();
    if (!u || u.team_id !== teamId) return null;
    const { data: fc } = await supabase.from('team_members').select('role').eq('team_id', teamId).eq('user_id', userId).eq('role', 'founder').maybeSingle();
    return fc || { role: 'owner' };
  }
  return requiredRoles.includes(membership.role) ? membership : null;
}

/**
 * Invite someone onto a team by email.
 *
 * `authorize` is the caller's own permission check, run at the point the Settings route has
 * always run it (after input validation, before the plan gate) so neither door's error order
 * changes. Return false to refuse with 403 insufficient_permissions.
 *
 * Returns { ok: true, invitation, email: { sent, link, error? } }
 *      or { ok: false, status, code, ...extra } — `code` is the snake_case error.
 */
export async function createTeamInvitation(supabase, {
  teamId, inviter, email, role = 'member', departmentId = null,
  allowedRoles = ['founder', 'owner', 'admin', 'member', 'viewer'],
  authorize = async () => true,
}) {
  if (typeof email !== 'string' || !email.trim()) return { ok: false, status: 400, code: 'email_required' };
  const normalizedEmail = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) return { ok: false, status: 400, code: 'invalid_email_format' };
  if (!allowedRoles.includes(role)) return { ok: false, status: 400, code: 'invalid_role', supported: allowedRoles };

  // Optional: pre-assign a department so the member lands in the right team on accept.
  // It must be a real department in one of THIS team's workspaces (never another team's).
  let dept = null;
  if (departmentId) {
    const { data: d } = await supabase
      .from('company_departments').select('id, workspace_id').eq('id', departmentId).maybeSingle();
    const { data: ws } = d
      ? await supabase.from('workspaces').select('id').eq('id', d.workspace_id).eq('team_id', teamId).maybeSingle()
      : { data: null };
    if (!d || !ws) return { ok: false, status: 400, code: 'invalid_department' };
    dept = departmentId;
  }

  if (!(await authorize())) return { ok: false, status: 403, code: 'insufficient_permissions' };

  const { data: sub } = await supabase.from('subscriptions').select('*').eq('team_id', teamId).maybeSingle();
  const teamPlan = getPlanFromSubscription(sub);

  // Email invite is an IN-APP path — it lands the member in the web app (accept in the
  // browser, then MemberSetup). On plans with the TEAM layer off (API/Free) members are
  // headless: they join over the CLI (`nous join`) and work through their own agent, so
  // there is no in-app seat to accept into. Block the email path there — the CLI join-token
  // path (POST /join-tokens) stays open. Self-host is single-operator, same rule. This is the
  // server enforcement behind the plan-gated invite UI in Settings.
  // SELF-SERVE INVITES INTO THE APP (GET-571). A self-serve member now has their own onboarding
  // in the app (their mail, their notes, their backfill on the workspace's pool), so the email
  // path is open there too. Seats stay unmetered; credits meter what they read.
  if (isSelfHosted() || (!hasFeature(teamPlan.id, 'inAppAgent') && !isApiTier(teamPlan))) {
    return {
      ok: false, status: 402, code: 'invite_requires_team_plan',
      current_plan: teamPlan.id,
      message: 'On this plan teammates join over the CLI. Share the "Invite by link" command, or upgrade to Growth to invite members into the app.',
      upgrade_url: '/settings?section=billing',
    };
  }

  // Seat limit — count existing members PLUS pending invites so you can't queue past the
  // cap. null = unlimited (other plans).
  const seatLimit = effectiveMemberLimit(teamPlan);
  if (seatLimit != null) {
    const [{ count: memberCount }, { count: pendingCount }] = await Promise.all([
      supabase.from('team_members').select('id', { count: 'exact', head: true }).eq('team_id', teamId),
      supabase.from('team_invitations').select('id', { count: 'exact', head: true }).eq('team_id', teamId).eq('status', 'pending'),
    ]);
    if ((memberCount ?? 0) + (pendingCount ?? 0) >= seatLimit) {
      return {
        ok: false, status: 402, code: 'seat_limit_reached',
        seatLimit,
        message: seatLimit === 1
          ? 'Starter is a single-operator plan. Upgrade to Growth to invite teammates.'
          : `Your plan includes ${seatLimit} members. Upgrade to invite more.`,
      };
    }
  }

  const { data: existing } = await supabase.from('team_invitations').select('id').eq('team_id', teamId).eq('email', normalizedEmail).eq('status', 'pending').maybeSingle();
  if (existing) return { ok: false, status: 400, code: 'invitation_already_exists' };

  const token = crypto.randomBytes(32).toString('hex');
  const { data: invitation, error } = await supabase.from('team_invitations')
    .insert({ team_id: teamId, email: normalizedEmail, token, invited_by_user_id: inviter.id, role, department_id: dept, status: 'pending', expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString() })
    .select().single();
  if (error) throw error;

  const { data: teamData } = await supabase.from('teams').select('name').eq('id', teamId).single();
  const emailResult = await sendInviteEmail({
    to: normalizedEmail,
    inviterName: inviter.name || inviter.email,
    teamName: teamData?.name || 'Your Team',
    token,
  });

  return {
    ok: true,
    invitation: { id: invitation.id, email: invitation.email, role: invitation.role, status: invitation.status, expires_at: invitation.expires_at, created_at: invitation.created_at },
    email: emailResult,
  };
}

/** Take a user off a team and out of every workspace the team owns. No checks — callers guard. */
export async function removeTeamMember(supabase, teamId, userId) {
  await supabase.from('team_members').delete().eq('team_id', teamId).eq('user_id', userId);
  const { data: workspaces } = await supabase.from('workspaces').select('id').eq('team_id', teamId);
  if (workspaces?.length) {
    await supabase.from('workspace_members').delete().in('workspace_id', workspaces.map(w => w.id)).eq('user_id', userId);
  }
}
