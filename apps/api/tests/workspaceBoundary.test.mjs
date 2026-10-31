// The workspace comes from the credential (GET-247), and a workspace key reads no raw content
// (GET-248). Both are decided at the door, so no route can forget them.
//
// Run: cd apps/api && node --test tests/workspaceBoundary.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { NO_CONTENT_VIEWER } from '@nous/core';
import { createVerifyApiKey } from '../src/middleware/apiKey.mjs';
import { verifyAuth } from '../src/middleware/supabaseAuth.mjs';
import { viewerReadContext } from '../src/lib/messagePrivacy.mjs';

const WS = '11111111-1111-4111-8111-111111111111';
const OTHER_WS = '44444444-4444-4444-8444-444444444444';
const REP = '33333333-3333-4333-8333-333333333333';
const raw = 'pk_' + 'cd'.repeat(24);

function client(keyRow) {
  return {
    from(table) {
      const rows = table === 'api_keys' ? [keyRow] : [{ workspace_id: WS, user_id: REP, role: 'member' }];
      const b = {
        select() { return b; }, update() { return b; }, eq() { return b; }, is() { return b; },
        maybeSingle() { return Promise.resolve({ data: rows[0], error: null }); },
        then(ok) { return Promise.resolve({ data: rows, error: null }).then(ok); },
      };
      return b;
    },
  };
}

const key = (extra = {}) => ({
  id: 'k', workspace_id: WS, owner_user_id: REP, scope: 'member', capability: 'read_write', expires_at: null,
  revoked_at: null, key_hash: crypto.createHash('sha256').update(raw).digest('hex'), ...extra,
});

function run(mw, request) {
  return new Promise((resolve) => {
    const req = { headers: { 'x-api-key': raw }, method: 'GET', originalUrl: '/v2/attention', query: {}, ...request };
    const res = {
      statusCode: 200,
      on() {},
      status(c) { this.statusCode = c; return this; },
      json(b) { resolve({ status: this.statusCode, body: b, req }); return this; },
    };
    mw(req, res, () => resolve({ status: 'next', req }));
  });
}

const withKey = (row, request) => run(createVerifyApiKey(() => client(row)), request);
const withSession = (query, body) => run(verifyAuth, {
  headers: { authorization: 'Bearer session' }, query, body,
});

// ── GET-247: an API key ──────────────────────────────────────────────────────────────────────────

for (const [where, request] of [
  ['query workspaceId', { query: { workspaceId: OTHER_WS } }],
  ['query workspace_id', { query: { workspace_id: OTHER_WS } }],
  ['body workspaceId', { method: 'POST', originalUrl: '/api/lead-lists', body: { workspaceId: OTHER_WS } }],
  ['body workspace_id', { method: 'POST', originalUrl: '/api/lead-lists', body: { workspace_id: OTHER_WS } }],
]) {
  test(`a key naming another workspace in the ${where} is refused`, async () => {
    const out = await withKey(key(), request);
    assert.equal(out.status, 403);
    assert.equal(out.body.error, 'workspace_mismatch');
  });
}

test('a key naming its own workspace, or none, passes', async () => {
  assert.equal((await withKey(key(), { query: { workspaceId: WS } })).status, 'next');
  assert.equal((await withKey(key(), {})).status, 'next');
});

test('a repeated parameter is refused rather than read as a list', async () => {
  const out = await withKey(key(), { query: { workspaceId: [WS, OTHER_WS] } });
  assert.equal(out.status, 403);
});

// ── GET-247: a session ───────────────────────────────────────────────────────────────────────────

test('a session cannot have one workspace checked and another used', async () => {
  // The check read the query first; a handler reading the body then used a workspace nobody checked.
  for (const [query, body] of [
    [{ workspaceId: WS }, { workspaceId: OTHER_WS }],
    [{ workspace_id: WS }, { workspaceId: OTHER_WS }],
    [{ workspaceId: WS }, { workspace_id: OTHER_WS }],
    [{ workspaceId: WS, workspace_id: OTHER_WS }, {}],
    [{ workspaceId: [WS, OTHER_WS] }, {}],
  ]) {
    const out = await withSession(query, body);
    assert.equal(out.status, 400);
    assert.equal(out.body.error, 'workspace_mismatch');
  }
});

// ── GET-248: a workspace key ─────────────────────────────────────────────────────────────────────

test('a workspace key reads as nobody, so no message, transcript or raw payload is theirs', async () => {
  const out = await withKey(key({ owner_user_id: null, scope: 'admin' }), {});
  assert.equal(out.status, 'next');
  assert.equal(out.req.viewerScope, 'admin');
  assert.equal(out.req.memberUserId, NO_CONTENT_VIEWER);
  assert.equal(viewerReadContext(out.req).viewerUserId, NO_CONTENT_VIEWER);
});

test('the read-shaped POSTs read as nobody too', async () => {
  const out = await withKey(key({ owner_user_id: null }), { method: 'POST', originalUrl: '/v2/context', body: {} });
  assert.equal(out.req.memberUserId, NO_CONTENT_VIEWER);
});

test('a workspace key writes unattributed: nobody is not a row in users', async () => {
  const out = await withKey(key({ owner_user_id: null }), { method: 'POST', originalUrl: '/v2/notes', body: {} });
  assert.equal(out.status, 'next');
  assert.equal(out.req.memberUserId, null);
  assert.equal(viewerReadContext(out.req).viewerUserId, NO_CONTENT_VIEWER);
});

test('a member key still acts as its person', async () => {
  const out = await withKey(key(), {});
  assert.equal(out.req.memberUserId, REP);
  assert.equal(out.req.noContent, false);
});
