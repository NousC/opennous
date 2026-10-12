// The per-key usage dashboard's reads (GET-623): day filling, the 7-day totals, who may see a
// key, and that every Supabase error surfaces instead of reading as zero. Supabase is faked:
// the aggregation itself runs in SQL (api_request_log_* functions), so the fake answers those
// RPCs with the rows Postgres would return.
//
// Run: cd apps/api && node --test tests/apiKeyUsage.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fillPerDay, totalsFrom, windowStart, canSeeKey, keySummary, loadKeyUsage, loadKeyRequests,
  loadUsageByKey, keyCredits, parseRequestsQuery, parseDays, UsageReadError, rotatedFrom,
} from '../src/lib/apiKeyUsage.mjs';

const NOW = Date.parse('2026-10-03T15:30:00Z');
const WS = '11111111-1111-4111-8111-111111111111';
const ME = 'user-me';

// A chainable fake: records each query's filters and answers from `tables` / `rpcs`.
function fakeSupabase({ tables = {}, rpcs = {} } = {}) {
  const calls = { rpc: [], from: [] };
  const sb = {
    calls,
    rpc(name, args) {
      calls.rpc.push({ name, args });
      const v = rpcs[name];
      return Promise.resolve(typeof v === 'function' ? v(args) : v ?? { data: [], error: null });
    },
    from(table) {
      const q = { table, filters: [], order: null, limit: null };
      calls.from.push(q);
      const answer = () => {
        const v = tables[table];
        return typeof v === 'function' ? v(q) : v ?? { data: [], error: null };
      };
      const b = {
        select() { return b; },
        eq(c, v) { q.filters.push(['eq', c, v]); return b; },
        lt(c, v) { q.filters.push(['lt', c, v]); return b; },
        in(c, v) { q.filters.push(['in', c, v]); return b; },
        or(v) { q.filters.push(['or', v]); return b; },
        order(c, o) { q.order ??= [c, o]; (q.orders ??= []).push([c, o]); return b; },
        limit(n) { q.limit = n; return b; },
        maybeSingle() { return Promise.resolve(answer()); },
        then(res, rej) { return Promise.resolve(answer()).then(res, rej); },
      };
      return b;
    },
  };
  return sb;
}

const KEY = {
  id: 'key-1', name: 'Claude Code', key_prefix: 'pk_3f9a1c', capability: 'read_only', scope: 'member',
  owner_user_id: ME, created_by_user_id: ME, created_at: '2026-09-01T00:00:00Z',
  last_used_at: '2026-10-03T15:00:00Z', expires_at: null, revoked_at: null,
};

// ── Days and totals ──────────────────────────────────────────────────────────

test('the window starts at UTC midnight, days - 1 days back', () => {
  assert.equal(windowStart(NOW, 14), '2026-09-20T00:00:00.000Z');
  assert.equal(windowStart(NOW, 1), '2026-10-03T00:00:00.000Z');
});

test('per_day has every one of the 14 days, oldest first, zeros filled in', () => {
  const days = fillPerDay([
    { day: '2026-09-20', calls: 3, errors: 1 },
    { day: '2026-10-01', calls: '7', errors: '0' }, // bigint arrives as a string from PostgREST
    { day: '2026-10-03', calls: 2, errors: 2 },
  ], NOW, 14);
  assert.equal(days.length, 14);
  assert.equal(days[0].day, '2026-09-20');
  assert.equal(days[13].day, '2026-10-03');
  assert.deepEqual(days[0], { day: '2026-09-20', calls: 3, errors: 1 });
  assert.deepEqual(days[11], { day: '2026-10-01', calls: 7, errors: 0 });
  assert.equal(days[5].calls, 0);
  assert.equal(days.reduce((n, d) => n + d.calls, 0), 12);
});

