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
import { maskEmail } from '../lib/redact.mjs';
import { decrypt as rawDecrypt } from '../utils/encryption.mjs';
import { refreshGoogleToken } from '../utils/googleOAuth.mjs';
import { syncGmailConnection } from './gmailSync.mjs';
import { syncCalendarConnection } from './calendarSync.mjs';
import { isNativeGoogle } from '../utils/googleNative.mjs';
import { nativeConnections } from '../utils/googleClient.mjs';
import { logActivity as coreLogActivity, replySignalToSentiment } from '@nous/core';
import { classifyReplySignal } from '../signals/replySentiment.mjs';
import { extractAfterActivity } from '../signals/index.mjs';
// The Fireflies backfill REPLAYS each recent transcript through the same handler the
// webhook uses, so it gets the full pipeline the raw scan lacked: identity resolution
// (co-attendance + alternate-email learning — this is what links one person's two addresses),
// the stored transcript document, and claim/fact extraction.
import { reprocessFireflies, firefliesBodyFromTranscript, FIREFLIES_TRANSCRIPT_FIELDS } from '../webhooks/handlers/fireflies.mjs';
import { reprocessFathom } from '../webhooks/handlers/fathom.mjs';
import { replayGranolaHistory } from '../pollers/granola.mjs';
import { isSelfHosted } from '../lib/cloud.mjs';

// The worker's decrypt THROWS on a bad/foreign-key credential; the API's crypto.mjs
// (which the enricher used before it moved here) returned null. The credential
// resolution below runs outside any try, so one undecryptable key would kill the
// whole job instead of just disabling that one source. Restore null-on-failure.
function decrypt(value) {
  try { return rawDecrypt(value); } catch { return null; }
}

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
// ── Per-plan history backfill window ──────────────────────────────────────────
//
// When a source connects we pull an account's PAST activity, but only as far back as
// the plan allows: Starter 30 days, Growth 6 months, Enterprise 12 months. KEEP IN SYNC
// with BACKFILL_WINDOW_DAYS in apps/api/src/lib/plans.mjs (the worker can't import the
// API package, same pattern as linkedinEngagement.mjs). null window = unlimited.
// Three months on every plan (GET-514) — see BACKFILL_WINDOW_DAYS in apps/api/src/lib/plans.mjs.
const BACKFILL_WINDOW_DAYS = {
  starter: 90, growth: 90, enterprise: 90,
  free: 90, api: 90, pro: 90, custom: 90, headless: 90, scale: 90, workspace: 90,
};
const DEFAULT_BACKFILL_DAYS = 90;

// Set at the top of each enrichContactHistory run (jobs run one-at-a-time — see the
// `running` guard in contactEnrichmentJobs.mjs — so a module-level value is safe). Any
// activity older than this is dropped before it's written. null = no limit.
let _backfillCutoffMs = null;

// Resolve the workspace's plan and turn it into a cutoff. Fails OPEN (null = no limit) on
// any lookup glitch — a metering hiccup must never silently discard a customer's history.
async function resolveBackfillCutoffMs(supabase, workspaceId, overrideDays = null, ownerUserId = null) {
  if (isSelfHosted()) return null; // own key, own data — no cap
  try {
    const { data: ws } = await supabase
      .from('workspaces').select('team_id, history_backfilled_at').eq('id', workspaceId).maybeSingle();
    if (!ws?.team_id) return null;
    const { data: sub } = await supabase
      .from('subscriptions').select('plan_id, status').eq('team_id', ws.team_id).maybeSingle();
    const dead = sub && (sub.status === 'canceled' || sub.status === 'incomplete_expired' || sub.status === 'past_due');
    const planId = (!sub || dead) ? 'free' : (sub.plan_id || 'free');
    const planDays = BACKFILL_WINDOW_DAYS[planId] ?? DEFAULT_BACKFILL_DAYS;
    // A job can ask for a NARROWER window than the plan allows, never a wider one.
    const days = overrideDays != null ? Math.min(overrideDays, planDays ?? overrideDays) : planDays;
    const windowMs = days ? Date.now() - days * 86_400_000 : null; // null = unlimited plan

    // WATERMARK — once we've backfilled up to a point, don't re-scan older than it. The
    // effective lower bound is the LATER of the plan window and the last backfill, so a
    // re-run only fetches what's new. First-ever backfill has no watermark → full window.
    // The watermark is the WORKSPACE backfill's. A member's first backfill reads their whole
    // window, not only what arrived after the founder's (GET-571).
    const watermarkMs = !ownerUserId && ws.history_backfilled_at ? new Date(ws.history_backfilled_at).getTime() : null;
    if (windowMs == null) return watermarkMs;                 // unlimited plan: bound only by watermark
    if (watermarkMs == null) return windowMs;                 // first backfill: full window
    return Math.max(windowMs, watermarkMs);
  } catch (e) {
    console.error('[BACKFILL_WINDOW] resolve failed — no cutoff applied:', e?.message || e);
    return null;
  }
}

// Should the APP run the one-time history backfill for this workspace?
//
// The API plan is bring-your-own-agent: the user's OWN agent (the plugin) walks their tool
// history and extracts it on their tokens — richer than the server's extractor (full
// transcript, the categorization discipline, per-person attribution). So the app must NOT
// also pull tool history for an 'api' workspace, or the same meetings get extracted twice,
// worse, server-side. The managed 'headless'/custom plans have no agent, so the app IS the
// backfiller for them. This gate is ONLY about the one-time historical pull on connect —
// ONGOING webhook ingestion (claims, insights, identity resolution) still runs for EVERY
// plan. Self-hosted = own key, own data → app backfills. Fails OPEN (true) so a lookup
// glitch never silently skips a paying custom workspace's history.
// How recently an API key must have been used for us to treat the plugin as live here.
// Long enough to cover a weekend and a holiday; short enough that a key someone made once,
// years ago, and abandoned does not silently switch the app's backfill off forever.
const PLUGIN_SEAT_WINDOW_MS = 30 * 24 * 60 * 60_000;

