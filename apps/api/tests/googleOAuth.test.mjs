// Native Google OAuth (self-host, GET-765): mode selection, the authorize URL, state/CSRF, the
// code exchange (Google mocked), token encryption at rest, reconnect, and disconnect's revoke rule.
//
// Run: node --test apps/api/tests/googleOAuth.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { fakeDb } from '../../worker/tests/fakeDb.mjs';

// Before the crypto module loads: it reads the key at import.
process.env.ENCRYPTION_KEY = 'b'.repeat(64);
process.env.APP_URL = 'https://app.example.com';
const ENV = {
  GOOGLE_CLIENT_ID: 'cid.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: 'shh',
  GOOGLE_OAUTH_REDIRECT_URI: 'https://api.example.com/api/oauth/google/callback',
};
Object.assign(process.env, ENV);

const g = await import('../src/providers/googleNative.mjs');
const { parkGoogleCallback, completeGoogleConnection, handoffPage } = await import('../src/routes/api/oauthGoogle.mjs');
const { decrypt } = await import('../src/providers/crypto.mjs');
const core = await import('@nous/core');

const WS = 'ws-1';
const USER = 'u-1';
const seed = () => ({
  workflow_providers: [{ id: 'p-gmail', name: 'gmail_oauth' }, { id: 'p-cal', name: 'google_calendar' }],
  workflow_provider_connections: [],
});

function fakeGoogle({ tokens, email = 'Theo@OpenNous.example', tokenStatus = 200 } = {}) {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url: String(url), body: init.body ? String(init.body) : null, auth: init.headers?.Authorization ?? null });
    if (String(url).startsWith('https://oauth2.googleapis.com/token')) {
      return new Response(JSON.stringify(tokens), { status: tokenStatus });
    }
    if (String(url).startsWith('https://openidconnect.googleapis.com/v1/userinfo')) {
      return new Response(JSON.stringify({ email, email_verified: true }), { status: 200 });
    }
    return new Response('{}', { status: 404 });
  };
  return { impl, calls };
}

const TOKENS = {
  access_token: 'ya29.access', refresh_token: '1//refresh', expires_in: 3599,
  scope: 'openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/gmail.readonly',
  token_type: 'Bearer', id_token: 'x.y.z',
};

const stateFrom = (authUrl) => new URL(authUrl).searchParams.get('state');
const noop = async () => {};

// ── Mode ──────────────────────────────────────────────────────────────────────

test('Cloud is always Composio, whatever the env says', async () => {
  assert.equal(await g.connectMode(null, WS, { env: ENV, hasCloud: true, loadComposio: async () => ({ apiKey: null }) }), 'composio');
});

test('self-host with the Google app set and no Composio key connects natively', async () => {
  assert.equal(await g.connectMode(null, WS, { env: ENV, hasCloud: false, loadComposio: async () => ({ apiKey: null }) }), 'native');
});

test('self-host with Composio configured keeps Composio', async () => {
  assert.equal(await g.connectMode(null, WS, { env: ENV, hasCloud: false, loadComposio: async () => ({ apiKey: 'ak_x' }) }), 'composio');
});

test('self-host with an incomplete Google app falls back to the Composio flow', async () => {
  for (const missing of Object.keys(ENV)) {
    const env = { ...ENV, [missing]: '' };
    assert.equal(await g.connectMode(null, WS, { env, hasCloud: false, loadComposio: async () => ({ apiKey: null }) }), 'composio', missing);
  }
});

// ── Authorize ─────────────────────────────────────────────────────────────────

