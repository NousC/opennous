// MCP OAuth (GET-762): the authorization server Grok, Claude.ai and ChatGPT use to
// sign in to the hosted MCP. The routes run over an in-memory Supabase, so the whole
// flow is exercised end to end: register → authorize → consent → token → use →
// refresh → reuse detection → revoke.
//
// Run: cd apps/api && node --test tests/mcpOAuth.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import express from 'express';
import { createOAuthRouters, authorizationServerMetadataHandler } from '../src/routes/oauth.mjs';
import { createVerifyApiKey } from '../src/middleware/apiKey.mjs';
import {
  verifyPkce, isAllowedRedirectUri, displayFor, validateRegistration, validateAuthorizeParams, authorizationServerMetadata,
} from '../src/lib/oauth.mjs';

const WS = '11111111-1111-4111-8111-111111111111';
const USER = '33333333-3333-4333-8333-333333333333';
const REDIRECT = 'https://grok.com/oauth/callback';

// ── In-memory Supabase: enough of the query builder for these routes ─────────────────────────

// Column defaults the migration sets.
const DEFAULTS = { oauth_authorization_requests: { status: 'pending' } };

function memorySupabase() {
  const tables = { oauth_clients: [], oauth_authorization_requests: [], oauth_tokens: [], api_keys: [] };
  const matches = (row, filters) => filters.every(([op, c, v]) =>
    op === 'eq' ? row[c] === v : op === 'is' ? (row[c] ?? null) === v : true);
  return {
    tables,
    from(table) {
      const rows = tables[table] ?? (tables[table] = []);
      const q = { op: 'select', filters: [] };
      const run = () => {
        if (q.op === 'insert') {
          const list = (Array.isArray(q.values) ? q.values : [q.values])
            .map((r) => ({ id: crypto.randomUUID(), revoked_at: null, created_at: new Date().toISOString(), ...DEFAULTS[table], ...r }));
          for (const r of list) {
            if (table === 'oauth_tokens' && rows.some((x) => x.token_hash === r.token_hash)) {
              return { data: null, error: { code: '23505' } };
            }
          }
          rows.push(...list);
          return { data: list, error: null };
        }
        const hit = rows.filter((r) => matches(r, q.filters));
        if (q.op === 'update') for (const r of hit) Object.assign(r, q.values);
        return { data: hit.map((r) => ({ ...r })), error: null };
      };
      const one = () => {
        const { data, error } = run();
        return Promise.resolve({ data: data?.[0] ?? null, error });
      };
      const b = {
        select() { return b; },
        insert(v) { q.op = 'insert'; q.values = v; return b; },
        update(v) { q.op = 'update'; q.values = v; return b; },
        eq(c, v) { q.filters.push(['eq', c, v]); return b; },
        is(c, v) { q.filters.push(['is', c, v]); return b; },
        order() { return b; },
        limit() { return b; },
        maybeSingle: one,
        single: one,
        then(resolve, reject) { return Promise.resolve(run()).then(resolve, reject); },
      };
      return b;
    },
  };
}

// The consent API needs a signed-in session; the fake stands in for verifySupabaseAuth.
const fakeSession = (req, res, next) => {
  if (req.headers.authorization !== 'Bearer session') return res.status(401).json({ error: 'auth_required' });
  req.workspaceId = req.body?.workspace_id ?? req.query.workspace_id;
  req.workspaceRole = 'member';
  req.internalUserId = USER;
  next();
};

async function startApp() {
  const db = memorySupabase();
  const { oauthRouter, oauthConsentRouter } = createOAuthRouters({
    getClient: () => db, requireSession: fakeSession, audit: () => {},
  });
  const verifyApiKey = createVerifyApiKey(() => db);
  const app = express();
  app.use(express.json());
  app.get('/.well-known/oauth-authorization-server', authorizationServerMetadataHandler);
  app.use('/oauth', express.urlencoded({ extended: false }), oauthRouter);
  app.use('/api/mcp-oauth', oauthConsentRouter);
  app.get('/v2/whoami', verifyApiKey, (req, res) => res.json({
    workspaceId: req.workspaceId, memberUserId: req.memberUserId, viewerScope: req.viewerScope,
  }));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { db, base, close: () => new Promise((r) => server.close(r)) };
}

