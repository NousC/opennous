// Rename, undo-revoke and extend for API keys (API plan E1–E3). The handlers are pure over the
// Supabase client, so a scripted fake answers each query in order and records what was asked.
//
// Run: cd apps/api && node --test tests/apiKeysChange.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { EXTEND_DAYS, UNDO_REVOKE_MS, extendKey, normalizeKeyName, renameKey, restoreKey } from '../src/routes/api/apiKeys.mjs';
import { createVerifyApiKey } from '../src/middleware/apiKey.mjs';

const WS = '11111111-1111-4111-8111-111111111111';
const KEY_ID = '22222222-2222-4222-8222-222222222222';
const ME = 'user-me';

/**
 * A Supabase stand-in. `answers` is a list of { data, error } handed out one per query, in the
 * order the queries finish (maybeSingle, single, or awaiting the builder). Every query is kept in
 * `queries` as { table, op, select, values, filters }.
 */
function fakeSupabase(answers) {
  const queries = [];
  const queue = [...answers];
  const next = () => Promise.resolve(queue.length ? queue.shift() : { data: null, error: null });
  const sb = {
    queries,
    from(table) {
      const q = { table, op: 'select', filters: [] };
      queries.push(q);
      const b = {
        select(c) { q.select = c; return b; },
        update(v) { q.op = 'update'; q.values = v; return b; },
        eq(c, v) { q.filters.push(['eq', c, v]); return b; },
        is(c, v) { q.filters.push(['is', c, v]); return b; },
        not(c, o, v) { q.filters.push(['not', c, o, v]); return b; },
        limit(n) { q.limit = n; return b; },
        maybeSingle: next,
        single: next,
        then(resolve, reject) { return next().then(resolve, reject); },
      };
      return b;
    },
  };
  return sb;
}

const member = { workspaceId: WS, workspaceRole: 'member', internalUserId: ME };
const admin = { workspaceId: WS, workspaceRole: 'admin', internalUserId: 'admin-1' };
const mine = { id: KEY_ID, name: 'claude-code', owner_user_id: ME, created_by_user_id: ME };
const theirs = { id: KEY_ID, name: 'n8n-prod', owner_user_id: 'u2', created_by_user_id: 'u2' };

// ── E1: rename ─────────────────────────────────────────────────────────────────────────────

test('normalizeKeyName trims and keeps 1–60 characters', () => {
  assert.deepEqual(normalizeKeyName('  agent  '), { name: 'agent' });
  assert.deepEqual(normalizeKeyName('x'.repeat(60)), { name: 'x'.repeat(60) });
  assert.deepEqual(normalizeKeyName('x'.repeat(61)), { error: 'name_too_long' });
  assert.deepEqual(normalizeKeyName('   '), { error: 'name_required' });
  assert.deepEqual(normalizeKeyName(undefined), { error: 'name_required' });
  assert.deepEqual(normalizeKeyName(42), { error: 'name_required' });
});

test('rename: validates before touching the database', async () => {
  const sb = fakeSupabase([]);
  assert.deepEqual(await renameKey(sb, member, 'nope', { name: 'a' }), { status: 400, body: { error: 'invalid_id' } });
  assert.deepEqual(await renameKey(sb, member, KEY_ID, { name: ' ' }), { status: 400, body: { error: 'name_required' } });
  assert.deepEqual(await renameKey(sb, member, KEY_ID, { name: 'y'.repeat(61) }), { status: 400, body: { error: 'name_too_long' } });
  assert.equal(sb.queries.length, 0);
});

test('rename: own key is renamed (trimmed), scoped to the workspace and active keys, and audited', async () => {
  const sb = fakeSupabase([{ data: mine, error: null }, { data: { id: KEY_ID, name: 'cursor' }, error: null }]);
  const out = await renameKey(sb, member, KEY_ID, { name: '  cursor ' });
  assert.equal(out.status, 200);
  assert.deepEqual(out.body, { id: KEY_ID, name: 'cursor' });
  assert.deepEqual(out.audit, {
    action: 'apikey.renamed', target_type: 'api_key', target_id: KEY_ID,
    target_workspace_id: WS, metadata: { from: 'claude-code', to: 'cursor' },
  });
  const upd = sb.queries[1];
  assert.equal(upd.op, 'update');
  assert.deepEqual(upd.values, { name: 'cursor' });
  assert.deepEqual(upd.filters, [['eq', 'id', KEY_ID], ['eq', 'workspace_id', WS], ['is', 'revoked_at', null]]);
});

