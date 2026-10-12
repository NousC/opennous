import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { get, post, stopServer, hasSupabase } from './helpers.mjs';

after(stopServer);

function withSupabase(name, fn) {
  if (hasSupabase) return test(name, fn);
  test(name, { skip: 'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set' }, fn);
}

// The v2 Context API rejects before touching Supabase (missing header check)
test('GET /v2/accounts/:id → 401 without API key', async () => {
  const res = await get('/v2/accounts/test');
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.equal(body.error, 'api_key_required');
});

test('GET /v2/attention → 401 without API key', async () => {
  const res = await get('/v2/attention');
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.equal(body.error, 'api_key_required');
});

test('GET /api/admin/users → 401 without token', async () => {
  const res = await get('/api/admin/users');
  assert.equal(res.status, 401);
});

test('GET /api/admin/blog/articles → 401 without token', async () => {
  const res = await get('/api/admin/blog/articles');
  assert.equal(res.status, 401);
});

test('POST /api/invitations/bad-token/accept → 401 without auth', async () => {
  const res = await post('/api/invitations/bad-token/accept', {});
  assert.equal(res.status, 401);
});

// These routes call Supabase to validate the token/key — require credentials
const protectedGetRoutes = [
  '/api/me',
  '/api/workspaces',
  '/api/usage',
  '/api/workspace/api-keys',
  '/api/workspace/system-log?workspace_id=00000000-0000-0000-0000-000000000000',
];

for (const route of protectedGetRoutes) {
  withSupabase(`GET ${route} → 401 without token`, async () => {
    const res = await get(route);
    assert.equal(res.status, 401, `Expected 401 for ${route}`);
    const body = await res.json();
    assert.ok(body.error, `Expected error field for ${route}`);
  });
}

withSupabase('GET /v2/accounts/:id with bad API key → 401', async () => {
  const res = await get('/v2/accounts/test', { 'x-api-key': 'not-a-real-key' });
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.equal(body.error, 'invalid_api_key');
});

withSupabase('GET /api/me with malformed Bearer token → 401', async () => {
  const res = await get('/api/me', { Authorization: 'Bearer not-a-jwt' });
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.equal(body.error, 'invalid_token');
});