export async function appOwnsHistoryBackfill(supabase, workspaceId) {
  // THE SERVER BACKFILLS EVERY PLAN NOW (GET-514). The plugin's own six-month backfill is retired:
  // one backfill, one estimate, one allowance, the same three windows for API and Workspace. The
  // reasoning below — the agent owns history on the API plan or when a plugin seat is live — is
  // kept for the record and no longer applies.
  if (process.env.APP_BACKFILL_DEFERS_TO_PLUGIN !== 'true') return true;
  if (isSelfHosted()) return true;
  try {
    const { data: ws } = await supabase.from('workspaces').select('team_id').eq('id', workspaceId).maybeSingle();
    if (!ws?.team_id) return true;
    const { data: sub } = await supabase.from('subscriptions').select('plan_id, status').eq('team_id', ws.team_id).maybeSingle();
    const dead = sub && (sub.status === 'canceled' || sub.status === 'incomplete_expired' || sub.status === 'past_due');
    const planId = (!sub || dead) ? 'free' : (sub.plan_id || 'free');
    if (planId === 'api') return false;   // API plan → the agent backfills; the app does not

    // The plan is the wrong axis on its own.
    //
    // A CUSTOM-plan workspace that also runs the revenue plugin used to get BOTH backfills:
    // this server-side pull AND the plugin's /opennous:backfill over the same tools and the
    // same window. Double extraction, double credit burn, and the server extractor is the
    // weaker of the two (no full transcript, no per-person attribution). The plan never said
    // anything about it because a plugin seat is not a plan, it is a choice a user makes.
    //
    // So ask the real question — is a plugin seat live on this workspace — and the signal
    // already exists. An API key is only ever the programmatic surface: the app itself
    // authenticates with Clerk, never with one of these. A key used recently means someone is
    // driving this graph from their own machine, and the richer agent should own the history.
    //
    // Ongoing webhook ingestion is untouched either way; this decides ONLY the one-time
    // historical pull.
    const { data: keys } = await supabase
      .from('api_keys')
      .select('last_used_at')
      .eq('workspace_id', workspaceId)
      .is('revoked_at', null)
      .not('last_used_at', 'is', null)
      .order('last_used_at', { ascending: false })
      .limit(1);
    const lastUsed = keys?.[0]?.last_used_at ? new Date(keys[0].last_used_at).getTime() : 0;
    if (lastUsed && Date.now() - lastUsed < PLUGIN_SEAT_WINDOW_MS) {
      console.log(`[BACKFILL_SKIP] ws=${workspaceId} a plugin seat is live (key used ${new Date(lastUsed).toISOString().slice(0, 10)}) — the agent owns history, skipping the in-app pull`);
      return false;
    }

    return true;
  } catch {
    // Fails OPEN. A lookup glitch must never silently skip a paying workspace's history.
    return true;
  }
}

// True when an activity's timestamp is older than the current job's backfill window and
// should be skipped. `now` activities (no occurredAt) are never dropped.
function _beforeBackfillCutoff(occurredAt) {
  if (_backfillCutoffMs == null || !occurredAt) return false;
  const t = new Date(occurredAt).getTime();
  return Number.isFinite(t) && t < _backfillCutoffMs;
}

async function logActivity(supabase, params) {
  // Universal per-plan backstop: every provider that funnels through this wrapper (Gmail,
  // Calendar, IMAP, LinkedIn, Slack, Calendly, Cal.com, Instantly thin rows) is gated here,
  // regardless of whether its fetch honored a server-side date filter.
  if (_beforeBackfillCutoff(params?.occurredAt)) return false;
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

/**
 * The backfill's Gmail read for a Composio mailbox (GET-552): the scheduled scan over the run's
 * window. It files mail against everyone already in the graph rather than a contact list, so the
 * count comes back unattributed. Throws when the read fails, so the lane says failed.
 */
async function scanGmailComposio(supabase, gmailConn, contacts = []) {
  const days = _backfillCutoffMs ? Math.max(1, Math.ceil((Date.now() - _backfillCutoffMs) / 86_400_000)) : 90;
  // Only the people being backfilled (GET-557). With nobody to look for there is nothing to file.
  const addresses = contacts.map(c => c.email).filter(Boolean);
  if (!addresses.length) { const none = new Map(); none.unattributed = 0; return none; }
  const r = await syncGmailConnection(supabase, gmailConn, { days, addresses });
  if (!r?.ok) throw new Error(`composio gmail read failed: ${r?.error || 'unknown'}`);
  console.log(`[ENRICH_GMAIL_COMPOSIO] connection=${gmailConn.id} ${days}d: ${r.fetched} messages, ${r.logged} filed`);
  const counts = new Map();
  counts.unattributed = r.logged || 0;
  return counts;
}

async function scanGmailBulk(supabase, workspaceId, contacts, gmailConn) {
  // A COMPOSIO MAILBOX HAS NO TOKEN OF OURS (GET-552). Gmail connects through Composio now, and
  // Composio holds the Google grant — so the refresh below found no refresh_token, called the
  // connection revoked, flagged it for re-auth and read nothing. Every new customer's Gmail
  // history was skipped this way. Read it the way the 30-minute scan does instead: the same
  // mailbox read, over the backfill's window, filed through the same ingestGmail.
  if (gmailConn.managed_by === 'composio') return scanGmailComposio(supabase, gmailConn, contacts);
  // A mailbox connected with the install's own Google OAuth app (GET-765, self-host) takes the
  // same read: the mailbox scan files through ingestGmail, so history lands exactly as live mail.
  if (isNativeGoogle(gmailConn)) return scanGmailComposio(supabase, gmailConn, contacts);

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
      // Per-plan backfill window: Gmail's `after:` takes a Unix-seconds bound, so we skip
      // fetching anything older than the plan allows (the logActivity backstop still catches
      // any stragglers). Older-than-window messages never leave Google.
      let q = group.join(' OR ');
      if (_backfillCutoffMs != null) q = `(${q}) after:${Math.floor(_backfillCutoffMs / 1000)}`;
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

      // ACTION BACKFILL — the operator's own SENT messages become `email_sent`
      // actions. The thread-level row above logs email_opened/reply and loses
      // direction, so the operator's Sent history never landed as an action (why a
      // live workspace had almost no email_sent). Per-message, and the dedup key matches
      // the live Gmail poller (gmail_<msgId>_<contactId>) so backfill and poller
      // share the (workspace, source, external_id) index and never double-count.
      for (const m of msgs) {
        if (!m.labelIds?.includes('SENT')) continue;
        const mh = m.payload?.headers || [];
        const recips = [];
        for (const h of mh) if (h.name === 'To' || h.name === 'Cc') for (const a of extractEmails(h.value)) recips.push(a.toLowerCase());
        const involved = [...new Map(recips.map(a => emailToContact.get(a)).filter(Boolean).map(c => [c.id, c])).values()];
        if (!involved.length) continue;
        const dh = mh.find(h => h.name === 'Date')?.value;
        const at = dh ? new Date(dh).toISOString() : occurredAt;
        const subj = mh.find(h => h.name === 'Subject')?.value || subject;
        for (const c of involved) {
          const r = await logActivity(supabase, {
            workspaceId, contactId: c.id, companyId: c.company_id || null,
            type: 'email_sent', source: 'gmail', externalId: `gmail_${m.id}_${c.id}`,
            occurredAt: at, description: subj, summary: m.snippet ? m.snippet.slice(0, 200) : null,
          });
          if (r) counts.set(c.id, (counts.get(c.id) || 0) + 1);
        }
      }
    });

    const total = [...counts.values()].reduce((a, b) => a + b, 0);
    console.log(`[ENRICH_GMAIL_BULK] ${withEmail.length} contacts, ${threadIds.size} threads, ${total} logged`);
  } catch (e) {
    if (e?.code === 'google_token_revoked') {
      await supabase.from('workflow_provider_connections').update({ is_verified: false }).eq('id', gmailConn.id);
      console.warn(`[ENRICH_GMAIL_BULK] connection=${gmailConn.id} revoked — flagged for re-auth`);
    }
    // A source that failed is not a source that found nothing: the lane says failed (GET-552).
    throw e;
  }
  return counts;
}