test('rename: a member cannot rename someone else\'s key; an admin can', async () => {
  const denied = await renameKey(fakeSupabase([{ data: theirs, error: null }]), member, KEY_ID, { name: 'mine now' });
  assert.deepEqual(denied, { status: 403, body: { error: 'forbidden' } });
  const ok = await renameKey(fakeSupabase([{ data: theirs, error: null }, { data: { id: KEY_ID, name: 'n8n' }, error: null }]), admin, KEY_ID, { name: 'n8n' });
  assert.equal(ok.status, 200);
});

test('rename: a key of another workspace (or revoked) is 404', async () => {
  const sb = fakeSupabase([{ data: null, error: null }]);
  assert.deepEqual(await renameKey(sb, admin, KEY_ID, { name: 'x' }), { status: 404, body: { error: 'not_found' } });
  assert.deepEqual(sb.queries[0].filters, [['eq', 'id', KEY_ID], ['eq', 'workspace_id', WS], ['is', 'revoked_at', null]]);
});

test('rename: a name another active key has is 409; the same name is a no-op without an audit row', async () => {
  const taken = await renameKey(fakeSupabase([{ data: mine, error: null }, { data: null, error: { code: '23505', message: 'dup' } }]), member, KEY_ID, { name: 'n8n-prod' });
  assert.deepEqual(taken, { status: 409, body: { error: 'name_taken' } });
  const sb = fakeSupabase([{ data: mine, error: null }]);
  const same = await renameKey(sb, member, KEY_ID, { name: ' claude-code ' });
  assert.deepEqual(same, { status: 200, body: { id: KEY_ID, name: 'claude-code' } });
  assert.equal(sb.queries.length, 1);
});

test('rename: a write error throws (the route turns it into a 500)', async () => {
  await assert.rejects(renameKey(fakeSupabase([{ data: mine, error: null }, { data: null, error: { code: 'XX000', message: 'boom' } }]), member, KEY_ID, { name: 'b' }));
});

// ── E2: undo a revoke ──────────────────────────────────────────────────────────────────────

const NOW = Date.parse('2026-10-03T12:00:00Z');
const revoked = (minutesAgo, extra = {}) => ({
  ...mine, revoked_at: new Date(NOW - minutesAgo * 60_000).toISOString(), expires_at: null, ...extra,
});
const restoredRow = { id: KEY_ID, name: 'claude-code', capability: 'read_write', expires_at: null };

test('restore: within 10 minutes the key comes back, scoped to the workspace, and is audited', async () => {
  const sb = fakeSupabase([
    { data: revoked(3), error: null },
    { data: [], error: null },
    { data: restoredRow, error: null },
  ]);
  const out = await restoreKey(sb, member, KEY_ID, NOW);
  assert.equal(out.status, 200);
  assert.equal(out.body.name, 'claude-code');
  assert.equal(out.body.can_manage, true);
  assert.equal(out.audit.action, 'apikey.restored');
  assert.equal(out.audit.target_id, KEY_ID);
  assert.deepEqual(sb.queries[0].filters, [['eq', 'id', KEY_ID], ['eq', 'workspace_id', WS]]);
  // The rotation check looks for this key as the one a rotation replaced.
  assert.equal(sb.queries[1].table, 'audit_log');
  assert.deepEqual(sb.queries[1].filters, [['eq', 'action', 'apikey.rotated'], ['eq', 'target_workspace_id', WS], ['eq', 'metadata->>replaced', KEY_ID]]);
  const upd = sb.queries[2];
  assert.deepEqual(upd.values, { revoked_at: null });
  assert.deepEqual(upd.filters, [['eq', 'id', KEY_ID], ['eq', 'workspace_id', WS], ['not', 'revoked_at', 'is', null]]);
});

test('restore: the 10-minute window is inclusive and closes after', async () => {
  assert.equal(UNDO_REVOKE_MS, 600_000);
  const atEdge = await restoreKey(fakeSupabase([{ data: revoked(10), error: null }, { data: [], error: null }, { data: restoredRow, error: null }]), member, KEY_ID, NOW);
  assert.equal(atEdge.status, 200);
  const late = fakeSupabase([{ data: revoked(10.02), error: null }]);
  assert.deepEqual(await restoreKey(late, member, KEY_ID, NOW), { status: 409, body: { error: 'undo_window_passed' } });
  assert.equal(late.queries.length, 1);
});