test('totals cover the last seven days only, today included', () => {
  const perDay = fillPerDay([
    { day: '2026-09-26', calls: 100, errors: 50 }, // 8 days back: outside
    { day: '2026-09-27', calls: 4, errors: 1 },    // 7th day back incl. today: inside
    { day: '2026-10-03', calls: 6, errors: 2 },
  ], NOW, 14);
  assert.deepEqual(totalsFrom(perDay), { calls_7d: 10, errors_7d: 3 });
});

// ── Who may see a key ────────────────────────────────────────────────────────

test('owners and admins see any key; members only keys that act as them or that they minted', () => {
  const other = { owner_user_id: 'u2', created_by_user_id: 'u2' };
  assert.equal(canSeeKey({ workspaceRole: 'owner', internalUserId: ME }, other), true);
  assert.equal(canSeeKey({ workspaceRole: 'admin', internalUserId: ME }, other), true);
  assert.equal(canSeeKey({ workspaceRole: 'member', internalUserId: ME }, other), false);
  assert.equal(canSeeKey({ workspaceRole: 'member', internalUserId: ME }, { owner_user_id: ME }), true);
  assert.equal(canSeeKey({ workspaceRole: 'member', internalUserId: ME }, { owner_user_id: null, created_by_user_id: ME }), true);
  // A workspace key nobody owns, and a request with no resolved user.
  assert.equal(canSeeKey({ workspaceRole: 'member', internalUserId: ME }, { owner_user_id: null, created_by_user_id: null }), false);
  assert.equal(canSeeKey({ workspaceRole: 'member' }, { owner_user_id: null, created_by_user_id: null }), false);
  assert.equal(canSeeKey({ workspaceRole: 'owner' }, null), false);
});

test('the key summary carries the dashboard header fields and never the hash', () => {
  const s = keySummary({ ...KEY, key_hash: 'secret' }, 'Cursor');
  assert.deepEqual(Object.keys(s).sort(), [
    'access', 'created_at', 'created_by', 'expires_at', 'id', 'last_client', 'last_used_at', 'name', 'prefix', 'revoked_at', 'scope',
  ]);
  assert.equal(s.prefix, 'pk_3f9a1c');
  assert.equal(s.access, 'read_only');
  assert.equal(s.last_client, 'Cursor');
  // A legacy key: no prefix column yet, no capability.
  const legacy = keySummary({ id: 'k', name: 'old', created_at: 'x' }, null);
  assert.equal(legacy.prefix, null);
  assert.equal(legacy.access, 'read_write');
  assert.equal(legacy.scope, 'admin');
});

// ── /api/keys/:id/usage ──────────────────────────────────────────────────────

test('usage: per_day, by_route and totals come from the aggregates, scoped to workspace and key', async () => {
  const sb = fakeSupabase({
    rpcs: {
      api_request_log_per_day: { data: [{ day: '2026-10-02', calls: '5', errors: '1' }, { day: '2026-10-03', calls: 3, errors: 0 }], error: null },
      api_request_log_by_route: { data: [{ route: 'get_context', surface: 'mcp', calls: '6' }, { route: '/v2/query', surface: 'rest', calls: 2 }], error: null },
    },
    tables: { api_request_log: { data: [{ client: 'Claude Code' }], error: null } },
  });
  const out = await loadKeyUsage(sb, { workspaceId: WS, key: KEY, now: NOW });

  assert.equal(out.per_day.length, 14);
  assert.deepEqual(out.per_day.at(-1), { day: '2026-10-03', calls: 3 });
  assert.deepEqual(out.per_day.at(-2), { day: '2026-10-02', calls: 5 });
  assert.ok(out.per_day.every((d) => Object.keys(d).join() === 'day,calls'));
  assert.deepEqual(out.by_route, [
    { route: 'get_context', surface: 'mcp', calls: 6 },
    { route: '/v2/query', surface: 'rest', calls: 2 },
  ]);
  assert.deepEqual(out.totals, { calls_7d: 8, errors_7d: 1 });
  assert.equal(out.key.last_client, 'Claude Code');

  const perDayCall = sb.calls.rpc.find((c) => c.name === 'api_request_log_per_day');
  assert.deepEqual(perDayCall.args, { p_workspace_id: WS, p_api_key_id: 'key-1', p_since: '2026-09-20T00:00:00.000Z' });
  assert.equal(sb.calls.rpc.find((c) => c.name === 'api_request_log_by_route').args.p_limit, 10);
  const last = sb.calls.from[0];
  assert.deepEqual(last.filters, [['eq', 'workspace_id', WS], ['eq', 'api_key_id', 'key-1']]);
  assert.deepEqual(last.order, ['at', { ascending: false }]);
});

