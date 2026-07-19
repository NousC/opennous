// Retroactive contact history enricher. Runs in the WORKER (drained from the
// contact_enrichment_jobs queue), NOT the API request path — a 50-account import
// hitting 5 integrations is minutes of I/O that must not sit on the API event loop.
//
// Scale strategy: fetch each provider ONCE and map locally, never once-per-contact.
// Gmail, IMAP and Fireflies are bulk (one sweep, mapped by participant). Calendly,
// Cal.com and Fathom are already one call per contact (their APIs only take a single
// email), so they run in bounded per-provider lanes. LinkedIn/Unipile is the
// irreducible per-contact tail and gets the smallest lane + backoff.

import { google } from 'googleapis';
import { decrypt } from '../utils/encryption.mjs';
import { refreshGoogleToken } from '../utils/googleOAuth.mjs';
import { logActivity as coreLogActivity } from '@nous/core';

// ── Unipile helpers ───────────────────────────────────────────────────────────

const UNIPILE_BASE = () => {
  const dsn = process.env.UNIPILE_DSN;
  if (!dsn) throw new Error('UNIPILE_DSN not configured');
  return `https://${dsn}/api/v1`;
};

const unipileHeaders = () => ({
  'X-API-KEY': process.env.UNIPILE_API_KEY || '',
  'Content-Type': 'application/json',
  accept: 'application/json',
});

function normaliseLinkedInUrl(raw) {
  if (!raw) return null;
  try {
    const u = new URL(raw.startsWith('http') ? raw : `https://${raw}`);
    const m = u.pathname.match(/\/in\/([^/]+)/);
    if (!m) return null;
    return `https://www.linkedin.com/in/${m[1].toLowerCase()}`;
  } catch { return null; }
}

async function unipilePages(url, accountId) {
  const items = [];
  let cursor = null;
  do {
    const u = new URL(url);
    u.searchParams.set('account_id', accountId);
    u.searchParams.set('limit', '100');
    if (cursor) u.searchParams.set('cursor', cursor);
    const res = await fetchRetry(u.toString(), { headers: unipileHeaders() });
    if (!res.ok) break;
    const body = await res.json();
    if (Array.isArray(body.items)) items.push(...body.items);
    cursor = body.cursor || null;
  } while (cursor);
  return items;
}

// ── Progress store ────────────────────────────────────────────────────────────
// In-memory job state for real-time progress polling (auto-cleaned after 10 min)

export const enrichmentJobs = new Map();

// ── logActivity — dedup by external_id ───────────────────────────────────────

// No pre-check SELECT. coreLogActivity already dedups on the (workspace, source,
// external_id) unique index and returns null on the 23505 — the old
// hasActivityWithExternalId pre-check was a wasted round-trip on every single
// activity (thousands, on a big import). skipStageAdvance defers per-activity
// pipeline staging to the hourly stageDerivation worker, so a bulk insert doesn't
// fire a stage read+write per row. Spreads all params so rawData (e.g. LinkedIn
// is_outbound) is no longer silently dropped.
async function logActivity(supabase, params) {
  const result = await coreLogActivity(supabase, { ...params, skipStageAdvance: true });
  return result != null;
}

// ── Concurrency + parsing helpers ─────────────────────────────────────────────

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

// Run `fn` over `items` with at most `limit` in flight. Errors on one item are
// swallowed so a single bad contact/thread never sinks the whole backfill.
async function pool(items, limit, fn) {
  const queue = items.map((item, i) => [item, i]);
  const runners = Array.from({ length: Math.max(1, Math.min(limit, queue.length)) }, async () => {
    for (;;) {
      const next = queue.shift();
      if (!next) return;
      try { await fn(next[0], next[1]); } catch (e) { console.error('[ENRICH_POOL]', e?.message || e); }
    }
  });
  await Promise.all(runners);
}

