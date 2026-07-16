// Gmail poller — syncs sent and received emails for all connected workspaces.
// Runs every 30 minutes. Resolves external participants to existing contacts only
// (createIfMissing: false — Gmail never bootstraps new contacts).
// Dedup via externalId (gmail_MSGID).

import { google } from 'googleapis';
import { getSupabaseClient, connectedAccountOwnerByEmail, attributeRelationship, getInternalEntityIds } from '@nous/core';
import { logActivity } from '../utils/activity.mjs';
import { refreshGoogleToken } from '../utils/googleOAuth.mjs';
import { isTokenRevoked, markGoogleConnectionRevoked } from '../utils/connectionHealth.mjs';

const LOOKBACK_MS = 65 * 60 * 1000; // 65 min (slightly past hourly cron to avoid gaps; dedup via externalId)

async function getGmailConnections(supabase) {
  const { data: conns } = await supabase
    .from('workflow_provider_connections')
    .select('id, workspace_id, encrypted_credentials, workflow_providers!inner(name)')
    .eq('is_verified', true)
    .eq('workflow_providers.name', 'gmail_oauth');
  return (conns || []).filter(c =>
    (c.encrypted_credentials?.scope || '').includes('gmail')
  );
}

function makeOAuth2Client() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_OAUTH_REDIRECT_URI,
  );
}

function extractHeader(headers, name) {
  return headers?.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || null;
}

function parseAddresses(raw) {
  if (!raw) return [];
  return raw.split(',').map(part => {
    const m = part.match(/<([^>]+)>/) || part.match(/([^\s,]+@[^\s,]+)/);
    return m ? m[1].toLowerCase().trim() : null;
  }).filter(Boolean);
}

export const MAX_BODY_BYTES = 1_000_000;
export function capBody(str) {
  if (!str) return null;
  return Buffer.byteLength(str, 'utf8') <= MAX_BODY_BYTES ? str : str.slice(0, MAX_BODY_BYTES);
}

// Walks the Gmail MIME tree and pulls plaintext + HTML bodies (base64url-decoded).
export function extractBody(payload) {
  let text = null, html = null;
  const walk = (part) => {
    if (!part) return;
    if (part.body?.data) {
      try {
        const decoded = Buffer.from(part.body.data, 'base64url').toString('utf8');
        if (part.mimeType === 'text/plain' && !text) text = decoded;
        else if (part.mimeType === 'text/html' && !html) html = decoded;
      } catch { /* skip malformed part */ }
    }
    if (Array.isArray(part.parts)) for (const sub of part.parts) walk(sub);
  };
  walk(payload);
  return { text: capBody(text), html: capBody(html) };
}