// ── Google Calendar (bulk) ─────────────────────────────────────────────────────
//
// Google Calendar has ONE integration: Composio. This used to read the calendar through the
// native Gmail OAuth grant's calendar scope — an OAuth app retired in the Composio cutover, whose
// token refresh now fails `invalid_client`, so it had not read a single event since (GET-221).
// History now comes from the same reconcile the 30-minute scan runs, over a 180-day lookback, on
// every Composio calendar connected in the workspace. Runs before Fireflies: calendar bookings
// feed its co-attendance matching.
const GCAL_LOOKBACK_DAYS = 180;

// WHOSE CONNECTIONS A RUN READS (GET-571). A member's backfill reads only what that member
// connected. The workspace backfill (the founder's) reads the workspace's connections except the
// ones invited members made — theirs are read by their own backfill, on their own confirm. Before
// this, connections were keyed by provider name, so a second person's Gmail silently replaced the
// first's.
let _ownerUserId = null;
let _memberIds = new Set();
async function loadMemberIds(supabase, workspaceId) {
  const { data: ws } = await supabase.from('workspaces').select('team_id').eq('id', workspaceId).maybeSingle();
  if (!ws?.team_id) return new Set();
  const { data } = await supabase.from('team_members').select('user_id, role').eq('team_id', ws.team_id);
  return new Set((data ?? []).filter(m => !['founder', 'owner'].includes(m.role)).map(m => m.user_id));
}
function connectionInScope(conn) {
  if (_ownerUserId) return conn.owner_user_id === _ownerUserId;
  return !conn.owner_user_id || !_memberIds.has(conn.owner_user_id);
}

async function calendarConnections(supabase, workspaceId) {
  const { data } = await supabase
    .from('workflow_provider_connections')
    .select('id, workspace_id, owner_user_id, account_email, composio_connection_id, workflow_providers!inner(name)')
    .eq('workspace_id', workspaceId).eq('is_verified', true)
    .eq('managed_by', 'composio').not('composio_connection_id', 'is', null)
    .eq('workflow_providers.name', 'google_calendar');
  // Calendars connected with the install's own Google OAuth app (GET-765) reconcile the same way.
  const native = await nativeConnections(supabase, 'google_calendar', { workspaceId });
  return [...(data || []), ...native].filter(connectionInScope);
}

async function scanGoogleCalendarBulk(supabase, workspaceId, calendarConns) {
  // The reconcile logs per person itself; the enrichment job's per-contact tally stays empty.
  for (const conn of calendarConns) {
    const r = await syncCalendarConnection(supabase, conn, { lookbackDays: GCAL_LOOKBACK_DAYS });
    console.log(`[ENRICH_GOOGLE_CALENDAR_BULK] connection=${conn.id} ok=${r.ok} logged=${r.logged ?? 0}${r.error ? ` err=${r.error}` : ''}`);
  }
  return new Map();
}

// ── Connection loader ─────────────────────────────────────────────────────────

