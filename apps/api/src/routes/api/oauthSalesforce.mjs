import { Router } from 'express';
import crypto from 'crypto';
import { getSupabaseClient } from '@nous/core';
import { verifySupabaseAuth } from '../../middleware/supabaseAuth.mjs';
import { encrypt } from '../../utils/crypto.mjs';

export const oauthSalesforceRouter = Router();

// Scopes: read/write CRM objects + offline access (refresh tokens)
const SCOPES = ['api', 'refresh_token', 'offline_access'].join(' ');

// In-memory CSRF + PKCE state store (10-min TTL)
const states = new Map();
setInterval(() => {
  const cutoff = Date.now() - 600_000;
  for (const [k, v] of states) if (v.timestamp < cutoff) states.delete(k);
}, 60_000);

function pkce() {
  const verifier  = crypto.randomBytes(32).toString('base64url').replace(/=/g, '');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url').replace(/=/g, '');
  return { verifier, challenge };
}

// Use 'login.salesforce.com' (prod) by default; switch via env for sandboxes.
function loginHost() {
  return (process.env.SALESFORCE_LOGIN_URL || 'https://login.salesforce.com').replace(/\/$/, '');
}

// GET /api/workflow-providers/salesforce/oauth/authorize  — authenticated
oauthSalesforceRouter.get('/authorize', verifySupabaseAuth, async (req, res) => {
  const workspaceId   = req.query.workspace_id || req.query.workspaceId;
  const connectionName = req.query.connectionName || 'Salesforce';
  if (!workspaceId) return res.status(400).json({ error: 'workspace_id_required' });
  if (!process.env.SALESFORCE_CLIENT_ID || !process.env.SALESFORCE_REDIRECT_URI) {
    return res.status(500).json({ error: 'salesforce_not_configured' });
  }

  const { verifier, challenge } = pkce();
  const state = crypto.randomBytes(32).toString('hex');
  states.set(state, {
    workspaceId, userId: req.internalUserId, verifier,
    connectionName, timestamp: Date.now(),
  });

  const url = new URL(`${loginHost()}/services/oauth2/authorize`);
  url.searchParams.set('client_id',             (process.env.SALESFORCE_CLIENT_ID    || '').trim());
  url.searchParams.set('redirect_uri',          (process.env.SALESFORCE_REDIRECT_URI || '').trim());
  url.searchParams.set('response_type',         'code');
  url.searchParams.set('scope',                 SCOPES);
  url.searchParams.set('state',                 state);
  url.searchParams.set('code_challenge',        challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  // Force the consent prompt so refresh_token is returned every time
  url.searchParams.set('prompt', 'consent');

  return res.json({ authorization_url: url.toString() });
});

// GET /api/workflow-providers/salesforce/oauth/callback  — no auth, redirect from Salesforce
oauthSalesforceRouter.get('/callback', async (req, res) => {
  const msg = (success, opts = {}) => {
    const payload = JSON.stringify({ type: 'salesforce_auth', success, ...opts });
    const text = success ? 'Salesforce connected! You can close this window.' : 'Connection failed. You can close this window.';
    return res.send(`<html><body><script>window.opener?.postMessage(${payload},'*');window.close();</script><p>${text}</p></body></html>`);
  };

  const { code, state, error: oauthError } = req.query;
  if (oauthError) return msg(false, { error: oauthError });
  if (!code || !state) return msg(false, { error: 'missing_parameters' });

  const stateData = states.get(state);
  if (!stateData) return msg(false, { error: 'invalid_state' });
  states.delete(state);

  try {
    const supabase = getSupabaseClient();
    const { data: provider } = await supabase
      .from('workflow_providers').select('id').eq('name', 'salesforce').single();
    if (!provider) return msg(false, { error: 'provider_not_configured' });

    const clientId     = (process.env.SALESFORCE_CLIENT_ID     || '').trim();
    const clientSecret = (process.env.SALESFORCE_CLIENT_SECRET || '').trim();
    const redirectUri  = (process.env.SALESFORCE_REDIRECT_URI  || '').trim();

    const tokenRes = await fetch(`${loginHost()}/services/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type:    'authorization_code',
        code,
        client_id:     clientId,
        client_secret: clientSecret,
        redirect_uri:  redirectUri,
        code_verifier: stateData.verifier,
      }),
    });

    const tokenData = await tokenRes.json();
    if (!tokenRes.ok || tokenData.error) {
      console.error('[SALESFORCE_OAUTH] Token exchange failed:', tokenData);
      return msg(false, { error: tokenData.error_description || tokenData.error || 'token_exchange_failed' });
    }

    // Salesforce returns `instance_url` — REST API base for this org
    const encryptedCredentials = {
      access_token:  encrypt(tokenData.access_token),
      refresh_token: tokenData.refresh_token ? encrypt(tokenData.refresh_token) : null,
      instance_url:  tokenData.instance_url,        // plain — not a secret, needed for every request
      issued_at:     tokenData.issued_at,
      token_type:    tokenData.token_type || 'Bearer',
      scope:         tokenData.scope || SCOPES,
    };

    // Upsert — replace existing connection for this workspace
    const { data: existing } = await supabase
      .from('workflow_provider_connections')
      .select('id')
      .eq('workspace_id', stateData.workspaceId)
      .eq('provider_id', provider.id)
      .maybeSingle();

    if (existing) {
      await supabase.from('workflow_provider_connections')
        .update({ encrypted_credentials: encryptedCredentials, is_verified: true })
        .eq('id', existing.id);
      return msg(true, { connection_id: existing.id });
    }

    const { data: newConn, error: insertErr } = await supabase
      .from('workflow_provider_connections')
      .insert({
        workspace_id: stateData.workspaceId,
        provider_id:  provider.id,
        name:         stateData.connectionName || 'Salesforce',
        encrypted_credentials: encryptedCredentials,
        is_verified:  true,
      })
      .select('id').single();

    if (insertErr) {
      console.error('[SALESFORCE_OAUTH] insert failed', insertErr);
      return msg(false, { error: 'connection_create_failed' });
    }
    return msg(true, { connection_id: newConn.id });
  } catch (err) {
    console.error('[SALESFORCE_OAUTH_CALLBACK_ERROR]', err.message);
    return msg(false, { error: err.message });
  }
});