async function pollWorkspace(supabase, conn) {
  const { credentials, needsUpdate, updatedCredentials } =
    await refreshGoogleToken(conn.encrypted_credentials);

  if (needsUpdate) {
    await supabase.from('workflow_provider_connections')
      .update({ encrypted_credentials: updatedCredentials }).eq('id', conn.id);
  }

  const auth = makeOAuth2Client();
  auth.setCredentials({ access_token: credentials.access_token });
  const gmail = google.gmail({ version: 'v1', auth });

  const ownerEmail = credentials.email?.toLowerCase();
  const afterEpoch = Math.floor((Date.now() - LOOKBACK_MS) / 1000);

  // Fetch recent sent + received messages
  const listRes = await gmail.users.messages.list({
    userId: 'me',
    q: `after:${afterEpoch}`,
    maxResults: 100,
  });

  const messages = listRes.data.messages || [];
  const fetched = messages.length;
  let logged = 0;

  if (fetched > 0) {
    const msgDetails = [];
    for (const { id } of messages) {
      try {
        const { data: msg } = await gmail.users.messages.get({
          userId: 'me', id, format: 'full',
        });
        msgDetails.push(msg);
      } catch { /* skip inaccessible messages */ }
    }

    // Collect unique external emails
    const externalEmails = new Set();
    for (const msg of msgDetails) {
      const headers = msg.payload?.headers || [];
      const from = parseAddresses(extractHeader(headers, 'From'));
      const to   = parseAddresses(extractHeader(headers, 'To'));
      const cc   = parseAddresses(extractHeader(headers, 'Cc'));
      for (const email of [...from, ...to, ...cc]) {
        if (email && email !== ownerEmail) externalEmails.add(email);
      }
    }

    if (externalEmails.size > 0) {
      // Match existing contacts only
      const { data: contacts } = await supabase.from('contacts').select('id, email, company_id')
        .eq('workspace_id', conn.workspace_id).in('email', [...externalEmails]);
      const contactByEmail = new Map((contacts || []).map(c => [c.email.toLowerCase(), c]));

      if (contactByEmail.size > 0) {
        // Whose mailbox is this, and which contacts are teammates — so each email
        // attributes the relationship to the right rep, and we never attribute an
        // internal-to-internal thread.
        const ownerUserId = await connectedAccountOwnerByEmail(supabase, conn.workspace_id, ownerEmail);
        const internalIds = await getInternalEntityIds(supabase, conn.workspace_id);

        for (const msg of msgDetails) {
          const headers  = msg.payload?.headers || [];
          const fromAddr = parseAddresses(extractHeader(headers, 'From'))[0] || null;
          const toAddrs  = parseAddresses(extractHeader(headers, 'To'));
          const subject  = extractHeader(headers, 'Subject') || '(no subject)';
          const dateStr  = extractHeader(headers, 'Date');
          const occurredAt = dateStr ? new Date(dateStr).toISOString() : new Date().toISOString();
          const snippet  = msg.snippet?.slice(0, 300) || null;

          const isOutbound = fromAddr === ownerEmail;
          const counterparts = isOutbound ? toAddrs : [fromAddr].filter(Boolean);
          const { text: bodyText, html: bodyHtml } = extractBody(msg.payload);

          for (const email of counterparts) {
            const contact = contactByEmail.get(email);
            if (!contact) continue;

            const result = await logActivity(supabase, {
              workspaceId: conn.workspace_id,
              contactId:   contact.id,
              companyId:   contact.company_id || null,
              type:        isOutbound ? 'email_sent' : 'email_received',
              source:      'gmail',
              externalId:  `gmail_${msg.id}_${contact.id}`,
              occurredAt,
              description: snippet || (isOutbound ? `Email sent: ${subject}` : `Email received: ${subject}`),
              summary:     snippet,
              // This raw email belongs to the rep whose mailbox it came through —
              // scopes its body to that rep + admins (PRIVACY_MODEL.md).
              ownerUserId,
              rawData:     {
                message_id: msg.id,
                subject,
                from: fromAddr,
                to: toAddrs,
                body_text: bodyText,
                body_html: bodyHtml,
              },
            });
            if (result) logged++;

            // Attribute the relationship to the rep whose mailbox this is — unless
            // the counterpart is itself a teammate (internal-to-internal email).
            if (ownerUserId && !internalIds.has(contact.id)) {
              try {
                await attributeRelationship(supabase, conn.workspace_id, contact.id, ownerUserId, { at: occurredAt });
              } catch (e) { console.warn('[gmail] attribute failed', e.message); }
            }
          }
        }
      }
    }
  }

  // Always log + emit Live Op event, even when fetched=0 or no matching contacts.
  // Earlier the function returned early in those cases and produced no visible signal at all.
  console.log(`[GMAIL_POLL] workspace=${conn.workspace_id}: ${logged} emails logged (${fetched} fetched)`);

  // Only surface scans that actually logged something — empty scans are noise
  // in the user-facing Live Op Log (the console.log above keeps the full audit trail).
  // billable_ops = items logged: this row IS the billing record (cloud).
  if (logged > 0) {
    try {
      await supabase.from('workspace_system_log').insert({
        workspace_id: conn.workspace_id,
        source:       'gmail',
        event_type:   'scan_complete',
        summary:      `Gmail scan: ${logged} email${logged === 1 ? '' : 's'} logged (${fetched} fetched)`,
        metadata:     { fetched, logged, lookback_ms: LOOKBACK_MS },
        billable_ops: logged,
        occurred_at:  new Date().toISOString(),
      });
    } catch (e) {
      console.warn('[GMAIL_POLL] system_log insert failed:', e.message);
    }
  }

  return logged;
}

export async function pollAllGmailWorkspaces() {
  const supabase = getSupabaseClient();
  const connections = await getGmailConnections(supabase);
  if (!connections.length) return 0;

  console.log(`[GMAIL_POLL] Starting — ${connections.length} workspace(s)`);
  let total = 0;
  for (const conn of connections) {
    try { total += await pollWorkspace(supabase, conn); }
    catch (e) {
      if (isTokenRevoked(e)) await markGoogleConnectionRevoked(supabase, conn, 'gmail');
      console.error(`[GMAIL_POLL] workspace=${conn.workspace_id}:`, e.message);
    }
  }
  console.log(`[GMAIL_POLL] Done — ${total} total activities logged`);
  return total;
}