test('usage: a failed aggregate is an error, never a dashboard of zeros', async () => {
  const sb = fakeSupabase({
    rpcs: { api_request_log_per_day: { data: null, error: { message: 'function does not exist', code: '42883' } } },
  });
  await assert.rejects(loadKeyUsage(sb, { workspaceId: WS, key: KEY, now: NOW }), UsageReadError);
});

// ── /api/keys/:id/requests ───────────────────────────────────────────────────

test('requests: limit and before are parsed and bounded', () => {
  assert.deepEqual(parseRequestsQuery({}), { limit: 50, before: null, beforeId: null });
  assert.deepEqual(parseRequestsQuery({ limit: '10' }), { limit: 10, before: null, beforeId: null });
  assert.equal(parseRequestsQuery({ limit: '100000' }).limit, 200);
  assert.equal(parseRequestsQuery({ limit: '-3' }).limit, 50);
  // The legacy bare timestamp still works.
  assert.equal(parseRequestsQuery({ before: '2026-10-03T10:00:00Z' }).before, '2026-10-03T10:00:00.000Z');
  assert.equal(parseRequestsQuery({ before: '2026-10-03T10:00:00Z' }).beforeId, null);
  assert.deepEqual(parseRequestsQuery({ before: 'yesterday-ish' }), { error: 'invalid_before' });
  // The compound cursor keeps the timestamp verbatim, microseconds and all.
  assert.deepEqual(parseRequestsQuery({ before: '2026-10-03T10:00:01.123456+00:00|9001' }),
    { limit: 50, before: '2026-10-03T10:00:01.123456+00:00', beforeId: '9001' });
  assert.deepEqual(parseRequestsQuery({ before: '2026-10-03T10:00:01Z|abc' }), { error: 'invalid_before' });
  assert.deepEqual(parseRequestsQuery({ before: '2026-10-03T10:00:01Z"),x|1' }), { error: 'invalid_before' });
});

test('requests: newest first, keyset on (at, id), next_before only on a full page', async () => {
  const rows = [
    { id: 12, at: '2026-10-03T10:00:02Z', surface: 'mcp', route: 'get_context', target: 'acme.com', status: 200, latency_ms: 120, client: 'Claude Code' },
    { id: 11, at: '2026-10-03T10:00:01Z', surface: 'rest', route: '/v2/query', target: null, status: 500, latency_ms: 900, client: 'curl' },
  ];
  const sb = fakeSupabase({ tables: { api_request_log: { data: rows, error: null } } });
  const full = await loadKeyRequests(sb, { workspaceId: WS, keyId: 'key-1', limit: 2, before: '2026-10-03T11:00:00.000Z' });
  assert.equal(full.requests.length, 2);
  assert.equal(full.requests[0].id, undefined, 'the row id stays inside the cursor');
  assert.equal(full.next_before, '2026-10-03T10:00:01Z|11');
  const q = sb.calls.from[0];
  assert.deepEqual(q.filters, [['eq', 'workspace_id', WS], ['eq', 'api_key_id', 'key-1'], ['lt', 'at', '2026-10-03T11:00:00.000Z']]);
  assert.deepEqual(q.orders, [['at', { ascending: false }], ['id', { ascending: false }]]);
  assert.equal(q.limit, 2);

  // The compound cursor: rows after (at, id), ties on `at` broken by id.
  await loadKeyRequests(sb, { workspaceId: WS, keyId: 'key-1', limit: 2, before: '2026-10-03T10:00:01Z', beforeId: '11' });
  assert.deepEqual(sb.calls.from[1].filters.at(-1),
    ['or', 'at.lt."2026-10-03T10:00:01Z",and(at.eq."2026-10-03T10:00:01Z",id.lt."11")']);

  const partial = await loadKeyRequests(sb, { workspaceId: WS, keyId: 'key-1', limit: 50, before: null });
  assert.equal(partial.next_before, null);
  assert.ok(!sb.calls.from[2].filters.some(([op]) => op === 'lt' || op === 'or'));
});

