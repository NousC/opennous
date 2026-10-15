// Settings > API & MCP activity (GET-898): the window and its buckets, the shaping of the SQL
// aggregate, target resolution, the call list's filters and paging, and the admin-only gate.
// Supabase is faked: the aggregation runs in SQL (api_request_log_activity), so the fake answers
// that RPC with the jsonb Postgres would return.
//
// Run: cd apps/api && node --test tests/apiActivity.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseWindow, windowBuckets, windowSince, fillSeries, shapeTotals, errorRate, targetKind,
  resolveTargets, loadActivity, parseCallsQuery, ilikeContains, loadCalls, UNKNOWN_CLIENT,
  ActivityUnavailableError, ActivityReadError,
} from '../src/lib/apiActivity.mjs';
import { activityGate, makeActivityHandler, makeActivityCallsHandler } from '../src/routes/api/apiActivity.mjs';

const NOW = Date.parse('2026-10-15T15:30:00Z');
const WS = '11111111-1111-4111-8111-111111111111';
const K1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const K2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CO = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const PE = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const DOC = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

function fakeSupabase({ tables = {}, rpcs = {} } = {}) {
  const calls = { rpc: [], from: [] };
  return {
    calls,
    rpc(name, args) {
      calls.rpc.push({ name, args });
      const v = rpcs[name];
      return Promise.resolve(typeof v === 'function' ? v(args) : v ?? { data: null, error: null });
    },
    from(table) {
      const q = { table, filters: [], orders: [], limit: null };
      calls.from.push(q);
      const answer = () => {
        const v = tables[table];
        return typeof v === 'function' ? v(q) : v ?? { data: [], error: null };
      };
      const b = {
        select(cols) { q.select = cols; return b; },
        eq(c, v) { q.filters.push(['eq', c, v]); return b; },
        lt(c, v) { q.filters.push(['lt', c, v]); return b; },
        gte(c, v) { q.filters.push(['gte', c, v]); return b; },
        in(c, v) { q.filters.push(['in', c, v]); return b; },
        is(c, v) { q.filters.push(['is', c, v]); return b; },
        ilike(c, v) { q.filters.push(['ilike', c, v]); return b; },
        or(v) { q.filters.push(['or', v]); return b; },
        order(c, o) { q.orders.push([c, o]); return b; },
        limit(n) { q.limit = n; return b; },
        then(res, rej) { return Promise.resolve(answer()).then(res, rej); },
      };
      return b;
    },
  };
}
const has = (q, ...f) => q.filters.some((x) => JSON.stringify(x) === JSON.stringify(f));
const KEYS = { data: [{ id: K1, name: 'Laptop agent', revoked_at: null }, { id: K2, name: 'Old script', revoked_at: '2026-10-01T00:00:00Z' }], error: null };

// ── Windows ──────────────────────────────────────────────────────────────────

test('parseWindow: the four windows, anything else is 7d', () => {
  for (const w of ['24h', '7d', '30d', '90d']) assert.equal(parseWindow(w), w);
  for (const w of [undefined, '', '1y', '7', 'constructor', '__proto__']) assert.equal(parseWindow(w), '7d');
});

test('24h is 24 UTC hours, oldest first, this hour last', () => {
  const b = windowBuckets('24h', NOW);
  assert.equal(b.length, 24);
  assert.equal(b[23], '2026-10-15T15:00:00Z');
  assert.equal(b[0], '2026-10-14T16:00:00Z');
  assert.equal(windowSince('24h', NOW), '2026-10-14T16:00:00.000Z');
});

test('7d / 30d / 90d are UTC calendar days, today included', () => {
  assert.deepEqual(windowBuckets('7d', NOW), ['2026-10-09', '2026-10-10', '2026-10-11', '2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15']);
  assert.equal(windowBuckets('30d', NOW).length, 30);
  assert.equal(windowBuckets('90d', NOW).length, 90);
  assert.equal(windowSince('7d', NOW), '2026-10-09T00:00:00.000Z');
  assert.equal(windowSince('90d', NOW), '2026-07-18T00:00:00.000Z');
});

