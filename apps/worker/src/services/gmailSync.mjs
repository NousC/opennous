// Gmail → the graph, on a schedule. The mailbox counterpart of calendarSync.mjs (GET-234).
//
// Push alone lost mail three different ways in two weeks: a payload-key change dropped every
// delivery (GET-221), a reconnect left an account with no trigger, and a second teammate's
// connect overwrote the first's row so that mailbox's deliveries matched nothing. And push was
// only ever half the conversation — no trigger for sent mail was registered.
//
// So a SCAN is the source of truth, exactly like the calendar:
//   - Every connected Composio mailbox is read through GMAIL_FETCH_EMAILS for the last day,
//     received AND sent (a plain Gmail search covers both), every 30 minutes and at boot.
//   - Each message goes through the same ingestGmail as a webhook, which files it only against
//     people already in the graph and dedups on the message id. A message already filed is
//     skipped before any work is done.
//   - Triggers still deliver; they just get a message in sooner.
//   - Each successful read stamps `last_used_at`, which the nightly `connection_not_syncing`
//     invariant reads.

import { getSupabaseClient } from '@nous/core';
import { ingestGmail } from '../webhooks/handlers/composio.mjs';
import { googleClientFor, hasGoogleTransport, noClientError, nativeConnections } from '../utils/googleClient.mjs';
import { isNativeGoogle } from '../utils/googleNative.mjs';

// Composio caps GMAIL_FETCH_EMAILS at 50 per call, but 50 real messages can exceed its response
// limit: a 60-day read of one mailbox failed with 413 Upstream_PayloadTooLarge (GET-237). 25 per
// page without the raw MIME payload read about 2,000 messages with no 413; messageText still arrives.
// Messages this process already handed to ingestGmail, per connection. A message that matched
// nobody is never filed, so without this every 30-minute scan would read it again — and a team
// send fetches its headers before matching (GET-244), one Composio call each time. Bounded;
// a restart starts clean, which only costs one extra read per message.
const handled = new Map();   // connection id → Set(message id)
const HANDLED_CAP = 5000;
function handledFor(connId) {
  let set = handled.get(connId);
  if (!set) { set = new Set(); handled.set(connId, set); }
  if (set.size > HANDLED_CAP) set.clear();
  return set;
}

const PAGE_SIZE = 25;
const MIN_PAGE_SIZE = 5;
// Pages allowed per scan, from the lookback: a day rarely fills more than a few pages, and a
// 60-day backfill of a busy mailbox needs ~80. Bounded either way.
export const maxPagesFor = (days) => Math.min(200, Math.max(10, Math.ceil(days * 2)));

/** True when Composio refused a page for being too big. */
export function isPayloadTooLarge(err) {
  const blob = `${err?.cause?.status ?? ''} ${err?.cause?.message ?? ''} ${err?.message ?? ''} ${JSON.stringify(err?.cause?.error ?? '')}`;
  return /\b413\b|PayloadTooLarge|too large/i.test(blob);
}

/** A GMAIL_FETCH_EMAILS message → the trigger-shaped `data` ingestGmail reads. */
export function gmailMessageToData(m) {
  const text = m.messageText || m.message_text || m.body_text || m.snippet || m.preview || '';
  const from = m.sender || m.from || '';
  return {
    id:               m.messageId || m.id || m.message_id,
    message_id:       m.message_id || m.messageId || m.id,
    thread_id:        m.threadId || m.thread_id || null,
    subject:          m.subject,
    sender:           from,
    from,
    to:               m.to || m.recipients,
    cc:               m.cc || null,
    labelIds:         m.labelIds || m.label_ids || [],
    message_text:     text,
    body_text:        text,
    messageTimestamp: m.messageTimestamp || m.internalDate || m.date,
  };
}

/** The Gmail message id inside a legacy observation external id `gmail_<messageId>_<contactId>`. */
export function messageIdFromExternalId(externalId) {
  const m = /^gmail_(?!rfc_)([^_]+)_/.exec(String(externalId || ''));
  return m ? m[1] : null;
}

/**
 * The Gmail message ids THIS mailbox already filed. Rows keyed on the RFC Message-ID (GET-244)
 * list every mailbox copy in raw.gmail_copies; older rows carry the id in the external id.
 */
export function filedMessageIds(rows, ownerUserId) {
  const seen = new Set();
  for (const r of rows || []) {
    for (const c of Array.isArray(r.gmail_copies) ? r.gmail_copies : []) {
      if (c?.message_id && (!ownerUserId || c.owner_user_id === ownerUserId)) seen.add(String(c.message_id));
    }
    const legacy = messageIdFromExternalId(r.external_id);
    if (legacy && (!ownerUserId || r.owner_user_id === ownerUserId)) seen.add(legacy);
  }
  return seen;
}