const EMAIL_RE = /[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}/gi;
function extractEmails(headerValue) {
  return (String(headerValue || '').match(EMAIL_RE) || []).map(e => e.toLowerCase());
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// fetch with exponential backoff on 429 / 5xx. The rate-limited providers (Unipile
// above all) 429 the moment concurrency climbs; the per-provider lanes keep that rare,
// and this absorbs the ones that slip through instead of dropping the data.
async function fetchRetry(url, opts = {}, { tries = 4, baseMs = 500 } = {}) {
  let last;
  for (let attempt = 0; attempt < tries; attempt++) {
    try {
      const res = await fetch(url, opts);
      if (res.status !== 429 && res.status < 500) return res;
      last = res;
    } catch (e) { last = e; }
    if (attempt < tries - 1) await sleep(baseMs * 2 ** attempt);
  }
  if (last instanceof Response) return last;
  throw last instanceof Error ? last : new Error('fetch failed');
}

// ── Gmail (bulk) ──────────────────────────────────────────────────────────────
//
// One pass for the WHOLE batch, not a mailbox scan per contact. We already know
// every contact's email, so we ask Gmail for the threads involving ANY of them
// (OR-batched into chunks to stay under the query-length limit), fetch each unique
// thread ONCE (metadata only, in parallel), then map its participants back to
// whichever contacts we hold. At 100 contacts that's a few dozen API calls instead
// of hundreds of sequential per-contact scans — and shared threads are fetched once,
// not once per participant. Returns Map<contactId, activitiesLogged>.

const GMAIL_EMAIL_CHUNK = 20;          // emails OR'd into a single search query
const GMAIL_THREAD_CONCURRENCY = 12;   // parallel thread fetches
const GMAIL_MAX_MSGS_PER_CHUNK = 3000; // pagination safety cap per chunk

async function scanGmailBulk(supabase, workspaceId, contacts, gmailConn) {
  const withEmail = contacts.filter(c => c.email);
  const counts = new Map(withEmail.map(c => [c.id, 0]));
  if (!withEmail.length) return counts;

  try {
    const { credentials, needsUpdate, updatedCredentials } =
      await refreshGoogleToken(gmailConn.encrypted_credentials);
    if (needsUpdate) {
      await supabase.from('workflow_provider_connections')
        .update({ encrypted_credentials: updatedCredentials }).eq('id', gmailConn.id);
    }

    const oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, process.env.GOOGLE_OAUTH_REDIRECT_URI,
    );
    oauth2Client.setCredentials({ access_token: credentials.access_token });
    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

    // email → contact (first wins on the rare shared address).
    const emailToContact = new Map();
    for (const c of withEmail) {
      const e = c.email.toLowerCase();
      if (!emailToContact.has(e)) emailToContact.set(e, c);
    }

    // 1) Collect the unique thread ids that involve any of our contacts. A bare
    //    email in Gmail search matches it in any header (from/to/cc/bcc), so OR-ing
    //    the addresses is both shorter than from:()/to:()/cc:() (stays well under the
    //    query-length limit at 20 per chunk) and wider. Over-fetch is harmless: step 2
    //    re-derives participants from the actual thread headers and only logs a real
    //    From/To/Cc match, so a stray body mention never becomes a false touchpoint.
    const threadIds = new Set();
    for (const group of chunk([...emailToContact.keys()], GMAIL_EMAIL_CHUNK)) {
      const q = group.join(' OR ');
      let pageToken = null, fetched = 0;
      do {
        let listRes;
        try {
          listRes = await gmail.users.messages.list({
            userId: 'me', q, maxResults: 500, ...(pageToken && { pageToken }),
          });
        } catch (e) { console.error('[ENRICH_GMAIL_BULK] list:', e.message); break; }
        for (const m of listRes.data.messages || []) if (m.threadId) threadIds.add(m.threadId);
        pageToken = listRes.data.nextPageToken || null;
        fetched += (listRes.data.messages || []).length;
      } while (pageToken && fetched < GMAIL_MAX_MSGS_PER_CHUNK);
    }

    // 2) Fetch each unique thread once (metadata), map participants → contacts, log.
    await pool([...threadIds], GMAIL_THREAD_CONCURRENCY, async (threadId) => {
      let t;
      try {
        t = await gmail.users.threads.get({
          userId: 'me', id: threadId, format: 'metadata',
          metadataHeaders: ['From', 'To', 'Cc', 'Date', 'Subject'],
        });
      } catch { return; }
      const msgs = t.data.messages || [];
      if (!msgs.length) return;

      const participants = new Set();
      let hasSent = false, hasInbox = false;
      for (const m of msgs) {
        if (m.labelIds?.includes('SENT')) hasSent = true;
        if (m.labelIds?.includes('INBOX')) hasInbox = true;
        for (const h of m.payload?.headers || []) {
          if (h.name === 'From' || h.name === 'To' || h.name === 'Cc') {
            for (const addr of extractEmails(h.value)) participants.add(addr);
          }
        }
      }

      const matched = [];
      const seen = new Set();
      for (const addr of participants) {
        const c = emailToContact.get(addr);
        if (c && !seen.has(c.id)) { seen.add(c.id); matched.push(c); }
      }
      if (!matched.length) return;

      const first = msgs[0];
      const hdrs0 = first.payload?.headers || [];
      const dateHdr = hdrs0.find(h => h.name === 'Date')?.value;
      const subject = hdrs0.find(h => h.name === 'Subject')?.value || '(no subject)';
      const occurredAt = dateHdr ? new Date(dateHdr).toISOString() : new Date().toISOString();
      const snippet = first.snippet || '';
      const isReply = msgs.length > 1 || (hasSent && hasInbox);

      for (const c of matched) {
        const r = await logActivity(supabase, {
          workspaceId, contactId: c.id, companyId: c.company_id || null,
          type: isReply ? 'email_reply' : 'email_opened',
          source: 'gmail', externalId: `gmail_thread_${threadId}`,
          occurredAt, description: subject, summary: snippet ? snippet.slice(0, 200) : null,
        });
        if (r) counts.set(c.id, (counts.get(c.id) || 0) + 1);
      }
    });

    const total = [...counts.values()].reduce((a, b) => a + b, 0);
    console.log(`[ENRICH_GMAIL_BULK] ${withEmail.length} contacts, ${threadIds.size} threads, ${total} logged`);
  } catch (e) {
    if (e?.code === 'google_token_revoked') {
      await supabase.from('workflow_provider_connections').update({ is_verified: false }).eq('id', gmailConn.id);
      console.warn(`[ENRICH_GMAIL_BULK] connection=${gmailConn.id} revoked — flagged for re-auth`);
    }
    console.error('[ENRICH_GMAIL_BULK]', e.message);
  }
  return counts;
}

// ── Connection loader ─────────────────────────────────────────────────────────

async function getWorkspaceConnections(supabase, workspaceId) {
  const { data: conns } = await supabase
    .from('workflow_provider_connections')
    .select('id, encrypted_credentials, workflow_providers!inner(name)')
    .eq('workspace_id', workspaceId)
    .eq('is_verified', true);

  const map = {};
  for (const conn of conns || []) {
    const name = conn.workflow_providers?.name;
    if (name) map[name] = conn;
  }

  const { data: liConn } = await supabase
    .from('workspace_linkedin_connections')
    .select('unipile_account_id')
    .eq('workspace_id', workspaceId)
    .order('connected_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (liConn?.unipile_account_id) map.linkedin = { account_id: liConn.unipile_account_id };

  return map;
}

// ── LinkedIn attendee map (fetched once per run) ──────────────────────────────

async function buildAttendeeMap(accountId) {
  const byUrl                 = new Map();
  const byMemberId            = new Map();
  const connectedAt           = new Map();
  const connectedAtByMemberId = new Map();
  try {
    const [attendees, relations] = await Promise.all([
      unipilePages(`${UNIPILE_BASE()}/chat_attendees`, accountId),
      unipilePages(`${UNIPILE_BASE()}/users/relations`, accountId),
    ]);
    for (const a of attendees) {
      const norm = normaliseLinkedInUrl(a.profile_url);
      if (norm) byUrl.set(norm, a.id);
      if (a.provider_id) byMemberId.set(a.provider_id, a.id);
    }
    for (const r of relations) {
      const norm = normaliseLinkedInUrl(r.public_profile_url || (r.public_identifier ? `https://www.linkedin.com/in/${r.public_identifier}` : null));
      if (norm && r.created_at) connectedAt.set(norm, new Date(r.created_at).toISOString());
      if (r.provider_id && r.created_at) connectedAtByMemberId.set(r.provider_id, new Date(r.created_at).toISOString());
    }
  } catch (e) {
    console.error('[ENRICH_LI] Attendee map failed:', e.message);
  }
  return { byUrl, byMemberId, connectedAt, connectedAtByMemberId };
}

// ── Gmail ─────────────────────────────────────────────────────────────────────

// Superseded by scanGmailBulk (one pass for the whole batch). Kept for reference /
// as a per-contact fallback; not called by the orchestrator anymore.
// eslint-disable-next-line no-unused-vars
async function scanGmail(supabase, workspaceId, contact, gmailConn) {
  if (!contact.email) return 0;
  try {
    const { credentials, needsUpdate, updatedCredentials } =
      await refreshGoogleToken(gmailConn.encrypted_credentials);

    if (needsUpdate) {
      await supabase.from('workflow_provider_connections')
        .update({ encrypted_credentials: updatedCredentials })
        .eq('id', gmailConn.id);
    }

    const oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      process.env.GOOGLE_OAUTH_REDIRECT_URI,
    );
    oauth2Client.setCredentials({ access_token: credentials.access_token });
    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

    let nextPageToken = null;
    let fetched = 0;
    let logged = 0;

    do {
      const listRes = await gmail.users.threads.list({
        userId: 'me',
        q: `{from:${contact.email} to:${contact.email}}`,
        maxResults: 100,
        ...(nextPageToken && { pageToken: nextPageToken }),
      });

      const threads = listRes.data.threads || [];
      nextPageToken = listRes.data.nextPageToken || null;
      fetched += threads.length;

      for (const thread of threads) {
        const t = await gmail.users.threads.get({ userId: 'me', id: thread.id, format: 'full' });
        const msgs = t.data.messages || [];
        if (!msgs.length) continue;

        const first   = msgs[0];
        const hdrs    = first?.payload?.headers || [];
        const dateHdr = hdrs.find(h => h.name === 'Date')?.value;
        const subject = hdrs.find(h => h.name === 'Subject')?.value || '(no subject)';
        const snippet = first?.snippet || '';
        const occurredAt = dateHdr ? new Date(dateHdr).toISOString() : new Date().toISOString();

        const hasSent  = msgs.some(m => m.labelIds?.includes('SENT'));
        const hasInbox = msgs.some(m => m.labelIds?.includes('INBOX'));
        const isReply  = msgs.length > 1 || (hasSent && hasInbox);

        const r = await logActivity(supabase, {
          workspaceId,
          contactId:   contact.id,
          companyId:   contact.company_id || null,
          type:        isReply ? 'email_reply' : 'email_opened',
          source:      'gmail',
          externalId:  `gmail_thread_${thread.id}`,
          occurredAt,
          description: subject,
          summary:     snippet ? snippet.slice(0, 200) : null,
        });
        if (r) logged++;
      }
    } while (nextPageToken && fetched < 500);

    console.log(`[ENRICH_GMAIL] ${contact.email}: ${logged} logged`);
    return logged;
  } catch (e) {
    // Revoked/expired grant — flag the connection so the UI shows "Needs auth"
    // and the user reconnects, instead of failing silently on every enrichment.
    if (e?.code === 'google_token_revoked') {
      await supabase.from('workflow_provider_connections')
        .update({ is_verified: false }).eq('id', gmailConn.id);
      console.warn(`[ENRICH_GMAIL] connection=${gmailConn.id} revoked — flagged for re-auth`);
    }
    console.error(`[ENRICH_GMAIL] ${contact.email}:`, e.message);
    return 0;
  }
}

