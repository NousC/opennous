// Partner OS provisioning endpoint — service-to-service. Lets the Partner OS
// (the agency white-label layer) create a Nous workspace for a new client and
// mint a workspace API key it can operate that workspace with.
//
// Auth is a shared secret (PARTNER_PROVISION_SECRET), NOT a user session — the
// caller is the Partner OS backend, not a browser. Disabled (503) if the secret
// is unset, so it's dead unless Nous Cloud opts in.
//
// POST /api/admin/provision/workspace
//   headers: X-Partner-Secret: <PARTNER_PROVISION_SECRET>
//   body:    { team_id, owner_user_id, name }
//   → 201 { workspace_id, api_key }   (raw key returned ONCE, never stored)

import express from 'express';
import crypto from 'node:crypto';
import { getSupabaseClient } from '@nous/core';
import { ensureUserAndTeam } from '../../../lib/auth.mjs';
import { clerkClient, findClerkUserByEmail } from '../../../lib/clerk.mjs';
import { runOnboardingAgent } from '../../../lib/onboardingAgent.mjs';

export const provisionRouter = express.Router();

function requirePartnerSecret(req, res, next) {
  const secret = process.env.PARTNER_PROVISION_SECRET;
  if (!secret) return res.status(503).json({ error: 'provisioning_disabled' });
  const given = req.headers['x-partner-secret'];
  if (!given || given !== secret) return res.status(401).json({ error: 'unauthorized' });
  next();
}

// POST /api/admin/provision/account — create a full, isolated Nous ACCOUNT for a
// new Partner OS agency: a service auth user + its own team + master workspace +
// Free subscription (via the canonical ensureUserAndTeam), then an admin key.
// Used when a brand-new agency signs up so it gets its OWN team, not a shared one.
//   body: { name, email? }  (email defaults to a derived service address)
//   → 201 { nous_user_id, team_id, workspace_id, api_key }
provisionRouter.post('/account', requirePartnerSecret, async (req, res) => {
  try {
    const name = (req.body?.name || 'Agency').trim();
    const email = (req.body?.email || `agency-${crypto.randomBytes(6).toString('hex')}@partner.opennous.cloud`).toLowerCase();
    const supabase = getSupabaseClient();

    // 1. Service Clerk user (no email sent). The agency operates the workspace
    //    through its MCP key — it never logs into Nous interactively, so it's
    //    created passwordless. Reuse if one already exists for this email.
    let clerkUser;
    try {
      clerkUser = await findClerkUserByEmail(email)
        || await clerkClient.users.createUser({ emailAddress: [email], firstName: name, skipPasswordRequirement: true });
    } catch (e) {
      return res.status(400).json({ error: 'auth_user', detail: e?.message });
    }

    // 2. Canonical account bootstrap: team + user + workspace + membership + Free sub.
    const { user, team } = await ensureUserAndTeam({ id: clerkUser.id, email, user_metadata: { name } });

    // 3. The workspace ensureUserAndTeam created for the team.
    const { data: ws } = await supabase.from('workspaces').select('id').eq('team_id', team.id).order('created_at').limit(1).maybeSingle();
    if (!ws) return res.status(500).json({ error: 'workspace_not_created' });

    // 4. Mint the workspace admin key the Partner OS operates it with.
    const rawKey = `pk_${crypto.randomBytes(24).toString('hex')}`;
    const key_hash = crypto.createHash('sha256').update(rawKey).digest('hex');
    const { error: keyErr } = await supabase.from('api_keys').insert({
      workspace_id: ws.id, name: 'Partner OS', key_hash, created_by_user_id: null, owner_user_id: null, scope: 'admin',
    });
    if (keyErr) throw keyErr;

    return res.status(201).json({ nous_user_id: user.id, team_id: team.id, workspace_id: ws.id, api_key: rawKey, email });
  } catch (err) {
    console.error('[provision/account]', err?.message || err);
    return res.status(500).json({ error: 'internal_error', detail: err?.message });
  }
});