test('restore: refuses an active key, an expired key, and a key a rotation replaced', async () => {
  assert.deepEqual(await restoreKey(fakeSupabase([{ data: { ...mine, revoked_at: null }, error: null }]), member, KEY_ID, NOW), { status: 409, body: { error: 'not_revoked' } });
  const expired = revoked(2, { expires_at: new Date(NOW - 1000).toISOString() });
  assert.deepEqual(await restoreKey(fakeSupabase([{ data: expired, error: null }]), member, KEY_ID, NOW), { status: 409, body: { error: 'key_expired' } });
  const rotatedSb = fakeSupabase([{ data: revoked(1), error: null }, { data: [{ id: 'a1' }], error: null }]);
  assert.deepEqual(await restoreKey(rotatedSb, member, KEY_ID, NOW), { status: 409, body: { error: 'key_rotated' } });
  assert.equal(rotatedSb.queries.length, 2);
});

test('restore: authz — another member\'s key is 403, another workspace\'s is 404, an admin may', async () => {
  assert.deepEqual(await restoreKey(fakeSupabase([{ data: { ...theirs, revoked_at: new Date(NOW).toISOString() }, error: null }]), member, KEY_ID, NOW), { status: 403, body: { error: 'forbidden' } });
  assert.deepEqual(await restoreKey(fakeSupabase([{ data: null, error: null }]), admin, KEY_ID, NOW), { status: 404, body: { error: 'not_found' } });
  const ok = await restoreKey(fakeSupabase([{ data: { ...theirs, revoked_at: new Date(NOW).toISOString() }, error: null }, { data: [], error: null }, { data: restoredRow, error: null }]), admin, KEY_ID, NOW);
  assert.equal(ok.status, 200);
  assert.deepEqual(await restoreKey(fakeSupabase([]), member, 'x', NOW), { status: 400, body: { error: 'invalid_id' } });
});

test('restore: a name taken meanwhile is 409; read errors throw', async () => {
  const taken = await restoreKey(fakeSupabase([{ data: revoked(1), error: null }, { data: [], error: null }, { data: null, error: { code: '23505' } }]), member, KEY_ID, NOW);
  assert.deepEqual(taken, { status: 409, body: { error: 'name_taken' } });
  await assert.rejects(restoreKey(fakeSupabase([{ data: null, error: { message: 'boom' } }]), member, KEY_ID, NOW));
  await assert.rejects(restoreKey(fakeSupabase([{ data: revoked(1), error: null }, { data: null, error: { message: 'audit read failed' } }]), member, KEY_ID, NOW));
});

/** A tiny in-memory api_keys table: eq/is filters over rows, update applied in place. */
function tableSupabase(rows) {
  return {
    from() {
      const filters = [];
      let values = null;
      const match = (r) => filters.every(([op, c, v]) => (op === 'eq' ? r[c] === v : (r[c] ?? null) === v));
      const b = {
        select() { return b; },
        update(v) { values = v; return b; },
        eq(c, v) { filters.push(['eq', c, v]); return b; },
        is(c, v) { filters.push(['is', c, v]); return b; },
        maybeSingle() { return Promise.resolve({ data: rows.find(match) ?? null, error: null }); },
        then(resolve) { if (values) rows.filter(match).forEach((r) => Object.assign(r, values)); return Promise.resolve({ error: null }).then(resolve); },
      };
      return b;
    },
  };
}

function call(mw, rawKey) {
  return new Promise((resolve) => {
    const req = { headers: { 'x-api-key': rawKey }, method: 'GET', originalUrl: '/v2/attention' };
    const res = {
      statusCode: 200,
      on() {},
      status(c) { this.statusCode = c; return this; },
      json(b) { resolve({ status: this.statusCode, body: b, req }); return this; },
    };
    mw(req, res, () => resolve({ status: 'next', req }));
  });
}

test('the API key middleware reads revocation on every request: revoked → 401, restored → works again', async () => {
  const raw = 'pk_' + 'ab'.repeat(24);
  const row = {
    id: KEY_ID, workspace_id: WS, owner_user_id: null, scope: 'admin', capability: 'read_write', expires_at: null,
    key_hash: crypto.createHash('sha256').update(raw).digest('hex'), revoked_at: null,
  };
  const mw = createVerifyApiKey(() => tableSupabase([row]));
  assert.equal((await call(mw, raw)).status, 'next');
  row.revoked_at = new Date().toISOString();
  const denied = await call(mw, raw);
  assert.equal(denied.status, 401);
  assert.equal(denied.body.error, 'invalid_api_key');
  row.revoked_at = null; // what POST /:id/restore writes
  const back = await call(mw, raw);
  assert.equal(back.status, 'next');
  assert.equal(back.req.apiKeyId, KEY_ID);
  assert.equal(back.req.workspaceId, WS);
});

// ── E3: extend expiry ──────────────────────────────────────────────────────────────────────

