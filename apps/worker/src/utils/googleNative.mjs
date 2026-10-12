// Native Google transport for self-hosted installs (GET-765).
//
// Cloud reads Gmail and Google Calendar through Composio. A self-hosted install can instead use
// its own Google OAuth app (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET): the API stores the member's
// tokens encrypted on the connection row (managed_by = 'google_oauth'), and this file reads
// Google with them.
//
// There is ONE ingest path. gmailSync, calendarSync and gmailBody talk to "a client with
// tools.execute(slug, { arguments })" and never know which transport answered. This client
// implements the four Composio actions those files call, against Google's REST API, and answers
// in the shape Composio answers in:
//
//   GMAIL_FETCH_EMAILS                 → { data: { messages: [{ messageId, threadId, sender, to, cc,
//                                          subject, labelIds, messageText, messageTimestamp }],
//                                          nextPageToken } }
//   GMAIL_GET_PROFILE                  → { data: { response_data: { emailAddress } } }
//   GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID  → { data: { response_data: <Gmail message, metadata> } }
//   GOOGLECALENDAR_EVENTS_LIST         → { data: <Google events.list response> }
//
// So a message read natively goes through the same ingestGmail, files the same observation with
// the same external id, the same participants and mailbox_owner_ids, and the same reply gate.
//
// Token handling: refreshGoogleToken (@nous/core) decrypts, refreshes inside five minutes of
// expiry and re-encrypts. A refreshed token is written back to the row. A revoked grant flags
// the row unverified so the Integrations page shows it needs reconnecting.

import { refreshGoogleToken } from '@nous/core';
import { HAS_CLOUD } from '../lib/cloud.mjs';

/** connections.managed_by for a connection made with the install's own Google OAuth app. */
export const NATIVE_GOOGLE = 'google_oauth';

/**
 * The callback URL on the Google OAuth client: GOOGLE_OAUTH_REDIRECT_URI when set to a real value,
 * else derived from API_URL / API_DOMAIN. The nous.env.example placeholder counts as unset. Same
 * rule as the API (apps/api/src/providers/googleNative.mjs), so API and worker agree on whether
 * native Google is configured.
 */
export function googleRedirectUri(env = process.env) {
  const set = String(env.GOOGLE_OAUTH_REDIRECT_URI || '').trim();
  if (set && !/yourdomain\.com/i.test(set)) return set;
  const api = String(env.API_URL || (env.API_DOMAIN ? `https://${env.API_DOMAIN}` : '')).trim().replace(/\/+$/, '');
  if (!api || /yourdomain\.com/i.test(api)) return null;
  return `${api}/api/oauth/google/callback`;
}

// Cloud never runs the native path, whatever its env says. Tests flip this to exercise it from a
// checkout that carries src/cloud.
let cloudBuild = HAS_CLOUD;
export function setCloudBuildForTests(value) { cloudBuild = Boolean(value); }

/** The install has a Google OAuth app configured, and this is not a Cloud build. */
export function nativeGoogleEnabled(env = process.env) {
  if (cloudBuild) return false;
  return Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && googleRedirectUri(env));
}

export const isNativeGoogle = (conn) => conn?.managed_by === NATIVE_GOOGLE;

const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
const CALENDAR = 'https://www.googleapis.com/calendar/v3';
const FETCH_CONCURRENCY = 5;

// ── Retries ───────────────────────────────────────────────────────────────────
//
// Gmail answers bursts with 429, or 403 rateLimitExceeded / userRateLimitExceeded, and has the
// odd 5xx. Those are retried with exponential backoff (honouring Retry-After), a bounded number of
// times. Anything else fails straight away.

export const MAX_ATTEMPTS = 5;
const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 32_000;
const RATE_REASONS = new Set(['rateLimitExceeded', 'userRateLimitExceeded']);

export function isRetryable(status, body) {
  if (status === 429 || status >= 500) return true;
  if (status === 403) {
    const reasons = (body?.error?.errors || []).map((e) => e?.reason);
    return reasons.some((r) => RATE_REASONS.has(r));
  }
  return false;
}

