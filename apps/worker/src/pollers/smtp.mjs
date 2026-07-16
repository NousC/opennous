// SMTP/IMAP poller — reads INBOX + Sent via IMAP every 15 minutes.
// Logs email_sent / email_received activities on matching contacts.
// Dedup via externalId (imap_<messageId>_<date>).
// Never creates new contacts — update-only, same as Gmail.

import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { getSupabaseClient } from '@nous/core';
import { logActivity } from '../utils/activity.mjs';
import { decrypt } from '../utils/encryption.mjs';

const LOOKBACK_DAYS = 30; // initial window; subsequent syncs use last_imap_sync_date
const MAX_BODY_BYTES = 1_000_000;
function capBody(str) {
  if (!str) return null;
  return Buffer.byteLength(str, 'utf8') <= MAX_BODY_BYTES ? str : str.slice(0, MAX_BODY_BYTES);
}

// Auto-reply detection (avoids logging OOO / vacation responders)
const AUTO_REPLY_SUBJECTS = /^(auto:|automatic reply|out of office|away|vacation)/i;
function isAutoReply(headers, subject) {
  if (AUTO_REPLY_SUBJECTS.test(subject || '')) return true;
  if ((headers['auto-submitted'] || '').toLowerCase() !== 'no') return !!headers['auto-submitted'];
  return false;
}

async function getSmtpConnections(supabase) {
  const { data: conns } = await supabase
    .from('workflow_provider_connections')
    .select('id, workspace_id, encrypted_credentials, workflow_providers!inner(name)')
    .eq('is_verified', true)
    .eq('workflow_providers.name', 'smtp');
  return conns || [];
}

function safeDecrypt(val) {
  if (!val) return null;
  try { return decrypt(val); } catch { return val; }
}