async function alreadyFiled(supabase, workspaceId, sinceIso, ownerUserId) {
  const { data } = await supabase.from('observations')
    .select('external_id, owner_user_id, gmail_copies:raw->gmail_copies')
    .eq('workspace_id', workspaceId).eq('source', 'gmail')
    .gte('observed_at', sinceIso)
    .like('external_id', 'gmail\\_%')
    .limit(2000);
  return filedMessageIds(data, ownerUserId);
}

async function listMessages(composio, conn, { days, query = null }) {
  const items = [];
  let pageToken = null;
  let size = PAGE_SIZE;
  const maxPages = maxPagesFor(days);
  // Native Google (GET-765) keeps the pages it already read when a later page fails, so a long
  // backfill that dies on page 40 still files pages 1-39; the next scan picks up the rest. The
  // Composio path keeps its all-or-nothing behaviour.
  const keepPartial = isNativeGoogle(conn);
  const partial = (why) => {
    console.warn(`[GMAIL] connection=${conn.id} page ${items.length ? 'after ' + items.length + ' messages' : ''} failed, filing what was read: ${why}`);
    items.partialError = why;
    return items;
  };
  for (let page = 0; page < maxPages; ) {
    let res;
    try {
      res = await composio.tools.execute('GMAIL_FETCH_EMAILS', {
        userId: String(conn.owner_user_id ?? ''),
        connectedAccountId: conn.composio_connection_id,
        arguments: {
          query: query ?? `newer_than:${days}d`, max_results: size, include_payload: false,
          ...(pageToken ? { page_token: pageToken } : {}),
        },
      });
    } catch (err) {
      // A page of heavy messages is too big for Composio to return. Ask for the same page in
      // fewer messages rather than failing the whole scan.
      if (isPayloadTooLarge(err) && size > MIN_PAGE_SIZE) { size = Math.max(MIN_PAGE_SIZE, Math.floor(size / 2)); continue; }
      if (keepPartial && page > 0 && err?.code !== 'google_token_revoked') return partial(err.message);
      throw err;
    }
    if (res?.successful === false) {
      const why = String(res?.error || res?.data?.message || 'GMAIL_FETCH_EMAILS rejected').slice(0, 300);
      if (keepPartial && page > 0) return partial(why);
      throw new Error(why);
    }
    const out = res?.data || res?.response_data || {};
    const batch = out.messages || out.items || [];
    if (Array.isArray(batch)) items.push(...batch);
    if (out.unreadable) items.unreadable = (items.unreadable || 0) + out.unreadable;
    pageToken = out.nextPageToken || out.next_page_token || null;
    page++;
    size = PAGE_SIZE;
    if (!pageToken) break;
  }
  if (pageToken) console.warn(`[GMAIL] connection=${conn.id} stopped at ${maxPages} pages for ${days}d — older mail in that window was not read`);
  return items;
}

/** Gmail searches for mail with any of these addresses, in chunks under the query-length limit. */
export function addressQueries(addresses, days, chunk = 20) {
  const clean = [...new Set(addresses.map(a => String(a || '').trim().toLowerCase()).filter(a => a.includes('@')))];
  const out = [];
  for (let i = 0; i < clean.length; i += chunk) {
    const terms = clean.slice(i, i + chunk).flatMap(a => [`from:${a}`, `to:${a}`, `cc:${a}`]);
    out.push(`newer_than:${days}d {${terms.join(' ')}}`);
  }
  return out;
}

// The connection row usually has no address (Composio's account object carries none). Ask Gmail.
async function fillAccountEmail(supabase, composio, conn) {
  if (conn.account_email) return conn.account_email;
  try {
    const res = await composio.tools.execute('GMAIL_GET_PROFILE', {
      userId: String(conn.owner_user_id ?? ''), connectedAccountId: conn.composio_connection_id, arguments: {},
    });
    // The address sits under response_data (verified against production 2026-09-14, GET-237).
    const raw = res?.data?.response_data?.emailAddress || res?.data?.emailAddress || null;
    const email = raw ? String(raw).trim().toLowerCase() : null;
    if (email) {
      await supabase.from('workflow_provider_connections').update({ account_email: email })
        .eq('id', conn.id).is('account_email', null).then(null, () => {});
    }
    return email;
  } catch (e) {
    console.warn(`[GMAIL] connection=${conn.id} profile read failed:`, e.message);
    return null;
  }
}

/**
 * Scan one connected mailbox. `days` > 1 is a history backfill (composioBackfill.mjs); the
 * schedule uses 1. Returns counts; never throws on a single message.
 */