/** How long to wait before attempt `attempt + 1` (0-based): Retry-After when given, else 2^n. */
export function backoffMs(attempt, retryAfter, now = Date.now()) {
  if (retryAfter != null && retryAfter !== '') {
    const secs = Number(retryAfter);
    const ms = Number.isFinite(secs) ? secs * 1000 : Date.parse(retryAfter) - now;
    if (Number.isFinite(ms) && ms >= 0) return Math.min(ms, 60_000);
  }
  return Math.min(BASE_DELAY_MS * 2 ** attempt, MAX_DELAY_MS);
}

const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Gmail message → Composio's GMAIL_FETCH_EMAILS message ────────────────────

const header = (headers, name) => {
  const h = (headers || []).find((x) => String(x?.name || '').toLowerCase() === name.toLowerCase());
  return h?.value ?? null;
};

/** The first text/html and text/plain bodies in a MIME tree, base64url-decoded. */
export function mimeBodies(payload) {
  let html = null;
  let text = null;
  const walk = (part) => {
    if (!part) return;
    if (part.body?.data && !(part.filename)) {
      try {
        const decoded = Buffer.from(part.body.data, 'base64url').toString('utf8');
        if (part.mimeType === 'text/html' && html == null) html = decoded;
        else if (part.mimeType === 'text/plain' && text == null) text = decoded;
      } catch { /* a malformed part is skipped */ }
    }
    for (const sub of part.parts || []) walk(sub);
  };
  walk(payload);
  return { html, text };
}

/**
 * A Gmail API message (format=full) → the message GMAIL_FETCH_EMAILS returns. messageText is the
 * HTML body when there is one (what Composio hands over for most real mail), else the plain text;
 * ingestGmail turns either into clean text with splitMessage. messageTimestamp is ISO, from
 * Gmail's internalDate (the time Gmail received or sent it).
 */
export function gmailApiMessageToComposio(msg) {
  if (!msg?.id) return null;
  const headers = msg.payload?.headers || [];
  const { html, text } = mimeBodies(msg.payload);
  const internal = Number(msg.internalDate);
  return {
    messageId: msg.id,
    threadId: msg.threadId ?? null,
    subject: header(headers, 'Subject'),
    sender: header(headers, 'From'),
    to: header(headers, 'To'),
    cc: header(headers, 'Cc'),
    labelIds: Array.isArray(msg.labelIds) ? msg.labelIds : [],
    messageText: html ?? text ?? msg.snippet ?? '',
    messageTimestamp: Number.isFinite(internal) && internal > 0
      ? new Date(internal).toISOString()
      : (header(headers, 'Date') ? new Date(header(headers, 'Date')).toISOString() : null),
  };
}

/** calendarListArgs (Composio, both spellings) → Google events.list query parameters. */
export function calendarQuery(args = {}) {
  const pick = (...keys) => keys.map((k) => args[k]).find((v) => v != null && v !== '');
  const q = new URLSearchParams();
  const set = (k, v) => { if (v != null && v !== '') q.set(k, String(v)); };
  set('timeMin', pick('timeMin', 'time_min'));
  set('timeMax', pick('timeMax', 'time_max'));
  set('singleEvents', pick('singleEvents', 'single_events'));
  set('orderBy', pick('orderBy', 'order_by'));
  set('maxResults', pick('maxResults', 'max_results'));
  set('showDeleted', pick('showDeleted', 'show_deleted'));
  set('pageToken', pick('pageToken', 'page_token'));
  set('alwaysIncludeEmail', pick('alwaysIncludeEmail'));
  return { calendarId: pick('calendarId', 'calendar_id') || 'primary', query: q };
}

async function pool(items, size, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (i < items.length) { const n = i++; out[n] = await fn(items[n], n); }
  }));
  return out;
}

// ── The client ───────────────────────────────────────────────────────────────

/**
 * A Composio-shaped client for one natively connected Google account.
 * `fetchImpl` and `refresh` are injectable for tests.
 */