const DAY = 86_400_000;
const expiring = (daysLeft, extra = {}) => ({ ...mine, revoked_at: null, expires_at: new Date(NOW + daysLeft * DAY).toISOString(), ...extra });

test('extend: a live key keeps the time it had: expires_at + days; scoped and audited', async () => {
  const sb = fakeSupabase([{ data: expiring(6), error: null }, { data: { id: KEY_ID, name: 'claude-code', expires_at: new Date(NOW + 96 * DAY).toISOString() }, error: null }]);
  const out = await extendKey(sb, member, KEY_ID, { days: 90 }, NOW);
  assert.equal(out.status, 200);
  assert.deepEqual(sb.queries[1].values, { expires_at: new Date(NOW + 96 * DAY).toISOString() });
  assert.deepEqual(sb.queries[1].filters, [['eq', 'id', KEY_ID], ['eq', 'workspace_id', WS], ['is', 'revoked_at', null]]);
  assert.deepEqual(sb.queries[0].filters, [['eq', 'id', KEY_ID], ['eq', 'workspace_id', WS]]);
  assert.equal(out.audit.action, 'apikey.extended');
  assert.equal(out.audit.metadata.days, 90);
  assert.equal(out.audit.metadata.from, expiring(6).expires_at);
});

test('extend: an expired key gets the days from now, not from its old expiry', async () => {
  const sb = fakeSupabase([{ data: expiring(-20), error: null }, { data: { id: KEY_ID, name: 'claude-code', expires_at: 'x' }, error: null }]);
  await extendKey(sb, member, KEY_ID, { days: 30 }, NOW);
  assert.deepEqual(sb.queries[1].values, { expires_at: new Date(NOW + 30 * DAY).toISOString() });
});

test('extend: only 30, 90 or 365 days', async () => {
  assert.deepEqual(EXTEND_DAYS, [30, 90, 365]);
  for (const days of [0, 7, 89, -90, '90x', null, undefined, 3650]) {
    const sb = fakeSupabase([]);
    const out = await extendKey(sb, member, KEY_ID, { days }, NOW);
    assert.equal(out.status, 400, `days=${days}`);
    assert.equal(out.body.error, 'invalid_days');
    assert.equal(sb.queries.length, 0);
  }
  // A numeric string from a form is fine.
  const ok = await extendKey(fakeSupabase([{ data: expiring(1), error: null }, { data: { id: KEY_ID, name: 'n', expires_at: 'x' }, error: null }]), member, KEY_ID, { days: '365' }, NOW);
  assert.equal(ok.status, 200);
});

test('extend: not on a revoked key, nor on one that never expires', async () => {
  assert.deepEqual(await extendKey(fakeSupabase([{ data: expiring(3, { revoked_at: new Date(NOW).toISOString() }), error: null }]), member, KEY_ID, { days: 90 }, NOW), { status: 409, body: { error: 'key_revoked' } });
  assert.deepEqual(await extendKey(fakeSupabase([{ data: { ...mine, revoked_at: null, expires_at: null }, error: null }]), member, KEY_ID, { days: 90 }, NOW), { status: 409, body: { error: 'no_expiry' } });
  // Revoked between the read and the write: the guarded update matches nothing.
  assert.deepEqual(await extendKey(fakeSupabase([{ data: expiring(3), error: null }, { data: null, error: null }]), member, KEY_ID, { days: 90 }, NOW), { status: 409, body: { error: 'key_revoked' } });
});

test('extend: authz — another member\'s key 403, another workspace 404, admin ok; errors throw', async () => {
  assert.deepEqual(await extendKey(fakeSupabase([{ data: expiring(3, { owner_user_id: 'u2', created_by_user_id: 'u2' }), error: null }]), member, KEY_ID, { days: 30 }, NOW), { status: 403, body: { error: 'forbidden' } });
  assert.deepEqual(await extendKey(fakeSupabase([{ data: null, error: null }]), admin, KEY_ID, { days: 30 }, NOW), { status: 404, body: { error: 'not_found' } });
  const ok = await extendKey(fakeSupabase([{ data: expiring(3, { owner_user_id: 'u2', created_by_user_id: 'u2' }), error: null }, { data: { id: KEY_ID, name: 'n', expires_at: 'x' }, error: null }]), admin, KEY_ID, { days: 30 }, NOW);
  assert.equal(ok.status, 200);
  assert.deepEqual(await extendKey(fakeSupabase([]), admin, 'nope', { days: 30 }, NOW), { status: 400, body: { error: 'invalid_id' } });
  await assert.rejects(extendKey(fakeSupabase([{ data: expiring(3), error: null }, { data: null, error: { message: 'boom' } }]), member, KEY_ID, { days: 30 }, NOW));
});
