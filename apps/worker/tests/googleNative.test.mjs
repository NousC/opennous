// Native Google (self-host, GET-765): the install's own OAuth tokens feed the SAME ingest the
// Composio path feeds. These tests drive real Gmail / Calendar API payloads (fixtures shaped as
// Google returns them) through the native transport and check:
//   - the message Composio's GMAIL_FETCH_EMAILS would hand over is what we build;
//   - ingestGmail files the same observation from either transport;
//   - the whole native scan (list → full message → headers) files one row per email, keyed on
//     the RFC Message-ID, visible to its participants and the mailbox owner (GET-244);
//   - a calendar scan files the meeting under gcal_<event>_<person>, as Composio's does;
//   - tokens are refreshed near expiry and written back encrypted; a revoked grant flags the row.
//
// Run: node --test apps/worker/tests/googleNative.test.mjs

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { fakeDb } from './fakeDb.mjs';

// Before anything loads @nous/core: its encryption reads the key at import.
process.env.ENCRYPTION_KEY = 'a'.repeat(64);
const { encrypt, decrypt } = await import('@nous/core');
const {
  gmailApiMessageToComposio, calendarQuery, nativeGoogleClient, NATIVE_GOOGLE, nativeGoogleEnabled,
  googleRedirectUri, setCloudBuildForTests, isRetryable, backoffMs, MAX_ATTEMPTS,
} = await import('../src/utils/googleNative.mjs');
const { HAS_CLOUD } = await import('../src/lib/cloud.mjs');
const { gmailMessageToData, syncGmailConnection } = await import('../src/services/gmailSync.mjs');
const { ingestGmail } = await import('../src/webhooks/handlers/composio.mjs');
const { syncCalendarConnection } = await import('../src/services/calendarSync.mjs');
const { calendarListArgs } = await import('../src/utils/calendarEvent.mjs');
const { emailExternalId, parseEmailHeaders } = await import('../src/utils/emailIdentity.mjs');

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64url');
const WS = 'ws-1';
const THEO = 'u-theo';
const MAILBOX = 'theo@opennous.example';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const HTML = '<div dir="ltr">Thanks Theo, Tuesday works.<br>Corwin</div><div class="gmail_quote">On Mon, Theo wrote:<blockquote>Does Tuesday work?</blockquote></div>';
const PLAIN = 'Thanks Theo, Tuesday works.\nCorwin\n\nOn Mon, Theo wrote:\n> Does Tuesday work?';
const HEADERS = [
  { name: 'From', value: 'Corwin Ashdale <corwin@harborline.example>' },
  { name: 'To', value: 'Theo Bramwell <theo@opennous.example>' },
  { name: 'Cc', value: 'ops@harborline.example' },
  { name: 'Subject', value: 'Re: OpenNous pilot' },
  { name: 'Date', value: 'Sat, 12 Sep 2026 15:04:00 +0000' },
  { name: 'Message-ID', value: '<CAF=abc123@mail.gmail.com>' },
  { name: 'In-Reply-To', value: '<CAF=prev999@mail.gmail.com>' },
  { name: 'References', value: '<CAF=prev999@mail.gmail.com>' },
];

/** users.messages.get?format=full, as Gmail returns it. */
const GMAIL_FULL = {
  id: '19a2b3c4d5e6f708',
  threadId: '19a2b3c4d5e6f700',
  labelIds: ['INBOX', 'UNREAD'],
  snippet: 'Thanks Theo, Tuesday works.',
  internalDate: String(Date.parse('2026-09-12T15:04:00Z')),
  payload: {
    mimeType: 'multipart/alternative',
    headers: HEADERS,
    parts: [
      { mimeType: 'text/plain', body: { data: b64(PLAIN) } },
      { mimeType: 'text/html', body: { data: b64(HTML) } },
    ],
  },
};
/** users.messages.get?format=metadata. */
const GMAIL_META = { id: GMAIL_FULL.id, threadId: GMAIL_FULL.threadId, labelIds: GMAIL_FULL.labelIds, payload: { headers: HEADERS } };

/** The same email as Composio's GMAIL_FETCH_EMAILS returns it (keys verified in gmailSync.test). */
const COMPOSIO_MSG = {
  messageId: '19a2b3c4d5e6f708',
  threadId: '19a2b3c4d5e6f700',
  subject: 'Re: OpenNous pilot',
  sender: 'Corwin Ashdale <corwin@harborline.example>',
  to: 'Theo Bramwell <theo@opennous.example>',
  cc: 'ops@harborline.example',
  labelIds: ['INBOX', 'UNREAD'],
  messageText: HTML,
  messageTimestamp: '2026-09-12T15:04:00.000Z',
};

