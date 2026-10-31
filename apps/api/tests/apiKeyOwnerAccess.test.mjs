// Access follows the person (GET-1058). A key acts AS the member who made it, so it must stop
// when that person leaves the workspace and must never see more than that person's role allows
// today: removal → 401, demotion → member scope from the next call, promotion does not widen an
// old key. Shared workspace keys (no owner, made by an admin) are not tied to a person and keep
// working. Also covers revokeMemberKeys, which removal paths call so the keys are dead in the
// table too, not only refused at the door.
//
// Run: cd apps/api && node --test tests/apiKeyOwnerAccess.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createVerifyApiKey } from '../src/middleware/apiKey.mjs';
import { revokeMemberKeys } from '../src/lib/apiKeyScope.mjs';

const WS = '11111111-1111-4111-8111-111111111111';
const OTHER_WS = '44444444-4444-4444-8444-444444444444';
const KEY_ID = '22222222-2222-4222-8222-222222222222';
const REP = '33333333-3333-4333-8333-333333333333';

/** In-memory tables with just the builder calls the middleware and revokeMemberKeys make. */
function tables(init) {
  const db = { api_keys: [], workspace_members: [], oauth_tokens: [], ...init };
  return {
    db,
    from(table) {
      const rows = db[table] ?? (db[table] = []);
      const filters = [];
      let values = null;
      const match = (r) => filters.every(([op, c, v]) =>
        op === 'eq' ? r[c] === v : op === 'in' ? v.includes(r[c]) : (r[c] ?? null) === v);
      const b = {
        select() { return b; },
        update(v) { values = v; return b; },
        eq(c, v) { filters.push(['eq', c, v]); return b; },
        in(c, v) { filters.push(['in', c, v]); return b; },
        is(c, v) { filters.push(['is', c, v]); return b; },
        maybeSingle() { return Promise.resolve({ data: rows.find(match) ?? null, error: null }); },
        then(resolve, reject) {
          const hit = rows.filter(match);
          if (values) hit.forEach((r) => Object.assign(r, values));
          return Promise.resolve({ data: hit, error: null }).then(resolve, reject);
        },
      };
      return b;
    },
  };
}

const raw = 'pk_' + 'cd'.repeat(24);
const keyRow = (extra = {}) => ({
  id: KEY_ID, workspace_id: WS, owner_user_id: REP, scope: 'member', capability: 'read_write',
  expires_at: null, revoked_at: null, key_hash: crypto.createHash('sha256').update(raw).digest('hex'), ...extra,
});
const membership = (role, extra = {}) => ({ workspace_id: WS, user_id: REP, role, ...extra });

function call(mw) {
  return new Promise((resolve) => {
    const req = { headers: { 'x-api-key': raw }, method: 'GET', originalUrl: '/v2/attention' };
    const res = {
      statusCode: 200,
      on() {},
      status(c) { this.statusCode = c; return this; },
      json(b) { resolve({ status: this.statusCode, body: b, req }); return this; },
    };
    mw(req, res, () => resolve({ status: 'next', req }));
  });
}

test('a member key works while its owner is a member, scoped to that member', async () => {
  const sb = tables({ api_keys: [keyRow()], workspace_members: [membership('member')] });
  const out = await call(createVerifyApiKey(() => sb));
  assert.equal(out.status, 'next');
  assert.equal(out.req.memberUserId, REP);
  assert.equal(out.req.viewerScope, 'member');
});

test('removed from the workspace → the key is refused from its next call', async () => {
  const sb = tables({ api_keys: [keyRow()], workspace_members: [membership('member')] });
  const mw = createVerifyApiKey(() => sb);
  assert.equal((await call(mw)).status, 'next');
  sb.db.workspace_members.length = 0; // what removeTeamMember / DELETE members/:userId do
  const out = await call(mw);
  assert.equal(out.status, 401);
  assert.equal(out.body.error, 'key_owner_not_member');
});