// POST /api/admin/provision/graduate — "graduation": hand a managed client
// workspace over to the client's OWN Nous account. The agency ran outbound in a
// workspace under its own team; when the client wants their own Nous (e.g. to
// connect their personal mailbox), we create/reuse an account for the client's
// REAL email and REASSIGN the existing workspace to that team — so all data
// (contacts, claims, foundations, history) moves with it (the rows reference
// workspace_id, which is unchanged). The agency owner is kept as a member so it
// stays a delegated collaborator. The client claims the login via password reset.
//   body: { workspace_id, email, name?, agency_owner_user_id? }
//   → 201 { nous_user_id, team_id, workspace_id, email }
provisionRouter.post('/graduate', requirePartnerSecret, async (req, res) => {
  try {
    const { workspace_id, email, name, agency_owner_user_id } = req.body || {};
    if (!workspace_id || !email?.trim()) return res.status(400).json({ error: 'workspace_id, email required' });
    const supabase = getSupabaseClient();
    const addr = email.trim().toLowerCase();

    // 1. Ensure a Clerk user for the client's real email. Reuse if it already
    //    exists; otherwise create passwordless (they claim the login below).
    let clerkUser;
    try {
      clerkUser = await findClerkUserByEmail(addr)
        || await clerkClient.users.createUser({ emailAddress: [addr], firstName: name || addr, skipPasswordRequirement: true });
    } catch (e) {
      return res.status(400).json({ error: 'auth_user', detail: e?.message });
    }

    // 2. Ensure the client's own team + Nous user (canonical bootstrap).
    const { user, team } = await ensureUserAndTeam({ id: clerkUser.id, email: addr, user_metadata: { name: name || addr } });

    // 3. Move the workspace to the client's team — data-preserving handoff.
    const { error: wErr } = await supabase.from('workspaces').update({ team_id: team.id }).eq('id', workspace_id);
    if (wErr) throw wErr;

    // 4. Client owns it; agency owner stays a member (delegated collaborator).
    await supabase.from('workspace_members').upsert({ workspace_id, user_id: user.id, role: 'owner' }, { onConflict: 'workspace_id,user_id' });
    if (agency_owner_user_id) {
      await supabase.from('workspace_members').upsert({ workspace_id, user_id: agency_owner_user_id, role: 'member' }, { onConflict: 'workspace_id,user_id' });
    }

    // 5. A claim link so the client can take over their login. Clerk's version of
    //    a recovery link is a sign-in-token "ticket" the /login page consumes:
    //    they land signed in, then set a password from account settings. Best-effort
    //    — the account exists regardless; the agency shares this link (branded email
    //    on their side).
    let claim_url = null;
    try {
      const appUrl = (process.env.APP_URL || 'https://app.opennous.cloud').replace(/\/$/, '');
      const created = await clerkClient.signInTokens.createSignInToken({
        userId: clerkUser.id,
        expiresInSeconds: 60 * 60 * 24 * 7,
      });
      claim_url = created?.token ? `${appUrl}/login?__clerk_ticket=${encodeURIComponent(created.token)}` : null;
    } catch (e) { console.warn('[provision/graduate] claim link:', e?.message || e); }

    return res.status(201).json({ nous_user_id: user.id, team_id: team.id, workspace_id, email: addr, claim_url });
  } catch (err) {
    console.error('[provision/graduate]', err?.message || err);
    return res.status(500).json({ error: 'internal_error', detail: err?.message });
  }
});

// POST /api/admin/provision/onboard — the server-side onboarding AGENT for Partner
// OS form submissions. A Haiku routine reads the client's website + intake answers,
// drafts the ICP/positioning/voice foundations, seeds the ICP scoring model, and marks
// the workspace onboarded. Only runs for agency form submissions; direct Nous users
// onboard via their own Claude Code.
//   body: { workspace_id, company_name?, website?, offer?, icp?, positioning?, voice? }
//   → 200 { ok, built: { foundations, scorecard, business_type, errors } }
provisionRouter.post('/onboard', requirePartnerSecret, async (req, res) => {
  try {
    const { workspace_id, company_name, website, offer, icp, positioning, voice, example_customers } = req.body || {};
    if (!workspace_id) return res.status(400).json({ error: 'workspace_id required' });
    const supabase = getSupabaseClient();
    const built = await runOnboardingAgent(supabase, workspace_id, { company_name, website, offer, icp, positioning, voice, example_customers });
    return res.json({ ok: true, built });
  } catch (err) {
    console.error('[provision/onboard]', err?.message || err);
    return res.status(500).json({ error: 'internal_error', detail: err?.message });
  }
});

provisionRouter.post('/workspace', requirePartnerSecret, async (req, res) => {
  try {
    const { team_id, owner_user_id, name } = req.body || {};
    if (!team_id || !owner_user_id || !name?.trim()) {
      return res.status(400).json({ error: 'team_id, owner_user_id, name required' });
    }
    const supabase = getSupabaseClient();

    // 1. Create the workspace under the agency's team.
    const { data: workspace, error: wsErr } = await supabase
      .from('workspaces')
      .insert({ team_id, name: name.trim() })
      .select('id')
      .single();
    if (wsErr) throw wsErr;

    // 2. Make the agency owner the workspace owner.
    await supabase.from('workspace_members').insert({
      workspace_id: workspace.id, user_id: owner_user_id, role: 'owner',
    });

    // 3. Mint a workspace-scoped automation key (admin scope, not tied to a person).
    const rawKey = `pk_${crypto.randomBytes(24).toString('hex')}`;
    const key_hash = crypto.createHash('sha256').update(rawKey).digest('hex');
    const { error: keyErr } = await supabase.from('api_keys').insert({
      workspace_id: workspace.id, name: 'Partner OS', key_hash,
      created_by_user_id: null, owner_user_id: null, scope: 'admin',
    });
    if (keyErr) throw keyErr;

    return res.status(201).json({ workspace_id: workspace.id, api_key: rawKey });
  } catch (err) {
    console.error('[provision/workspace]', err?.message || err);
    return res.status(500).json({ error: 'internal_error', detail: err?.message });
  }
});