test('requests: a PostgREST error surfaces', async () => {
  const sb = fakeSupabase({ tables: { api_request_log: { data: null, error: { message: 'relation "api_request_log" does not exist', code: '42P01' } } } });
  await assert.rejects(loadKeyRequests(sb, { workspaceId: WS, keyId: 'key-1', limit: 50 }), /does not exist/);
});

// ── /api/usage/by-key ────────────────────────────────────────────────────────

const KEYS = [
  { id: 'k-mine', name: 'Mine', revoked_at: null, owner_user_id: ME, created_by_user_id: ME },
  { id: 'k-other', name: 'Other', revoked_at: null, owner_user_id: 'u2', created_by_user_id: 'u2' },
  { id: 'k-idle', name: 'Idle', revoked_at: null, owner_user_id: null, created_by_user_id: ME },
  { id: 'k-revoked-used', name: 'Old used', revoked_at: '2026-09-30T00:00:00Z', owner_user_id: 'u2', created_by_user_id: 'u2' },
  { id: 'k-revoked-idle', name: 'Old idle', revoked_at: '2026-01-01T00:00:00Z', owner_user_id: 'u2', created_by_user_id: 'u2' },
];
// api_request_log's own `credits` column is ignored: a credit is spent in the worker, later.
const AGG = [
  { api_key_id: 'k-other', calls: '40', credits: '999' },
  { api_key_id: 'k-mine', calls: 12, credits: 999 },
  { api_key_id: 'k-revoked-used', calls: 5, credits: 999 },
];
// What the read ledger's per-key sum returns (conversationCreditsByKey), stubbed.
const sum = (byKey, { unknown = 0, unattributed = 0 } = {}) => ({ byKey: new Map(Object.entries(byKey)), unknown, unattributed });
const byKeySb = (keys = KEYS) => fakeSupabase({
  rpcs: { api_request_log_by_key: { data: AGG, error: null } },
  tables: { api_keys: { data: keys, error: null } },
});
const OWNER = { workspaceRole: 'owner', internalUserId: ME };

test('by-key: calls from the request log, credits from the read ledger, idle keys at 0, revoked only if used', async () => {
  const sb = byKeySb();
  const seen = [];
  const creditsByKey = async (...args) => { seen.push(args.slice(1)); return sum({ 'k-other': 6, 'k-revoked-used': 2 }, { unattributed: 40 }); };
  const out = await loadUsageByKey(sb, { req: OWNER, workspaceId: WS, days: 30, now: NOW, creditsByKey });
  assert.deepEqual(out, {
    keys: [
      { api_key_id: 'k-other', name: 'Other', revoked: false, calls: 40, credits: 6 },
      { api_key_id: 'k-mine', name: 'Mine', revoked: false, calls: 12, credits: 0 },
      { api_key_id: 'k-revoked-used', name: 'Old used', revoked: true, calls: 5, credits: 2 },
      { api_key_id: 'k-idle', name: 'Idle', revoked: false, calls: 0, credits: 0 },
    ],
    credits_complete: true,
  });
  // Same window for calls and credits; credits OAuth sources caused (unattributed) go to no key.
  assert.deepEqual(seen, [[WS, '2026-09-04T00:00:00.000Z']]);
  assert.deepEqual(sb.calls.rpc[0].args, { p_workspace_id: WS, p_since: '2026-09-04T00:00:00.000Z' });
  assert.deepEqual(sb.calls.from[0].filters, [['eq', 'workspace_id', WS]]);
});