test('the authorize URL asks for read-only scopes per product, offline, with PKCE', () => {
  const { state, challenge } = g.createOAuthState({ workspaceId: WS, userId: USER, provider: 'gmail_oauth' });
  const u = new URL(g.buildAuthUrl({ provider: 'gmail_oauth', state, challenge, env: ENV }));
  assert.equal(u.origin + u.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(u.searchParams.get('client_id'), ENV.GOOGLE_CLIENT_ID);
  assert.equal(u.searchParams.get('redirect_uri'), ENV.GOOGLE_OAUTH_REDIRECT_URI);
  assert.deepEqual(u.searchParams.get('scope').split(' '), [
    'openid', 'https://www.googleapis.com/auth/userinfo.email', 'https://www.googleapis.com/auth/gmail.readonly',
  ]);
  assert.equal(u.searchParams.get('access_type'), 'offline');
  assert.equal(u.searchParams.get('prompt'), 'consent');
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
  // The challenge is the SHA-256 of the verifier the callback will send.
  const data = g.consumeOAuthState(state);
  assert.equal(crypto.createHash('sha256').update(data.verifier).digest('base64url'), u.searchParams.get('code_challenge'));

  const cal = new URL(g.buildAuthUrl({ provider: 'google_calendar', state: 's', challenge: 'c', env: ENV }));
  assert.ok(cal.searchParams.get('scope').split(' ').includes('https://www.googleapis.com/auth/calendar.readonly'));
  assert.ok(!cal.searchParams.get('scope').includes('gmail'));
});

test('product names resolve, anything else does not', () => {
  assert.equal(g.googleProviderName('gmail'), 'gmail_oauth');
  assert.equal(g.googleProviderName('calendar'), 'google_calendar');
  assert.equal(g.googleProviderName('google_calendar'), 'google_calendar');
  assert.equal(g.googleProviderName('drive'), null);
});

// ── State / CSRF ──────────────────────────────────────────────────────────────

test('state is single use, unguessable, and expires after ten minutes', () => {
  const a = g.createOAuthState({ workspaceId: WS, userId: USER, provider: 'gmail_oauth' });
  const b = g.createOAuthState({ workspaceId: WS, userId: USER, provider: 'gmail_oauth' });
  assert.notEqual(a.state, b.state);
  assert.match(a.state, /^[0-9a-f]{64}$/);
  assert.equal(g.consumeOAuthState(a.state).userId, USER);
  assert.equal(g.consumeOAuthState(a.state), null, 'second use refused');
  assert.equal(g.consumeOAuthState('f'.repeat(64)), null, 'unknown refused');
  const old = g.createOAuthState({ workspaceId: WS, userId: USER, provider: 'gmail_oauth', now: Date.now() - 11 * 60_000 });
  assert.equal(g.consumeOAuthState(old.state), null, 'expired refused');
});

// The flow as the browser drives it: authorize → Google → callback (parks) → the opener completes.
function startFlow({ provider = 'gmail_oauth', workspaceId = WS, userId = USER } = {}) {
  const { state } = g.createOAuthState({ workspaceId, userId, provider });
  const out = parkGoogleCallback({ query: { code: '4/0code', state } });
  return { state, out, completion: out.completion };
}
const complete = (db, completion, { userId = USER, workspaceId = WS, google = fakeGoogle({ tokens: TOKENS }), afterConnect = noop } = {}) =>
  completeGoogleConnection({ code: completion, userId, workspaceId, supabase: db, fetchImpl: google.impl, env: ENV, afterConnect });

test('a callback with a forged state parks nothing', () => {
  const out = parkGoogleCallback({ query: { code: 'c', state: 'forged' } });
  assert.equal(out.redirect, 'https://app.example.com/oauth-callback.html?oauth_error=invalid_state');
});

test("a callback carrying Google's error (the member cancelled) reports it", () => {
  assert.match(parkGoogleCallback({ query: { error: 'access_denied' } }).redirect, /oauth_error=access_denied/);
});

test('the callback saves nothing: it serves a hand-off page carrying a one-time code that is never in a URL', () => {
  const { out, completion, state } = startFlow();
  assert.equal(out.redirect, undefined);
  assert.match(completion, /^[0-9a-f]{64}$/);
  assert.ok(out.html.includes(completion), 'the code is in the page body');
  assert.ok(out.html.includes(`nonce="${out.nonce}"`));
  assert.ok(out.html.includes('"appOrigin":"https://app.example.com"'), 'posted to the app origin only');
  assert.match(parkGoogleCallback({ query: { code: '4/0code', state } }).redirect, /oauth_error=invalid_state/, 'state is single use');
});

// Run the hand-off page's script against a fake browser window.
function runHandoff(html, { opener = null, ack = false } = {}) {
  const script = html.slice(html.indexOf('<script'), html.indexOf('</script>')).replace(/^<script[^>]*>/, '');
  const fetches = [];
  const posted = [];
  const timers = [];
  const listeners = {};
  const replaced = [];
  const el = { textContent: '' };
  const win = {
    opener: opener && { postMessage: (msg, origin) => { posted.push({ msg, origin }); if (ack) listeners.message?.({ origin, data: { type: 'google-oauth-ack', code: msg.completionCode } }); } },
    addEventListener: (t, fn) => { listeners[t] = fn; },
    close: () => {},
  };
  const ctx = {
    window: win, document: { getElementById: () => el },
    history: { replaceState: (_s, _t, u) => replaced.push(u) },
    location: { pathname: '/api/oauth/google/callback' },
    fetch: (url, init) => { fetches.push({ url, body: JSON.parse(init.body), credentials: init.credentials }); return Promise.resolve(); },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); },
    JSON,
  };
  vm.runInNewContext(script, ctx);
  return { fetches, posted, timers, replaced, text: () => el.textContent, fireTimers: () => timers.splice(0).forEach((t) => t.fn()) };
}