test('fillSeries: every bucket present, zeros filled, bigint strings read as numbers', () => {
  const s = fillSeries([
    { bucket: '2026-10-10', calls: '5', mcp: '4', rest: '1', errors: '1' },
    { bucket: '2026-10-15', calls: 2, mcp: 0, rest: 2, errors: 0 },
    { bucket: '2026-09-01', calls: 99, mcp: 99, rest: 0, errors: 0 }, // outside the window: dropped
  ], '7d', NOW);
  assert.equal(s.length, 7);
  assert.deepEqual(s[1], { bucket: '2026-10-10', calls: 5, mcp: 4, rest: 1, errors: 1 });
  assert.deepEqual(s[0], { bucket: '2026-10-09', calls: 0, mcp: 0, rest: 0, errors: 0 });
  assert.equal(s.reduce((n, d) => n + d.calls, 0), 7);
  const h = fillSeries([{ bucket: '2026-10-15T15:00:00Z', calls: 3, mcp: 3, rest: 0, errors: 0 }], '24h', NOW);
  assert.equal(h[23].calls, 3);
});

test('shapeTotals: error rate, latency null when nothing was called', () => {
  assert.deepEqual(shapeTotals({ calls: '20', mcp: '15', rest: '5', errors: '2', p50_ms: 80, p95_ms: 410, keys: 2, clients: 3, targets: 7 }), {
    calls: 20, mcp: 15, rest: 5, errors: 2, error_rate: 0.1, p50_ms: 80, p95_ms: 410, keys: 2, clients: 3, targets: 7,
  });
  const empty = shapeTotals({ calls: 0, p50_ms: null, p95_ms: null });
  assert.equal(empty.error_rate, null);
  assert.equal(empty.p95_ms, null);
  assert.equal(shapeTotals(undefined).calls, 0);
  assert.equal(errorRate(1, 4), 0.25);
});

// ── Targets ──────────────────────────────────────────────────────────────────

test('targetKind: entity id, email, domain, else nothing', () => {
  assert.equal(targetKind(CO), 'entity_id');
  assert.equal(targetKind('dana@harborline.example'), 'email');
  assert.equal(targetKind('harborline.example'), 'domain');
  assert.equal(targetKind('Harborline Supply'), null);
  assert.equal(targetKind(''), null);
  assert.equal(targetKind(null), null);
});

function worldTables(extra = {}) {
  return {
    api_keys: KEYS,
    entity_identifiers: (q) => {
      const kind = q.filters.find((f) => f[1] === 'kind')?.[2];
      const rows = kind === 'domain' ? [{ entity_id: CO, value: 'harborline.example' }]
        : kind === 'email' ? [{ entity_id: PE, value: 'dana@harborline.example' }] : [];
      return { data: rows, error: null };
    },
    entities: { data: [{ id: CO, type: 'company', merged_into: null }, { id: PE, type: 'person', merged_into: null }], error: null },
    claims: { data: [{ entity_id: CO, value: 'Harborline Supply' }, { entity_id: PE, value: 'Dana Fernpoint' }], error: null },
    ...extra,
  };
}

test('resolveTargets: ids, domains and emails become named entities, workspace-scoped; the rest stay raw', async () => {
  const sb = fakeSupabase({ tables: worldTables() });
  const m = await resolveTargets(sb, WS, [CO, 'Harborline.example', 'dana@harborline.example', DOC, 'a name', null]);
  assert.deepEqual(m.get(CO), { id: CO, type: 'company', name: 'Harborline Supply' });
  assert.deepEqual(m.get('Harborline.example'), { id: CO, type: 'company', name: 'Harborline Supply' });
  assert.deepEqual(m.get('dana@harborline.example'), { id: PE, type: 'person', name: 'Dana Fernpoint' });
  assert.equal(m.has(DOC), false); // a document id is no entity: shown raw
  assert.equal(m.has('a name'), false);
  for (const q of sb.calls.from) assert.ok(has(q, 'eq', 'workspace_id', WS), `${q.table} is workspace-scoped`);
});

test('resolveTargets: nothing to look up → no reads; a failed read costs only the names', async () => {
  const sb = fakeSupabase();
  assert.equal((await resolveTargets(sb, WS, ['a name', null])).size, 0);
  assert.equal(sb.calls.from.length, 0);
  const broken = fakeSupabase({ tables: worldTables({ entities: { data: null, error: { message: 'boom' } } }) });
  const m = await resolveTargets(broken, WS, [CO]);
  assert.equal(m.size, 0);
});

// ── loadActivity ─────────────────────────────────────────────────────────────