async function pollWorkspace(supabase, conn) {
  const raw = conn.encrypted_credentials || {};

  const host     = safeDecrypt(raw.host);
  const username = safeDecrypt(raw.username);
  const password = safeDecrypt(raw.password);

  if (!host || !username || !password) {
    console.warn('[SMTP_POLL] Missing credentials for conn', conn.id);
    return 0;
  }

  // Derive IMAP host from SMTP host if not explicit
  let imapHost = safeDecrypt(raw.imap_host) || null;
  let imapPort = raw.imap_port ? parseInt(safeDecrypt(raw.imap_port) || '993') : 993;

  if (!imapHost) {
    if (/office365\.com|smtp-mail\.outlook\.com/i.test(host)) {
      imapHost = 'outlook.office365.com';
    } else {
      imapHost = host.replace(/^smtp\./i, 'imap.');
    }
  }

  const lastSync = raw.last_imap_sync_date
    ? new Date(raw.last_imap_sync_date)
    : new Date(Date.now() - LOOKBACK_DAYS * 86_400_000);

  const client = new ImapFlow({
    host: imapHost,
    port: imapPort,
    secure: imapPort === 993,
    auth: { user: username, pass: password },
    logger: false,
    // Hard timeouts so a slow/unreachable IMAP server can't hang the poller forever
    connectionTimeout: 15_000,
    greetingTimeout: 10_000,
    socketTimeout: 30_000,
  });

  await client.connect();
  console.log(`[SMTP_POLL] workspace=${conn.workspace_id} connected to ${imapHost}:${imapPort}`);

  // Load workspace contacts for matching
  const { data: contacts } = await supabase
    .from('contacts')
    .select('id, email, company_id')
    .eq('workspace_id', conn.workspace_id)
    .not('email', 'is', null);

  const contactByEmail = {};
  for (const c of contacts || []) {
    if (c.email) contactByEmail[c.email.toLowerCase()] = c;
  }

  const connectedEmail = username.toLowerCase();
  let processed = 0;

  // Auto-detect INBOX and Sent folders
  const allFolders = await client.list();
  const inboxPath = allFolders.find(f => f.flags?.has('\\Inbox') || f.path === 'INBOX')?.path || 'INBOX';
  const sentPath  = allFolders.find(f => f.flags?.has('\\Sent'))?.path || null;
  const foldersToScan = [inboxPath, ...(sentPath ? [sentPath] : [])];

  const processFolder = async (folderPath) => {
    const lock = await client.getMailboxLock(folderPath);
    try {
      const uids = await client.search({ since: lastSync }, { uid: true });

      for (const uid of uids) {
        try {
          const { content } = await client.download(String(uid), undefined, { uid: true });
          const chunks = [];
          for await (const chunk of content) chunks.push(chunk);
          const parsed = await simpleParser(Buffer.concat(chunks));

          const fromEmail = (parsed.from?.value?.[0]?.address || '').toLowerCase();
          const toEmails  = (parsed.to?.value  || []).map(a => (a.address || '').toLowerCase());
          const ccEmails  = (parsed.cc?.value  || []).map(a => (a.address || '').toLowerCase());
          const subject   = parsed.subject || '(no subject)';
          const occurredAt = parsed.date?.toISOString() ?? new Date().toISOString();
          const messageId  = parsed.messageId || `uid_${uid}_${folderPath}`;

          const hdrs = {
            'auto-submitted': parsed.headers?.get('auto-submitted') || '',
          };
          if (isAutoReply(hdrs, subject)) continue;

          const isOutbound = fromEmail === connectedEmail;
          let contact = null;

          if (isOutbound) {
            for (const email of [...toEmails, ...ccEmails]) {
              if (contactByEmail[email]) { contact = contactByEmail[email]; break; }
            }
          } else {
            contact = contactByEmail[fromEmail] || null;
          }

          if (!contact) continue;

          const externalId = `imap_${messageId.replace(/[<>\s]/g, '')}_${occurredAt.slice(0, 10)}`;
          const snippet = (parsed.text || '').slice(0, 300) || null;

          await logActivity(supabase, {
            workspaceId: conn.workspace_id,
            contactId:   contact.id,
            companyId:   contact.company_id || null,
            type:        isOutbound ? 'email_sent' : 'email_received',
            source:      'smtp',
            externalId,
            occurredAt,
            description: isOutbound ? `Email sent: ${subject}` : `Email received: ${subject}`,
            summary:     snippet,
            rawData: {
              subject,
              from:      parsed.from?.text,
              to:        toEmails.join(', '),
              cc:        ccEmails.join(', ') || null,
              direction: isOutbound ? 'outbound' : 'inbound',
              body_text: capBody(parsed.text),
              body_html: capBody(parsed.html),
            },
          });

          processed++;
        } catch (msgErr) {
          console.warn('[SMTP_POLL] Message error uid', uid, 'in', folderPath, msgErr.message);
        }
      }
    } finally {
      lock.release();
    }
  };

  try {
    for (const folder of foldersToScan) {
      await processFolder(folder).catch(e =>
        console.warn('[SMTP_POLL] folder', folder, e.message)
      );
    }

    // Persist last sync timestamp
    await supabase.from('workflow_provider_connections')
      .update({ encrypted_credentials: { ...raw, last_imap_sync_date: new Date().toISOString() } })
      .eq('id', conn.id);
  } finally {
    // Always close the connection — even on partial failure — to avoid socket leaks
    try { await client.logout(); } catch { /* already disconnected */ }
  }

  // Always log per-workspace summary, even when processed=0 (so we can confirm pollers are reaching IMAP)
  console.log(`[SMTP_POLL] workspace=${conn.workspace_id} imap=${imapHost}:${imapPort} processed=${processed}`);

  // Only surface scans that actually logged something — empty scans are noise
  // in the user-facing Live Op Log (the console.log above keeps the full audit trail).
  if (processed > 0) {
    try {
      await supabase.from('workspace_system_log').insert({
        workspace_id: conn.workspace_id,
        source:       'smtp',
        event_type:   'scan_complete',
        summary:      `SMTP scan: ${processed} email${processed === 1 ? '' : 's'} logged`,
        metadata:     { processed, imap_host: imapHost, imap_port: imapPort },
        billable_ops: processed,
        occurred_at:  new Date().toISOString(),
      });
    } catch (e) {
      console.warn('[SMTP_POLL] system_log insert failed:', e.message);
    }
  }

  return processed;
}

const WORKSPACE_POLL_TIMEOUT_MS = 60_000;

export async function pollAllSmtpWorkspaces() {
  const supabase = getSupabaseClient();
  const connections = await getSmtpConnections(supabase);
  if (!connections.length) return 0;

  console.log(`[SMTP_POLL] Starting — ${connections.length} workspace(s)`);
  let total = 0;
  for (const conn of connections) {
    try {
      // Hard cap per workspace — if a connection wedges past 60s we abort and move on
      total += await Promise.race([
        pollWorkspace(supabase, conn),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error(`workspace poll exceeded ${WORKSPACE_POLL_TIMEOUT_MS / 1000}s`)),
            WORKSPACE_POLL_TIMEOUT_MS,
          ),
        ),
      ]);
    } catch (e) {
      console.error(`[SMTP_POLL] workspace=${conn.workspace_id}:`, e.message);
    }
  }
  console.log(`[SMTP_POLL] Done — ${total} activities logged across ${connections.length} workspace(s)`);
  return total;
}