/** events.list, as Google Calendar returns it (Composio's GOOGLECALENDAR_EVENTS_LIST is this shape). */
const START = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 19) + 'Z';
const CAL_LIST = {
  kind: 'calendar#events',
  items: [{
    id: 'evt_42',
    status: 'confirmed',
    summary: 'OpenNous x Harborline',
    start: { dateTime: START },
    end: { dateTime: new Date(Date.parse(START) + 1800_000).toISOString() },
    organizer: { email: MAILBOX, self: true },
    attendees: [
      { email: MAILBOX, self: true, responseStatus: 'accepted' },
      { email: 'corwin@harborline.example', displayName: 'Corwin Ashdale', responseStatus: 'accepted' },
    ],
  }],
};

const seed = () => ({
  entity_identifiers: [
    { workspace_id: WS, entity_id: 'c-corwin', kind: 'email', status: 'active', value: 'corwin@harborline.example' },
  ],
  contacts: [{ id: 'c-corwin', workspace_id: WS, company_id: 'co-auto', email: 'corwin@harborline.example', first_name: 'Corwin', last_name: 'Ashdale' }],
  entities: [{ id: 'c-corwin', workspace_id: WS, type: 'person', status: 'active' }],
  workflow_provider_connections: [],
  observations: [],
});

const creds = (over = {}) => ({
  access_token: encrypt('ya29.live'),
  refresh_token: encrypt('1//refresh'),
  expiry_date: Date.now() + 3600_000,
  scope: 'openid https://www.googleapis.com/auth/gmail.readonly',
  email: MAILBOX,
  ...over,
});

const nativeConn = (provider, over = {}) => ({
  id: `conn-${provider}`, workspace_id: WS, owner_user_id: THEO, account_email: MAILBOX,
  managed_by: NATIVE_GOOGLE, composio_connection_id: null, encrypted_credentials: creds(),
  workflow_providers: { name: provider }, ...over,
});

// A Google that answers the REST calls the native client makes.
function fakeGoogle(routes) {
  const calls = [];
  const impl = async (url, init = {}) => {
    const u = String(url);
    calls.push({ url: u, auth: init.headers?.Authorization ?? null, body: init.body ? String(init.body) : null });
    for (const [re, answer] of routes) {
      if (re.test(u)) {
        const { status = 200, body } = typeof answer === 'function' ? answer(u, init) : { body: answer };
        return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
      }
    }
    return new Response(JSON.stringify({ error: { message: `unrouted ${u}` } }), { status: 404 });
  };
  return { impl, calls };
}

