// Admin-only config writes, and a viewer that can only view (GET-1059). Workspace configuration
// (onboarding profile, scoring model, stage ladder, integration credentials, CRM sync policy,
// CRM proposal approval, ICP) is the team's, so a member-scoped key (every member's OAuth or MCP
// connector) gets 403 admin_key_required before the handler runs. A viewer's key is read-only
// whatever it was minted as, because the middleware reads the owner's live role.
//
// Run: cd apps/api && node --test tests/adminOnlyConfigWrites.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import express from 'express';
import { workspaceStatusV2Router } from '../src/routes/v2/workspaceStatus.mjs';
import { icpV2Router } from '../src/routes/v2/icp.mjs';
import { createVerifyApiKey } from '../src/middleware/apiKey.mjs';

const WS = '11111111-1111-4111-8111-111111111111';
const REP = '33333333-3333-4333-8333-333333333333';

// Every admin-only write, as mounted in index.mjs.
const ADMIN_ONLY = [
  ['post', '/v2/workspace/onboarding'],
  ['post', '/v2/workspace/scoring-model'],
  ['put', '/v2/workspace/stages'],
  ['post', '/v2/workspace/integrations'],
  ['post', '/v2/workspace/crm-sync'],
  ['post', '/v2/workspace/crm-hygiene/abc'],
  ['post', '/v2/workspace/icp/import'],
  ['put', '/v2/icp'],
  ['put', '/v2/icp/scorer'],
  ['put', '/v2/icp/tiers'],
];

async function startApp(viewerScope) {
  const app = express();
  app.use(express.json());
  // Stand-in for verifyApiKey: the scope is all the gate reads.
  app.use((req, _res, next) => { req.workspaceId = WS; req.viewerScope = viewerScope; req.isApiKeyAuth = true; next(); });
  app.use('/v2/workspace', workspaceStatusV2Router);
  app.use('/v2/icp', icpV2Router);
  // Anything that got past the gate stops here instead of touching a database.
  app.use((err, _req, res, _next) => res.status(599).json({ error: 'reached_handler', detail: String(err?.message) }));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

const send = (base, method, path) => fetch(base + path, {
  method: method.toUpperCase(), headers: { 'Content-Type': 'application/json' }, body: '{}',
});

test('a member-scoped key gets 403 admin_key_required on every config write', async () => {
  const app = await startApp('member');
  try {
    for (const [method, path] of ADMIN_ONLY) {
      const r = await send(app.base, method, path);
      assert.equal(r.status, 403, `${method} ${path}`);
      assert.equal((await r.json()).error, 'admin_key_required', `${method} ${path}`);
    }
  } finally { await app.close(); }
});

test('an admin-scoped key passes the gate on every config write', async () => {
  const app = await startApp('admin');
  try {
    for (const [method, path] of ADMIN_ONLY) {
      const r = await send(app.base, method, path);
      const body = await r.json().catch(() => ({}));
      assert.notEqual(body.error, 'admin_key_required', `${method} ${path}`);
    }
  } finally { await app.close(); }
});

// ── Viewer keys are read-only ─────────────────────────────────────────────────────────────

const raw = 'pk_' + 'ef'.repeat(24);
function tables(members) {
  const db = {
    api_keys: [{ id: 'k1', workspace_id: WS, owner_user_id: REP, scope: 'member', capability: 'read_write',
      expires_at: null, revoked_at: null, key_hash: crypto.createHash('sha256').update(raw).digest('hex') }],
    workspace_members: members,
  };
  return {
    from(table) {
      const rows = db[table] ?? [];
      const filters = [];
      const match = (r) => filters.every(([op, c, v]) => (op === 'eq' ? r[c] === v : (r[c] ?? null) === v));
      const b = {
        select() { return b; }, update() { return b; },
        eq(c, v) { filters.push(['eq', c, v]); return b; },
        is(c, v) { filters.push(['is', c, v]); return b; },
        maybeSingle() { return Promise.resolve({ data: rows.find(match) ?? null, error: null }); },
        then(resolve) { return Promise.resolve({ data: [], error: null }).then(resolve); },
      };
      return b;
    },
  };
}
function call(mw, method, originalUrl) {
  return new Promise((resolve) => {
    const req = { headers: { 'x-api-key': raw }, method, originalUrl };
    const res = {
      statusCode: 200, on() {},
      status(c) { this.statusCode = c; return this; },
      json(b) { resolve({ status: this.statusCode, body: b, req }); return this; },
    };
    mw(req, res, () => resolve({ status: 'next', req }));
  });
}

test('a viewer\'s read_write key is read-only: reads go through, writes get 403 read_only_key', async () => {
  const mw = createVerifyApiKey(() => tables([{ workspace_id: WS, user_id: REP, role: 'viewer' }]));
  const read = await call(mw, 'GET', '/v2/attention');
  assert.equal(read.status, 'next');
  assert.equal(read.req.keyCapability, 'read_only');
  const ctx = await call(mw, 'POST', '/v2/context');
  assert.equal(ctx.status, 'next');
  const write = await call(mw, 'POST', '/v2/observations');
  assert.equal(write.status, 403);
  assert.equal(write.body.error, 'read_only_key');
});

test('a member\'s read_write key keeps writing', async () => {
  const mw = createVerifyApiKey(() => tables([{ workspace_id: WS, user_id: REP, role: 'member' }]));
  const write = await call(mw, 'POST', '/v2/observations');
  assert.equal(write.status, 'next');
  assert.equal(write.req.keyCapability, 'read_write');
});