// ── IMAP (custom SMTP connection) ─────────────────────────────────────────────

async function scanImap(supabase, workspaceId, contact, smtpConn) {
  if (!contact.email) return 0;
  try {
    const { ImapFlow }    = await import('imapflow');
    const { simpleParser } = await import('mailparser');

    const creds = smtpConn.encrypted_credentials;
    let host, username, password;
    try { host     = decrypt(creds.host     || creds.smtp_host); }    catch { host     = creds.host     || creds.smtp_host; }
    try { username = decrypt(creds.username || creds.smtp_username || creds.email); } catch { username = creds.username || creds.smtp_username || creds.email; }
    try { password = decrypt(creds.password || creds.smtp_password); } catch { password = creds.password || creds.smtp_password; }

    if (!host || !username || !password) return 0;

    let imapHost;
    try { imapHost = creds.imap_host ? decrypt(creds.imap_host) : null; } catch { imapHost = creds.imap_host || null; }
    let imapPort;
    try { imapPort = creds.imap_port ? parseInt(decrypt(creds.imap_port)) : null; } catch { imapPort = parseInt(creds.imap_port || '993'); }

    if (!imapHost) {
      if (/office365\.com|smtp-mail\.outlook\.com/i.test(host)) imapHost = 'outlook.office365.com';
      else imapHost = host.replace(/^smtp\./i, 'imap.');
    }
    imapPort = imapPort || 993;

    const client = new ImapFlow({
      host: imapHost, port: imapPort, secure: imapPort === 993,
      auth: { user: username, pass: password },
      logger: false,
    });

    await client.connect();

    let logged = 0;
    const connectedEmail = username.toLowerCase();
    const contactEmail   = contact.email.toLowerCase();
    const allFolders = await client.list();
    const inboxPath = allFolders.find(m => m.flags?.has('\\Inbox') || m.path === 'INBOX')?.path || 'INBOX';
    const sentPath  = allFolders.find(m => m.flags?.has('\\Sent'))?.path || null;

    const processFolder = async (folderPath) => {
      const lock = await client.getMailboxLock(folderPath);
      try {
        const uids = await client.search(
          { or: [{ from: contactEmail }, { to: contactEmail }] },
          { uid: true }
        );
        for (const uid of uids.slice(0, 200)) {
          try {
            const { content } = await client.download(String(uid), undefined, { uid: true });
            const chunks = [];
            for await (const chunk of content) chunks.push(chunk);
            const parsed = await simpleParser(Buffer.concat(chunks));

            const fromEmail  = (parsed.from?.value?.[0]?.address || '').toLowerCase();
            const toEmails   = (parsed.to?.value || []).map(a => (a.address || '').toLowerCase());
            const subject    = parsed.subject || '(no subject)';
            const occurredAt = parsed.date ? parsed.date.toISOString() : new Date().toISOString();
            const messageId  = parsed.messageId || `uid_${uid}_${folderPath}`;

            const isOutbound     = fromEmail === connectedEmail;
            const involvesContact = isOutbound ? toEmails.some(e => e === contactEmail) : fromEmail === contactEmail;
            if (!involvesContact) continue;

            const r = await logActivity(supabase, {
              workspaceId, contactId: contact.id, companyId: contact.company_id || null,
              type:       isOutbound ? 'email_sent' : 'email_received',
              source:     'smtp',
              externalId: `imap_${messageId.replace(/[<>\s]/g, '')}_${occurredAt.slice(0, 10)}`,
              occurredAt,
              description: subject,
              summary:    (parsed.text || '').slice(0, 200) || null,
            });
            if (r) logged++;
          } catch { /* per-message errors are non-fatal */ }
        }
      } finally {
        lock.release();
      }
    };

    for (const folder of [inboxPath, ...(sentPath ? [sentPath] : [])]) {
      try { await processFolder(folder); } catch (e) { console.warn(`[ENRICH_IMAP] folder ${folder}:`, e.message); }
    }

    await client.logout();
    console.log(`[ENRICH_IMAP] ${contact.email}: ${logged} logged`);
    return logged;
  } catch (e) {
    console.error(`[ENRICH_IMAP] ${contact.email}:`, e.message);
    return 0;
  }
}

