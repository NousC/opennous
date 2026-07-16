/**
 * CRM route tests — auth enforcement (always run) + import validation (needs Supabase + credentials).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { get, post, stopServer, hasSupabase } from './helpers.mjs';

after(stopServer);

const FAKE = '00000000-0000-0000-0000-000000000001';

// ── Auth enforcement (no Supabase needed) ─────────────────────────────────────

test('GET /api/crm/records → 401 without auth', async () => {
  const res = await get(`/api/crm/records?provider=hubspot&type=contact&connectionId=${FAKE}&workspaceId=${FAKE}`);
  assert.equal(res.status, 401);
});

test('POST /api/crm/import → 401 without auth', async () => {
  const res = await post('/api/crm/import', {
    workspaceId: FAKE, provider: 'hubspot', connectionId: FAKE, records: [],
  });
  assert.equal(res.status, 401);
});

test('GET /api/crm/sync-config → 401 without auth', async () => {
  const res = await get(`/api/crm/sync-config?workspaceId=${FAKE}&provider=hubspot`);
  assert.equal(res.status, 401);
});

test('POST /api/crm/sync-config → 401 without auth', async () => {
  const res = await post('/api/crm/sync-config', { workspaceId: FAKE, provider: 'hubspot' });
  assert.equal(res.status, 401);
});

test('POST /api/crm/sync-now → 401 without auth', async () => {
  const res = await post('/api/crm/sync-now', { workspaceId: FAKE });
  assert.equal(res.status, 401);
});

// ── Import endpoint validation (requires valid JWT + real connection) ──────────

const token = process.env.TEST_USER_TOKEN;
const workspaceId = process.env.TEST_WORKSPACE_ID;
const canValidate = hasSupabase && !!token && !!workspaceId;

function skipValidation(name, fn) {
  if (canValidate) return test(name, fn);
  test(name, { skip: 'TEST_USER_TOKEN / TEST_WORKSPACE_ID not set' }, fn);
}

const auth = () => ({ Authorization: `Bearer ${token}` });

skipValidation('POST /api/crm/import — empty records array → 400', async () => {
  const res = await post('/api/crm/import', {
    workspaceId, provider: 'hubspot', connectionId: FAKE, records: [],
  }, auth());
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.ok(body.error, 'should return error');
});

skipValidation('POST /api/crm/import — missing provider → 400', async () => {
  const res = await post('/api/crm/import', {
    workspaceId, connectionId: FAKE, records: [{ id: '1', type: 'contact' }],
  }, auth());
  assert.equal(res.status, 400);
});

skipValidation('POST /api/crm/import — unknown connection → 404', async () => {
  const res = await post('/api/crm/import', {
    workspaceId, provider: 'hubspot', connectionId: FAKE,
    records: [{ id: '1', type: 'contact', name: 'Test', email: 'test@example.com' }],
  }, auth());
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.error, 'connection_not_found');
});
