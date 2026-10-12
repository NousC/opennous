import { Router } from 'express';
import crypto from 'crypto';
import { getSupabaseClient, recogniseTeamMembers } from '@nous/core';
import { verifySupabaseAuth } from '../../middleware/supabaseAuth.mjs';
import { ensureUserAndTeam } from '../../lib/auth.mjs';
import { apiKeyScopeFor } from '../../lib/apiKeyScope.mjs';
import { auditFromReq } from '../../lib/audit.mjs';
import { invalidateAuthCache } from '../../lib/auth.mjs';
import { identityColumn, canClaimByEmailMatch, emailConfirmedWithoutRoundTrip, authProviderName } from '../../lib/authProvider/index.mjs';

// Validate a join token for redemption. Returns the row or a { error } string.
async function loadRedeemableJoinToken(supabase, token) {
  if (!token) return { error: 'join_token_required' };
  const { data: jt } = await supabase.from('team_join_tokens').select('*').eq('token', token).maybeSingle();
  if (!jt) return { error: 'invalid_join_token' };
  if (jt.revoked_at) return { error: 'join_token_revoked' };
  if (jt.expires_at && new Date(jt.expires_at) < new Date()) return { error: 'join_token_expired' };
  if (jt.max_uses != null && jt.uses >= jt.max_uses) return { error: 'join_token_exhausted' };
  return { jt };
}

// CLI / plugin browser-login — an OAuth-style device-authorization flow so a
// user signs in with their browser and the CLI receives a freshly minted API
// key, no copy-paste. start + poll are public (the CLI has no key yet);
// approve requires a logged-in web session.
export const cliAuthRouter = Router();

const TTL_MS = 10 * 60 * 1000; // 10 minutes
const INTERVAL_S = 4;

function appUrl() {
  return process.env.APP_URL || 'https://app.opennous.cloud';
}

