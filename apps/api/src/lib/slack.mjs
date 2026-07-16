// Slack bot helpers — the plumbing behind the Events endpoint and the /nous
// slash command (see routes/slackEvents.mjs).
//
// Multi-tenant by design: Slack sends every event to ONE URL and identifies the
// workspace only by the team_id in the payload. So the first thing every inbound
// event does is findWorkspaceByTeam() — team_id -> our workspace + that team's
// bot token — and everything after is scoped to that workspace.
//
// The bot's answer runs the same Sonnet agent as the in-app Threads surface
// (runPlaygroundTurn), so it gates on the SAME feature: inAppAgent (Custom plan).

import crypto from 'crypto';
import { getSupabaseClient } from '@nous/core';
import { decrypt } from '../utils/crypto.mjs';
import { getPlanFromSubscription, hasFeature, isSelfHosted } from './plans.mjs';

const SLACK_API = 'https://slack.com/api';

// ── Signature verification ────────────────────────────────────────────────────
// Slack signs the RAW request body: v0=HMAC_SHA256(signing_secret, `v0:${ts}:${body}`).
// The route must hand us the raw Buffer (mounted before express.json) or this fails.
export function verifySlackSignature({ signingSecret, rawBody, timestamp, signature }) {
  if (!signingSecret || !rawBody || !timestamp || !signature) return false;
  // Reject anything older than 5 minutes — replay protection.
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
  const base = `v0:${timestamp}:${rawBody.toString('utf8')}`;
  const expected = `v0=${crypto.createHmac('sha256', signingSecret).update(base).digest('hex')}`;
  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

// ── Tenant resolution ─────────────────────────────────────────────────────────
// team_id (from the Slack payload) -> our workspace + decrypted bot token.
// The Slack connection lives in workflow_provider_connections; team_id is stored
// in plaintext inside encrypted_credentials (only the tokens are encrypted), so we
// can filter on it directly.
export async function findWorkspaceByTeam(supabase, teamId) {
  if (!teamId) return null;
  const { data: provider } = await supabase
    .from('workflow_providers')
    .select('id')
    .eq('name', 'slack')
    .maybeSingle();
  if (!provider) return null;

  const { data: conn } = await supabase
    .from('workflow_provider_connections')
    .select('id, workspace_id, encrypted_credentials')
    .eq('provider_id', provider.id)
    .eq('encrypted_credentials->>slack_team_id', teamId)
    .maybeSingle();
  if (!conn) return null;

  const creds = conn.encrypted_credentials || {};
  const botToken = creds.bot_token ? decrypt(creds.bot_token) : null;
  return {
    connectionId: conn.id,
    workspaceId: conn.workspace_id,
    botToken,
    botUserId: creds.bot_user_id || null,
  };
}

// The bot's answer is the Sonnet agent surface, so it gates like the in-app agent.
// Returns { allowed, plan }. Cloud-only feature, so self-host is NOT allowed here
// (mirrors requireFeature's CLOUD_ONLY handling for inAppAgent).
export async function checkAgentAccess(supabase, workspaceId) {
  if (isSelfHosted()) return { allowed: false, plan: { id: 'self_hosted', name: 'Self-hosted' } };
  const { data: ws } = await supabase
    .from('workspaces')
    .select('team_id')
    .eq('id', workspaceId)
    .maybeSingle();
  if (!ws) return { allowed: false, plan: null };
  const { data: subscription } = await supabase
    .from('subscriptions')
    .select('*')
    .eq('team_id', ws.team_id)
    .maybeSingle();
  const plan = getPlanFromSubscription(subscription);
  return { allowed: hasFeature(plan.id, 'inAppAgent'), plan };
}

// ── Slack Web API calls (per-workspace bot token) ─────────────────────────────
async function slackPost(botToken, method, body) {
  const res = await fetch(`${SLACK_API}/${method}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${botToken}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify(body),
  });
  return res.json();
}

export function postMessage(botToken, { channel, thread_ts, text }) {
  return slackPost(botToken, 'chat.postMessage', { channel, thread_ts, text, unfurl_links: false });
}

export async function addReaction(botToken, { channel, timestamp, name }) {
  try {
    await slackPost(botToken, 'reactions.add', { channel, timestamp, name });
  } catch {
    /* best-effort */
  }
}

export async function getChannelName(botToken, channelId) {
  try {
    const res = await fetch(`${SLACK_API}/conversations.info?channel=${channelId}`, {
      headers: { Authorization: `Bearer ${botToken}` },
    });
    const data = await res.json();
    return data.channel?.name || null;
  } catch {
    return null;
  }
}

// Slack user -> our internal user (users.id) via their Slack email. Used to
// attribute the turn to the right person; null when we can't match (the agent
// still answers, just unattributed).
export async function resolveAsker(supabase, botToken, slackUserId) {
  try {
    const res = await fetch(`${SLACK_API}/users.info?user=${slackUserId}`, {
      headers: { Authorization: `Bearer ${botToken}` },
    });
    const data = await res.json();
    const email = data.user?.profile?.email || null;
    if (!email) return { internalUserId: null, email: null };
    const { data: user } = await supabase
      .from('users')
      .select('id')
      .eq('email', email)
      .maybeSingle();
    return { internalUserId: user?.id ?? null, email };
  } catch {
    return { internalUserId: null, email: null };
  }
}

// Channel -> bound account entity id (if the team ran `/nous link`). Null when
// unmapped — the agent then infers the account from the channel name + question.
export async function resolveChannelAccount(supabase, workspaceId, channelId) {
  const { data } = await supabase
    .from('slack_channel_map')
    .select('account_entity_id')
    .eq('workspace_id', workspaceId)
    .eq('slack_channel_id', channelId)
    .maybeSingle();
  return data?.account_entity_id ?? null;
}

// ── Markdown -> Slack mrkdwn ──────────────────────────────────────────────────
// The agent writes GitHub-flavoured markdown (for the web UI). Slack uses its own
// dialect: *bold* not **bold**, _italic_ not *italic*, no ATX headings, and links
// are <url|label>. A light transform keeps answers readable in a channel.
export function toSlackMrkdwn(md) {
  if (!md) return '';
  let t = md;
  // [label](url) -> <url|label>
  t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<$2|$1>');
  // **bold** -> *bold*  (before single-asterisk handling)
  t = t.replace(/\*\*([^*]+)\*\*/g, '§B§$1§B§');
  // markdown *italic* / _italic_ -> Slack _italic_
  t = t.replace(/(?<!\w)\*([^*\n]+)\*(?!\w)/g, '_$1_');
  t = t.replace(/§B§/g, '*');
  // ### Heading -> *Heading*
  t = t.replace(/^#{1,6}\s+(.+)$/gm, '*$1*');
  // - bullet -> • bullet
  t = t.replace(/^\s*[-*]\s+/gm, '• ');
  return t.trim();
}

export { getSupabaseClient };
