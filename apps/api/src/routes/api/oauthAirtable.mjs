import { Router } from 'express';
import crypto from 'crypto';
import { getSupabaseClient } from '@nous/core';
import { verifySupabaseAuth } from '../../middleware/supabaseAuth.mjs';
import { encrypt } from '../../utils/crypto.mjs';

export const oauthAirtableRouter = Router();

const SCOPES = [
  'data.records:read', 'data.records:write',
  'data.recordComments:read', 'data.recordComments:write',
  'schema.bases:read', 'schema.bases:write',
  'webhook:manage', 'user.email:read',
].join(' ');

// In-memory CSRF + PKCE state store (10-min TTL)
const states = new Map();
setInterval(() => {
  const cutoff = Date.now() - 600_000;
  for (const [k, v] of states) if (v.timestamp < cutoff) states.delete(k);
}, 60_000);

function pkce() {
  const verifier = crypto.randomBytes(32).toString('base64url').replace(/=/g, '');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url').replace(/=/g, '');
  return { verifier, challenge };
}

// GET /api/workflow-providers/airtable/oauth/authorize  — authenticated
oauthAirtableRouter.get('/authorize', verifySupabaseAuth, async (req, res) => {
  const { workspace_id } = req.query;
  if (!workspace_id) return res.status(400).json({ error: 'workspace_id_required' });
  if (!process.env.AIRTABLE_CLIENT_ID) return res.status(500).json({ error: 'airtable_not_configured' });

  const { verifier, challenge } = pkce();
  const state = crypto.randomBytes(32).toString('hex');
  states.set(state, { workspaceId: workspace_id, userId: req.internalUserId, verifier, timestamp: Date.now() });

  const url = new URL('https://airtable.com/oauth2/v1/authorize');
  url.searchParams.set('client_id',              (process.env.AIRTABLE_CLIENT_ID || '').trim());
  url.searchParams.set('redirect_uri',           (process.env.AIRTABLE_REDIRECT_URI || '').trim());
  url.searchParams.set('response_type',          'code');
  url.searchParams.set('scope',                  SCOPES);
  url.searchParams.set('state',                  state);
  url.searchParams.set('code_challenge',         challenge);
  url.searchParams.set('code_challenge_method',  'S256');

  return res.json({ authorization_url: url.toString() });
});

// GET /api/workflow-providers/airtable/oauth/callback  — no auth, redirect from Airtable
oauthAirtableRouter.get('/callback', async (req, res) => {
  const msg = (success, opts = {}) => {
    const payload = JSON.stringify({ type: 'airtable_auth', success, ...opts });
    const text = success ? 'Airtable connected! You can close this window.' : 'Connection failed. You can close this window.';
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
    const { data: provider } = await supabase.from('workflow_providers').select('id').eq('name', 'airtable').single();
    if (!provider) return msg(false, { error: 'provider_not_configured' });

    const clientId     = (process.env.AIRTABLE_CLIENT_ID     || '').trim();
    const clientSecret = (process.env.AIRTABLE_CLIENT_SECRET || '').trim();
    const redirectUri  = (process.env.AIRTABLE_REDIRECT_URI  || '').trim();

    const tokenRes = await fetch('https://airtable.com/oauth2/v1/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
      },
      body: new URLSearchParams({
        grant_type:    'authorization_code',
        code,
        redirect_uri:  redirectUri,
        code_verifier: stateData.verifier,
      }),
    });

    const tokenData = await tokenRes.json();
    if (!tokenRes.ok || tokenData.error) {
      console.error('[AIRTABLE_OAUTH] Token exchange failed:', tokenData);
      return msg(false, { error: tokenData.error_description || tokenData.error || 'token_exchange_failed' });
    }

    const now = Date.now();
    const encryptedCredentials = {
      access_token:         encrypt(tokenData.access_token),
      refresh_token:        encrypt(tokenData.refresh_token),
      token_expiry:         new Date(now + tokenData.expires_in * 1000).toISOString(),
      refresh_token_expiry: new Date(now + 60 * 24 * 60 * 60 * 1000).toISOString(),
      scope:                tokenData.scope || SCOPES,
      token_type:           tokenData.token_type || 'Bearer',
    };

    // Upsert — update if connection already exists for this workspace
    const { data: existing } = await supabase
      .from('workflow_provider_connections')
      .select('id')
      .eq('workspace_id', stateData.workspaceId)
      .eq('provider_id', provider.id)
      .single();

    if (existing) {
      await supabase.from('workflow_provider_connections')
        .update({ encrypted_credentials: encryptedCredentials, is_verified: true })
        .eq('id', existing.id);
      console.log('[AIRTABLE_OAUTH] Updated connection:', existing.id);
      return msg(true, { connection_id: existing.id });
    }

    const { data: newConn, error: insertErr } = await supabase
      .from('workflow_provider_connections')
      .insert({ workspace_id: stateData.workspaceId, provider_id: provider.id, name: 'Airtable', encrypted_credentials: encryptedCredentials, is_verified: true })
      .select('id')
      .single();

    if (insertErr) return msg(false, { error: 'connection_create_failed' });
    console.log('[AIRTABLE_OAUTH] Created connection:', newConn.id);
    return msg(true, { connection_id: newConn.id });
  } catch (err) {
    console.error('[AIRTABLE_OAUTH_CALLBACK_ERROR]', err.message);
    return msg(false, { error: err.message });
  }
});