async function getWorkspaceConnections(supabase, workspaceId) {
  const { data: conns } = await supabase
    .from('workflow_provider_connections')
    .select('id, workspace_id, owner_user_id, account_email, managed_by, composio_connection_id, encrypted_credentials, workflow_providers!inner(name)')
    .eq('workspace_id', workspaceId)
    .eq('is_verified', true);

  const map = {};
  for (const conn of (conns || []).filter(connectionInScope)) {
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
  // Composio mailboxes are read in bulk (scanGmailComposio); there is no token here to refresh.
  if (gmailConn?.managed_by === 'composio' || isNativeGoogle(gmailConn)) return 0;
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

    console.log(`[ENRICH_GMAIL] ${maskEmail(contact.email)}: ${logged} logged`);
    return logged;
  } catch (e) {
    // Revoked/expired grant — flag the connection so the UI shows "Needs auth"
    // and the user reconnects, instead of failing silently on every enrichment.
    if (e?.code === 'google_token_revoked') {
      await supabase.from('workflow_provider_connections')
        .update({ is_verified: false }).eq('id', gmailConn.id);
      console.warn(`[ENRICH_GMAIL] connection=${gmailConn.id} revoked — flagged for re-auth`);
    }
    console.error(`[ENRICH_GMAIL] ${maskEmail(contact.email)}:`, e.message);
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
    console.log(`[ENRICH_IMAP] ${maskEmail(contact.email)}: ${logged} logged`);
    return logged;
  } catch (e) {
    console.error(`[ENRICH_IMAP] ${maskEmail(contact.email)}:`, e.message);
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
        // The full text, so extraction and any later re-read see all of it — the
        // summary below is the 200-character timeline line.
        rawData:     { is_outbound: !!msg.is_sender, text: msg.text },
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

// Fetch the lead's most-recent inbound reply from Instantly's emails API so a
// backfilled reply carries the same richness as a live webhook: subject, the
// actual reply text, campaign_id, step, and the interest disposition. Only called
// when /leads/list says a reply exists — the emails endpoint is rate-limited to
// 20/min, and repliers are a minority. Returns the mapped reply, or null on any
// failure (caller falls back to the thin row).
async function fetchInstantlyReply(apiKey, email) {
  const url = `https://api.instantly.ai/api/v2/emails?email_type=received&lead=${encodeURIComponent(email)}&limit=5`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' } });
  if (!res.ok) return null;
  const data = await res.json();
  const items = data?.items || (Array.isArray(data) ? data : []);
  if (!items.length) return null;
  // The reply we want to show is the newest genuine inbound — prefer a real reply
  // over an out-of-office auto-reply when both exist.
  const nonAuto = items.filter(e => e.is_auto_reply !== 1);
  const pool = nonAuto.length ? nonAuto : items;
  const e = pool.reduce((a, b) =>
    new Date(b.timestamp_email || 0) > new Date(a.timestamp_email || 0) ? b : a);
  return {
    subject:     e.subject || null,
    text:        e.body?.text || e.content_preview || null,
    campaignId:  e.campaign_id || null,
    step:        e.step ?? null,
    variant:     e.variant ?? e.v ?? null,
    iStatus:     typeof e.i_status === 'number' ? e.i_status : null,
    isAutoReply: e.is_auto_reply === 1,
    occurredAt:  e.timestamp_email || null,
  };
}

// Instantly's numeric interest status → our canonical reply signal. Positive
// codes (interested / meeting booked / completed / won) → positive; negative
// codes (not interested / wrong person / lost) → negative. 0/null is ambiguous,
// so we defer to the body classifier. Auto-replies short-circuit.
function instantlyReplySignal({ iStatus, isAutoReply }) {
  if (isAutoReply) return 'auto_reply';
  if (iStatus == null || iStatus === 0) return null;
  return iStatus > 0 ? 'positive' : 'negative';
}

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
      // Pull the actual reply so the row renders like an email with its campaign
      // and variant — the unit feedback loops read. Falls back to the thin row if
      // the emails API is unavailable, so we never regress to logging nothing.
      let reply = null;
      try { reply = await fetchInstantlyReply(apiKey, contact.email); } catch { /* fall back */ }

      if (reply) {
        let signal = instantlyReplySignal(reply);
        if (!signal && reply.text) {
          try { signal = await classifyReplySignal(reply.text, supabase, workspaceId); } catch { /* leave null */ }
        }
        const rawData = {
          event_type:  'reply_received',
          campaign_id: reply.campaignId,
          campaign_name: lead.campaign_name || null,
          step:        reply.step,
          variant:     reply.variant,
          subject:     reply.subject,
          source_path: 'history_enricher',
          ...(signal ? { provider_signal: signal, reply_signal: signal, sentiment: replySignalToSentiment(signal) } : {}),
        };
        // Per-plan backfill window: this path writes observations directly (not through
        // logActivity), so gate it here too.
        const instantlyOccurredAt = reply.occurredAt || (lead.timestamp_last_reply ? new Date(lead.timestamp_last_reply).toISOString() : null);
        if (_beforeBackfillCutoff(instantlyOccurredAt)) return logged;
        // Upsert (not insert) keyed on the stable external_id so a re-scan
        // ENRICHES the earlier thin row in place rather than dedup-skipping it.
        // owner_user_id is deliberately omitted so we never overwrite an existing
        // row's ownership (the privacy/redaction model keys off it).
        await supabase.from('entities').upsert(
          { id: contact.id, workspace_id: workspaceId, type: 'person', status: 'active' },
          { onConflict: 'id', ignoreDuplicates: true },
        );
        const { data: up, error } = await supabase.from('observations').upsert({
          workspace_id: workspaceId,
          entity_id:    contact.id,
          kind:         'event',
          property:     'interaction.email_received',
          value:        { description: reply.subject || 'Replied to cold email sequence', summary: reply.text || null },
          source:       'instantly',
          method:       'connector',
          observed_at:  instantlyOccurredAt,
          external_id:  `instantly_reply_${contact.email}`,
          raw:          rawData,
        }, { onConflict: 'workspace_id,source,external_id', ignoreDuplicates: false }).select('id').maybeSingle();
        if (!error) {
          logged++;
          // Mine Intel from the reply body — facts into categories, graph edges,
          // action items — the same pipeline the live webhook runs via logActivity.
          // Best-effort; never blocks the backfill.
          if (up?.id && reply.text) {
            extractAfterActivity(supabase, { id: up.id }, {
              contactId: contact.id, workspaceId, type: 'email_received', source: 'instantly',
              summary: reply.text, isOutbound: false,
              occurredAt: reply.occurredAt || new Date(lead.timestamp_last_reply).toISOString(),
            }).catch(() => {});
          }
        } else console.error(`[ENRICH_INSTANTLY] upsert ${contact.email}:`, error.message);
      } else {
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

    console.log(`[ENRICH_INSTANTLY] ${maskEmail(contact.email)}: ${logged} logged`);
    return logged;
  } catch (e) {
    console.error(`[ENRICH_INSTANTLY] ${maskEmail(contact.email)}:`, e.message);
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

    console.log(`[ENRICH_SLACK] ${maskEmail(contact.email)}: ${logged} logged`);
    return logged;
  } catch (e) {
    console.error(`[ENRICH_SLACK] ${maskEmail(contact.email)}:`, e.message);
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
    console.log(`[ENRICH_FIREFLIES] ${maskEmail(contact.email)}: ${logged} logged`);
    return logged;
  } catch (e) {
    console.error(`[ENRICH_FIREFLIES] ${maskEmail(contact.email)}:`, e.message);
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

// Fireflies backfill via REPLAY, but RATE-LIMIT SAFE. We run each transcript through
// reprocessFireflies (the same handler the live webhook uses — full identity resolution,
// saved document, claim extraction), but we HYDRATE the body from a single paginated
// list query up front. The earlier version fetched the id list AND then re-fetched every
// transcript one-by-one inside reprocessFireflies (~2 calls × N), which blew straight
// through Fireflies' request quota and returned 429s for everything. Passing a body that
// already carries participants makes reprocessFireflies skip its own fetch entirely, so
// the whole batch costs ~3 API calls instead of ~200. externalId dedup keeps re-imports
// free.
// The whole backfill window, not the 150 newest (GET-788): the pre-check counts every transcript
// in the window, and a meeting past the 150th never met its people. Pages run newest first and
// stop at the first page that reaches back past the window; 40 pages is the counter's own cap.
const FIREFLIES_REPLAY_PAGES = 40;

async function scanFirefliesReplay(supabase, workspaceId, apiKey) {
  const transcripts = [];
  try {
    for (let page = 0; page < FIREFLIES_REPLAY_PAGES; page++) {
      const query = `query { transcripts(limit: ${FIREFLIES_PAGE_SIZE}, skip: ${page * FIREFLIES_PAGE_SIZE}) {
        ${FIREFLIES_TRANSCRIPT_FIELDS}
      } }`;
      const res = await fetchRetry('https://api.fireflies.ai/graphql', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ query }),
      });
      if (!res.ok) { console.warn(`[ENRICH_FIREFLIES_REPLAY] list ${res.status}`); break; }
      const data = await res.json();
      if (data.errors?.length && !data.data?.transcripts) {
        console.warn('[ENRICH_FIREFLIES_REPLAY] api:', JSON.stringify(data.errors).slice(0, 160));
        break;
      }
      const ts = data.data?.transcripts || [];
      if (!ts.length) break;
      transcripts.push(...ts);
      if (ts.length < FIREFLIES_PAGE_SIZE) break;
      if (_beforeBackfillCutoff(ts[ts.length - 1]?.date)) break;
    }

    let touched = 0;
    // Hydrated body → reprocessFireflies skips its per-transcript fetch. Extraction still
    // runs (LLM), but only for transcripts that resolve to a contact we hold.
    await pool(transcripts, 3, async (t) => {
      try {
        // Per-plan backfill window. Fireflies replays through reprocessFireflies (the live
        // webhook path, which does NOT gate), so drop old meetings here at the scan.
        if (_beforeBackfillCutoff(t.date)) return;
        const body = firefliesBodyFromTranscript(t);
        const r = await reprocessFireflies(supabase, workspaceId, body, { onceOnly: true });
        if (r?.logged) touched += r.logged;
      } catch (e) { console.warn('[ENRICH_FIREFLIES_REPLAY]', t.id, e?.message || e); }
    });
    console.log(`[ENRICH_FIREFLIES_REPLAY] ${transcripts.length} transcripts (hydrated, one API call per 50), ${touched} contact-meetings logged`);
    return touched;
  } catch (e) {
    console.error('[ENRICH_FIREFLIES_REPLAY]', e.message);
    return 0;
  }
}