export function nativeGoogleClient(supabase, conn, { fetchImpl = globalThis.fetch, refresh = refreshGoogleToken, sleep = realSleep } = {}) {
  let tokenPromise = null;

  // One token per client; `force` refreshes even before expiry (after a 401: revoked early,
  // rotated, or the stored expiry was wrong).
  const accessToken = ({ force = false } = {}) => {
    if (force) tokenPromise = null;
    tokenPromise ??= (async () => {
      try {
        const stored = force ? { ...conn.encrypted_credentials, expiry_date: 0 } : conn.encrypted_credentials;
        const { credentials, needsUpdate, updatedCredentials } = await refresh(stored);
        if (needsUpdate && updatedCredentials) {
          await supabase.from('workflow_provider_connections')
            .update({ encrypted_credentials: updatedCredentials }).eq('id', conn.id);
          conn.encrypted_credentials = updatedCredentials;
        }
        return credentials.access_token;
      } catch (e) {
        if (e?.code === 'google_token_revoked') {
          await supabase.from('workflow_provider_connections')
            .update({ is_verified: false }).eq('id', conn.id).then(null, () => {});
          console.warn(`[GOOGLE] connection=${conn.id} grant revoked or expired — flagged for reconnect`);
        }
        tokenPromise = null;
        throw e;
      }
    })();
    return tokenPromise;
  };

  const get = async (url) => {
    let refreshed = false;
    for (let attempt = 0; ; attempt++) {
      const token = await accessToken();
      const res = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
      const body = await res.json().catch(() => ({}));
      if (res.ok) return body;
      // An access token Google no longer accepts: refresh once and retry.
      if (res.status === 401 && !refreshed) {
        refreshed = true;
        await accessToken({ force: true });
        attempt--;   // the refresh retry does not count against the backoff budget
        continue;
      }
      if (isRetryable(res.status, body) && attempt + 1 < MAX_ATTEMPTS) {
        await sleep(backoffMs(attempt, res.headers?.get?.('retry-after')));
        continue;
      }
      const err = new Error(`google ${res.status}: ${body?.error?.message || body?.error || 'request failed'}`.slice(0, 300));
      err.status = res.status;
      throw err;
    }
  };

  const ok = (data) => ({ successful: true, data, error: null });
  const fail = (e) => ({ successful: false, data: {}, error: String(e?.message || e).slice(0, 300) });

  const actions = {
    async GMAIL_FETCH_EMAILS(a) {
      const q = new URLSearchParams();
      if (a.query) q.set('q', a.query);
      q.set('maxResults', String(a.max_results ?? a.maxResults ?? 25));
      const pageToken = a.page_token ?? a.pageToken;
      if (pageToken) q.set('pageToken', pageToken);
      const list = await get(`${GMAIL}/messages?${q}`);
      const ids = (list.messages || []).map((m) => m.id).filter(Boolean);
      // One unreadable message must not cost the page: it is skipped (and, not being filed, read
      // again by the next scan while it is inside the window). A revoked grant still stops the read.
      let unreadable = 0;
      const full = await pool(ids, FETCH_CONCURRENCY, async (id) => {
        try { return await get(`${GMAIL}/messages/${encodeURIComponent(id)}?format=full`); }
        catch (e) {
          if (e?.code === 'google_token_revoked') throw e;
          if (e.status !== 404) {   // 404: deleted between list and get
            unreadable++;
            console.warn(`[GOOGLE] connection=${conn.id} message ${id} skipped: ${e.message}`);
          }
          return null;
        }
      });
      return ok({
        unreadable,
        messages: full.map(gmailApiMessageToComposio).filter(Boolean),
        nextPageToken: list.nextPageToken || null,
        resultSizeEstimate: list.resultSizeEstimate ?? null,
      });
    },
    async GMAIL_GET_PROFILE() {
      const p = await get(`${GMAIL}/profile`);
      return ok({ response_data: p });
    },
    async GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID(a) {
      const id = a.message_id ?? a.messageId;
      const format = a.format || 'metadata';
      const m = await get(`${GMAIL}/messages/${encodeURIComponent(String(id))}?format=${encodeURIComponent(format)}`);
      return ok({ response_data: m });
    },
    async GOOGLECALENDAR_EVENTS_LIST(a) {
      const { calendarId, query } = calendarQuery(a);
      return ok(await get(`${CALENDAR}/calendars/${encodeURIComponent(calendarId)}/events?${query}`));
    },
  };

  return {
    transport: NATIVE_GOOGLE,
    tools: {
      async execute(slug, { arguments: args = {} } = {}) {
        const action = actions[slug];
        if (!action) return fail(`${slug} is not available on a native Google connection`);
        try { return await action(args); }
        catch (e) {
          // A failed token is not a failed read: let the caller see it was the grant.
          if (e?.code === 'google_token_revoked') throw e;
          return fail(e);
        }
      },
    },
  };
}