test('by-key: a revoked key whose writes are still being read shows, with no calls in the window', async () => {
  // A credit is spent when the worker reads, which can be after the key was revoked.
  const out = await loadUsageByKey(byKeySb(), { req: OWNER, workspaceId: WS, days: 30, now: NOW,
    creditsByKey: async () => sum({ 'k-revoked-idle': 4 }) });
  assert.deepEqual(out.keys.find((k) => k.api_key_id === 'k-revoked-idle'),
    { api_key_id: 'k-revoked-idle', name: 'Old idle', revoked: true, calls: 0, credits: 4 });
});

test('by-key: reads from before keys were stamped make an unrecorded key null, not 0', async () => {
  const out = await loadUsageByKey(byKeySb(), { req: OWNER, workspaceId: WS, days: 30, now: NOW,
    creditsByKey: async () => sum({ 'k-other': 6 }, { unknown: 10 }) });
  assert.equal(out.credits_complete, false);
  assert.equal(out.keys.find((k) => k.api_key_id === 'k-other').credits, 6, 'what is on record still shows');
  assert.equal(out.keys.find((k) => k.api_key_id === 'k-mine').credits, null);
  assert.equal(out.keys.find((k) => k.api_key_id === 'k-idle').credits, null);
});

test('by-key: a failed credit read blanks the credits, not the calls', async () => {
  const out = await loadUsageByKey(byKeySb(), { req: OWNER, workspaceId: WS, days: 30, now: NOW,
    creditsByKey: async () => { throw new Error('statement timeout'); } });
  assert.equal(out.credits_complete, false);
  assert.deepEqual(out.keys.map((k) => [k.api_key_id, k.calls, k.credits]), [
    ['k-other', 40, null], ['k-mine', 12, null], ['k-revoked-used', 5, null], ['k-idle', 0, null],
  ]);
});

test('keyCredits: on record → the number; nothing on record → 0 when complete, null when not', () => {
  assert.equal(keyCredits(sum({ a: 3 }), 'a'), 3);
  assert.equal(keyCredits(sum({ a: 3 }), 'b'), 0);
  assert.equal(keyCredits(sum({ a: 3 }, { unknown: 1 }), 'b'), null);
  assert.equal(keyCredits(null, 'a'), null);
});

test('by-key: a member sees only their own keys', async () => {
  const out = await loadUsageByKey(byKeySb(), { req: { workspaceRole: 'member', internalUserId: ME }, workspaceId: WS, days: 30, now: NOW,
    creditsByKey: async () => sum({ 'k-other': 6 }) });
  assert.deepEqual(out.keys.map((k) => k.api_key_id), ['k-mine', 'k-idle']);
});

test('by-key: days default to 30 and cap at the 90-day retention', () => {
  assert.equal(parseDays(undefined), 30);
  assert.equal(parseDays('7'), 7);
  assert.equal(parseDays('365'), 90);
  assert.equal(parseDays('zero'), 30);
});

test('by-key: a failed read surfaces', async () => {
  const sb = fakeSupabase({
    rpcs: { api_request_log_by_key: { data: AGG, error: null } },
    tables: { api_keys: { data: null, error: { message: 'timeout' } } },
  });
  await assert.rejects(loadUsageByKey(sb, { req: { workspaceRole: 'owner' }, workspaceId: WS, days: 30, now: NOW,
    creditsByKey: async () => sum({}) }), UsageReadError);
});

// ── Rotation history ─────────────────────────────────────────────────────────

// key-3 replaced key-2, which replaced key-1 (audit rows, as rotate writes them).
const AUDIT = { 'key-3': 'key-2', 'key-2': 'key-1' };
const auditTable = (q) => {
  const target = q.filters.find(([, c]) => c === 'target_id')?.[2];
  const prev = AUDIT[target];
  return { data: prev ? [{ metadata: { name: 'Claude Code', replaced: prev } }] : [], error: null };
};