// POST /api/cli/auth/start — begin a request. Returns the codes + the URL the CLI opens.
cliAuthRouter.post('/start', async (_req, res) => {
  try {
    const supabase = getSupabaseClient();
    const device_code = `dc_${crypto.randomBytes(32).toString('hex')}`;
    const user_code = crypto.randomBytes(9).toString('base64url'); // ~12 url-safe chars
    const expires_at = new Date(Date.now() + TTL_MS).toISOString();

    const { error } = await supabase
      .from('cli_auth_requests')
      .insert({ device_code, user_code, status: 'pending', expires_at });
    if (error) throw error;

    const verification_uri = `${appUrl()}/cli-login`;
    return res.json({
      device_code,
      user_code,
      verification_uri,
      verification_uri_complete: `${verification_uri}?code=${encodeURIComponent(user_code)}`,
      interval: INTERVAL_S,
      expires_in: Math.floor(TTL_MS / 1000),
    });
  } catch (err) {
    console.error('[POST /api/cli/auth/start]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// POST /api/cli/join/start — like /start, but redeems a team join token. Validates
// the token up front (so a bad token fails in the terminal), then rides the SAME
// device-auth request + browser approve; the join_token on the row tells approve to
// attach the member to the token's team instead of minting a key in their own.
cliAuthRouter.post('/join/start', async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { token } = req.body || {};
    const { jt, error } = await loadRedeemableJoinToken(supabase, token);
    if (error) return res.status(400).json({ error });

    const device_code = `dc_${crypto.randomBytes(32).toString('hex')}`;
    const user_code = crypto.randomBytes(9).toString('base64url');
    const expires_at = new Date(Date.now() + TTL_MS).toISOString();
    const { error: insErr } = await supabase
      .from('cli_auth_requests')
      .insert({ device_code, user_code, status: 'pending', expires_at, join_token: jt.token });
    if (insErr) throw insErr;

    const verification_uri = `${appUrl()}/cli-login`;
    return res.json({
      device_code,
      user_code,
      verification_uri,
      verification_uri_complete: `${verification_uri}?code=${encodeURIComponent(user_code)}`,
      interval: INTERVAL_S,
      expires_in: Math.floor(TTL_MS / 1000),
    });
  } catch (err) {
    console.error('[POST /api/cli/join/start]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// POST /api/cli/auth/poll — the CLI polls with its device_code until approved.
cliAuthRouter.post('/poll', async (req, res) => {
  try {
    const { device_code } = req.body || {};
    if (!device_code) return res.status(400).json({ error: 'device_code_required' });
    const supabase = getSupabaseClient();
    const { data: row } = await supabase
      .from('cli_auth_requests').select('*').eq('device_code', device_code).maybeSingle();
    if (!row) return res.status(404).json({ error: 'unknown_device_code' });
    if (new Date(row.expires_at) < new Date()) return res.json({ status: 'expired' });

    if (row.status === 'approved') {
      // Hand the key back exactly once, then consume the request.
      await supabase.from('cli_auth_requests')
        .update({ status: 'consumed', raw_key: null }).eq('id', row.id);
      return res.json({ status: 'approved', api_key: row.raw_key, workspace_id: row.workspace_id });
    }
    if (row.status === 'consumed') return res.json({ status: 'consumed' });
    if (row.status === 'denied')   return res.json({ status: 'denied' });
    return res.json({ status: 'pending' });
  } catch (err) {
    console.error('[POST /api/cli/auth/poll]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// POST /api/cli/auth/approve — the signed-in user approves; mint a key for their workspace.
cliAuthRouter.post('/approve', verifySupabaseAuth, async (req, res) => {
  try {
    const { user_code } = req.body || {};
    if (!user_code) return res.status(400).json({ error: 'user_code_required' });

    const supabase = getSupabaseClient();
    const { data: row } = await supabase
      .from('cli_auth_requests').select('*')
      .eq('user_code', user_code).eq('status', 'pending')
      .order('created_at', { ascending: false }).limit(1).maybeSingle();
    if (!row) return res.status(404).json({ error: 'unknown_or_used_code' });
    if (new Date(row.expires_at) < new Date()) return res.status(410).json({ error: 'expired' });

    // JOIN branch — this request is redeeming a team join token. Attach the approving
    // person to the token's team as a member and mint them a member-scoped key there,
    // ignoring whatever workspace their session happens to sit in.
    if (row.join_token) {
      return await approveJoin(req, res, supabase, row);
    }

    const workspaceId = req.workspaceId;
    if (!workspaceId) return res.status(400).json({ error: 'workspace_required' });

    // Mint an API key scoped to the approving member (same rule as
    // POST /api/workspace/api-keys): a member gets a member-scoped key, an
    // owner/admin an admin key. See PRIVACY_MODEL.md.
    const rawKey = `pk_${crypto.randomBytes(24).toString('hex')}`;
    const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
    // Short suffix keeps the (workspace_id, name) unique constraint happy across logins.
    const name = `CLI login ${crypto.randomBytes(2).toString('hex')}`;
    const { data: keyRow, error: keyErr } = await supabase
      .from('api_keys').insert({
        workspace_id: workspaceId, name, key_hash: keyHash,
        created_by_user_id: req.internalUserId ?? null,
        ...apiKeyScopeFor(req),
      })
      .select('id').single();
    if (keyErr) throw keyErr;

    const { error: updErr } = await supabase.from('cli_auth_requests').update({
      status: 'approved',
      workspace_id: workspaceId,
      api_key_id: keyRow.id,
      raw_key: rawKey,
      approved_at: new Date().toISOString(),
    }).eq('id', row.id);
    if (updErr) throw updErr;

    auditFromReq(req, {
      action: 'cli.token_issued',
      target_type: 'api_key',
      target_id: keyRow.id,
      target_workspace_id: workspaceId,
      metadata: { name },
    });

    return res.json({ ok: true });
  } catch (err) {
    console.error('[POST /api/cli/auth/approve]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// Attach the approving person to a join token's team as a member, mint them a
// member-scoped key there, and complete the CLI request. Reuses the invitation
// attach shape (team_members + workspace_members across the team's workspaces).
async function approveJoin(req, res, supabase, row) {
  const { jt, error } = await loadRedeemableJoinToken(supabase, row.join_token);
  if (error) return res.status(400).json({ error });

  // The approver's identity. By the time the browser can approve, /api/me has
  // provisioned their user row, so skipTeamCreation is safe (no stray team minted here).
  let { user } = await ensureUserAndTeam(req.user, true);
  // Self-host (Supabase Auth): a new teammate may have no Nous user yet, and with
  // DISABLE_SIGNUPS=true /me never makes one for them. The join token is the proof, so
  // provision them straight into the token's team (after the domain checks below).
  // Cloud (Clerk) keeps the old path: /me provisions first, this retries on 409.
  const provisionHere = !user && authProviderName() === 'supabase';
  if (!user && !provisionHere) return res.status(409).json({ error: 'provisioning', retry: true });
  const email = user?.email ?? req.user?.email ?? '';

  // Domain lock: only <name>@domain may redeem, when the token sets one.
  if (jt.domain && !email.toLowerCase().endsWith(`@${jt.domain}`)) {
    return res.status(403).json({ error: 'domain_mismatch', domain: jt.domain });
  }
  // A domain lock is only as good as the email behind it, so it takes the same proof as
  // any other claim by email (canClaimByEmailMatch). Always true on Clerk (Cloud
  // unchanged). On Supabase Auth the address must be proven by a confirmation email;
  // under autoconfirm nothing is, since anyone can sign up as <name>@domain, so a
  // domain-locked token cannot be redeemed there at all (and cannot be created, see
  // POST /api/teams/:id/join-tokens).
  if (jt.domain && !(await canClaimByEmailMatch(req.user?.id, email))) {
    if (emailConfirmedWithoutRoundTrip()) {
      return res.status(403).json({
        error: 'domain_lock_unavailable',
        message: 'This join link is limited to an email domain, which this instance cannot check: it confirms addresses without sending an email. Ask the owner for a join link without a domain.',
      });
    }
    return res.status(403).json({ error: 'email_unverified' });
  }
  if (provisionHere) {
    ({ user } = await ensureUserAndTeam(req.user, false, { invitation: { team_id: jt.team_id } }));
    if (!user) return res.status(409).json({ error: 'provisioning', retry: true });
  }

  const memberRole = jt.role === 'admin' ? 'admin' : jt.role === 'viewer' ? 'viewer' : 'member';

  // Add to the team (idempotent — a re-approve or a race is success, not a 500).
  const { error: tmErr } = await supabase.from('team_members')
    .insert({ team_id: jt.team_id, user_id: user.id, role: memberRole });
  if (tmErr && tmErr.code !== '23505') throw tmErr;

  // Add to every workspace on the team at the mapped scope; flag internal so a
  // teammate is never mistaken for a lead. Best-effort per workspace.
  const { data: workspaces } = await supabase.from('workspaces').select('id').eq('team_id', jt.team_id);
  const wsList = workspaces || [];
  const wsRole = memberRole; // admin → admin, viewer → viewer, else member
  // Pre-assigned department (parity with the email invite): set it only on the workspace
  // that owns the department, so the member lands already scoped to the right vault folders.
  let deptWorkspaceId = null;
  if (jt.department_id) {
    const { data: dept } = await supabase.from('company_departments').select('workspace_id').eq('id', jt.department_id).maybeSingle();
    deptWorkspaceId = dept?.workspace_id ?? null;
  }
  await Promise.allSettled(wsList.map((ws) =>
    supabase.from('workspace_members').insert({
      workspace_id: ws.id, user_id: user.id, role: wsRole,
      // Pre-assigned GTM role from the invite (job_roles live on workspace_members) → the member
      // lands already scoped, so role-report + their role view work on their first onboarding.
      ...(jt.job_role ? { job_roles: [jt.job_role], job_role: jt.job_role } : {}),
      ...(jt.department_id && ws.id === deptWorkspaceId ? { department_id: jt.department_id } : {}),
    })));
  await Promise.allSettled(wsList.map((ws) => recogniseTeamMembers(supabase, ws.id)));

  // Make the joined team their primary (same as invitation-accept). They keep any
  // prior membership; a brand-new signup's auto-created empty solo team is left
  // orphaned — a memberless-team cleanup sweep is a follow-up (docs/api-plan-cli-join.md).
  if (user.team_id !== jt.team_id) {
    try { await supabase.from('users').update({ team_id: jt.team_id }).eq('id', user.id); } catch { /* best-effort */ }
    // Same reason as the invitation path: the cached identity is now wrong (GET-312).
    invalidateAuthCache(user?.[identityColumn()]);
  }

  // Mint a member-scoped key in the team's primary workspace.
  const primaryWs = wsList[0]?.id;
  if (!primaryWs) return res.status(409).json({ error: 'no_workspace', detail: 'The team has no workspace yet.' });
  const rawKey = `pk_${crypto.randomBytes(24).toString('hex')}`;
  const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
  const name = `CLI join ${crypto.randomBytes(2).toString('hex')}`;
  const { data: keyRow, error: keyErr } = await supabase.from('api_keys').insert({
    workspace_id: primaryWs, name, key_hash: keyHash,
    created_by_user_id: user.id, owner_user_id: user.id, scope: 'member',
  }).select('id').single();
  if (keyErr) throw keyErr;

  // Consume one use of the token (the cap is also checked up front in loadRedeemable…).
  await supabase.from('team_join_tokens').update({ uses: (jt.uses || 0) + 1 }).eq('id', jt.id);

  const { error: updErr } = await supabase.from('cli_auth_requests').update({
    status: 'approved', workspace_id: primaryWs, api_key_id: keyRow.id,
    raw_key: rawKey, approved_at: new Date().toISOString(),
  }).eq('id', row.id);
  if (updErr) throw updErr;

  auditFromReq(req, {
    action: 'cli.member_joined', target_type: 'api_key', target_id: keyRow.id,
    target_workspace_id: primaryWs, metadata: { team_id: jt.team_id, role: memberRole, join_token_id: jt.id },
  });

  return res.json({ ok: true, joined_team_id: jt.team_id });
}
