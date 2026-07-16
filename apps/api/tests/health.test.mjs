import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { get, stopServer, hasSupabase } from './helpers.mjs';

after(stopServer);

function withSupabase(name, fn) {
  if (hasSupabase) return test(name, fn);
  test(name, { skip: 'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set' }, fn);
}

// No Supabase needed — pure in-process checks
test('GET /health returns ok', async () => {
  const res = await get('/health');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
});

test('GET /unknown returns 404', async () => {
  const res = await get('/not-a-real-route');
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.error, 'not_found');
});

// These read from Supabase even though they're public endpoints
withSupabase('GET /api/roadmap/items returns items array', async () => {
  const res = await get('/api/roadmap/items');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body.items), 'items should be an array');
});

withSupabase('GET /api/updates returns updates array', async () => {
  const res = await get('/api/updates');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body.updates), 'updates should be an array');
});