const AGG = {
  totals: { calls: 12, mcp: 9, rest: 3, errors: 1, p50_ms: 90, p95_ms: 600, keys: 2, clients: 2, targets: 2 },
  series: [{ bucket: '2026-10-14', calls: 8, mcp: 6, rest: 2, errors: 1 }, { bucket: '2026-10-15', calls: 4, mcp: 3, rest: 1, errors: 0 }],
  by_route: [{ surface: 'mcp', route: 'get_account', calls: 7, errors: 1, p95_ms: 640, last_at: '2026-10-15T10:00:00Z' }],
  by_target: [{ target: CO, calls: 5, errors: 0, last_at: '2026-10-15T10:00:00Z' }, { target: DOC, calls: 1, errors: 1, last_at: '2026-10-14T10:00:00Z' }],
  by_key: [{ api_key_id: K2, calls: 2, errors: 1, last_at: '2026-10-14T09:00:00Z' }, { api_key_id: K1, calls: 10, errors: 0, last_at: '2026-10-15T10:00:00Z' }],
  by_client: [{ client: 'Claude Code', calls: 9, errors: 0, last_at: '2026-10-15T10:00:00Z' }, { client: '', calls: 3, errors: 1, last_at: null }],
};

test('loadActivity: one RPC for the window, keys named, targets resolved, series filled', async () => {
  const sb = fakeSupabase({ tables: worldTables(), rpcs: { api_request_log_activity: { data: AGG, error: null } } });
  const out = await loadActivity(sb, { workspaceId: WS, window: '7d', now: NOW });
  assert.deepEqual(sb.calls.rpc[0], { name: 'api_request_log_activity', args: { p_workspace_id: WS, p_since: '2026-10-09T00:00:00.000Z', p_bucket: 'day', p_limit: 10 } });
  assert.equal(out.window, '7d');
  assert.equal(out.totals.calls, 12);
  assert.equal(out.series.length, 7);
  assert.equal(out.series[5].calls, 8);
  assert.deepEqual(out.by_route[0], { surface: 'mcp', route: 'get_account', calls: 7, errors: 1, error_rate: 1 / 7, last_at: '2026-10-15T10:00:00Z', p95_ms: 640 });
  assert.equal(out.by_target[0].about.name, 'Harborline Supply');
  assert.equal(out.by_target[1].about, null);
  // Sorted by calls; the key is its name, never a hash.
  assert.deepEqual(out.by_key.map((k) => [k.name, k.calls, k.revoked]), [['Laptop agent', 10, false], ['Old script', 2, true]]);
  assert.equal(out.by_client[1].client, null);
  assert.ok(!JSON.stringify(out).includes('ip_prefix'));
  const keysRead = sb.calls.from.find((q) => q.table === 'api_keys');
  assert.equal(keysRead.select, 'id, name, revoked_at');
  assert.ok(has(keysRead, 'eq', 'workspace_id', WS));
});

test('loadActivity: 24h asks for hourly buckets', async () => {
  const sb = fakeSupabase({ tables: worldTables(), rpcs: { api_request_log_activity: { data: { ...AGG, series: [] }, error: null } } });
  const out = await loadActivity(sb, { workspaceId: WS, window: '24h', now: NOW });
  assert.equal(sb.calls.rpc[0].args.p_bucket, 'hour');
  assert.equal(out.series.length, 24);
  assert.equal(out.bucket, 'hour');
});

test('loadActivity: a missing function is "unavailable", any other error throws, never a quiet zero', async () => {
  const missing = fakeSupabase({ tables: worldTables(), rpcs: { api_request_log_activity: { data: null, error: { code: 'PGRST202', message: 'Could not find the function public.api_request_log_activity' } } } });
  await assert.rejects(loadActivity(missing, { workspaceId: WS, window: '7d', now: NOW }), ActivityUnavailableError);
  const broken = fakeSupabase({ tables: worldTables(), rpcs: { api_request_log_activity: { data: null, error: { message: 'timeout' } } } });
  await assert.rejects(loadActivity(broken, { workspaceId: WS, window: '7d', now: NOW }), ActivityReadError);
  const keysDown = fakeSupabase({ tables: worldTables({ api_keys: { data: null, error: { message: 'down' } } }), rpcs: { api_request_log_activity: { data: AGG, error: null } } });
  await assert.rejects(loadActivity(keysDown, { workspaceId: WS, window: '7d', now: NOW }), ActivityReadError);
});