const savedEnv = {};
let realFetch;
beforeEach(() => {
  for (const k of ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_OAUTH_REDIRECT_URI', 'API_DOMAIN', 'API_URL', 'COMPOSIO_API_KEY']) savedEnv[k] = process.env[k];
  process.env.GOOGLE_CLIENT_ID = 'cid.apps.googleusercontent.com';
  process.env.GOOGLE_CLIENT_SECRET = 'secret';
  process.env.GOOGLE_OAUTH_REDIRECT_URI = 'https://api.example.com/api/oauth/google/callback';
  delete process.env.COMPOSIO_API_KEY;
  realFetch = globalThis.fetch;
  // This checkout carries src/cloud; these tests exercise the self-host build.
  setCloudBuildForTests(false);
});
afterEach(() => {
  setCloudBuildForTests(HAS_CLOUD);
  for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  globalThis.fetch = realFetch;
});

const strip = (rows) => rows.map(({ id, ingested_at, created_at, updated_at, ...r }) => r);

// ── Shape ─────────────────────────────────────────────────────────────────────

test('a Gmail API message becomes exactly the message GMAIL_FETCH_EMAILS returns', () => {
  assert.deepEqual(gmailApiMessageToComposio(GMAIL_FULL), COMPOSIO_MSG);
  assert.deepEqual(gmailMessageToData(gmailApiMessageToComposio(GMAIL_FULL)), gmailMessageToData(COMPOSIO_MSG));
});

test('a plain-text-only message carries its text; a message without an id is dropped', () => {
  const plainOnly = { ...GMAIL_FULL, payload: { mimeType: 'text/plain', headers: HEADERS, body: { data: b64('hello') } } };
  assert.equal(gmailApiMessageToComposio(plainOnly).messageText, 'hello');
  assert.equal(gmailApiMessageToComposio({ payload: {} }), null);
});

test('calendarListArgs (both spellings) maps onto Google events.list parameters', () => {
  const { calendarId, query } = calendarQuery(calendarListArgs({ timeMin: 'A', timeMax: 'B', maxResults: 50, pageToken: 'p2' }));
  assert.equal(calendarId, 'primary');
  assert.deepEqual(Object.fromEntries(query), {
    timeMin: 'A', timeMax: 'B', singleEvents: 'true', orderBy: 'startTime', maxResults: '50',
    showDeleted: 'true', pageToken: 'p2', alwaysIncludeEmail: 'true',
  });
});

// ── Same rows from either transport ───────────────────────────────────────────

test('ingestGmail files the same observation from the Composio message and the native one', async () => {
  // Headers unavailable on both sides (no Composio key, native app switched off for this test),
  // so the comparison isolates the normalizer: same input shape → same row.
  delete process.env.GOOGLE_CLIENT_ID;
  const composioConn = { id: 'conn-c', workspace_id: WS, owner_user_id: THEO, account_email: MAILBOX, composio_connection_id: 'ca_1', workflow_providers: { name: 'gmail_oauth' } };
  const a = fakeDb(seed());
  const b = fakeDb(seed());
  const nA = await ingestGmail(a, composioConn, gmailMessageToData(COMPOSIO_MSG), { triggerSlug: 'GMAIL_SCAN' });
  const nB = await ingestGmail(b, nativeConn('gmail_oauth'), gmailMessageToData(gmailApiMessageToComposio(GMAIL_FULL)), { triggerSlug: 'GMAIL_SCAN' });
  assert.equal(nA, 1);
  assert.equal(nB, 1);
  assert.ok(a.tables.observations.length > 0, 'the email was filed');
  assert.deepEqual(strip(b.tables.observations), strip(a.tables.observations));
});

test('the native mailbox scan files one row per email, keyed on the RFC Message-ID, private to its participants', async () => {
  const google = fakeGoogle([
    [/\/messages\?/, { messages: [{ id: GMAIL_FULL.id, threadId: GMAIL_FULL.threadId }], resultSizeEstimate: 1 }],
    [/\/messages\/19a2b3c4d5e6f708\?format=full/, GMAIL_FULL],
    [/\/messages\/19a2b3c4d5e6f708\?format=metadata/, GMAIL_META],
    [/\/profile$/, { emailAddress: MAILBOX }],
  ]);
  globalThis.fetch = google.impl;
  const db = fakeDb(seed());
  const conn = nativeConn('gmail_oauth');
  db.tables.workflow_provider_connections.push({ ...conn });

  const r = await syncGmailConnection(db, conn, { days: 1 });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.fetched, 1);
  assert.equal(r.logged, 1);

  // Every call carried the member's own token, decrypted from the row.
  assert.ok(google.calls.every((c) => c.auth === 'Bearer ya29.live'));
  assert.match(google.calls[0].url, /q=newer_than%3A1d/);

  const obs = db.tables.observations.filter((o) => o.source === 'gmail');
  assert.equal(obs.length, 1, 'one row per email');
  const row = obs[0];
  const rfc = parseEmailHeaders(HEADERS).rfcMessageId;
  assert.ok(rfc, 'the fixture carries a Message-ID');
  assert.equal(row.external_id, emailExternalId({ rfcMessageId: rfc, gmailMessageId: GMAIL_FULL.id, contactId: 'c-corwin' }),
    'the dedup key a teammate\'s Composio copy of the same email would land on');
  assert.match(row.external_id, /^gmail_rfc_/);
  assert.equal(row.raw.rfc_message_id, rfc);
  assert.deepEqual(row.raw.mailbox_owner_ids, [THEO], 'the mailbox owner holds it');
  assert.deepEqual(row.raw.gmail_copies, [{ owner_user_id: THEO, message_id: GMAIL_FULL.id }]);
  assert.ok(row.raw.participants.cc.includes('ops@harborline.example'), 'cc came from the headers fetch');
  assert.equal(row.raw.is_outbound, false);
  assert.equal(row.raw.reply_eligible, false, 'no prior outbound, so not a reply to us');
  assert.equal(row.raw.text.startsWith('Thanks Theo, Tuesday works.'), true);
  assert.equal(/Does Tuesday work/.test(row.raw.text), false, 'the quoted thread is not this email');

  // A second scan finds it filed and does nothing.
  const again = await syncGmailConnection(db, conn, { days: 1 });
  assert.equal(again.logged, 0);
  assert.equal(db.tables.observations.filter((o) => o.source === 'gmail').length, 1);
});

