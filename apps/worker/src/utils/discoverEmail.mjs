// Name-based email discovery for contacts that have no email (e.g. created from a
// LinkedIn connection). Searches the workspace's ALREADY-CONNECTED Gmail and IMAP
// mailboxes for messages whose From/To/Cc display name matches the contact's name,
// then extracts that participant's email address. This is identity resolution over
// data the workspace already owns — not external scraping/enrichment.
//
// Precision gate: a candidate is only accepted when the message's display name
// contains BOTH the contact's first and last name. We'd rather find nothing than
// weld a stranger's email onto the record. When several mailbox hits agree, the most
// frequent candidate wins.

import { google } from 'googleapis';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { recordObservation } from '@nous/core';
import { refreshGoogleToken } from './googleOAuth.mjs';
import { decrypt } from './encryption.mjs';

const FREE_OR_NOISE = /^(no-?reply|noreply|notifications?|mailer-daemon|postmaster|bounce)/i;

function makeOAuth2Client() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, process.env.GOOGLE_OAUTH_REDIRECT_URI,
  );
}

// Split a From/To/Cc header into [{ name, email }] pairs.
function parseAddressList(raw) {
  if (!raw) return [];
  return raw.split(',').map(part => {
    const m = part.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
    if (m) return { name: m[1].trim(), email: m[2].trim().toLowerCase() };
    const bare = part.match(/([^\s,<>]+@[^\s,<>]+)/);
    return bare ? { name: '', email: bare[1].trim().toLowerCase() } : null;
  }).filter(Boolean);
}

function bothNamesPresent(displayName, first, last) {
  if (!displayName || !first || !last) return false;
  const d = displayName.toLowerCase();
  return d.includes(first.toLowerCase()) && d.includes(last.toLowerCase());
}

// Tally candidate emails across mailbox hits; return the winner + evidence.
function pickWinner(candidates) {
  if (!candidates.length) return null;
  const counts = new Map();
  for (const c of candidates) counts.set(c.email, (counts.get(c.email) || 0) + 1);
  const [email, hits] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  const evidence = candidates.find(c => c.email === email);
  return { email, hits, evidence };
}

// ── Gmail ───────────────────────────────────────────────────────────────────
async function discoverViaGmail(supabase, workspaceId, first, last) {
  const { data: conn } = await supabase
    .from('workflow_provider_connections')
    .select('id, encrypted_credentials, workflow_providers!inner(name)')
    .eq('workspace_id', workspaceId).eq('is_verified', true)
    .eq('workflow_providers.name', 'gmail_oauth').maybeSingle();
  if (!conn) return [];

  const { credentials, needsUpdate, updatedCredentials } = await refreshGoogleToken(conn.encrypted_credentials);
  if (needsUpdate) await supabase.from('workflow_provider_connections').update({ encrypted_credentials: updatedCredentials }).eq('id', conn.id);
  const ownEmail = (credentials.email || conn.encrypted_credentials.email || '').toLowerCase();

  const auth = makeOAuth2Client();
  auth.setCredentials({ access_token: credentials.access_token });
  const gmail = google.gmail({ version: 'v1', auth });

  const fullName = `${first} ${last}`;
  const q = `from:"${fullName}" OR to:"${fullName}"`;
  const list = await gmail.users.messages.list({ userId: 'me', q, maxResults: 12 });
  const ids = (list.data.messages || []).map(m => m.id);

  const candidates = [];
  for (const id of ids) {
    const msg = await gmail.users.messages.get({
      userId: 'me', id, format: 'metadata', metadataHeaders: ['From', 'To', 'Cc', 'Subject'],
    });
    const headers = msg.data.payload?.headers || [];
    const subject = headers.find(h => h.name === 'Subject')?.value || '(no subject)';
    for (const hname of ['From', 'To', 'Cc']) {
      const raw = headers.find(h => h.name === hname)?.value;
      for (const { name, email } of parseAddressList(raw)) {
        if (!email || email === ownEmail || FREE_OR_NOISE.test(email.split('@')[0])) continue;
        if (bothNamesPresent(name, first, last)) candidates.push({ email, name, source: 'gmail', subject });
      }
    }
  }
  return candidates;
}

// ── IMAP ────────────────────────────────────────────────────────────────────
function safeDecrypt(v) { if (!v) return null; try { return decrypt(v); } catch { return v; } }