// Bulk IMAP — ONE connection for the whole batch, ENVELOPE-only. The per-contact
// scanImap above opened a fresh IMAP connection per contact and downloaded + parsed
// up to 200 full message BODIES each (thousands of body downloads at 50 accounts —
// the single heaviest thing the backfill did). Here we connect once, search each
// folder for the OR of every contact email, and fetch only envelopes (from/to/
// subject/date, no body), mapping each message to its contact. Returns
// Map<contactId, count>.
async function scanImapBulk(supabase, workspaceId, contacts, smtpConn) {
  const withEmail = contacts.filter(c => c.email);
  const counts = new Map(withEmail.map(c => [c.id, 0]));
  if (!withEmail.length) return counts;

  let client;
  try {
    const { ImapFlow } = await import('imapflow');
    const creds = smtpConn.encrypted_credentials;
    let host, username, password;
    try { host     = decrypt(creds.host     || creds.smtp_host); }    catch { host     = creds.host     || creds.smtp_host; }
    try { username = decrypt(creds.username || creds.smtp_username || creds.email); } catch { username = creds.username || creds.smtp_username || creds.email; }
    try { password = decrypt(creds.password || creds.smtp_password); } catch { password = creds.password || creds.smtp_password; }
    if (!host || !username || !password) return counts;

    let imapHost;
    try { imapHost = creds.imap_host ? decrypt(creds.imap_host) : null; } catch { imapHost = creds.imap_host || null; }
    let imapPort;
    try { imapPort = creds.imap_port ? parseInt(decrypt(creds.imap_port)) : null; } catch { imapPort = parseInt(creds.imap_port || '993'); }
    if (!imapHost) {
      if (/office365\.com|smtp-mail\.outlook\.com/i.test(host)) imapHost = 'outlook.office365.com';
      else imapHost = host.replace(/^smtp\./i, 'imap.');
    }
    imapPort = imapPort || 993;

    client = new ImapFlow({
      host: imapHost, port: imapPort, secure: imapPort === 993,
      auth: { user: username, pass: password }, logger: false,
    });
    await client.connect();

    const connectedEmail = username.toLowerCase();
    const emailToContact = new Map();
    for (const c of withEmail) {
      const e = c.email.toLowerCase();
      if (!emailToContact.has(e)) emailToContact.set(e, c);
    }
    const emails = [...emailToContact.keys()];

    const allFolders = await client.list();
    const inboxPath = allFolders.find(m => m.flags?.has('\\Inbox') || m.path === 'INBOX')?.path || 'INBOX';
    const sentPath  = allFolders.find(m => m.flags?.has('\\Sent'))?.path || null;

    const processFolder = async (folderPath) => {
      const lock = await client.getMailboxLock(folderPath);
      try {
        // One search per chunk of addresses (OR from/to); union the UIDs. Chunked so
        // a huge OR criteria set never trips a server's search-complexity limit.
        const uidSet = new Set();
        for (const group of chunk(emails, 30)) {
          const or = [];
          for (const e of group) { or.push({ from: e }); or.push({ to: e }); }
          try {
            const uids = await client.search({ or }, { uid: true });
            for (const u of uids || []) uidSet.add(u);
          } catch (e) { console.warn('[ENRICH_IMAP_BULK] search:', e.message); }
        }
        if (!uidSet.size) return;

        // Envelope-only fetch — headers, no body download.
        for await (const msg of client.fetch([...uidSet], { envelope: true, uid: true })) {
          const env = msg.envelope || {};
          const fromEmail = (env.from?.[0]?.address || '').toLowerCase();
          const toEmails  = (env.to || []).map(a => (a.address || '').toLowerCase());
          const isOutbound = fromEmail === connectedEmail;
          const involved = isOutbound ? toEmails : [fromEmail];

          const seen = new Set();
          for (const addr of involved) {
            const c = emailToContact.get(addr);
            if (!c || seen.has(c.id)) continue;
            seen.add(c.id);
            const subject   = env.subject || '(no subject)';
            const occurredAt = env.date ? new Date(env.date).toISOString() : new Date().toISOString();
            const messageId = env.messageId || `uid_${msg.uid}_${folderPath}`;
            const r = await logActivity(supabase, {
              workspaceId, contactId: c.id, companyId: c.company_id || null,
              type:       isOutbound ? 'email_sent' : 'email_received',
              source:     'smtp',
              externalId: `imap_${String(messageId).replace(/[<>\s]/g, '')}_${occurredAt.slice(0, 10)}`,
              occurredAt, description: subject, summary: null,
            });
            if (r) counts.set(c.id, (counts.get(c.id) || 0) + 1);
          }
        }
      } finally {
        lock.release();
      }
    };

    for (const folder of [inboxPath, ...(sentPath ? [sentPath] : [])]) {
      try { await processFolder(folder); } catch (e) { console.warn(`[ENRICH_IMAP_BULK] folder ${folder}:`, e.message); }
    }

    const total = [...counts.values()].reduce((a, b) => a + b, 0);
    console.log(`[ENRICH_IMAP_BULK] ${withEmail.length} contacts, ${total} logged`);
  } catch (e) {
    console.error('[ENRICH_IMAP_BULK]', e.message);
  } finally {
    try { if (client) await client.logout(); } catch { /* ignore */ }
  }
  return counts;
}

// ── LinkedIn / Unipile ────────────────────────────────────────────────────────