export async function syncGmailConnection(supabase, conn, { days = 1, addresses = null } = {}) {
  // Composio or the install's own Google OAuth app (GET-765): the same reads either way.
  if (!hasGoogleTransport(conn)) return { ok: false, error: 'no composio_connection_id' };
  const composio = await googleClientFor(supabase, conn);
  if (!composio) return { ok: false, error: noClientError(conn) };

  let items;
  // Native Google only (GET-765): what a partly failed read left behind. Composio never sets these.
  let partialError = null;
  let unreadable = 0;
  const note = (list) => {
    if (list.partialError) partialError = list.partialError;
    unreadable += list.unreadable || 0;
    return list;
  };
  try {
    // Never search for the mailbox's own address (GET-557): it is on every message in the mailbox,
    // so one CRM contact who is the person who connected Gmail turned the search back into a
    // download of everything. Found on a workspace whose founder was in their own CRM.
    const searching = Array.isArray(addresses);
    if (addresses?.length) {
      const own = String(await fillAccountEmail(supabase, composio, conn) || conn.account_email || '').toLowerCase();
      addresses = addresses.filter(a => String(a || '').toLowerCase() !== own);
    }
    if (searching) {
      // SEARCH, DON'T DOWNLOAD (GET-557). A backfill only files mail with the people it is
      // backfilling, so it asks Gmail for exactly that — the addresses, OR-batched — instead of
      // pulling every message in the window and throwing most of it away. 90 days of a busy inbox
      // was a quarter of an hour of paging; this is a handful of searches.
      const seen = new Set();
      items = [];
      for (const q of addressQueries(addresses, days)) {
        for (const m of note(await listMessages(composio, conn, { days, query: q }))) {
          const id = String(m.messageId || m.id || m.message_id || '');
          if (id && seen.has(id)) continue;
          if (id) seen.add(id);
          items.push(m);
        }
      }
    } else {
      items = note(await listMessages(composio, conn, { days }));
    }
  } catch (e) {
    console.error(`[GMAIL] connection=${conn.id} list failed:`, e.message);
    return { ok: false, error: e.message };
  }

  const mailbox = await fillAccountEmail(supabase, composio, conn);
  const scanConn = { ...conn, account_email: mailbox || conn.account_email || null };
  const seen = await alreadyFiled(supabase, conn.workspace_id, new Date(Date.now() - (days + 1) * 86_400_000).toISOString(), conn.owner_user_id ?? null);

  const done = handledFor(conn.id);
  const totals = { fetched: items.length, skipped_seen: 0, logged: 0, errors: 0 };
  for (const raw of items) {
    const data = gmailMessageToData(raw);
    if (!data.id) continue;
    if (seen.has(String(data.id)) || done.has(String(data.id))) { totals.skipped_seen++; continue; }
    try {
      totals.logged += await ingestGmail(supabase, scanConn, data, { triggerSlug: 'GMAIL_SCAN' }) || 0;
      done.add(String(data.id));
    } catch (e) {
      totals.errors++;
      console.warn(`[GMAIL] connection=${conn.id} message failed:`, e.message);
    }
  }

  await supabase.from('workflow_provider_connections')
    .update({ last_used_at: new Date().toISOString() }).eq('id', conn.id).then(null, () => {});

  console.log(`[GMAIL] connection=${conn.id} workspace=${conn.workspace_id}: ${totals.fetched} messages, ${totals.logged} filed, ${totals.skipped_seen} already filed, ${totals.errors} errors`);
  if (unreadable) totals.unreadable = unreadable;
  // What was read is filed, but the read did not finish: say failed, so a backfill does not
  // advance its watermark and reads the rest next time (dedup makes the re-read free).
  if (partialError) return { ok: false, error: partialError, partial: true, ...totals };
  return { ok: true, ...totals };
}

export async function syncAllGmail() {
  const supabase = getSupabaseClient();
  const { data: conns, error } = await supabase
    .from('workflow_provider_connections')
    .select('id, workspace_id, owner_user_id, account_email, composio_connection_id, workflow_providers!inner(name)')
    .eq('is_verified', true)
    .eq('managed_by', 'composio')
    .not('composio_connection_id', 'is', null)
    .eq('workflow_providers.name', 'gmail_oauth');
  if (error) { console.error('[GMAIL] connections query failed:', error.message); return; }
  const all = [...(conns || []), ...await nativeConnections(supabase, 'gmail_oauth')];
  for (const conn of all) {
    try { await syncGmailConnection(supabase, conn); }
    catch (e) { console.error(`[GMAIL] connection=${conn.id}:`, e.message); }
  }
}