async function discoverViaImap(supabase, workspaceId, first, last) {
  const { data: conn } = await supabase
    .from('workflow_provider_connections')
    .select('id, encrypted_credentials, workflow_providers!inner(name)')
    .eq('workspace_id', workspaceId).eq('is_verified', true)
    .eq('workflow_providers.name', 'smtp').maybeSingle();
  if (!conn) return [];

  const raw = conn.encrypted_credentials || {};
  const host = safeDecrypt(raw.host), username = safeDecrypt(raw.username), password = safeDecrypt(raw.password);
  if (!host || !username || !password) return [];
  let imapHost = safeDecrypt(raw.imap_host) || (/office365\.com|smtp-mail\.outlook\.com/i.test(host) ? 'outlook.office365.com' : host.replace(/^smtp\./i, 'imap.'));
  const imapPort = raw.imap_port ? parseInt(safeDecrypt(raw.imap_port) || '993') : 993;
  const ownEmail = username.toLowerCase();

  const client = new ImapFlow({
    host: imapHost, port: imapPort, secure: imapPort === 993,
    auth: { user: username, pass: password }, logger: false,
    connectionTimeout: 15_000, greetingTimeout: 10_000, socketTimeout: 30_000,
  });

  const fullName = `${first} ${last}`;
  const candidates = [];
  try {
    await client.connect();
    const folders = await client.list();
    const inbox = folders.find(f => f.flags?.has('\\Inbox') || f.path === 'INBOX')?.path || 'INBOX';
    const sent  = folders.find(f => f.flags?.has('\\Sent'))?.path || null;
    for (const folder of [inbox, ...(sent ? [sent] : [])]) {
      const lock = await client.getMailboxLock(folder);
      try {
        const uids = (await client.search({ or: [{ from: fullName }, { to: fullName }] }, { uid: true }) || []).slice(-12);
        for (const uid of uids) {
          const { content } = await client.download(String(uid), undefined, { uid: true });
          const chunks = []; for await (const c of content) chunks.push(c);
          const parsed = await simpleParser(Buffer.concat(chunks));
          for (const grp of [parsed.from, parsed.to, parsed.cc]) {
            for (const a of grp?.value || []) {
              const email = (a.address || '').toLowerCase();
              if (!email || email === ownEmail || FREE_OR_NOISE.test(email.split('@')[0])) continue;
              if (bothNamesPresent(a.name, first, last)) candidates.push({ email, name: a.name, source: 'imap', subject: parsed.subject || '(no subject)' });
            }
          }
        }
      } finally { lock.release(); }
    }
  } catch (e) {
    console.warn('[DISCOVER_IMAP] failed (non-fatal):', e.message);
  } finally {
    try { await client.logout(); } catch { /* ignore */ }
  }
  return candidates;
}

// Attach a discovered email: identifier + provenance observation + the visible
// contacts.email column (only when still empty). Returns true if written.
async function attachEmail(supabase, workspaceId, contact, email, source, evidence) {
  if (contact.email) return false;
  const clean = email.toLowerCase().trim();
  await supabase.from('entity_identifiers')
    .upsert({ workspace_id: workspaceId, entity_id: contact.id, kind: 'email', value: clean },
      { onConflict: 'workspace_id,kind,value', ignoreDuplicates: true }).then(null, () => {});
  await recordObservation(supabase, {
    workspaceId, entityId: contact.id, kind: 'state', property: 'email',
    value: clean, source, method: 'extraction',
    externalId: `discover_${source}_${clean}`,
    raw: { matched_name: evidence?.name || null, subject: evidence?.subject || null },
  }).catch(() => {});
  await supabase.from('contacts').update({ email: clean }).eq('id', contact.id);
  return true;
}

// Main entry: try Gmail then IMAP; attach the winner. Returns a result for logging.
export async function discoverEmailForContact(supabase, workspaceId, contact) {
  const first = contact.first_name, last = contact.last_name;
  if (contact.email || !first || !last) return { found: false, reason: contact.email ? 'already_has_email' : 'no_name' };

  let candidates = [];
  try { candidates = candidates.concat(await discoverViaGmail(supabase, workspaceId, first, last)); }
  catch (e) { console.warn('[DISCOVER_GMAIL] failed (non-fatal):', e.message); }
  try { candidates = candidates.concat(await discoverViaImap(supabase, workspaceId, first, last)); }
  catch (e) { console.warn('[DISCOVER_IMAP] failed (non-fatal):', e.message); }

  const winner = pickWinner(candidates);
  if (!winner) return { found: false, reason: 'no_match', scanned: candidates.length };

  const wrote = await attachEmail(supabase, workspaceId, contact, winner.email, winner.evidence.source, winner.evidence);
  return { found: true, email: winner.email, source: winner.evidence.source, hits: winner.hits, wrote, evidence: winner.evidence };
}
