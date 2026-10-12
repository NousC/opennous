/**
 * Teams & Invitations tests
 * Auth-enforcement tests run without Supabase.
 * Validation tests require TEST_USER_TOKEN + TEST_TEAM_ID env vars.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { get, post, patch, del, stopServer, hasSupabase } from './helpers.mjs';

after(stopServer);

const FAKE_TEAM = '00000000-0000-0000-0000-000000000001';
const FAKE_INV  = '00000000-0000-0000-0000-000000000002';

// ── Auth enforcement (no Supabase needed) ─────────────────────────────────────

test('POST /api/teams/:id/invitations → 401 without auth', async () => {
  const res = await post(`/api/teams/${FAKE_TEAM}/invitations`, { email: 'test@example.com' });
  assert.equal(res.status, 401);
});

test('GET /api/teams/:id/invitations → 401 without auth', async () => {
  const res = await get(`/api/teams/${FAKE_TEAM}/invitations`);
  assert.equal(res.status, 401);
});

test('DELETE /api/teams/:id/invitations/:invId → 401 without auth', async () => {
  const res = await del(`/api/teams/${FAKE_TEAM}/invitations/${FAKE_INV}`);
  assert.equal(res.status, 401);
});

test('GET /api/teams/:id/members → 401 without auth', async () => {
  const res = await get(`/api/teams/${FAKE_TEAM}/members`);
  assert.equal(res.status, 401);
});

test('GET /api/teams/:id/workspaces → 401 without auth', async () => {
  const res = await get(`/api/teams/${FAKE_TEAM}/workspaces`);
  assert.equal(res.status, 401);
});

test('PATCH /api/teams/:id → 401 without auth', async () => {
  const res = await patch(`/api/teams/${FAKE_TEAM}`, { name: 'Updated' });
  assert.equal(res.status, 401);
});

test('DELETE /api/teams/:id/members/:userId → 401 without auth', async () => {
  const res = await del(`/api/teams/${FAKE_TEAM}/members/some-user-id`);
  assert.equal(res.status, 401);
});

// ── Input validation (requires valid Supabase JWT) ────────────────────────────

const token = process.env.TEST_USER_TOKEN;
const teamId = process.env.TEST_TEAM_ID;
const canValidate = hasSupabase && !!token && !!teamId;

function skipValidation(name, fn) {
  if (canValidate) return test(name, fn);
  test(name, { skip: 'TEST_USER_TOKEN / TEST_TEAM_ID not set' }, fn);
}

const auth = () => ({ Authorization: `Bearer ${token}` });

skipValidation('POST invitation — missing email → 400', async () => {
  const res = await post(`/api/teams/${teamId}/invitations`, {}, auth());
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error, 'email is required');
});

skipValidation('POST invitation — invalid email format → 400', async () => {
  const res = await post(`/api/teams/${teamId}/invitations`, { email: 'not-an-email' }, auth());
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error, 'invalid_email_format');
});

skipValidation('POST invitation — invalid role → 400', async () => {
  const res = await post(`/api/teams/${teamId}/invitations`, { email: 'x@example.com', role: 'superadmin' }, auth());
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error, 'invalid_role');
});

skipValidation('GET /api/invitations/:token — invalid token → 404', async () => {
  const res = await get('/api/invitations/this-token-does-not-exist-abc123');
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.error, 'invitation_not_found');
});