async function scanLinkedIn(supabase, workspaceId, contact, accountId, attendeeMap) {
  if (!contact.linkedin_url && !contact.linkedin_member_id) return 0;
  let logged = 0;

  try {
    const norm       = normaliseLinkedInUrl(contact.linkedin_url);
    // Extract identifier from the ORIGINAL url (not norm) to preserve case — ACoAA member IDs are case-sensitive
    const identifier = contact.linkedin_url?.match(/\/in\/([^/?]+)/i)?.[1] || null;
    const storedMemberId = contact.linkedin_member_id || null;

    const knownConnectedAt = (storedMemberId && attendeeMap.connectedAtByMemberId.get(storedMemberId))
      || (norm && attendeeMap.connectedAt.get(norm));

    if (knownConnectedAt) {
      const r = await logActivity(supabase, {
        workspaceId, contactId: contact.id, companyId: contact.company_id || null,
        type: 'linkedin_connected', source: 'linkedin',
        externalId:  `li_conn_${storedMemberId || identifier}`,
        occurredAt:  knownConnectedAt,
        description: 'Connected on LinkedIn',
        summary:     '1st degree connection',
      });
      if (r) logged++;
    }

    // Message history
    // Check attendee map by storedMemberId, by URL, or by identifier (handles ACoAA-format provider IDs in the URL)
    const attendeeId = (storedMemberId && attendeeMap.byMemberId.get(storedMemberId))
      || (norm && attendeeMap.byUrl.get(norm))
      || (identifier && attendeeMap.byMemberId.get(identifier));

    let messages = [];
    if (attendeeId) {
      console.log(`[ENRICH_LI] found attendeeId=${attendeeId} for ${norm || identifier}`);
      // Fetch via attendee endpoint first to get the chat_id, then re-fetch from the chat endpoint for full history
      const sample = await unipilePages(`${UNIPILE_BASE()}/chat_attendees/${attendeeId}/messages`, accountId);
      const chatId = sample[0]?.chat_id;
      if (chatId) {
        console.log(`[ENRICH_LI] fetching full chat history from chat_id=${chatId}`);
        messages = await unipilePages(`${UNIPILE_BASE()}/chats/${chatId}/messages`, accountId);
      } else {
        messages = sample;
      }
    } else if (storedMemberId || identifier) {
      try {
        const candidateIds = [...new Set([storedMemberId, identifier].filter(Boolean))];

        for (const candidateId of candidateIds) {
          // Step 1: resolve the actual LinkedIn provider_id (ACoAA format) via /users/
          // This is critical — searching chats by a URL slug returns unrelated chats
          let realProviderId = null;
          console.log(`[ENRICH_LI PATH B] resolving ${candidateId} via /users/`);
          const profileRes = await fetch(`${UNIPILE_BASE()}/users/${candidateId}?account_id=${accountId}`, { headers: unipileHeaders() });
          if (profileRes.ok) {
            const profile = await profileRes.json();
            realProviderId = profile.provider_id || null;
            console.log(`[ENRICH_LI PATH B] resolved -> provider_id=${realProviderId}`);
            if (realProviderId && !storedMemberId) {
              try { await supabase.from('contacts').update({ linkedin_member_id: realProviderId }).eq('id', contact.id); } catch {}
            }
          } else {
            console.log(`[ENRICH_LI PATH B] /users/${candidateId} -> ${profileRes.status}`);
          }

          // Step 2: check if the resolved provider_id is already in our attendee map
          // If so, use the reliable Path A approach (attendee → chat_id → full messages)
          if (realProviderId) {
            const attendeeIdFromMap = attendeeMap.byMemberId.get(realProviderId);
            console.log(`[ENRICH_LI PATH B] attendee map lookup for ${realProviderId}: ${attendeeIdFromMap || 'not found'}`);
            if (attendeeIdFromMap) {
              const sample = await unipilePages(`${UNIPILE_BASE()}/chat_attendees/${attendeeIdFromMap}/messages`, accountId);
              const chatId = sample[0]?.chat_id;
              console.log(`[ENRICH_LI PATH B] Path A fallback: attendeeId=${attendeeIdFromMap} chatId=${chatId}`);
              if (chatId) {
                messages = await unipilePages(`${UNIPILE_BASE()}/chats/${chatId}/messages`, accountId);
              } else {
                messages = sample;
              }
              break;
            }
          }

          // Step 3: fall back to chat search by provider_id — less reliable, but last resort
          const searchId = realProviderId || (candidateId.startsWith('ACoAA') ? candidateId : null);
          if (!searchId) continue;

          console.log(`[ENRICH_LI PATH B] fallback chat search by provider_id=${searchId}`);
          const chatRes = await fetch(`${UNIPILE_BASE()}/chats?account_id=${accountId}&attendee_provider_id=${searchId}&limit=5`, { headers: unipileHeaders() });
          if (!chatRes.ok) { console.log(`[ENRICH_LI PATH B] /chats -> ${chatRes.status}`); continue; }

          const chats = (await chatRes.json()).items || [];
          console.log(`[ENRICH_LI PATH B] ${chats.length} chats found`);

          for (const chat of chats) {
            const chatMsgs = await unipilePages(`${UNIPILE_BASE()}/chats/${chat.id}/messages`, accountId);
            const inboundSenders = new Set(chatMsgs.filter(m => !m.is_sender && m.sender_id).map(m => m.sender_id));
            // Skip group chats
            if (inboundSenders.size > 1) { console.log(`[ENRICH_LI PATH B] skip group chat ${chat.id} (${inboundSenders.size} senders)`); continue; }
            if (inboundSenders.size === 0) continue;
            const [actualSenderId] = inboundSenders;
            console.log(`[ENRICH_LI PATH B] chat=${chat.id} inbound sender_id=${actualSenderId} expected=${realProviderId} match=${actualSenderId === realProviderId}`);
            // Only include if the single inbound sender matches the contact's provider_id
            if (actualSenderId === realProviderId) messages.push(...chatMsgs);
          }

          if (messages.length > 0) break;
        }
      } catch (e) { console.error(`[ENRICH_LI PATH B] ${norm || storedMemberId}:`, e.message); }
    }

    const withText = messages.filter(m => m.text?.trim());
    console.log(`[ENRICH_LI] ${messages.length} msgs fetched, ${withText.length} have text, keys: ${JSON.stringify([...new Set(messages.slice(0,1).flatMap(m => Object.keys(m)))])}`);
    for (const msg of messages) {
      if (!msg.text?.trim()) continue;
      const r = await logActivity(supabase, {
        workspaceId, contactId: contact.id, companyId: contact.company_id || null,
        type: 'linkedin_message', source: 'linkedin',
        externalId:  `li_msg_${msg.id || msg.provider_id}`,
        occurredAt:  msg.timestamp ? new Date(msg.timestamp).toISOString() : new Date().toISOString(),
        // is_outbound so the signal extractor skips messages WE sent.
        rawData:     { is_outbound: !!msg.is_sender },
        description: 'LinkedIn message',
        summary:     msg.is_sender ? `You: ${msg.text.slice(0, 200)}` : msg.text.slice(0, 200),
      });
      if (r) logged++;
    }

    console.log(`[ENRICH_LI] ${contact.linkedin_url || storedMemberId}: ${logged} logged`);
    return logged;
  } catch (e) {
    console.error(`[ENRICH_LI] ${contact.linkedin_url}:`, e.message);
    return 0;
  }
}

// ── Instantly ─────────────────────────────────────────────────────────────────

async function scanInstantly(supabase, workspaceId, contact, apiKey) {
  if (!contact.email) return 0;
  try {
    const res = await fetch('https://api.instantly.ai/api/v2/leads/list', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ contacts: [contact.email], limit: 1 }),
    });
    if (!res.ok) return 0;

    const data = await res.json();
    const lead = data.items?.[0];
    if (!lead) return 0;

    let logged = 0;
    if (lead.timestamp_last_reply) {
      const r = await logActivity(supabase, {
        workspaceId, contactId: contact.id, companyId: contact.company_id || null,
        type: 'email_reply', source: 'instantly',
        externalId:  `instantly_reply_${contact.email}`,
        occurredAt:  new Date(lead.timestamp_last_reply).toISOString(),
        description: 'Replied to cold email sequence',
        summary:     lead.campaign_name || null,
      });
      if (r) logged++;
    }
    if (lead.timestamp_last_open) {
      const r = await logActivity(supabase, {
        workspaceId, contactId: contact.id, companyId: contact.company_id || null,
        type: 'email_opened', source: 'instantly',
        externalId:  `instantly_open_${contact.email}`,
        occurredAt:  new Date(lead.timestamp_last_open).toISOString(),
        description: 'Opened cold email sequence',
        summary:     lead.campaign_name || null,
      });
      if (r) logged++;
    }

    console.log(`[ENRICH_INSTANTLY] ${contact.email}: ${logged} logged`);
    return logged;
  } catch (e) {
    console.error(`[ENRICH_INSTANTLY] ${contact.email}:`, e.message);
    return 0;
  }
}

// ── Slack ─────────────────────────────────────────────────────────────────────
// Uses user token to search messages mentioning the contact's email.