test('no opener (a forwarded link opened in a plain tab): the code is burned at once and the URL stripped', () => {
  const { out, completion } = startFlow();
  const page = runHandoff(out.html, { opener: null });
  assert.deepEqual(page.replaced, ['/api/oauth/google/callback'], "Google's query is stripped from the address bar");
  assert.equal(page.posted.length, 0);
  assert.deepEqual(page.fetches, [{ url: 'discard', body: { code: completion }, credentials: 'omit' }]);
  assert.match(page.text(), /cancelled/);
  // What POST /discard does with it: the code can no longer be redeemed.
  assert.equal(g.discardCompletion(page.fetches[0].body.code), true);
  assert.equal(g.completionPending(completion), false);
});

test('an opener that never acknowledges (foreign or gone): the code is burned after the wait', () => {
  const { out, completion } = startFlow();
  const page = runHandoff(out.html, { opener: true, ack: false });
  assert.deepEqual(page.posted.map((p) => p.origin), ['https://app.example.com'], 'posted to the app origin, never "*"');
  assert.equal(page.fetches.length, 0, 'waits for the app first');
  page.fireTimers();
  assert.deepEqual(page.fetches.map((f) => f.body.code), [completion]);
});

test('the app window acknowledges: nothing is burned', () => {
  const { out } = startFlow();
  const page = runHandoff(out.html, { opener: true, ack: true });
  page.fireTimers();
  assert.equal(page.fetches.length, 0);
  assert.match(page.text(), /Connected/);
});

test('a burned code cannot be completed', async () => {
  const db = fakeDb(seed());
  const { completion } = startFlow();
  g.discardCompletion(completion);
  const r = await complete(db, completion);
  assert.equal(r.body.error, 'invalid_completion');
  assert.equal(db.tables.workflow_provider_connections.length, 0);
});

test('the hand-off page escapes what it embeds', () => {
  const html = handoffPage({ code: 'c', provider: '</script><script>alert(1)</script>', appOrigin: 'https://a.io', nonce: 'n' });
  assert.equal(html.split('</script>').length, 2, 'only the page\'s own closing tag');
});

test("a consent link forwarded to someone else connects nothing (login CSRF): another member's session is refused", async () => {
  const db = fakeDb(seed());
  const google = fakeGoogle({ tokens: TOKENS });
  const { completion } = startFlow({ userId: 'u-member-b' });
  // Admin A's browser finished the Google consent; A's session tries to complete B's flow.
  const r = await complete(db, completion, { userId: 'u-admin-a', google });
  assert.equal(r.status, 403);
  assert.equal(r.body.error, 'not_your_connection');
  assert.equal(google.calls.length, 0, 'the code is never exchanged');
  assert.equal(db.tables.workflow_provider_connections.length, 0);
  // And the code is spent: B cannot use it afterwards either.
  const again = await complete(db, completion, { userId: 'u-member-b', google });
  assert.equal(again.body.error, 'invalid_completion');
});