// ── Fathom ────────────────────────────────────────────────────────────────────

// Fathom — the REPLAY path, mirroring Fireflies. We fetch every meeting once WITH its
// transcript (`include_transcript=true`) and hand each one to reprocessFathom, the same
// pipeline the live webhook uses: email + speaker-name identity resolution, create the
// contact when a meeting has no match, save the transcript document, and run ONE fact
// extraction over the room → note.* facts → intent. (Fathom's API is quirky: auth is the
// `X-Api-Key` header, the list is `{ items: [...] }` cursor-paginated, and the
// `participant_email` filter is IGNORED — so a per-contact query can't work; we page the
// whole set. reprocessFathom resolves contacts itself, so — like Fireflies — there's no
// per-contact count to attribute up front; we return the total contact-meetings logged.)
async function scanFathomReplay(supabase, workspaceId, apiKey) {
  if (!apiKey) return 0;
  try {
    const meetings = [];
    let cursor = null, pages = 0;
    do {
      // limit=10 with transcripts keeps each page's payload manageable (~450 segments/meeting).
      const url = `https://api.fathom.ai/external/v1/meetings?limit=10&include_transcript=true${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const res = await fetchRetry(url, { headers: { 'X-Api-Key': apiKey } });
      if (!res.ok) { if (pages === 0) console.warn(`[ENRICH_FATHOM_REPLAY] list failed ${res.status}`); break; }
      const data = await res.json();
      const pageItems = data.items || [];
      meetings.push(...pageItems);
      cursor = data.next_cursor || null;
      // Per-plan backfill window. Fathom is newest-first, so once a whole page is older
      // than the cutoff, stop paging — the rest is all older. (Each meeting is also
      // filtered below, so this only bounds fetch cost.)
      if (_backfillCutoffMs != null && pageItems.length
          && pageItems.every(x => _beforeBackfillCutoff(x?.recording_start_time || x?.scheduled_start_time))) {
        break;
      }
    } while (cursor && ++pages < 60);

    let touched = 0;
    // Serial: each reprocessFathom kicks off an LLM extraction, so we don't want 200
    // meetings firing extractions at once. Extraction is fire-and-forget inside it.
    for (const m of meetings) {
      try {
        // Per-plan backfill window. Fathom replays through reprocessFathom (the live
        // webhook path, which does NOT gate), so drop old meetings here.
        if (_beforeBackfillCutoff(m?.recording_start_time || m?.scheduled_start_time)) continue;
        const r = await reprocessFathom(supabase, workspaceId, m, { onceOnly: true });
        if (r?.logged) touched += r.logged;
      } catch (e) { console.warn('[ENRICH_FATHOM_REPLAY]', m?.recording_id, e?.message || e); }
    }
    console.log(`[ENRICH_FATHOM_REPLAY] ${meetings.length} meetings, ${touched} contact-meetings logged`);
    return touched;
  } catch (e) {
    console.error('[ENRICH_FATHOM_REPLAY]', e?.message || e);
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
    console.log(`[ENRICH_CALENDLY] ${maskEmail(contact.email)}: ${logged} logged`);
    return logged;
  } catch (e) {
    console.error(`[ENRICH_CALENDLY] ${maskEmail(contact.email)}:`, e.message);
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
    console.log(`[ENRICH_CAL_COM] ${maskEmail(contact.email)}: ${logged} logged`);
    return logged;
  } catch (e) {
    console.error(`[ENRICH_CAL_COM] ${maskEmail(contact.email)}:`, e.message);
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
    // `state` also carries what the API wrote there — the estimate and when the customer started
    // the backfill (GET-515), which the billing page reads. Read once per job and kept, so the
    // progress writes add the contacts beside them instead of replacing them.
    if (job._stateMeta === undefined) {
      const { data } = await supabase.from('contact_enrichment_jobs').select('state').eq('job_id', jobId).maybeSingle();
      const { contacts: _drop, ...meta } = data?.state ?? {};
      job._stateMeta = meta;
    }
    await supabase.from('contact_enrichment_jobs')
      .update({ state: { ...job._stateMeta, contacts: job.contacts }, done: done || job.done, updated_at: new Date().toISOString() })
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
export async function enrichContactHistory(supabase, workspaceId, input, jobId = null, opts = {}) {
  // `allowEmpty` is a DISCOVERY run: no accounts to enrich, but a notetaker is connected and
  // its replay creates the accounts from the meetings themselves. See historyBackfill.mjs —
  // without this, connecting Fireflies to an empty workspace did nothing, silently.
  const allowEmpty = opts.allowEmpty === true;
  if (!input?.length && !allowEmpty) return { enriched: 0, activitiesLogged: 0 };

  // API plan → the user's own agent backfills history (richer, on their tokens). The app
  // must not also pull it. Ongoing webhooks still ingest for every plan; this is only the
  // one-time historical pull.
  if (!(await appOwnsHistoryBackfill(supabase, workspaceId))) {
    console.log(`[BACKFILL_SKIP] ws=${workspaceId} on the API plan — history backfill is the agent's job, skipping in-app pull`);
    return { enriched: 0, activitiesLogged: 0, skipped: 'api_agent_backfill' };
  }

  // opts.windowDays  — override the plan's default backfill window (a deep-backfill job
  //                    passes the full plan window; an incremental job passes ~30).
  // opts.creditGuard — async (phase) => throws CreditsExhausted when the API-plan wallet
  //                    hits the floor, so a long run stops between source phases instead of
  //                    spending into the red. A no-op on non-wallet plans.
  const { windowDays = null, creditGuard = null, ownerUserId = null } = opts;
  _ownerUserId = ownerUserId;
  _memberIds = ownerUserId ? new Set() : await loadMemberIds(supabase, workspaceId).catch(() => new Set());
  const guard = creditGuard ? (phase) => creditGuard(phase) : async () => {};

  // Resolve this workspace's plan → history backfill cutoff for the whole run. Every
  // provider below gates against it (server-side date filters where the API supports one,
  // the logActivity backstop everywhere else). Jobs run one-at-a-time, so this module-level
  // value is safe for the duration of the run.
  _backfillCutoffMs = await resolveBackfillCutoffMs(supabase, workspaceId, windowDays, ownerUserId);
  if (_backfillCutoffMs != null) {
    console.log(`[BACKFILL_WINDOW] ws=${workspaceId} cutoff=${new Date(_backfillCutoffMs).toISOString().slice(0, 10)}`);
  }

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

  // GATE (2026-08-19): only backfill REAL contacts — people that exist in the `contacts`
  // table. Cold lead-list imports (Sales Nav / Lookalike / engager scrapes — thousands of
  // entities) must NOT be swept through LinkedIn: scanning people you've never messaged is
  // pointless, hammers the LinkedIn account, and floods the log. So we keep only ids that are
  // real contacts and skip the rest. (A lead earns a scan once it's promoted to a contact.)
  if (contacts.length) {
    const ids = contacts.map(c => c.id);
    const real = new Set();
    for (let i = 0; i < ids.length; i += 1000) {
      const { data: realRows } = await supabase
        .from('contacts').select('id')
        .eq('workspace_id', workspaceId).in('id', ids.slice(i, i + 1000));
      (realRows || []).forEach(r => real.add(r.id));
    }
    const before = contacts.length;
    contacts = contacts.filter(c => real.has(c.id));
    if (contacts.length < before) {
      console.log(`[ENRICH_GATE] ws=${workspaceId} skipped ${before - contacts.length} lead-list (non-contact) rows; scanning ${contacts.length} real contacts`);
    }
  }

  console.log(`[ENRICH] Starting: ${contacts.length} contacts in ${workspaceId}${allowEmpty && !contacts.length ? ' (discovery run — the notetaker replay creates them)' : ''}`);
  if (!contacts.length && !allowEmpty) return { enriched: 0, activitiesLogged: 0 };

  const connections = await getWorkspaceConnections(supabase, workspaceId);

  // Resolve credentials once
  const gmailConn      = connections.gmail_oauth || null;
  const calendarConns  = await calendarConnections(supabase, workspaceId);
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
          gmail:           makeSource(!!gmailConn),
          google_calendar: makeSource(calendarConns.length > 0),
          smtp:      makeSource(!!smtpConn),
          linkedin:  makeSource(!!connections.linkedin?.account_id),
          instantly: makeSource(!!instantlyKey),
          slack:     makeSource(!!slackConn),
          fireflies: makeSource(!!firefliesKey),
          fathom:    makeSource(!!fathomKey),
          granola:   makeSource(!!connections.granola),
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
  // Sources whose read threw (GET-552). A run with one is not a complete backfill, and the job
  // must not stamp the watermark as if it were — see contactEnrichmentJobs.mjs.
  const failedSources = new Set();
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
      let failed = false;
      try { counts = await fn(); } catch (e) { failed = true; failedSources.add(source); console.error(`[ENRICH_${source.toUpperCase()}_BULK]`, e?.message || e); }
      for (const c of contacts) {
        const n = counts.get(c.id) || 0;
        setSource(c.id, source, failed ? 'failed' : 'done', n);
        totalActivities += n;
      }
      totalActivities += counts.unattributed || 0;
    };

    // One per-contact lane runner, declared here because outbound (below) is its first
    // caller. Each source gets its own concurrency lane; the lanes further down run together.
    // (Calendly/Cal.com only accept a single email per call, so they can't be bulked;
    // LinkedIn/Unipile is per-attendee and rate-limited — smallest lane + fetchRetry backoff.)
    const runLane = async (source, enabled, laneSize, scan) => {
      if (!enabled) return;
      await pool(contacts, laneSize, async (contact) => {
        setSource(contact.id, source, 'scanning');
        let n = 0;
        let failed = false;
        try { n = await scan(contact); } catch (e) { failed = true; failedSources.add(source); console.error(`[ENRICH_${source.toUpperCase()}]`, e?.message || e); }
        setSource(contact.id, source, failed ? 'failed' : 'done', n);
        logScanEvent(contact, source, n);
        totalActivities += n;
      });
    };

    // ── The order of the tiers below is identity, not tidiness ───────────────
    //
    // Each tier teaches the next one who people are, so they run oldest-authority first:
    //
    //   1. CRM        the source of truth for who exists. Imported BEFORE this job was even
    //                 enqueued (lib/connectIngest.mjs awaits it), so the graph is seeded.
    //   2. outbound   who we have been contacting.
    //   3. mail +     threads and bookings attached to those people; also surfaces the
    //      calendar   alternate addresses the last tier matches on.
    //   4. meetings   the notetaker replay, LAST — it resolves a ROOM to people and CREATES
    //                 anyone it cannot match, so running it earlier invents duplicates of
    //                 contacts the tiers above were about to establish properly.
    //
    // A tier with nothing connected is skipped, never waited on.
    await runLane('instantly', !!instantlyKey, LANES.instantly,
      c => scanInstantly(supabase, workspaceId, c, instantlyKey));
    await guard('outbound');

    await runBulk('gmail', !!gmailConn, () => scanGmailBulk(supabase, workspaceId, contacts, gmailConn));
    await runBulk('smtp',  !!smtpConn,  () => scanImapBulk(supabase, workspaceId, contacts, smtpConn));
    // Calendar before Fireflies: its bookings feed Fireflies co-attendance matching.
    await runBulk('google_calendar', calendarConns.length > 0, () => scanGoogleCalendarBulk(supabase, workspaceId, calendarConns));
    // Fathom runs the REPLAY path too (transcript fetch + identity resolution +
    // create-missing + transcript docs + claim extraction → intent), not a bulk map —
    // reprocessFathom resolves contacts itself, so there's no per-contact count up front.
    await guard('gmail_smtp_calendar');

    if (fathomKey) {
      for (const c of contacts) setSource(c.id, 'fathom', 'scanning');
      await persist();
      const touched = await scanFathomReplay(supabase, workspaceId, fathomKey);
      for (const c of contacts) setSource(c.id, 'fathom', 'done', 0);
      totalActivities += touched;
      await persist();
    }

    // Fireflies runs the REPLAY path (identity resolution + transcript docs + claim
    // extraction), not the bulk map. It resolves meetings to contacts itself (incl.
    // alternate emails via co-attendance), so we can't attribute a per-contact count
    // up front — mark the source done and fold the total into the tally.
    await guard('fathom');
    if (firefliesKey) {
      for (const c of contacts) setSource(c.id, 'fireflies', 'scanning');
      await persist();
      const touched = await scanFirefliesReplay(supabase, workspaceId, firefliesKey);
      for (const c of contacts) setSource(c.id, 'fireflies', 'done', 0);
      totalActivities += touched;
      await persist();
    }

    // ── Bridge email → linkedin_url BEFORE the LinkedIn lane ──────────────────
    // LinkedIn history is keyed by profile URL / member id (LinkedIn never exposes
    // an email), so an email-only contact matches NOTHING on LinkedIn. For those,
    // run data-enrichment (Prospeo/Apollo) to DISCOVER their linkedin_url — it's a
    // real /in/<slug>, persisted on the contact (and attached as an identifier by the
    // view trigger, which also links future LinkedIn messages to this person). We then
    // feed the discovered URL into the LinkedIn scan below. Gated on LinkedIn actually
    // being connected (no point paying for a lookup otherwise) and capped so a huge
    // import can't run away on credits. Best-effort — never fails the job.
    // Granola's history (GET-854): every note inside the window, through the same handler as the
    // live poll, which resolves the room and creates the people it does not know. Granola keys are
    // personal, so every connection in the workspace is read.
    await guard('fireflies');
    if (connections.granola) {
      for (const c of contacts) setSource(c.id, 'granola', 'scanning');
      await persist();
      const sinceIso = new Date(Date.now() - (windowDays ?? 90) * 86400000).toISOString();
      const touched = await replayGranolaHistory(supabase, workspaceId, { sinceIso, guard });
      for (const c of contacts) setSource(c.id, 'granola', 'done', 0);
      totalActivities += touched;
      await persist();
    }

    await guard('granola');
    if (connections.linkedin?.account_id) {
      const needUrl = contacts.filter(c => c.email && !c.linkedin_url && !c.linkedin_member_id);
      const RESOLVE_CAP = 250;
      const toResolve = needUrl.slice(0, RESOLVE_CAP);
      if (needUrl.length > RESOLVE_CAP) {
        console.log(`[ENRICH_LI_RESOLVE] ${needUrl.length} email-only contacts; capping linkedin_url discovery at ${RESOLVE_CAP}`);
      }
      if (toResolve.length) {
        let resolved = 0;
        for (const c of toResolve) setSource(c.id, 'linkedin', 'scanning');
        await persist();
        try {
          const { enrichContact } = await import('../utils/enrichContact.mjs');
          await pool(toResolve, LANES.linkedin, async (contact) => {
            try {
              await enrichContact(supabase, {
                id: contact.id, workspace_id: workspaceId, email: contact.email,
                first_name: contact.first_name, last_name: contact.last_name,
                company: contact.company, company_id: contact.company_id,
                domain: (contact.email.split('@')[1] || null),
              });
              // enrichContact persists linkedin_url on the contacts row — read it back
              // so scanLinkedIn (which reads contact.linkedin_url in-memory) can match.
              const { data } = await supabase.from('contacts')
                .select('linkedin_url, linkedin_member_id').eq('id', contact.id).maybeSingle();
              if (data?.linkedin_url) { contact.linkedin_url = data.linkedin_url; resolved++; }
              if (data?.linkedin_member_id) contact.linkedin_member_id = data.linkedin_member_id;
            } catch (e) { /* per-contact best-effort */ }
          });
        } catch (e) { console.error('[ENRICH_LI_RESOLVE]', e?.message || e); }
        if (resolved) console.log(`[ENRICH_LI_RESOLVE] discovered ${resolved}/${toResolve.length} linkedin_url from email`);
      }
    }

    await guard('linkedin_resolve');
    await Promise.all([
      runLane('calendly',  !!(calendlyPat && calendlyUserUri), LANES.calendly, c => scanCalendly(supabase, workspaceId, c, calendlyPat, calendlyUserUri)),
      runLane('cal_com',   !!calComPat,   LANES.cal_com,   c => scanCalCom(supabase, workspaceId, c, calComPat)),
      runLane('slack',     !!slackConn,   LANES.slack,     c => scanSlack(supabase, workspaceId, c, slackConn)),
      runLane('linkedin',  !!connections.linkedin?.account_id, LANES.linkedin, c => scanLinkedIn(supabase, workspaceId, c, connections.linkedin.account_id, attendeeMap)),
    ]);

    // ── Second email pass over ALTERNATE addresses identity resolution discovered.
    //    Fireflies co-attendance can learn that a contact also uses another email
    //    (a work address vs the imported personal one); a person's history lives across all their
    //    addresses, so re-scan Gmail/IMAP for the newly-linked ones, mapped back to the
    //    SAME contact. Bounded to genuinely-new addresses so it's cheap and idempotent.
    if (gmailConn || smtpConn) {
      const known = new Set(contacts.map(c => (c.email || '').toLowerCase()).filter(Boolean));
      const { data: allIdents } = await supabase
        .from('entity_identifiers')
        .select('entity_id, value')
        .eq('workspace_id', workspaceId).eq('kind', 'email').eq('status', 'active')
        .in('entity_id', contacts.map(c => c.id));
      const byId = new Map(contacts.map(c => [c.id, c]));
      const alts = [];
      for (const r of allIdents || []) {
        const e = (r.value || '').toLowerCase();
        const base = byId.get(r.entity_id);
        if (e && base && !known.has(e)) alts.push({ ...base, email: e });
      }
      if (alts.length) {
        console.log(`[ENRICH] identity resolution surfaced ${alts.length} alternate email(s) — second pass`);
        // A Composio mailbox was already read whole and filed against everyone (GET-552); only a
        // native grant searches by address, so only it has a second pass to make. A failure here
        // is the second pass, not the run: logged, never thrown.
        if (gmailConn && gmailConn.managed_by !== 'composio') {
          try { const gc = await scanGmailBulk(supabase, workspaceId, alts, gmailConn); for (const n of gc.values()) totalActivities += n; }
          catch (e) { console.error('[ENRICH_GMAIL_BULK] second pass:', e?.message || e); }
        }
        if (smtpConn)  { const ic = await scanImapBulk(supabase, workspaceId, alts, smtpConn);  for (const n of ic.values()) totalActivities += n; }
        await persist();
      }
    }
  } finally {
    if (heartbeat) clearInterval(heartbeat);
  }

  if (jobId) {
    const job = enrichmentJobs.get(jobId);
    if (job) job.done = true;
  }
  await persist(true);

  console.log(`[ENRICH] Done: ${totalActivities} activities for ${contacts.length} contacts`);
  return { enriched: contacts.length, activitiesLogged: totalActivities, failedSources: [...failedSources] };
}