async function scanSlack(supabase, workspaceId, contact, slackConn) {
  if (!contact.email) return 0;
  try {
    const userToken = decrypt(slackConn.encrypted_credentials?.user_token);
    if (!userToken) return 0;

    const headers = { Authorization: `Bearer ${userToken}`, 'Content-Type': 'application/json' };

    // Search messages that mention this email
    const searchRes = await fetch(
      `https://slack.com/api/search.messages?query=${encodeURIComponent(contact.email)}&count=50`,
      { headers }
    );
    if (!searchRes.ok) return 0;
    const searchData = await searchRes.json();
    if (!searchData.ok) return 0;

    const messages = searchData.messages?.matches || [];
    let logged = 0;

    for (const msg of messages) {
      const occurredAt = msg.ts ? new Date(parseFloat(msg.ts) * 1000).toISOString() : new Date().toISOString();
      const r = await logActivity(supabase, {
        workspaceId, contactId: contact.id, companyId: contact.company_id || null,
        type: 'slack_message', source: 'slack',
        externalId:  `slack_msg_${msg.ts}_${msg.channel?.id}`,
        occurredAt,
        description: `Slack: #${msg.channel?.name || 'message'}`,
        summary:     msg.text ? msg.text.slice(0, 200) : null,
      });
      if (r) logged++;
    }

    console.log(`[ENRICH_SLACK] ${contact.email}: ${logged} logged`);
    return logged;
  } catch (e) {
    console.error(`[ENRICH_SLACK] ${contact.email}:`, e.message);
    return 0;
  }
}

// ── Fireflies ─────────────────────────────────────────────────────────────────

async function scanFireflies(supabase, workspaceId, contact, apiKey) {
  if (!contact.email) return 0;
  try {
    const query = `query {
      transcripts(participant_email: "${contact.email}") {
        id title date duration
        participants { name email }
        summary { overview }
      }
    }`;
    const res = await fetch('https://api.fireflies.ai/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ query }),
    });
    if (!res.ok) return 0;
    const data = await res.json();
    const transcripts = data.data?.transcripts || [];
    let logged = 0;
    for (const t of transcripts) {
      const occurredAt = t.date ? new Date(t.date).toISOString() : new Date().toISOString();
      const participants = (t.participants || []).map(p => p.name || p.email).filter(Boolean).join(', ');
      const r = await logActivity(supabase, {
        workspaceId, contactId: contact.id, companyId: contact.company_id || null,
        type: 'meeting_held', source: 'fireflies',
        externalId:  `ff_${t.id}_${contact.id}`,
        occurredAt,
        description: t.title || 'Meeting recorded',
        summary:     t.summary?.overview ? t.summary.overview.slice(0, 300) : (participants ? `Participants: ${participants}` : null),
      });
      if (r) logged++;
    }
    console.log(`[ENRICH_FIREFLIES] ${contact.email}: ${logged} logged`);
    return logged;
  } catch (e) {
    console.error(`[ENRICH_FIREFLIES] ${contact.email}:`, e.message);
    return 0;
  }
}

// Bulk Fireflies — one paginated sweep of recent transcripts, mapped locally by
// participant email, instead of a GraphQL query per contact. Each transcript already
// carries its participants' emails, so a few pages cover the whole batch.
const FIREFLIES_PAGES = 6;
const FIREFLIES_PAGE_SIZE = 50;

async function scanFirefliesBulk(supabase, workspaceId, contacts, apiKey) {
  const withEmail = contacts.filter(c => c.email);
  const counts = new Map(withEmail.map(c => [c.id, 0]));
  if (!withEmail.length) return counts;

  const emailToContact = new Map();
  for (const c of withEmail) {
    const e = c.email.toLowerCase();
    if (!emailToContact.has(e)) emailToContact.set(e, c);
  }

  try {
    for (let page = 0; page < FIREFLIES_PAGES; page++) {
      const query = `query {
        transcripts(limit: ${FIREFLIES_PAGE_SIZE}, skip: ${page * FIREFLIES_PAGE_SIZE}) {
          id title date
          participants { name email }
          summary { overview }
        }
      }`;
      const res = await fetchRetry('https://api.fireflies.ai/graphql', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ query }),
      });
      if (!res.ok) break;
      const data = await res.json();
      const transcripts = data.data?.transcripts || [];
      if (!transcripts.length) break;

      for (const t of transcripts) {
        const occurredAt = t.date ? new Date(t.date).toISOString() : new Date().toISOString();
        const partList = (t.participants || []).map(p => p.name || p.email).filter(Boolean).join(', ');
        const seen = new Set();
        for (const p of t.participants || []) {
          const c = emailToContact.get((p.email || '').toLowerCase());
          if (!c || seen.has(c.id)) continue;
          seen.add(c.id);
          const r = await logActivity(supabase, {
            workspaceId, contactId: c.id, companyId: c.company_id || null,
            type: 'meeting_held', source: 'fireflies',
            externalId: `ff_${t.id}_${c.id}`,
            occurredAt,
            description: t.title || 'Meeting recorded',
            summary: t.summary?.overview ? t.summary.overview.slice(0, 300) : (partList ? `Participants: ${partList}` : null),
          });
          if (r) counts.set(c.id, (counts.get(c.id) || 0) + 1);
        }
      }
      if (transcripts.length < FIREFLIES_PAGE_SIZE) break;
    }
    const total = [...counts.values()].reduce((a, b) => a + b, 0);
    console.log(`[ENRICH_FIREFLIES_BULK] ${withEmail.length} contacts, ${total} logged`);
  } catch (e) {
    console.error('[ENRICH_FIREFLIES_BULK]', e.message);
  }
  return counts;
}

// ── Fathom ────────────────────────────────────────────────────────────────────

async function scanFathom(supabase, workspaceId, contact, apiKey) {
  if (!contact.email) return 0;
  try {
    const res = await fetch(
      `https://api.fathom.ai/external/v1/meetings?participant_email=${encodeURIComponent(contact.email)}&limit=50`,
      { headers: { Authorization: `Bearer ${apiKey}` } }
    );
    if (!res.ok) return 0;
    const data = await res.json();
    const meetings = data.data || data.meetings || [];
    let logged = 0;
    for (const m of meetings) {
      const occurredAt = m.started_at || m.created_at || new Date().toISOString();
      const r = await logActivity(supabase, {
        workspaceId, contactId: contact.id, companyId: contact.company_id || null,
        type: 'meeting_held', source: 'fathom',
        externalId:  `fathom_${m.id}_${contact.id}`,
        occurredAt,
        description: m.title || 'Meeting recorded',
        summary:     m.summary || null,
      });
      if (r) logged++;
    }
    console.log(`[ENRICH_FATHOM] ${contact.email}: ${logged} logged`);
    return logged;
  } catch (e) {
    console.error(`[ENRICH_FATHOM] ${contact.email}:`, e.message);
    return 0;
  }
}

// ── Calendly ──────────────────────────────────────────────────────────────────

async function fetchCalendlyUserUri(pat) {
  try {
    const res = await fetch('https://api.calendly.com/users/me', {
      headers: { Authorization: `Bearer ${pat}`, 'Content-Type': 'application/json' },
    });
    if (!res.ok) return null;
    const body = await res.json();
    return body.resource?.uri || null;
  } catch { return null; }
}