test('a completion from another workspace is refused', async () => {
  const db = fakeDb(seed());
  const { completion } = startFlow();
  const r = await complete(db, completion, { workspaceId: 'ws-other' });
  assert.equal(r.status, 403);
  assert.equal(db.tables.workflow_provider_connections.length, 0);
});

test('an unknown or reused completion code is refused', async () => {
  const db = fakeDb(seed());
  assert.equal((await complete(db, 'f'.repeat(64))).body.error, 'invalid_completion');
  const { completion } = startFlow();
  assert.equal((await complete(db, completion)).status, 200);
  assert.equal((await complete(db, completion)).body.error, 'invalid_completion');
  assert.equal(db.tables.workflow_provider_connections.length, 1);
});

test('the code is exchanged with the PKCE verifier and the tokens are stored encrypted', async () => {
  const db = fakeDb(seed());
  const google = fakeGoogle({ tokens: TOKENS });
  const { completion } = startFlow();
  let after = null;
  const r = await complete(db, completion, { google, afterConnect: async (x) => { after = x; } });
  const row = db.tables.workflow_provider_connections[0];
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true, connection_id: row.id, provider: 'gmail_oauth' });

  const exchange = new URLSearchParams(google.calls[0].body);
  assert.equal(exchange.get('grant_type'), 'authorization_code');
  assert.equal(exchange.get('code'), '4/0code');
  assert.equal(exchange.get('client_secret'), 'shh');
  assert.equal(exchange.get('redirect_uri'), ENV.GOOGLE_OAUTH_REDIRECT_URI);
  assert.ok(exchange.get('code_verifier'), 'PKCE verifier sent');
  assert.equal(google.calls[1].auth, 'Bearer ya29.access');

  assert.equal(row.workspace_id, WS);
  assert.equal(row.provider_id, 'p-gmail');
  assert.equal(row.managed_by, 'google_oauth');
  assert.equal(row.owner_user_id, USER);
  assert.equal(row.account_email, 'theo@opennous.example');
  assert.equal(row.name, 'theo@opennous.example');
  assert.equal(row.is_verified, true);
  assert.equal(row.composio_connection_id, null);

  const c = row.encrypted_credentials;
  const json = JSON.stringify(c);
  assert.ok(!json.includes('ya29.access') && !json.includes('1//refresh'), 'no token in the clear');
  assert.match(c.access_token, /^[0-9a-f]{32}:[0-9a-f]+:[0-9a-f]{32}$/, 'AES-256-GCM iv:data:tag');
  assert.equal(decrypt(c.access_token), 'ya29.access');
  assert.equal(decrypt(c.refresh_token), '1//refresh');
  assert.equal(c.email, 'theo@opennous.example');
  assert.ok(c.scope.includes('gmail.readonly'));
  assert.ok(c.expiry_date > Date.now() + 3000_000);

  // The worker's refresher (@nous/core) reads exactly this shape back.
  const back = await core.refreshGoogleToken(c);
  assert.equal(back.needsUpdate, false);
  assert.equal(back.credentials.access_token, 'ya29.access');
  assert.equal(back.credentials.refresh_token, '1//refresh');

  assert.equal(after.provider, 'gmail_oauth');
  assert.equal(after.connection.id, row.id);
});

test('a grant without the product scope (unticked on the consent screen) is not saved', async () => {
  const db = fakeDb(seed());
  const { completion } = startFlow();
  const r = await complete(db, completion, { google: fakeGoogle({ tokens: { ...TOKENS, scope: 'openid https://www.googleapis.com/auth/userinfo.email' } }) });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'scope_not_granted');
  assert.equal(db.tables.workflow_provider_connections.length, 0);

  // Calendar needs calendar.readonly, not gmail.readonly.
  const cal = startFlow({ provider: 'google_calendar' });
  const rc = await complete(db, cal.completion);
  assert.equal(rc.body.error, 'scope_not_granted');
  assert.equal(g.grantedRequiredScope('google_calendar', 'openid https://www.googleapis.com/auth/calendar.readonly'), true);
});