test('membership of another workspace does not count', async () => {
  const sb = tables({ api_keys: [keyRow()], workspace_members: [membership('admin', { workspace_id: OTHER_WS })] });
  const out = await call(createVerifyApiKey(() => sb));
  assert.equal(out.status, 401);
  assert.equal(out.body.error, 'key_owner_not_member');
});

test('demoted admin → their admin key gets member scope from the next call', async () => {
  const sb = tables({ api_keys: [keyRow({ scope: 'admin' })], workspace_members: [membership('admin')] });
  const mw = createVerifyApiKey(() => sb);
  assert.equal((await call(mw)).req.viewerScope, 'admin');
  sb.db.workspace_members[0].role = 'member'; // PATCH /api/teams/:teamId/members/:userId
  assert.equal((await call(mw)).req.viewerScope, 'member');
});

test('promotion does not widen an old member key, and viewer is member scope', async () => {
  const promoted = tables({ api_keys: [keyRow({ scope: 'member' })], workspace_members: [membership('owner')] });
  assert.equal((await call(createVerifyApiKey(() => promoted))).req.viewerScope, 'member');
  const viewer = tables({ api_keys: [keyRow({ scope: 'admin' })], workspace_members: [membership('viewer')] });
  assert.equal((await call(createVerifyApiKey(() => viewer))).req.viewerScope, 'member');
});

test('a legacy owned key with no scope stays member scope even for an owner', async () => {
  const sb = tables({ api_keys: [keyRow({ scope: null })], workspace_members: [membership('owner')] });
  assert.equal((await call(createVerifyApiKey(() => sb))).req.viewerScope, 'member');
});

test('a shared workspace key (no owner) is not tied to a person and keeps admin scope', async () => {
  const sb = tables({ api_keys: [keyRow({ owner_user_id: null, scope: 'admin' })] });
  const out = await call(createVerifyApiKey(() => sb));
  assert.equal(out.status, 'next');
  assert.equal(out.req.viewerScope, 'admin');
  assert.equal(out.req.memberUserId, null);
});

test('revokeMemberKeys revokes the person\'s live keys and OAuth tokens in the given workspaces only', async () => {
  const live = keyRow();
  const elsewhere = keyRow({ id: 'k-other-ws', workspace_id: OTHER_WS });
  const someoneElse = keyRow({ id: 'k-colleague', owner_user_id: 'u-colleague' });
  const sb = tables({
    api_keys: [live, elsewhere, someoneElse],
    oauth_tokens: [
      { id: 't1', api_key_id: KEY_ID, revoked_at: null },
      { id: 't2', api_key_id: 'k-other-ws', revoked_at: null },
    ],
  });
  const ids = await revokeMemberKeys(sb, REP, { workspaceIds: [WS] });
  assert.deepEqual(ids, [KEY_ID]);
  assert.ok(live.revoked_at);
  assert.equal(elsewhere.revoked_at, null);
  assert.equal(someoneElse.revoked_at, null);
  assert.ok(sb.db.oauth_tokens[0].revoked_at);
  assert.equal(sb.db.oauth_tokens[1].revoked_at, null);
});

test('revokeMemberKeys with no workspace list revokes the person\'s keys everywhere', async () => {
  const a = keyRow();
  const b = keyRow({ id: 'k-other-ws', workspace_id: OTHER_WS });
  const sb = tables({ api_keys: [a, b] });
  const ids = await revokeMemberKeys(sb, REP);
  assert.deepEqual(ids.sort(), [KEY_ID, 'k-other-ws'].sort());
  assert.ok(a.revoked_at && b.revoked_at);
});

test('revokeMemberKeys does nothing without a user, or with an empty workspace list', async () => {
  const sb = tables({ api_keys: [keyRow()] });
  assert.deepEqual(await revokeMemberKeys(sb, null), []);
  assert.deepEqual(await revokeMemberKeys(sb, REP, { workspaceIds: [] }), []);
  assert.equal(sb.db.api_keys[0].revoked_at, null);
});