test('rotatedFrom walks the apikey.rotated audit rows back, newest first, workspace-scoped', async () => {
  const sb = fakeSupabase({ tables: { audit_log: auditTable } });
  assert.deepEqual(await rotatedFrom(sb, WS, 'key-3'), ['key-2', 'key-1']);
  const first = sb.calls.from[0];
  assert.deepEqual(first.filters, [
    ['eq', 'action', 'apikey.rotated'], ['eq', 'target_type', 'api_key'], ['eq', 'target_id', 'key-3'], ['eq', 'target_workspace_id', WS],
  ]);
  assert.deepEqual(await rotatedFrom(fakeSupabase({ tables: { audit_log: auditTable } }), WS, 'key-1'), []);
  // Bounded, and a loop in the data cannot spin.
  const loop = fakeSupabase({ tables: { audit_log: () => ({ data: [{ metadata: { replaced: 'key-x' } }], error: null }) } });
  assert.deepEqual(await rotatedFrom(loop, WS, 'key-3'), ['key-x']);
  // A failed audit read stops the chain; the key's own usage still loads.
  const down = fakeSupabase({ tables: { audit_log: { data: null, error: { message: 'timeout' } } } });
  assert.deepEqual(await rotatedFrom(down, WS, 'key-3'), []);
});

test("usage: a rotated key's chart carries the keys it replaced", async () => {
  const perDay = {
    'key-1': [{ day: '2026-10-01', calls: 4, errors: 1 }],
    'key-2': [{ day: '2026-10-01', calls: 1, errors: 0 }, { day: '2026-10-02', calls: 2, errors: 0 }],
  };
  const byRoute = {
    'key-1': [{ route: 'get_context', surface: 'mcp', calls: 4 }],
    'key-2': [{ route: 'get_context', surface: 'mcp', calls: 2 }, { route: '/v2/query', surface: 'rest', calls: 1 }],
  };
  const sb = fakeSupabase({
    rpcs: {
      api_request_log_per_day: (a) => ({ data: perDay[a.p_api_key_id] ?? [], error: null }),
      api_request_log_by_route: (a) => ({ data: byRoute[a.p_api_key_id] ?? [], error: null }),
    },
    tables: { api_request_log: { data: [{ client: 'Cursor' }], error: null } },
  });
  const out = await loadKeyUsage(sb, { workspaceId: WS, key: { ...KEY, id: 'key-3' }, priorKeyIds: ['key-2', 'key-1'], now: NOW });
  assert.deepEqual(out.per_day.at(-3), { day: '2026-10-01', calls: 5 });
  assert.deepEqual(out.per_day.at(-2), { day: '2026-10-02', calls: 2 });
  assert.deepEqual(out.totals, { calls_7d: 7, errors_7d: 1 });
  assert.deepEqual(out.by_route, [{ route: 'get_context', surface: 'mcp', calls: 6 }, { route: '/v2/query', surface: 'rest', calls: 1 }]);
  assert.deepEqual(out.rotated_from, ['key-2', 'key-1']);
  assert.equal(sb.calls.rpc.filter((c) => c.name === 'api_request_log_per_day').length, 3);
  assert.deepEqual(sb.calls.from[0].filters.at(-1), ['in', 'api_key_id', ['key-3', 'key-2', 'key-1']]);
});

test('requests: a rotation chain reads every key in it', async () => {
  const sb = fakeSupabase({ tables: { api_request_log: { data: [], error: null } } });
  await loadKeyRequests(sb, { workspaceId: WS, keyId: 'key-3', keyIds: ['key-3', 'key-2'], limit: 50, before: null });
  assert.deepEqual(sb.calls.from[0].filters, [['eq', 'workspace_id', WS], ['in', 'api_key_id', ['key-3', 'key-2']]]);
});