test('a failed exchange reports failure and stores nothing', async () => {
  const db = fakeDb(seed());
  const { completion } = startFlow();
  const r = await complete(db, completion, { google: fakeGoogle({ tokens: { error: 'invalid_grant' }, tokenStatus: 400 }) });
  assert.equal(r.status, 502);
  assert.equal(db.tables.workflow_provider_connections.length, 0);
});

test('reconnecting the same mailbox updates the row; a missing refresh token keeps the stored one', async () => {
  const db = fakeDb(seed());
  await complete(db, startFlow().completion);
  const { refresh_token, ...noRefresh } = TOKENS;
  await complete(db, startFlow().completion, { google: fakeGoogle({ tokens: { ...noRefresh, access_token: 'ya29.second' } }) });
  assert.equal(db.tables.workflow_provider_connections.length, 1, 'one row per mailbox');
  const c = db.tables.workflow_provider_connections[0].encrypted_credentials;
  assert.equal(decrypt(c.access_token), 'ya29.second');
  assert.equal(decrypt(c.refresh_token), '1//refresh');
});

test('two members completing the same mailbox at once: exactly one wins, the other gets 409', async () => {
  const db = fakeDb(seed());
  const a = startFlow({ userId: 'u-a' });
  const b = startFlow({ userId: 'u-b' });
  const [ra, rb] = await Promise.all([complete(db, a.completion, { userId: 'u-a' }), complete(db, b.completion, { userId: 'u-b' })]);
  assert.deepEqual([ra.status, rb.status].sort(), [200, 409]);
  assert.equal(db.tables.workflow_provider_connections.length, 1);
  const winner = ra.status === 200 ? 'u-a' : 'u-b';
  assert.equal(db.tables.workflow_provider_connections[0].owner_user_id, winner, 'the loser never overwrote the owner');
});

test('a row with no recorded owner is not claimable through this path', async () => {
  const db = fakeDb(seed());
  db.tables.workflow_provider_connections.push({ id: 'legacy', workspace_id: WS, provider_id: 'p-gmail', name: 'theo@opennous.example', owner_user_id: null, encrypted_credentials: { x: 1 } });
  const r = await complete(db, startFlow().completion);
  assert.equal(r.status, 409);
  assert.equal(db.tables.workflow_provider_connections[0].owner_user_id, null);
  assert.deepEqual(db.tables.workflow_provider_connections[0].encrypted_credentials, { x: 1 });
});

test("a mailbox another member connected is never moved to someone else's ownership", async () => {
  const db = fakeDb(seed());
  await complete(db, startFlow({ userId: 'u-a' }).completion, { userId: 'u-a' });
  const before = { ...db.tables.workflow_provider_connections[0] };
  const r = await complete(db, startFlow({ userId: 'u-b' }).completion, { userId: 'u-b' });
  assert.equal(r.status, 409);
  assert.equal(r.body.error, 'connected_by_another_member');
  assert.equal(db.tables.workflow_provider_connections.length, 1);
  assert.equal(db.tables.workflow_provider_connections[0].owner_user_id, 'u-a');
  assert.deepEqual(db.tables.workflow_provider_connections[0].encrypted_credentials, before.encrypted_credentials);
});

test('Gmail and Calendar on the same account are two rows', async () => {
  const db = fakeDb(seed());
  const calTokens = { ...TOKENS, scope: `${TOKENS.scope} https://www.googleapis.com/auth/calendar.readonly` };
  for (const provider of ['gmail_oauth', 'google_calendar']) {
    const r = await complete(db, startFlow({ provider }).completion, { google: fakeGoogle({ tokens: calTokens }) });
    assert.equal(r.status, 200);
  }
  assert.deepEqual(db.tables.workflow_provider_connections.map((r) => r.provider_id).sort(), ['p-cal', 'p-gmail']);
});

// ── Disconnect ────────────────────────────────────────────────────────────────

