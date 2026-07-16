// Slack DM poller — fetches direct messages from the last 2 hours across all connected workspaces.
// Uses a user token (xoxp-) stored by the Slack OAuth flow.
// Dedup is handled by externalId (slack_msg_CHANNEL_TS).

import { getSupabaseClient } from '@nous/core';
import { logActivity } from '../utils/activity.mjs';
import { decrypt } from '../utils/encryption.mjs';

const LOOKBACK_MS = 2 * 60 * 60 * 1000; // 2 hours

async function getSlackConnections(supabase) {
  const { data: provider } = await supabase.from('workflow_providers')
    .select('id').eq('name', 'slack').maybeSingle();
  if (!provider) return [];

  const { data: conns } = await supabase.from('workflow_provider_connections')
    .select('id, workspace_id, encrypted_credentials')
    .eq('provider_id', provider.id).eq('is_verified', true);
  return conns || [];
}

function slackGet(path, token) {
  return fetch(`https://slack.com/api/${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  }).then(r => r.json());
}

async function pollWorkspace(supabase, conn) {
  const creds = conn.encrypted_credentials || {};
  const userToken = decrypt(creds.user_token);
  if (!userToken) {
    console.warn(`[SLACK_POLL] workspace=${conn.workspace_id}: no user_token — skipping`);
    return 0;
  }

  const workspaceId = conn.workspace_id;
  const oldest = ((Date.now() - LOOKBACK_MS) / 1000).toFixed(0);

  // List all DM conversations
  const convRes = await slackGet(`conversations.list?types=im&limit=200&exclude_archived=true`, userToken);
  if (!convRes.ok) {
    console.warn(`[SLACK_POLL] workspace=${workspaceId}: conversations.list error: ${convRes.error}`);
    return 0;
  }

  const dms = (convRes.channels || []).filter(c => !c.is_user_deleted);
  if (!dms.length) return 0;

  // Batch-fetch all unique user IDs to get their emails
  const userIds = [...new Set(dms.map(c => c.user).filter(Boolean))];
  const emailByUserId = new Map();
  for (const uid of userIds) {
    const info = await slackGet(`users.info?user=${uid}`, userToken);
    if (info.ok && info.user?.profile?.email) {
      emailByUserId.set(uid, info.user.profile.email.toLowerCase());
    }
  }

  // Match emails to contacts
  const emails = [...emailByUserId.values()];
  if (!emails.length) return 0;

  const { data: contacts } = await supabase.from('contacts').select('id, email, company_id')
    .eq('workspace_id', workspaceId).in('email', emails);
  const contactByEmail = new Map((contacts || []).map(c => [c.email.toLowerCase(), c]));

  let logged = 0;
  for (const dm of dms) {
    const email = emailByUserId.get(dm.user);
    if (!email) continue;
    const contact = contactByEmail.get(email);
    if (!contact) continue;

    // Get message history for this DM
    const histRes = await slackGet(
      `conversations.history?channel=${dm.id}&oldest=${oldest}&limit=50`,
      userToken,
    );
    if (!histRes.ok) continue;

    for (const msg of (histRes.messages || [])) {
      if (msg.subtype || !msg.text || msg.text.trim().length < 3) continue;
      const ts = msg.ts; // Slack timestamp is the unique message ID
      const occurredAt = new Date(parseFloat(ts) * 1000).toISOString();

      const result = await logActivity(supabase, {
        workspaceId,
        contactId:  contact.id,
        companyId:  contact.company_id || null,
        type:       'slack_dm',
        source:     'slack',
        externalId: `slack_msg_${dm.id}_${ts}`,
        occurredAt,
        description: msg.text.slice(0, 500),
        summary:    msg.text.slice(0, 500),
        rawData:    { channel_id: dm.id, ts, user: msg.user },
      });
      if (result) logged++;
    }
  }

  if (logged) console.log(`[SLACK_POLL] workspace=${workspaceId}: ${logged} DMs logged`);

  // Surface in the Live Op Log only when something was logged — that row is
  // also the billing record (billable_ops = DMs logged).
  if (logged > 0) {
    try {
      await supabase.from('workspace_system_log').insert({
        workspace_id: workspaceId,
        source:       'slack',
        event_type:   'scan_complete',
        summary:      `Slack scan: ${logged} DM${logged === 1 ? '' : 's'} logged`,
        metadata:     { logged },
        billable_ops: logged,
        occurred_at:  new Date().toISOString(),
      });
    } catch (e) {
      console.warn('[SLACK_POLL] system_log insert failed:', e.message);
    }
  }

  return logged;
}

export async function pollAllSlackWorkspaces() {
  const supabase = getSupabaseClient();
  const connections = await getSlackConnections(supabase);
  if (!connections.length) return 0;

  console.log(`[SLACK_POLL] Starting — ${connections.length} workspace(s)`);
  let total = 0;
  for (const conn of connections) {
    try { total += await pollWorkspace(supabase, conn); }
    catch (e) { console.error(`[SLACK_POLL] workspace=${conn.workspace_id}:`, e.message); }
  }
  console.log(`[SLACK_POLL] Done — ${total} total activities logged`);
  return total;
}