// ── The call list ────────────────────────────────────────────────────────────

test('parseCallsQuery: defaults, caps, and closed sets reject typos', () => {
  const d = parseCallsQuery({});
  assert.deepEqual(d, { window: '7d', limit: 50, before: null, beforeId: null, surface: null, route: null, status: null, keyId: null, client: null, q: null });
  assert.equal(parseCallsQuery({ limit: '5000' }).limit, 200);
  assert.deepEqual(parseCallsQuery({ surface: 'soap' }), { error: 'invalid_surface' });
  assert.deepEqual(parseCallsQuery({ status: 'fine' }), { error: 'invalid_status' });
  assert.deepEqual(parseCallsQuery({ key: 'nope' }), { error: 'invalid_key' });
  assert.deepEqual(parseCallsQuery({ before: 'garbage|x' }), { error: 'invalid_before' });
  const p = parseCallsQuery({ window: '24h', surface: 'mcp', status: 'error', key: K1, route: ' get_account ', q: ' harbor ', before: '2026-10-15T10:00:00.123456+00:00|42' });
  assert.equal(p.window, '24h');
  assert.equal(p.route, 'get_account');
  assert.equal(p.q, 'harbor');
  assert.equal(p.beforeId, '42');
  assert.equal(parseCallsQuery({ client: ' Claude Code ' }).client, 'Claude Code');
  assert.equal(parseCallsQuery({ client: '   ' }).client, null);
});

test('loadCalls: the client filter, and Unknown is a null or empty client (GET-900)', async () => {
  const named = fakeSupabase({ tables: worldTables({ api_request_log: { data: [], error: null } }) });
  await loadCalls(named, { workspaceId: WS, window: '7d', client: 'Cursor', now: NOW });
  assert.ok(has(named.calls.from.find((x) => x.table === 'api_request_log'), 'eq', 'client', 'Cursor'));
  const unknown = fakeSupabase({ tables: worldTables({ api_request_log: { data: [], error: null } }) });
  await loadCalls(unknown, { workspaceId: WS, window: '7d', client: UNKNOWN_CLIENT, now: NOW });
  const q = unknown.calls.from.find((x) => x.table === 'api_request_log');
  assert.ok(has(q, 'or', 'client.is.null,client.eq.""'));
  assert.ok(!q.filters.some((f) => f[0] === "eq" && f[1] === "client"));
});

test('ilikeContains: the search matches literally', () => {
  assert.equal(ilikeContains('harbor'), '%harbor%');
  assert.equal(ilikeContains('50%_off\\'), '%50\\%\\_off\\\\%');
  assert.equal(ilikeContains('a*b'), '%ab%');
});

const ROWS = [
  { id: 9, at: '2026-10-15T10:00:00.5+00:00', surface: 'mcp', route: 'get_account', target: CO, status: 200, latency_ms: 120, client: 'Claude Code', api_key_id: K1, ip_prefix: '203.0' },
  { id: 8, at: '2026-10-15T09:00:00+00:00', surface: 'rest', route: '/v2/documents/:id', target: DOC, status: 404, latency_ms: 30, client: 'curl', api_key_id: K2 },
];

test('loadCalls: workspace and window scoped, filters applied, names resolved, no ip', async () => {
  const sb = fakeSupabase({ tables: worldTables({ api_request_log: { data: ROWS, error: null } }) });
  const out = await loadCalls(sb, { workspaceId: WS, window: '24h', limit: 2, surface: 'mcp', route: 'get_account', status: 'error', keyId: K1, q: 'harbor', now: NOW });
  const q = sb.calls.from.find((x) => x.table === 'api_request_log');
  assert.ok(!q.select.includes('ip_prefix'));
  assert.ok(has(q, 'eq', 'workspace_id', WS));
  assert.ok(has(q, 'gte', 'at', '2026-10-14T16:00:00.000Z'));
  assert.ok(has(q, 'eq', 'surface', 'mcp'));
  assert.ok(has(q, 'eq', 'route', 'get_account'));
  assert.ok(has(q, 'gte', 'status', 400));
  assert.ok(has(q, 'eq', 'api_key_id', K1));
  assert.ok(has(q, 'ilike', 'target', '%harbor%'));
  assert.deepEqual(q.orders, [['at', { ascending: false }], ['id', { ascending: false }]]);
  assert.equal(q.limit, 2);
  assert.deepEqual(out.calls[0], {
    id: '9', at: ROWS[0].at, surface: 'mcp', route: 'get_account', target: CO,
    about: { id: CO, type: 'company', name: 'Harborline Supply' },
    status: 200, latency_ms: 120, client: 'Claude Code', key: { id: K1, name: 'Laptop agent' },
  });
  assert.equal(out.calls[1].about, null);
  assert.ok(!JSON.stringify(out).includes('203.0'));
  // A full page carries a compound cursor; a short one does not.
  assert.equal(out.next_before, `${ROWS[1].at}|8`);
});