test('the native calendar scan files the meeting the way the Composio scan does', async () => {
  const google = fakeGoogle([[/\/calendars\/primary\/events\?/, CAL_LIST]]);
  globalThis.fetch = google.impl;
  const db = fakeDb(seed());
  db.tables.entity_identifiers.push({ workspace_id: WS, entity_id: 'co-auto', kind: 'domain', status: 'active', value: 'harborline.example' });

  const r = await syncCalendarConnection(db, nativeConn('google_calendar'));
  assert.equal(r.ok, true, r.error);
  assert.equal(r.fetched, 1);
  assert.equal(r.logged, 1);
  assert.match(google.calls[0].url, /singleEvents=true/);
  assert.match(google.calls[0].url, /showDeleted=true/);
  const row = db.tables.observations.find((o) => o.source === 'google_calendar');
  assert.equal(row.external_id, 'gcal_evt_42_c-corwin');
  assert.equal(row.property, 'interaction.meeting_scheduled');
  assert.equal(row.raw.event_id, 'evt_42');
});

// ── Tokens ────────────────────────────────────────────────────────────────────

test('an expiring token is refreshed, used, and written back encrypted', async () => {
  const google = fakeGoogle([
    [/oauth2\.googleapis\.com\/token/, { access_token: 'ya29.fresh', expires_in: 3599, scope: 'openid https://www.googleapis.com/auth/gmail.readonly', token_type: 'Bearer' }],
    [/\/profile$/, { emailAddress: MAILBOX }],
  ]);
  globalThis.fetch = google.impl;
  const db = fakeDb(seed());
  const conn = nativeConn('gmail_oauth', { encrypted_credentials: creds({ expiry_date: Date.now() - 1000 }) });
  db.tables.workflow_provider_connections.push({ ...conn });

  const client = nativeGoogleClient(db, conn);
  const res = await client.tools.execute('GMAIL_GET_PROFILE', { arguments: {} });
  assert.equal(res.successful, true);
  assert.equal(res.data.response_data.emailAddress, MAILBOX);

  const refresh = google.calls.find((c) => c.url.includes('/token'));
  assert.match(refresh.body, /grant_type=refresh_token/);
  assert.match(refresh.body, /refresh_token=1%2F%2Frefresh/);
  assert.equal(google.calls.at(-1).auth, 'Bearer ya29.fresh');

  const stored = db.tables.workflow_provider_connections[0].encrypted_credentials;
  assert.notEqual(stored.access_token, 'ya29.fresh', 'never stored in the clear');
  assert.equal(decrypt(stored.access_token), 'ya29.fresh');
  assert.equal(decrypt(stored.refresh_token), '1//refresh');
  assert.ok(stored.expiry_date > Date.now());
});

test('a revoked grant flags the connection for reconnect instead of reading nothing quietly', async () => {
  globalThis.fetch = fakeGoogle([[/oauth2\.googleapis\.com\/token/, () => ({ status: 400, body: { error: 'invalid_grant' } })]]).impl;
  const db = fakeDb(seed());
  const conn = nativeConn('gmail_oauth', { encrypted_credentials: creds({ expiry_date: 0 }) });
  db.tables.workflow_provider_connections.push({ ...conn, is_verified: true });

  const r = await syncGmailConnection(db, conn, { days: 1 });
  assert.equal(r.ok, false);
  assert.equal(db.tables.workflow_provider_connections[0].is_verified, false);
});

test('an action the native transport does not implement says so', async () => {
  const client = nativeGoogleClient(fakeDb(seed()), nativeConn('gmail_oauth'), { fetchImpl: async () => { throw new Error('no network'); } });
  const r = await client.tools.execute('GMAIL_SEND_EMAIL', { arguments: {} });
  assert.equal(r.successful, false);
  assert.match(r.error, /not available on a native Google connection/);
});

test('without the OAuth app configured, a native connection is not read', async () => {
  delete process.env.GOOGLE_CLIENT_SECRET;
  const r = await syncGmailConnection(fakeDb(seed()), nativeConn('gmail_oauth'), { days: 1 });
  assert.deepEqual(r, { ok: false, error: 'google_oauth_not_configured' });
});

// ── Configuration ─────────────────────────────────────────────────────────────