const form = (base, path, body) => fetch(`${base}${path}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(body).toString(),
});
const json = (base, path, body, headers = {}) => fetch(`${base}${path}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify(body),
});

function pkcePair() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

// Register, authorize, approve. Returns what the client holds at the redirect.
async function signIn(base, { redirect = REDIRECT } = {}) {
  const reg = await json(base, '/oauth/register', { client_name: 'Grok', redirect_uris: [redirect] });
  assert.equal(reg.status, 201);
  const { client_id } = await reg.json();
  const { verifier, challenge } = pkcePair();
  const qs = new URLSearchParams({
    response_type: 'code', client_id, redirect_uri: redirect, code_challenge: challenge,
    code_challenge_method: 'S256', state: 'xyz', resource: 'https://mcp.opennous.cloud/mcp',
  });
  const auth = await fetch(`${base}/oauth/authorize?${qs}`, { redirect: 'manual' });
  assert.equal(auth.status, 302);
  const consentUrl = new URL(auth.headers.get('location'));
  assert.equal(consentUrl.pathname, '/oauth/consent');
  const requestId = consentUrl.searchParams.get('request');

  const info = await fetch(`${base}/api/mcp-oauth/requests/${requestId}`, { headers: { Authorization: 'Bearer session' } });
  assert.deepEqual(await info.json(), { display_name: 'Grok', verified: true, redirect_host: new URL(redirect).host });

  const ok = await json(base, `/api/mcp-oauth/requests/${requestId}/approve`, { workspace_id: WS }, { Authorization: 'Bearer session' });
  assert.equal(ok.status, 200);
  const back = new URL((await ok.json()).redirect_to);
  assert.equal(`${back.origin}${back.pathname}`, redirect);
  assert.equal(back.searchParams.get('state'), 'xyz');
  return { client_id, verifier, code: back.searchParams.get('code'), requestId };
}

async function redeem(base, { client_id, verifier, code }, redirect = REDIRECT) {
  return form(base, '/oauth/token', {
    grant_type: 'authorization_code', client_id, code, code_verifier: verifier, redirect_uri: redirect,
  });
}

// ── Pure helpers ──────────────────────────────────────────────────────────────────────────────

test('PKCE S256 accepts the matching verifier and nothing else', () => {
  const { verifier, challenge } = pkcePair();
  assert.equal(verifyPkce(verifier, challenge), true);
  assert.equal(verifyPkce(pkcePair().verifier, challenge), false);
  assert.equal(verifyPkce('short', challenge), false);
  assert.equal(verifyPkce(undefined, challenge), false);
});

test('redirect URIs: https anywhere, http only on loopback, no fragments or custom schemes', () => {
  assert.equal(isAllowedRedirectUri('https://claude.ai/api/mcp/auth_callback'), true);
  assert.equal(isAllowedRedirectUri('http://localhost:6274/oauth/callback'), true);
  assert.equal(isAllowedRedirectUri('http://127.0.0.1:33418/cb'), true);
  assert.equal(isAllowedRedirectUri('http://evil.example/cb'), false);
  assert.equal(isAllowedRedirectUri('https://ok.example/cb#frag'), false);
  assert.equal(isAllowedRedirectUri('javascript:alert(1)'), false);
  assert.equal(isAllowedRedirectUri('not a url'), false);
});

test('registration rejects bad metadata', () => {
  assert.equal(validateRegistration({}).error, 'invalid_redirect_uri');
  assert.equal(validateRegistration({ redirect_uris: ['http://evil.example/cb'] }).error, 'invalid_redirect_uri');
  assert.equal(validateRegistration({ redirect_uris: [REDIRECT], grant_types: ['client_credentials'] }).error, 'invalid_client_metadata');
  assert.equal(validateRegistration({ redirect_uris: [REDIRECT], response_types: ['token'] }).error, 'invalid_client_metadata');
  assert.deepEqual(validateRegistration({ redirect_uris: [REDIRECT, REDIRECT], client_name: ' Grok ' }).client,
    { client_name: 'Grok', redirect_uris: [REDIRECT] });
});