test('the Google grant is revoked only when nothing else on the install uses that account', async () => {
  const db = fakeDb({
    workflow_provider_connections: [
      { id: 'g', workspace_id: WS, managed_by: 'google_oauth', account_email: 'b@x.com', owner_user_id: USER },
      { id: 'c', workspace_id: WS, managed_by: 'google_oauth', account_email: 'b@x.com', owner_user_id: USER },
      { id: 'other-ws', workspace_id: 'ws-2', managed_by: 'google_oauth', account_email: 'b@x.com', owner_user_id: 'u-9' },
      { id: 'composio', workspace_id: WS, managed_by: 'composio', account_email: 'solo@x.com' },
    ],
  });
  const without = (id) => { db.tables.workflow_provider_connections = db.tables.workflow_provider_connections.filter((r) => r.id !== id); };
  assert.equal(await g.shouldRevokeNativeGrant(db, { id: 'g', workspace_id: WS, account_email: 'b@x.com' }), false, 'Calendar still uses it');
  without('g');
  assert.equal(await g.shouldRevokeNativeGrant(db, { id: 'c', workspace_id: WS, account_email: 'b@x.com' }), false, 'another workspace on this install still uses it');
  without('c');
  assert.equal(await g.shouldRevokeNativeGrant(db, { id: 'other-ws', workspace_id: 'ws-2', account_email: 'B@x.com' }), true, 'the last one revokes');
  assert.equal(await g.shouldRevokeNativeGrant(db, { id: 'n', workspace_id: WS, account_email: 'solo@x.com' }), true, 'Composio rows do not hold our grant');
});

// ── Config ────────────────────────────────────────────────────────────────────

test('the redirect URI is derived from API_DOMAIN when unset or left at the example placeholder', () => {
  const base = { GOOGLE_CLIENT_ID: 'a', GOOGLE_CLIENT_SECRET: 'b' };
  assert.equal(g.nativeGoogleConfigured(base), false);
  assert.equal(g.nativeGoogleConfigured({ ...base, API_DOMAIN: 'api.acme.io' }), true);
  assert.equal(g.googleRedirectUri({ ...base, API_DOMAIN: 'api.acme.io', GOOGLE_OAUTH_REDIRECT_URI: 'https://api.yourdomain.com/api/oauth/google/callback' }), 'https://api.acme.io/api/oauth/google/callback');
  const u = new URL(g.buildAuthUrl({ provider: 'gmail_oauth', state: 's', challenge: 'c', env: { ...base, API_DOMAIN: 'api.acme.io' } }));
  assert.equal(u.searchParams.get('redirect_uri'), 'https://api.acme.io/api/oauth/google/callback');
});

// ── Mounting ──────────────────────────────────────────────────────────────────

test('the route is mounted on open-source builds only, so Cloud\'s route table is unchanged', () => {
  const src = readFileSync(new URL('../src/index.mjs', import.meta.url), 'utf8');
  assert.match(src, /if \(!HAS_CLOUD\) app\.use\('\/api\/oauth\/google',\s+oauthGoogleRouter\);/);
  const route = readFileSync(new URL('../src/routes/api/oauthGoogle.mjs', import.meta.url), 'utf8');
  assert.match(route, /oauthGoogleRouter\.get\('\/:product\/authorize', verifySupabaseAuth,/, 'authorize needs a member session');
  assert.match(route, /if \(mode !== 'native'\)/, 'authorize refuses where Composio is the transport');
  assert.match(route, /oauthGoogleRouter\.post\('\/complete', verifySupabaseAuth,/, 'completing needs a member session');
  const cb = route.slice(route.indexOf("oauthGoogleRouter.get('/callback'"), route.indexOf('const discardLimiter'));
  assert.doesNotMatch(cb, /save|completeGoogleConnection/i, 'the callback itself saves nothing');
  assert.match(cb, /'Content-Security-Policy': `default-src 'none'; script-src 'nonce-/, 'the hand-off page runs only its own script');
  assert.match(route, /oauthGoogleRouter\.post\('\/discard', discardLimiter,/, 'discard is rate-limited');
});