test('a Cloud build never runs the native path, whatever the env says', () => {
  setCloudBuildForTests(true);
  assert.equal(nativeGoogleEnabled(process.env), false);
  setCloudBuildForTests(false);
  assert.equal(nativeGoogleEnabled(process.env), true);
});

test('the redirect URI comes from API_DOMAIN when unset or left at the example placeholder', () => {
  assert.equal(googleRedirectUri({ GOOGLE_OAUTH_REDIRECT_URI: 'https://api.acme.example/api/oauth/google/callback' }), 'https://api.acme.example/api/oauth/google/callback');
  assert.equal(googleRedirectUri({ API_DOMAIN: 'api.acme.example' }), 'https://api.acme.example/api/oauth/google/callback');
  assert.equal(googleRedirectUri({ GOOGLE_OAUTH_REDIRECT_URI: 'https://api.yourdomain.com/api/oauth/google/callback', API_DOMAIN: 'api.acme.example' }), 'https://api.acme.example/api/oauth/google/callback');
  assert.equal(googleRedirectUri({ API_URL: 'https://api.acme.example/' }), 'https://api.acme.example/api/oauth/google/callback');
  assert.equal(googleRedirectUri({}), null);
  assert.equal(nativeGoogleEnabled({ GOOGLE_CLIENT_ID: 'a', GOOGLE_CLIENT_SECRET: 'b' }), false, 'no way to know the callback → not configured');
  assert.equal(nativeGoogleEnabled({ GOOGLE_CLIENT_ID: 'a', GOOGLE_CLIENT_SECRET: 'b', API_DOMAIN: 'api.acme.example' }), true);
});

test('the API and the worker agree on the redirect URI rule', async () => {
  const api = await import('../../api/src/providers/googleNative.mjs');
  for (const env of [
    {}, { API_DOMAIN: 'api.acme.example' }, { API_URL: 'https://x.example' },
    { GOOGLE_OAUTH_REDIRECT_URI: 'https://api.yourdomain.com/api/oauth/google/callback' },
    { GOOGLE_OAUTH_REDIRECT_URI: 'https://y.example/api/oauth/google/callback', API_DOMAIN: 'z.example' },
  ]) assert.equal(googleRedirectUri(env), api.googleRedirectUri(env), JSON.stringify(env));
});

// ── Retries, partial reads, 401 ──────────────────────────────────────────────

test('rate limits and 5xx are retryable; other errors are not', () => {
  assert.equal(isRetryable(429, {}), true);
  assert.equal(isRetryable(503, {}), true);
  assert.equal(isRetryable(403, { error: { errors: [{ reason: 'userRateLimitExceeded' }] } }), true);
  assert.equal(isRetryable(403, { error: { errors: [{ reason: 'rateLimitExceeded' }] } }), true);
  assert.equal(isRetryable(403, { error: { errors: [{ reason: 'insufficientPermissions' }] } }), false);
  assert.equal(isRetryable(400, {}), false);
  assert.equal(backoffMs(0, '7'), 7000, 'Retry-After seconds');
  assert.equal(backoffMs(0, null), 1000);
  assert.equal(backoffMs(3, null), 8000);
  assert.equal(backoffMs(10, null), 32_000, 'capped');
});

function sequenced(responses) {
  const calls = [];
  const impl = async (url) => {
    calls.push(String(url));
    const r = responses.shift() ?? { status: 200, body: {} };
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status ?? 200, headers: r.headers || {} });
  };
  return { impl, calls };
}

test('a 429 is retried after its Retry-After, then succeeds', async () => {
  const waits = [];
  const g = sequenced([
    { status: 429, body: { error: { message: 'slow down' } }, headers: { 'Retry-After': '3' } },
    { status: 403, body: { error: { errors: [{ reason: 'userRateLimitExceeded' }] } } },
    { status: 200, body: { emailAddress: MAILBOX } },
  ]);
  const client = nativeGoogleClient(fakeDb(seed()), nativeConn('gmail_oauth'), { fetchImpl: g.impl, sleep: async (ms) => { waits.push(ms); } });
  const r = await client.tools.execute('GMAIL_GET_PROFILE', { arguments: {} });
  assert.equal(r.successful, true);
  assert.deepEqual(waits, [3000, 2000], 'Retry-After honoured, then exponential');
  assert.equal(g.calls.length, 3);
});

