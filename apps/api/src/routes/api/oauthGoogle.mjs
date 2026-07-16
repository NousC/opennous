import { Router } from 'express';
import crypto from 'crypto';
import { google } from 'googleapis';
import { getSupabaseClient } from '@nous/core';
import { verifySupabaseAuth } from '../../middleware/supabaseAuth.mjs';
import { encrypt } from '../../utils/crypto.mjs';

export const oauthGoogleRouter = Router();

// In-memory CSRF state store (10-min TTL)
const oauthStates = new Map();
setInterval(() => {
  const cutoff = Date.now() - 600_000;
  for (const [k, v] of oauthStates) if (v.timestamp < cutoff) oauthStates.delete(k);
}, 60_000);

function makeOAuth2Client() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_OAUTH_REDIRECT_URI,
  );
}

// GET /api/oauth/google/gmail/authorize  — authenticated, returns authUrl
oauthGoogleRouter.get('/gmail/authorize', verifySupabaseAuth, async (req, res) => {
  const { workspaceId, connectionName } = req.query;
  if (!workspaceId || !connectionName) return res.status(400).json({ error: 'workspace_id_and_name_required' });
  if (!process.env.GOOGLE_CLIENT_ID) return res.status(500).json({ error: 'google_oauth_not_configured' });

  const state = crypto.randomBytes(32).toString('hex');
  oauthStates.set(state, { workspaceId, connectionName, userId: req.internalUserId, timestamp: Date.now() });

  const authUrl = makeOAuth2Client().generateAuthUrl({
    access_type: 'offline',
    scope: [
      'https://www.googleapis.com/auth/gmail.send',
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/calendar.readonly',
    ],
    state,
    prompt: 'consent',
  });

  return res.json({ authUrl });
});

// GET /api/oauth/google/callback  — no auth, redirect from Google
oauthGoogleRouter.get('/callback', async (req, res) => {
  const frontendUrl = process.env.APP_URL || `https://${process.env.APP_DOMAIN}` || 'https://app.opennous.cloud';
  const { code, state, error: oauthError } = req.query;

  if (oauthError) return res.redirect(`${frontendUrl}/oauth-callback.html?oauth_error=${oauthError}`);
  if (!code || !state) return res.redirect(`${frontendUrl}/oauth-callback.html?oauth_error=missing_code_or_state`);

  const stateData = oauthStates.get(state);
  if (!stateData) return res.redirect(`${frontendUrl}/oauth-callback.html?oauth_error=invalid_state`);
  oauthStates.delete(state);

  try {
    const client = makeOAuth2Client();
    const { tokens } = await client.getToken(code);
    client.setCredentials(tokens);

    const { data: userInfo } = await google.oauth2({ version: 'v2', auth: client }).userinfo.get();

    const supabase = getSupabaseClient();
    const { data: provider } = await supabase.from('workflow_providers').select('id').eq('name', 'gmail_oauth').single();
    if (!provider) throw new Error('Gmail OAuth provider not found in database');

    const credentials = {
      access_token:  encrypt(tokens.access_token),
      refresh_token: encrypt(tokens.refresh_token),
      // Store as unix-ms number to match what googleapis' refreshAccessToken() returns.
      // Field name MUST be expiry_date (not token_expiry) — refreshGoogleToken reads this exact key.
      expiry_date:   tokens.expiry_date,
      email:         userInfo.email,
      scope:         tokens.scope,
    };

    // Per-member mailboxes: key the connection by (workspace, provider, OWNER) so
    // each teammate gets their OWN Gmail row instead of overwriting the workspace's
    // one connection. Reconnecting updates that member's row; a new member inserts
    // a new one. The name is the member's email, which also keeps the
    // (workspace_id, provider_id, name) unique index distinct across members.
    // See PRIVACY_MODEL.md / internal/MULTI_ACCOUNT_FOUNDATION.md. The poller already
    // iterates all connections and attributes each email to its owner.
    const connName = userInfo.email || stateData.connectionName;
    const { data: existing } = await supabase
      .from('workflow_provider_connections')
      .select('id')
      .eq('workspace_id', stateData.workspaceId)
      .eq('provider_id', provider.id)
      .eq('owner_user_id', stateData.userId)
      .maybeSingle();

    let connection;
    if (existing) {
      const { data, error } = await supabase
        .from('workflow_provider_connections')
        .update({
          encrypted_credentials: credentials,
          name: connName,
          is_verified: true,
          last_test_at: new Date().toISOString(),
          owner_user_id: stateData.userId,
          account_email: userInfo.email?.toLowerCase() ?? null,
        })
        .eq('id', existing.id)
        .select('id')
        .single();
      if (error) throw error;
      connection = data;
      console.log('[GOOGLE_OAUTH] Updated existing connection:', existing.id);
    } else {
      const { data, error } = await supabase
        .from('workflow_provider_connections')
        .insert({
          workspace_id: stateData.workspaceId,
          provider_id: provider.id,
          name: connName,
          encrypted_credentials: credentials,
          created_by: stateData.userId,
          owner_user_id: stateData.userId,
          account_email: userInfo.email?.toLowerCase() ?? null,
          is_verified: true,
          last_test_at: new Date().toISOString(),
        })
        .select('id')
        .single();
      if (error) throw error;
      connection = data;
    }

    console.log('[GOOGLE_OAUTH] Connected:', userInfo.email, 'connection:', connection.id);
    return res.redirect(`${frontendUrl}/oauth-callback.html?oauth_success=true&connection_id=${connection.id}`);
  } catch (err) {
    console.error('[GOOGLE_OAUTH_CALLBACK_ERROR]', err.message);
    return res.redirect(`${frontendUrl}/oauth-callback.html?oauth_error=callback_failed&error_message=${encodeURIComponent(err.message)}`);
  }
});