async function scanCalendly(supabase, workspaceId, contact, pat, userUri) {
  if (!contact.email || !pat || !userUri) return 0;
  try {
    const url = new URL('https://api.calendly.com/scheduled_events');
    url.searchParams.set('invitee_email', contact.email);
    url.searchParams.set('user', userUri);
    url.searchParams.set('count', '100');
    // No status filter — fetch both active and canceled so dedup mirrors webhook.

    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${pat}`, 'Content-Type': 'application/json' },
    });
    if (!res.ok) return 0;
    const data = await res.json();
    const events = data.collection || [];

    let logged = 0;
    for (const ev of events) {
      const eventUuid = ev.uri?.split('/').pop();
      if (!eventUuid) continue;
      const isCanceled = ev.status === 'canceled';
      const occurredAt = ev.start_time || new Date().toISOString();

      const r = await logActivity(supabase, {
        workspaceId,
        contactId:   contact.id,
        companyId:   contact.company_id || null,
        type:        isCanceled ? 'meeting_cancelled' : 'meeting_scheduled',
        source:      'calendly',
        externalId:  `calendly_${isCanceled ? 'cancel' : 'book'}_event_${eventUuid}`,
        occurredAt,
        description: isCanceled ? `Cancelled: ${ev.name}` : `Booked: ${ev.name}`,
        rawData:     {
          meeting_name: ev.name,
          start_time:   ev.start_time,
          end_time:     ev.end_time,
          event_uri:    ev.uri,
          status:       ev.status,
        },
      });
      if (r) logged++;
    }
    console.log(`[ENRICH_CALENDLY] ${contact.email}: ${logged} logged`);
    return logged;
  } catch (e) {
    console.error(`[ENRICH_CALENDLY] ${contact.email}:`, e.message);
    return 0;
  }
}

// ── Cal.com ───────────────────────────────────────────────────────────────────

const CAL_COM_API_VERSION = '2026-05-01';

async function scanCalCom(supabase, workspaceId, contact, pat) {
  if (!contact.email || !pat) return 0;
  try {
    const url = new URL('https://api.cal.com/v2/bookings');
    url.searchParams.set('attendeeEmail', contact.email);
    url.searchParams.set('limit', '100');

    const res = await fetch(url.toString(), {
      headers: {
        Authorization:     `Bearer ${pat}`,
        'cal-api-version': CAL_COM_API_VERSION,
      },
    });
    if (!res.ok) return 0;

    const body = await res.json();
    // v2 wraps in `data`. The bookings list may be `data.bookings` or just `data`.
    const list = body?.data?.bookings || body?.data || body?.bookings || [];

    let logged = 0;
    for (const b of list) {
      const bookingUid = b.uid || b.bookingUid;
      if (!bookingUid) continue;
      const isCanceled = (b.status || '').toLowerCase() === 'cancelled';
      const occurredAt = b.start || b.startTime || new Date().toISOString();
      const title = b.title || b.eventType?.title || 'Meeting';

      const r = await logActivity(supabase, {
        workspaceId,
        contactId:   contact.id,
        companyId:   contact.company_id || null,
        type:        isCanceled ? 'meeting_cancelled' : 'meeting_scheduled',
        source:      'cal_com',
        externalId:  `cal_com_${isCanceled ? 'cancel' : 'book'}_${bookingUid}`,
        occurredAt,
        description: isCanceled ? `Cancelled: ${title}` : `Booked: ${title}`,
        rawData:     {
          meeting_name: title,
          start_time:   b.start || b.startTime,
          end_time:     b.end   || b.endTime,
          booking_uid:  bookingUid,
          status:       b.status,
        },
      });
      if (r) logged++;
    }
    console.log(`[ENRICH_CAL_COM] ${contact.email}: ${logged} logged`);
    return logged;
  } catch (e) {
    console.error(`[ENRICH_CAL_COM] ${contact.email}:`, e.message);
    return 0;
  }
}

// ── Main export ───────────────────────────────────────────────────────────────

// Per-PROVIDER concurrency lanes for the per-contact sources (the bulk sources —
// Gmail, IMAP, Fireflies — fetch once and don't use these). A single global pool
// was wrong: it would fire 8 Unipile calls AND 8 Calendly calls at once and earn
// 429s. Each provider gets its own cap, and the lanes run concurrently so different
// providers still overlap. Unipile is the strictest, so it gets the smallest lane.
const LANES = {
  calendly:  3,
  cal_com:   3,
  fathom:    3,
  instantly: 3,
  slack:     3,
  linkedin:  2,
};

// Write the in-memory job snapshot through to the DB row (created by the API on
// enqueue) so progress survives a worker restart / the 10-min in-memory cleanup. An
// UPDATE, not an upsert — it must never clobber the queue columns (status,
// contact_ids) the drainer owns. Best-effort; the in-memory copy drives the live UI.
async function persistJob(supabase, jobId, done = false) {
  if (!jobId) return;
  const job = enrichmentJobs.get(jobId);
  if (!job) return;
  try {
    await supabase.from('contact_enrichment_jobs')
      .update({ state: { contacts: job.contacts }, done: done || job.done, updated_at: new Date().toISOString() })
      .eq('job_id', jobId);
  } catch { /* best-effort */ }
}

// `input` is EITHER a rich payload array [{id, email, first_name, ...}] handed over
// by the import, OR a bare array of entity ids (legacy). The payload path is the
// important one: a freshly CSV-imported person is a COLD LEAD — it exists as an
// `entity` with name/company claims, but it is NOT in the `contacts` view (which only
// projects people you've engaged), and its email isn't queryable there either. So
// loading by id from the view returned zero and the whole backfill silently no-op'd
// on exactly the people it's meant to seed. The import already holds every email and
// name, so it passes them straight through and we scan off that — no view dependency.
export async function enrichContactHistory(supabase, workspaceId, input, jobId = null) {
  if (!input?.length) return { enriched: 0, activitiesLogged: 0 };

  let contacts;
  if (typeof input[0] === 'object') {
    contacts = input
      .filter(c => c && c.id)
      .map(c => ({
        id: c.id,
        email: c.email ? String(c.email).toLowerCase().trim() : null,
        first_name: c.first_name || null,
        last_name: c.last_name || null,
        company: c.company || null,
        company_id: c.company_id || null,
        linkedin_url: c.linkedin_url || null,
        linkedin_member_id: c.linkedin_member_id || null,
      }));
  } else {
    // Legacy: bare ids. Load from the view (works only for people already in it).
    const { data } = await supabase
      .from('contacts')
      .select('id, email, first_name, last_name, company, company_id, linkedin_url, linkedin_member_id')
      .in('id', input)
      .eq('workspace_id', workspaceId);
    contacts = data || [];
  }

  console.log(`[ENRICH] Starting: ${contacts.length} contacts in ${workspaceId}`);
  if (!contacts.length) return { enriched: 0, activitiesLogged: 0 };

  const connections = await getWorkspaceConnections(supabase, workspaceId);

  // Resolve credentials once
  const gmailConn      = connections.gmail_oauth || null;
  const smtpConn       = connections.smtp        || null;
  const slackConn      = connections.slack       || null;
  const instantlyKey   = connections.instantly?.encrypted_credentials?.api_key
    ? decrypt(connections.instantly.encrypted_credentials.api_key) : null;
  const firefliesKey   = connections.fireflies?.encrypted_credentials?.api_key
    ? decrypt(connections.fireflies.encrypted_credentials.api_key) : null;
  const fathomKey      = connections.fathom?.encrypted_credentials?.api_key
    ? decrypt(connections.fathom.encrypted_credentials.api_key) : null;
  const calendlyPat    = connections.calendly?.encrypted_credentials?.api_key
    ? decrypt(connections.calendly.encrypted_credentials.api_key) : null;
  // Resolved once per run — needed as a query param on every /scheduled_events call.
  const calendlyUserUri = calendlyPat ? await fetchCalendlyUserUri(calendlyPat) : null;
  const calComPat      = connections.cal_com?.encrypted_credentials?.api_key
    ? decrypt(connections.cal_com.encrypted_credentials.api_key) : null;

  // Pre-fetch LinkedIn attendee map once for the whole batch
  let attendeeMap = { byUrl: new Map(), byMemberId: new Map(), connectedAt: new Map(), connectedAtByMemberId: new Map() };
  if (connections.linkedin?.account_id && process.env.UNIPILE_DSN && process.env.UNIPILE_API_KEY) {
    attendeeMap = await buildAttendeeMap(connections.linkedin.account_id);
  }

  // Initialise job progress state
  if (jobId) {
    const makeSource = (connected) => ({ status: connected ? 'pending' : 'skipped', count: 0 });
    enrichmentJobs.set(jobId, {
      contacts: contacts.map(c => ({
        id:    c.id,
        name:  [c.first_name, c.last_name].filter(Boolean).join(' ') || c.email,
        email: c.email,
        sources: {
          gmail:     makeSource(!!gmailConn),
          smtp:      makeSource(!!smtpConn),
          linkedin:  makeSource(!!connections.linkedin?.account_id),
          instantly: makeSource(!!instantlyKey),
          slack:     makeSource(!!slackConn),
          fireflies: makeSource(!!firefliesKey),
          fathom:    makeSource(!!fathomKey),
          calendly:  makeSource(!!calendlyPat && !!calendlyUserUri),
          cal_com:   makeSource(!!calComPat),
        },
      })),
      done: false,
    });
    // Long enough to outlast a big run (the LinkedIn lane is the slow tail). The DB
    // row is the durable copy the API reads once this is gone.
    setTimeout(() => enrichmentJobs.delete(jobId), 30 * 60 * 1000);
  }

  const setSource = (contactId, source, status, count = 0) => {
    if (!jobId) return;
    const job = enrichmentJobs.get(jobId);
    if (!job) return;
    const c = job.contacts.find(x => x.id === contactId);
    if (c) c.sources[source] = { status, count };
  };

  let totalActivities = 0;
  const persist = (done = false) => persistJob(supabase, jobId, done);

  // Heartbeat: setSource updates the in-memory snapshot as work lands; this flushes
  // it to the DB every few seconds so the modal shows smooth progress even while the
  // concurrent lanes are mid-run.
  const heartbeat = jobId ? setInterval(() => { persist().catch(() => {}); }, 4000) : null;

  const logScanEvent = (contact, source, n) => {
    const name = [contact.first_name, contact.last_name].filter(Boolean).join(' ') || contact.email || 'Contact';
    return supabase.from('workspace_system_log').insert({
      workspace_id: workspaceId, source, event_type: 'scan_complete', contact_id: contact.id,
      summary: n > 0 ? `${name}: found ${n} item${n === 1 ? '' : 's'}` : `${name}: no new activity`,
      metadata: { contact_id: contact.id, items_found: n },
      occurred_at: new Date().toISOString(),
    }).then(() => {}).catch(() => {});
  };

  try {
    // ── Bulk sweeps: fetch each provider ONCE, map locally. ──
    const runBulk = async (source, enabled, fn) => {
      if (!enabled) return;
      for (const c of contacts) setSource(c.id, source, 'scanning');
      let counts = new Map();
      try { counts = await fn(); } catch (e) { console.error(`[ENRICH_${source.toUpperCase()}_BULK]`, e?.message || e); }
      for (const c of contacts) {
        const n = counts.get(c.id) || 0;
        setSource(c.id, source, 'done', n);
        totalActivities += n;
      }
    };

    await runBulk('gmail',     !!gmailConn,   () => scanGmailBulk(supabase, workspaceId, contacts, gmailConn));
    await runBulk('smtp',      !!smtpConn,    () => scanImapBulk(supabase, workspaceId, contacts, smtpConn));
    await runBulk('fireflies', !!firefliesKey, () => scanFirefliesBulk(supabase, workspaceId, contacts, firefliesKey));

    // ── Per-contact sources: each its own concurrency lane, lanes run concurrently.
    //    (Calendly/Cal.com/Fathom only accept a single email per call, so they can't
    //    be bulked; LinkedIn/Unipile is per-attendee and rate-limited — smallest lane
    //    + fetchRetry backoff.) ──
    const runLane = async (source, enabled, laneSize, scan) => {
      if (!enabled) return;
      await pool(contacts, laneSize, async (contact) => {
        setSource(contact.id, source, 'scanning');
        let n = 0;
        try { n = await scan(contact); } catch (e) { console.error(`[ENRICH_${source.toUpperCase()}]`, e?.message || e); }
        setSource(contact.id, source, 'done', n);
        logScanEvent(contact, source, n);
        totalActivities += n;
      });
    };

    await Promise.all([
      runLane('calendly',  !!(calendlyPat && calendlyUserUri), LANES.calendly, c => scanCalendly(supabase, workspaceId, c, calendlyPat, calendlyUserUri)),
      runLane('cal_com',   !!calComPat,   LANES.cal_com,   c => scanCalCom(supabase, workspaceId, c, calComPat)),
      runLane('fathom',    !!fathomKey,   LANES.fathom,    c => scanFathom(supabase, workspaceId, c, fathomKey)),
      runLane('instantly', !!instantlyKey, LANES.instantly, c => scanInstantly(supabase, workspaceId, c, instantlyKey)),
      runLane('slack',     !!slackConn,   LANES.slack,     c => scanSlack(supabase, workspaceId, c, slackConn)),
      runLane('linkedin',  !!connections.linkedin?.account_id, LANES.linkedin, c => scanLinkedIn(supabase, workspaceId, c, connections.linkedin.account_id, attendeeMap)),
    ]);
  } finally {
    if (heartbeat) clearInterval(heartbeat);
  }

  if (jobId) {
    const job = enrichmentJobs.get(jobId);
    if (job) job.done = true;
  }
  await persist(true);

  console.log(`[ENRICH] Done: ${totalActivities} activities for ${contacts.length} contacts`);
  return { enriched: contacts.length, activitiesLogged: totalActivities };
}