test('retries are bounded', async () => {
  const waits = [];
  const g = sequenced(Array.from({ length: 10 }, () => ({ status: 503, body: { error: { message: 'down' } } })));
  const client = nativeGoogleClient(fakeDb(seed()), nativeConn('gmail_oauth'), { fetchImpl: g.impl, sleep: async (ms) => { waits.push(ms); } });
  const r = await client.tools.execute('GMAIL_GET_PROFILE', { arguments: {} });
  assert.equal(r.successful, false);
  assert.equal(g.calls.length, MAX_ATTEMPTS);
  assert.equal(waits.length, MAX_ATTEMPTS - 1);
});

test('a 401 refreshes the token once and retries', async () => {
  const refreshes = [];
  const refresh = async (c) => {
    refreshes.push(c.expiry_date);
    return { credentials: { access_token: refreshes.length === 1 ? 'old' : 'new' }, needsUpdate: refreshes.length > 1, updatedCredentials: refreshes.length > 1 ? { ...c, access_token: 'enc-new', expiry_date: 9e12 } : null };
  };
  const auths = [];
  const impl = async (url, init) => {
    auths.push(init.headers.Authorization);
    return init.headers.Authorization === 'Bearer old'
      ? new Response(JSON.stringify({ error: { message: 'Invalid Credentials' } }), { status: 401 })
      : new Response(JSON.stringify({ emailAddress: MAILBOX }), { status: 200 });
  };
  const db = fakeDb(seed());
  const conn = nativeConn('gmail_oauth');
  db.tables.workflow_provider_connections.push({ ...conn });
  const r = await nativeGoogleClient(db, conn, { fetchImpl: impl, refresh }).tools.execute('GMAIL_GET_PROFILE', { arguments: {} });
  assert.equal(r.successful, true);
  assert.deepEqual(auths, ['Bearer old', 'Bearer new']);
  assert.equal(refreshes[1], 0, 'the second refresh is forced');
  assert.equal(db.tables.workflow_provider_connections[0].encrypted_credentials.access_token, 'enc-new');
});

test('one unreadable message is skipped; the rest of the page is filed', async () => {
  const OTHER = { ...GMAIL_FULL, id: 'msg_two', payload: { ...GMAIL_FULL.payload, headers: HEADERS.map((h) => (h.name === 'Message-ID' ? { ...h, value: '<two@mail.gmail.com>' } : h)) } };
  globalThis.fetch = fakeGoogle([
    [/\/messages\?/, { messages: [{ id: GMAIL_FULL.id }, { id: 'msg_bad' }, { id: 'msg_two' }] }],
    [/\/messages\/msg_bad\?/, () => ({ status: 400, body: { error: { message: 'bad request' } } })],
    [/\/messages\/msg_two\?format=full/, OTHER],
    [/\/messages\/19a2b3c4d5e6f708\?format=full/, GMAIL_FULL],
    [/\/messages\/msg_two\?format=metadata/, { ...OTHER, payload: { headers: OTHER.payload.headers } }],
    [/\/messages\/19a2b3c4d5e6f708\?format=metadata/, GMAIL_META],
    [/\/profile$/, { emailAddress: MAILBOX }],
  ]).impl;
  const db = fakeDb(seed());
  const r = await syncGmailConnection(db, nativeConn('gmail_oauth', { id: 'conn-skip' }), { days: 1 });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.fetched, 2);
  assert.equal(r.logged, 2);
  assert.equal(r.unreadable, 1);
});

test('a page that fails after earlier pages files what was read and reports the read as failed', async () => {
  let listCalls = 0;
  globalThis.fetch = fakeGoogle([
    [/\/messages\?/, () => (++listCalls === 1
      ? { body: { messages: [{ id: GMAIL_FULL.id }], nextPageToken: 'p2' } }
      : { status: 400, body: { error: { message: 'Invalid pageToken' } } })],
    [/\/messages\/19a2b3c4d5e6f708\?format=full/, GMAIL_FULL],
    [/\/messages\/19a2b3c4d5e6f708\?format=metadata/, GMAIL_META],
    [/\/profile$/, { emailAddress: MAILBOX }],
  ]).impl;
  const db = fakeDb(seed());
  const r = await syncGmailConnection(db, nativeConn('gmail_oauth', { id: 'conn-partial' }), { days: 30 });
  assert.equal(r.ok, false, 'a backfill must not advance its watermark on a partial read');
  assert.equal(r.partial, true);
  assert.equal(r.logged, 1, 'page 1 was still filed');
  assert.equal(db.tables.observations.filter((o) => o.source === 'gmail').length, 1);
});