test('loadCalls: status ok is < 400; the cursor pages on (at, id); a short page ends', async () => {
  const sb = fakeSupabase({ tables: worldTables({ api_request_log: { data: [ROWS[0]], error: null } }) });
  const out = await loadCalls(sb, { workspaceId: WS, window: '7d', limit: 50, status: 'ok', before: '2026-10-15T11:00:00+00:00', beforeId: '10', now: NOW });
  const q = sb.calls.from.find((x) => x.table === 'api_request_log');
  assert.ok(has(q, 'lt', 'status', 400));
  assert.ok(has(q, 'or', 'at.lt."2026-10-15T11:00:00+00:00",and(at.eq."2026-10-15T11:00:00+00:00",id.lt."10")'));
  assert.equal(out.next_before, null);
});

test('loadCalls: a failed read throws', async () => {
  const sb = fakeSupabase({ tables: worldTables({ api_request_log: { data: null, error: { message: 'down' } } }) });
  await assert.rejects(loadCalls(sb, { workspaceId: WS, window: '7d', now: NOW }), ActivityReadError);
});

// ── The gate and the handlers ────────────────────────────────────────────────

function fakeRes() {
  const r = { statusCode: 200, body: undefined };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  return r;
}

test('admins only: members get 403, no workspace 400, and nothing is read', async () => {
  assert.deepEqual(activityGate({ workspaceId: WS, workspaceRole: 'member' }), { status: 403, body: { error: 'admin_only' } });
  assert.deepEqual(activityGate({ workspaceRole: 'owner' }), { status: 400, body: { error: 'workspace_required' } });
  assert.equal(activityGate({ workspaceId: WS, workspaceRole: 'admin' }), null);
  assert.equal(activityGate({ workspaceId: WS, workspaceRole: 'owner' }), null);
  let reads = 0;
  const getClient = () => { reads++; return fakeSupabase(); };
  for (const h of [makeActivityHandler({ getClient }), makeActivityCallsHandler({ getClient })]) {
    const res = fakeRes();
    await h({ workspaceId: WS, workspaceRole: 'member', query: {} }, res);
    assert.equal(res.statusCode, 403);
  }
  assert.equal(reads, 0);
});

test('handlers: the viewer\'s workspace only, 503 before the migration, 400 on a bad filter', async () => {
  const sb = fakeSupabase({ tables: worldTables(), rpcs: { api_request_log_activity: { data: AGG, error: null } } });
  const res = fakeRes();
  // A workspaceId in the query string is not what scopes the read: req.workspaceId (set by auth) is.
  await makeActivityHandler({ getClient: () => sb, now: () => NOW })({ workspaceId: WS, workspaceRole: 'owner', query: { window: '30d', workspaceId: 'someone-else' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.window, '30d');
  assert.equal(sb.calls.rpc[0].args.p_workspace_id, WS);

  const missing = fakeSupabase({ tables: worldTables(), rpcs: { api_request_log_activity: { data: null, error: { code: 'PGRST202', message: 'Could not find the function' } } } });
  const r2 = fakeRes();
  await makeActivityHandler({ getClient: () => missing, now: () => NOW })({ workspaceId: WS, workspaceRole: 'admin', query: {} }, r2);
  assert.deepEqual([r2.statusCode, r2.body], [503, { error: 'activity_unavailable' }]);

  const r3 = fakeRes();
  await makeActivityCallsHandler({ getClient: () => sb, now: () => NOW })({ workspaceId: WS, workspaceRole: 'admin', query: { status: 'meh' } }, r3);
  assert.deepEqual([r3.statusCode, r3.body], [400, { error: 'invalid_status' }]);
});
