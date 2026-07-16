import { Router } from 'express';
import crypto from 'crypto';
import { getSupabaseClient } from '@nous/core';
import { verifySupabaseAuth } from '../../middleware/supabaseAuth.mjs';
import { encrypt } from '../../utils/crypto.mjs';

export const oauthSlackRouter = Router();

// User token scopes — needed to read DMs and channel messages on the user's behalf
const USER_SCOPES = [
  'channels:history', 'channels:read',
  'groups:history',   'groups:read',
  'im:history',       'im:read',
  'users:read',       'users:read.email',
  'team:read',
].join(',');

// Bot token scopes — the bot user that lives in channels and answers @mentions.
// This is what turns the connection from "read my DMs" into the in-channel bot.
const BOT_SCOPES = [
  'app_mentions:read',           // hear @Nous
  'chat:write',                  // post answers
  'reactions:write',             // the "working…" eyes reaction
  'commands',                    // the /nous slash command
  'channels:read', 'groups:read',// resolve channel name -> account hint
  'users:read',    'users:read.email', // map a Slack user to a Nous contact
].join(',');

// In-memory CSRF state (10-min TTL)
const oauthStates = new Map();
setInterval(() => {
  const cutoff = Date.now() - 600_000;
  for (const [k, v] of oauthStates) if (v.timestamp < cutoff) oauthStates.delete(k);
}, 60_000);

// GET /api/oauth/slack/authorize  — authenticated, returns authUrl
oauthSlackRouter.get('/authorize', verifySupabaseAuth, async (req, res) => {
  // The frontend's generic OAuth path sends workspace_id (snake_case); some
  // older callers use workspaceId (camelCase). Accept either.
  const workspaceId = req.query.workspaceId || req.query.workspace_id;
  const { connectionName } = req.query;
  if (!workspaceId) return res.status(400).json({ error: 'workspace_id_required' });
  if (!process.env.SLACK_CLIENT_ID) return res.status(500).json({ error: 'slack_not_configured' });

  const state = crypto.randomBytes(32).toString('hex');
  oauthStates.set(state, {
    workspaceId,
    connectionName: connectionName || 'Slack',
    userId: req.internalUserId,
    timestamp: Date.now(),
  });

  const url = new URL('https://slack.com/oauth/v2/authorize');
  url.searchParams.set('client_id', process.env.SLACK_CLIENT_ID);
  url.searchParams.set('scope', BOT_SCOPES);        // bot token — the in-channel bot
  url.searchParams.set('user_scope', USER_SCOPES);  // user token — DM ingestion (kept)
  url.searchParams.set('redirect_uri', process.env.SLACK_REDIRECT_URI || `${process.env.API_URL || 'https://api.opennous.cloud'}/api/oauth/slack/callback`);
  url.searchParams.set('state', state);

  return res.json({ authUrl: url.toString() });
});

// GET /api/oauth/slack/callback  — no auth, redirect from Slack
oauthSlackRouter.get('/callback', async (req, res) => {
  const frontendUrl = process.env.APP_URL || 'https://app.opennous.cloud';
  const { code, state, error: oauthError } = req.query;

  if (oauthError) return res.redirect(`${frontendUrl}/oauth-callback.html?oauth_error=${oauthError}`);
  if (!code || !state) return res.redirect(`${frontendUrl}/oauth-callback.html?oauth_error=missing_code_or_state`);

  const stateData = oauthStates.get(state);
  if (!stateData) return res.redirect(`${frontendUrl}/oauth-callback.html?oauth_error=invalid_state`);
  oauthStates.delete(state);

  try {
    const tokenRes = await fetch('https://slack.com/api/oauth.v2.access', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id:     process.env.SLACK_CLIENT_ID,
        client_secret: process.env.SLACK_CLIENT_SECRET,
        code,
        redirect_uri: process.env.SLACK_REDIRECT_URI || `${process.env.API_URL || 'https://api.opennous.cloud'}/api/oauth/slack/callback`,
      }),
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.ok) throw new Error(tokenData.error || 'token_exchange_failed');

    const userToken = tokenData.authed_user?.access_token;
    const botToken  = tokenData.access_token;      // the bot user's token
    const botUserId = tokenData.bot_user_id;
    const slackUserId = tokenData.authed_user?.id;
    const teamId   = tokenData.team?.id;
    const teamName = tokenData.team?.name;
    // The bot token is what makes the in-channel bot work; the user token (DM
    // ingestion) is a bonus. Require the bot token.
    if (!botToken) throw new Error('No bot access token in Slack response');

    // Get the user's email from Slack (user token if we have one, else bot token)
    const userEmail = await (async () => {
      if (!slackUserId) return null;
      try {
        const r = await fetch(`https://slack.com/api/users.info?user=${slackUserId}`, {
          headers: { Authorization: `Bearer ${userToken || botToken}` },
        });
        const info = await r.json();
        return info.user?.profile?.email || null;
      } catch {
        return null;
      }
    })();

    const supabase = getSupabaseClient();
    const { data: provider } = await supabase.from('workflow_providers')
      .select('id').eq('name', 'slack').maybeSingle();
    if (!provider) throw new Error('Slack provider not found in database');

    const credentials = {
      // Bot token — powers the in-channel bot (@mentions, posting, slash command).
      // Stored encrypted; bot_user_id + slack_team_id stay plaintext so the Events
      // endpoint can look this connection up by team_id.
      bot_token:       encrypt(botToken),
      bot_user_id:     botUserId,
      bot_scope:       tokenData.scope || '',
      // User token — DM ingestion (optional; only present if user granted it).
      user_token:      userToken ? encrypt(userToken) : null,
      slack_user_id:   slackUserId,
      slack_team_id:   teamId,
      slack_team_name: teamName,
      user_email:      userEmail,
      scope:           tokenData.authed_user?.scope || '',
    };

    // Upsert — one Slack connection per workspace
    const { data: existing } = await supabase.from('workflow_provider_connections')
      .select('id').eq('workspace_id', stateData.workspaceId).eq('provider_id', provider.id).maybeSingle();

    let connectionId;
    if (existing) {
      await supabase.from('workflow_provider_connections').update({
        encrypted_credentials: credentials,
        name: stateData.connectionName,
        is_verified: true,
        last_test_at: new Date().toISOString(),
      }).eq('id', existing.id);
      connectionId = existing.id;
    } else {
      const { data: created, error: insertErr } = await supabase.from('workflow_provider_connections').insert({
        workspace_id:          stateData.workspaceId,
        provider_id:           provider.id,
        name:                  stateData.connectionName,
        encrypted_credentials: credentials,
        created_by:            stateData.userId,
        is_verified:           true,
        last_test_at:          new Date().toISOString(),
      }).select('id').single();
      if (insertErr) throw insertErr;
      connectionId = created.id;
    }

    console.log('[SLACK_OAUTH] Connected:', userEmail || slackUserId, 'team:', teamName);
    return res.redirect(`${frontendUrl}/oauth-callback.html?oauth_success=true&connection_id=${connectionId}`);
  } catch (err) {
    console.error('[SLACK_OAUTH_CALLBACK_ERROR]', err.message);
    return res.redirect(`${frontendUrl}/oauth-callback.html?oauth_error=callback_failed&error_message=${encodeURIComponent(err.message)}`);
  }
});