test('authorize params: PKCE required, unknown redirect never redirected to, foreign resource refused', () => {
  const client = { client_id: 'c', redirect_uris: [REDIRECT] };
  const { challenge } = pkcePair();
  const good = { response_type: 'code', redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256' };
  assert.deepEqual(validateAuthorizeParams(good, client), { ok: true });
  assert.deepEqual(validateAuthorizeParams(good, null), { error: 'invalid_client', redirect: false });
  assert.equal(validateAuthorizeParams({ ...good, redirect_uri: 'https://evil.example/cb' }, client).redirect, false);
  assert.equal(validateAuthorizeParams({ ...good, code_challenge_method: 'plain' }, client).error, 'invalid_request');
  assert.equal(validateAuthorizeParams({ ...good, code_challenge: undefined }, client).error, 'invalid_request');
  assert.equal(validateAuthorizeParams({ ...good, resource: 'https://other.example/mcp' }, client).error, 'invalid_target');
  assert.equal(validateAuthorizeParams({ ...good, scope: 'admin' }, client).error, 'invalid_scope');
});

test('consent names the app by redirect host, never by the self-chosen client_name', () => {
  assert.deepEqual(displayFor('claude.ai'), { displayName: 'Claude', verified: true });
  assert.deepEqual(displayFor('chatgpt.com'), { displayName: 'ChatGPT', verified: true });
  assert.deepEqual(displayFor('grok.com'), { displayName: 'Grok', verified: true });
  assert.deepEqual(displayFor('evil.example'), { displayName: 'evil.example', verified: false });
  assert.deepEqual(displayFor('claude.ai.evil.example'), { displayName: 'claude.ai.evil.example', verified: false });
  assert.equal(displayFor('localhost:6274').verified, false);
});

test('authorization-server metadata advertises the endpoints MCP clients look for', () => {
  const m = authorizationServerMetadata('https://api.example');
  assert.equal(m.issuer, 'https://api.example');
  assert.equal(m.token_endpoint, 'https://api.example/oauth/token');
  assert.equal(m.registration_endpoint, 'https://api.example/oauth/register');
  assert.deepEqual(m.code_challenge_methods_supported, ['S256']);
  assert.deepEqual(m.grant_types_supported, ['authorization_code', 'refresh_token']);
});

// ── The flow ──────────────────────────────────────────────────────────────────────────────────

test('full flow: the access token acts as a member-scoped key in the approved workspace', async () => {
  const { db, base, close } = await startApp();
  try {
    const grant = await signIn(base);
    const tok = await redeem(base, grant);
    assert.equal(tok.status, 200);
    assert.equal(tok.headers.get('cache-control'), 'no-store');
    const t = await tok.json();
    assert.match(t.access_token, /^nat_/);
    assert.match(t.refresh_token, /^nrt_/);
    assert.equal(t.token_type, 'Bearer');
    assert.equal(t.expires_in, 3600);

    const me = await fetch(`${base}/v2/whoami`, { headers: { Authorization: `Bearer ${t.access_token}` } });
    assert.equal(me.status, 200);
    assert.deepEqual(await me.json(), { workspaceId: WS, memberUserId: USER, viewerScope: 'member' });

    // The grant is an api_keys row with an owner and member scope; the raw tokens are never stored.
    const [key] = db.tables.api_keys;
    assert.equal(key.owner_user_id, USER);
    assert.equal(key.scope, 'member');
    assert.equal(key.oauth_client_id, grant.client_id);
    const stored = JSON.stringify(db.tables);
    assert.ok(!stored.includes(t.access_token) && !stored.includes(t.refresh_token) && !stored.includes(grant.code));

    const status = await fetch(`${base}/oauth/token-status`, { headers: { Authorization: `Bearer ${t.access_token}` } });
    assert.equal(status.status, 204);
  } finally { await close(); }
});

test('a code is single-use, bound to its client, redirect and PKCE verifier', async () => {
  const { base, close } = await startApp();
  try {
    const grant = await signIn(base);
    assert.equal((await redeem(base, { ...grant, verifier: pkcePair().verifier })).status, 400);
    // A failed PKCE attempt burns the code too.
    assert.equal((await redeem(base, grant)).status, 400);

    const g2 = await signIn(base);
    assert.equal((await redeem(base, g2, 'https://grok.com/other')).status, 400);

    const g3 = await signIn(base);
    const other = await (await json(base, '/oauth/register', { redirect_uris: [REDIRECT] })).json();
    assert.equal((await redeem(base, { ...g3, client_id: other.client_id })).status, 400);

    const g4 = await signIn(base);
    assert.equal((await redeem(base, g4)).status, 200);
    assert.equal((await redeem(base, g4)).status, 400, 'replayed code');
  } finally { await close(); }
});

test('an approved code expires after a minute', async () => {
  const { db, base, close } = await startApp();
  try {
    const grant = await signIn(base);
    db.tables.oauth_authorization_requests[0].approved_at = new Date(Date.now() - 61_000).toISOString();
    const r = await redeem(base, grant);
    assert.equal(r.status, 400);
    assert.equal((await r.json()).error, 'invalid_grant');
  } finally { await close(); }
});

test('authorize refuses unknown clients and unregistered redirects without redirecting', async () => {
  const { base, close } = await startApp();
  try {
    const { challenge } = pkcePair();
    const qs = (o) => new URLSearchParams({ response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256', ...o });
    const r1 = await fetch(`${base}/oauth/authorize?${qs({ client_id: 'nope', redirect_uri: REDIRECT })}`, { redirect: 'manual' });
    assert.equal(r1.status, 400);
    const { client_id } = await (await json(base, '/oauth/register', { redirect_uris: [REDIRECT] })).json();
    const r2 = await fetch(`${base}/oauth/authorize?${qs({ client_id, redirect_uri: 'https://evil.example/cb' })}`, { redirect: 'manual' });
    assert.equal(r2.status, 400);
    assert.equal(r2.headers.get('location'), null);
    // A bad request is shown, never bounced to the (self-registered) redirect: no open redirector.
    const r3 = await fetch(`${base}/oauth/authorize?${qs({ client_id, redirect_uri: REDIRECT, code_challenge_method: 'plain', state: 's' })}`, { redirect: 'manual' });
    assert.equal(r3.status, 400);
    assert.equal(r3.headers.get('location'), null);
    // Repeated params arrive as arrays: a 400, not a crash.
    const r4 = await fetch(`${base}/oauth/authorize?${qs({ client_id, redirect_uri: REDIRECT })}&scope=a&scope=b`, { redirect: 'manual' });
    assert.equal(r4.status, 400);
  } finally { await close(); }
});

test('consent needs a session; deny sends access_denied back', async () => {
  const { base, close } = await startApp();
  try {
    const { client_id } = await (await json(base, '/oauth/register', { redirect_uris: [REDIRECT] })).json();
    const { challenge } = pkcePair();
    const qs = new URLSearchParams({ response_type: 'code', client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', state: 'st' });
    const loc = new URL((await fetch(`${base}/oauth/authorize?${qs}`, { redirect: 'manual' })).headers.get('location'));
    const id = loc.searchParams.get('request');
    assert.equal((await json(base, `/api/mcp-oauth/requests/${id}/approve`, { workspace_id: WS })).status, 401);
    const d = await json(base, `/api/mcp-oauth/requests/${id}/deny`, {}, { Authorization: 'Bearer session' });
    const back = new URL((await d.json()).redirect_to);
    assert.equal(back.searchParams.get('error'), 'access_denied');
    assert.equal(back.searchParams.get('state'), 'st');
    // Denied requests can't be approved afterwards.
    assert.equal((await json(base, `/api/mcp-oauth/requests/${id}/approve`, { workspace_id: WS }, { Authorization: 'Bearer session' })).status, 409);
  } finally { await close(); }
});

test('refresh rotates; reusing an old refresh token ends the whole grant', async () => {
  const { db, base, close } = await startApp();
  try {
    const grant = await signIn(base);
    const t1 = await (await redeem(base, grant)).json();
    const refresh = (rt) => form(base, '/oauth/token', { grant_type: 'refresh_token', client_id: grant.client_id, refresh_token: rt });

    const r2 = await refresh(t1.refresh_token);
    assert.equal(r2.status, 200);
    const t2 = await r2.json();
    assert.notEqual(t2.refresh_token, t1.refresh_token);
    assert.equal((await fetch(`${base}/v2/whoami`, { headers: { Authorization: `Bearer ${t2.access_token}` } })).status, 200);

    // A retry inside the grace window is refused but the grant survives.
    assert.equal((await refresh(t1.refresh_token)).status, 400);
    assert.equal((await fetch(`${base}/v2/whoami`, { headers: { Authorization: `Bearer ${t2.access_token}` } })).status, 200);

    // Replay after the window: refused, and every token on the grant dies.
    db.tables.oauth_tokens.find((x) => x.token_hash === crypto.createHash('sha256').update(t1.refresh_token).digest('hex'))
      .revoked_at = new Date(Date.now() - 120_000).toISOString();
    assert.equal((await refresh(t1.refresh_token)).status, 400);
    assert.equal((await refresh(t2.refresh_token)).status, 400);
    assert.equal((await fetch(`${base}/v2/whoami`, { headers: { Authorization: `Bearer ${t2.access_token}` } })).status, 401);
  } finally { await close(); }
});

test('revoking the key (Settings) cuts the client off; expired and revoked tokens get 401', async () => {
  const { db, base, close } = await startApp();
  try {
    const t = await (await redeem(base, await signIn(base))).json();
    const auth = { Authorization: `Bearer ${t.access_token}` };

    db.tables.oauth_tokens.find((x) => x.kind === 'access').expires_at = new Date(Date.now() - 1000).toISOString();
    const exp = await fetch(`${base}/v2/whoami`, { headers: auth });
    assert.equal(exp.status, 401);
    assert.equal((await exp.json()).error, 'token_expired');
    assert.equal((await fetch(`${base}/oauth/token-status`, { headers: auth })).status, 401);

    const t2 = await (await redeem(base, await signIn(base))).json();
    db.tables.api_keys[1].revoked_at = new Date().toISOString();
    assert.equal((await fetch(`${base}/v2/whoami`, { headers: { Authorization: `Bearer ${t2.access_token}` } })).status, 401);
    assert.equal((await fetch(`${base}/oauth/token-status`, { headers: { Authorization: `Bearer ${t2.access_token}` } })).status, 401);
    const rr = await form(base, '/oauth/token', { grant_type: 'refresh_token', client_id: db.tables.oauth_clients[1].client_id, refresh_token: t2.refresh_token });
    assert.equal(rr.status, 400);

    // RFC 7009 revoke: always 200, and the token stops working.
    const t3 = await (await redeem(base, await signIn(base))).json();
    assert.equal((await form(base, '/oauth/revoke', { token: t3.access_token })).status, 200);
    assert.equal((await form(base, '/oauth/revoke', { token: 'nat_unknown' })).status, 200);
    assert.equal((await fetch(`${base}/v2/whoami`, { headers: { Authorization: `Bearer ${t3.access_token}` } })).status, 401);
  } finally { await close(); }
});

test('pk_ keys still work unchanged', async () => {
  const { db, base, close } = await startApp();
  try {
    const raw = 'pk_' + crypto.randomBytes(24).toString('hex');
    db.tables.api_keys.push({ id: crypto.randomUUID(), workspace_id: WS, key_hash: crypto.createHash('sha256').update(raw).digest('hex'),
      owner_user_id: null, scope: 'admin', capability: null, expires_at: null, revoked_at: null });
    const r = await fetch(`${base}/v2/whoami`, { headers: { Authorization: `Bearer ${raw}` } });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).viewerScope, 'admin');
  } finally { await close(); }
});
