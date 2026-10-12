// Webhook delivery log, stats and Resend (GET-624), end to end through Express on both
// surfaces (/api/triggers for the Webhooks page, /v2/webhooks for API keys) against an
// in-process fake PostgREST (globalThis.fetch answers the Supabase REST calls from in-memory
// tables). The customer's receiver is faked on the same stub. No network, no database.
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.SUPABASE_URL = 'http://fake-supabase.test';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-test';

const { default: express } = await import('express');
const { triggersRouter } = await import('../src/routes/api/triggers.mjs');
const { webhooksV2Router } = await import('../src/routes/v2/webhooks.mjs');

// ── fake PostgREST ───────────────────────────────────────────────────────────
let tables = {};

const unquote = (v) => (v.startsWith('"') && v.endsWith('"') ? v.slice(1, -1) : v);
function cmp(a, b) {
  const da = Date.parse(a), db = Date.parse(b);
  if (typeof a === 'string' && Number.isFinite(da) && Number.isFinite(db) && /\d{4}-\d{2}-\d{2}/.test(a)) return da - db;
  return a < b ? -1 : a > b ? 1 : 0;
}
function test1(row, col, expr) {
  if (expr.startsWith('not.')) return !test1(row, col, expr.slice(4));
  const dot = expr.indexOf('.');
  const op = expr.slice(0, dot);
  const raw = unquote(expr.slice(dot + 1));
  const v = row[col];
  switch (op) {
    case 'eq': return v != null && String(v) === raw;
    case 'neq': return String(v) !== raw;
    case 'is': return raw === 'null' ? v == null : String(v) === raw;
    case 'in': return raw.replace(/^\(|\)$/g, '').split(',').map(unquote).includes(String(v));
    case 'gte': return v != null && cmp(v, raw) >= 0;
    case 'gt': return v != null && cmp(v, raw) > 0;
    case 'lte': return v != null && cmp(v, raw) <= 0;
    case 'lt': return v != null && cmp(v, raw) < 0;
    case 'cs': return Array.isArray(v) && raw.replace(/^\{|\}$/g, '').split(',').every((x) => v.includes(x));
    default: return true;
  }
}
function splitTop(s) {
  const out = []; let depth = 0, cur = '';
  for (const ch of s) {
    if (ch === '(') depth++; if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; } else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}
function partMatch(row, part) {
  if (part.startsWith('and(')) return splitTop(part.slice(4, -1)).every((p) => partMatch(row, p));
  const i = part.indexOf('.');
  return test1(row, part.slice(0, i), part.slice(i + 1));
}
function orMatch(row, expr) {
  return splitTop(expr.replace(/^\(|\)$/g, '')).some((part) => partMatch(row, part));
}
const RESERVED = new Set(['select', 'order', 'limit', 'offset', 'on_conflict', 'columns']);
function filterRows(rows, params) {
  return rows.filter((r) => {
    for (const [k, v] of params) {
      if (RESERVED.has(k)) continue;
      if (k === 'or') { if (!orMatch(r, v)) return false; continue; }
      if (!test1(r, k, v)) return false;
    }
    return true;
  });
}
function orderRows(rows, spec) {
  if (!spec) return rows;
  const keys = spec.split(',').map((s) => { const [col, dir = 'asc', nulls] = s.split('.'); return { col, desc: dir === 'desc', nullsLast: nulls ? nulls === 'nullslast' : dir === 'desc' ? false : true }; });
  return [...rows].sort((a, b) => {
    for (const k of keys) {
      const av = a[k.col], bv = b[k.col];
      if (av == null && bv == null) continue;
      if (av == null) return k.nullsLast ? 1 : -1;
      if (bv == null) return k.nullsLast ? -1 : 1;
      const c = cmp(av, bv);
      if (c) return k.desc ? -c : c;
    }
    return 0;
  });
}
let idN = 0;
async function fakeSupabase(url, init = {}) {
  const u = new URL(url);
  const method = (init.method || 'GET').toUpperCase();
  const headers = new Headers(init.headers || {});
  const json = (body, status = 200, extra = {}) => new Response(body === undefined ? '' : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...extra } });
  if (u.pathname.startsWith('/rest/v1/rpc/')) return json(null);
  const table = u.pathname.replace('/rest/v1/', '');
  tables[table] ??= [];
  const params = [...u.searchParams.entries()];
  const wantsObject = (headers.get('accept') || '').includes('vnd.pgrst.object');
  const prefer = headers.get('prefer') || '';
  if (method === 'GET' || method === 'HEAD') {
    let rows = orderRows(filterRows(tables[table], params), u.searchParams.get('order'));
    const total = rows.length;
    const off = parseInt(u.searchParams.get('offset') || '0', 10);
    const lim = u.searchParams.get('limit');
    rows = rows.slice(off, lim != null ? off + parseInt(lim, 10) : undefined);
    if (wantsObject) return rows.length === 1 ? json(rows[0]) : json({ code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' }, 406);
    return json(method === 'HEAD' ? undefined : rows, 200, { 'content-range': `${off}-${off + rows.length - 1}/${total}` });
  }
  const body = init.body ? JSON.parse(init.body) : null;
  if (method === 'POST') {
    const list = (Array.isArray(body) ? body : [body]).map((r) => ({ id: r.id ?? `gen-${++idN}`, ...r }));
    tables[table].push(...list);
    const ret = prefer.includes('return=representation') ? list : undefined;
    if (wantsObject) return json(list[0], 201);
    return json(ret ?? null, 201);
  }
  if (method === 'PATCH') {
    const hit = filterRows(tables[table], params);
    for (const r of hit) Object.assign(r, body);
    return json(prefer.includes('return=representation') ? (wantsObject ? hit[0] : hit) : null, 200);
  }
  if (method === 'DELETE') {
    const hit = new Set(filterRows(tables[table], params));
    tables[table] = tables[table].filter((r) => !hit.has(r));
    return json(null, 200);
  }
  return json(null);
}
let received = [];
let receiverStatus = 200;
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const s = String(url);
  if (s.startsWith('http://fake-supabase.test')) return fakeSupabase(s, init);
  if (s.startsWith('https://hook.example')) {
    received.push({ url: s, headers: init.headers, body: init.body });
    return new Response(receiverStatus === 204 ? null : 'ack', { status: receiverStatus });
  }
  if (s.includes('127.0.0.1')) return realFetch(url, init);
  throw new Error(`unexpected network call in test: ${s}`);
};

// ── app under test ───────────────────────────────────────────────────────────
const WS = '11111111-1111-4111-8111-111111111111';
const OTHER_WS = '99999999-9999-4999-8999-999999999999';
const SUB = '22222222-2222-4222-8222-222222222222';
const OE = '33333333-3333-4333-8333-333333333333';
const D_FAIL = '44444444-4444-4444-8444-444444444444';
const D_OLD = '55555555-5555-4555-8555-555555555555';
const D_FOREIGN = '66666666-6666-4666-8666-666666666666';
const D_ORPHAN = '77777777-7777-4777-8777-777777777777';

const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.workspaceId = WS; req.viewerScope = 'admin'; next(); });
app.use('/api/triggers', triggersRouter);
app.use('/v2/webhooks', webhooksV2Router);
const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
const base = `http://127.0.0.1:${server.address().port}`;
after(() => { server.closeAllConnections?.(); server.close(); });
const call = async (method, path, body) => {
  const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};

const ago = (h) => new Date(Date.now() - h * 3600_000).toISOString();
const delivery = (id, over) => ({
  id, workspace_id: WS, subscription_id: SUB, outbound_event_id: OE, event: 'deal.won', event_id: 'evt_1',
  attempt: 1, status_code: 200, ok: true, error: null, duration_ms: 50, resent_from: null, ...over,
});
const PAYLOAD = { id: 'evt_1', type: 'deal.won', data: { amount: 4200 } };

beforeEach(() => {
  received = [];
  receiverStatus = 200;
  tables = {
    trigger_subscriptions: [{
      id: SUB, workspace_id: WS, name: 'n8n', url: 'https://hook.example/nous', events: ['deal.won'],
      signing_secret: 'whsec_current', active: true, created_at: ago(500), updated_at: ago(1),
    }],
    outbound_events: [{ id: OE, workspace_id: WS, subscription_id: SUB, event_type: 'deal.won', payload: PAYLOAD }],
    webhook_deliveries: [
      // In the 7-day window: 3 attempts, 1 failure.
      delivery(D_FAIL, { attempt: 1, ok: false, status_code: 503, error: 'down', created_at: ago(30) }),
      delivery('d-2', { attempt: 2, created_at: ago(29) }),
      delivery('d-3', { event_id: 'evt_2', created_at: ago(2) }),
      // Outside the window: counted by neither total nor failures.
      delivery(D_OLD, { ok: false, status_code: 500, created_at: ago(24 * 8) }),
      // Another workspace's row on a lookalike id.
      { ...delivery(D_FOREIGN, { created_at: ago(1) }), workspace_id: OTHER_WS },
      // A row whose outbox event is gone.
      delivery(D_ORPHAN, { outbound_event_id: null, created_at: ago(3) }),
    ],
  };
});

test('GET /api/triggers/:id/deliveries lists newest first, pages with before, hides workspace_id', async () => {
  const r = await call('GET', `/api/triggers/${SUB}/deliveries?workspace_id=${WS}&limit=2`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.deliveries.map((d) => d.id), ['d-3', D_ORPHAN]);
  assert.equal(r.body.deliveries[0].workspace_id, undefined);
  assert.equal(r.body.next_before, `${r.body.deliveries[1].created_at}|${D_ORPHAN}`);
  const next = await call('GET', `/api/triggers/${SUB}/deliveries?limit=10&before=${encodeURIComponent(r.body.next_before)}`);
  assert.deepEqual(next.body.deliveries.map((d) => d.id), ['d-2', D_FAIL, D_OLD]);
  // A short page is the last page.
  assert.equal(next.body.next_before, null);
  // The old bare-timestamp cursor still works.
  const legacy = await call('GET', `/api/triggers/${SUB}/deliveries?limit=10&before=${encodeURIComponent(r.body.deliveries[1].created_at)}`);
  assert.deepEqual(legacy.body.deliveries.map((d) => d.id), ['d-2', D_FAIL, D_OLD]);
  assert.equal((await call('GET', `/api/triggers/${SUB}/deliveries?before=${encodeURIComponent('2026-10-03T10:00:00Z|not-a-uuid')}`)).status, 400);
  assert.equal((await call('GET', `/api/triggers/${SUB}/deliveries?before=yesterday`)).status, 400);
  assert.equal((await call('GET', `/api/triggers/${OTHER_WS}/deliveries`)).status, 404);
});

test('GET /api/triggers/:id/stats: 7-day attempts, failures, rate and the last delivery', async () => {
  const r = await call('GET', `/api/triggers/${SUB}/stats`);
  assert.equal(r.status, 200);
  // In window: D_FAIL (fail), d-2, d-3, D_ORPHAN → 4 attempts, 1 failure.
  assert.equal(r.body.deliveries_7d, 4);
  assert.equal(r.body.failures_7d, 1);
  assert.equal(r.body.success_rate_7d, 0.75);
  assert.equal(r.body.last_delivery_at, tables.webhook_deliveries.find((d) => d.id === 'd-3').created_at);
});

test('GET stats with no deliveries reads a null rate, not 0%', async () => {
  tables.webhook_deliveries = [];
  const r = await call('GET', `/v2/webhooks/${SUB}/stats`);
  assert.deepEqual(r.body, { success_rate_7d: null, deliveries_7d: 0, failures_7d: 0, last_delivery_at: null });
});

test('POST /api/triggers/deliveries/:id/resend re-sends the stored body, signed, and records resent_from', async () => {
  receiverStatus = 204;
  const r = await call('POST', `/api/triggers/deliveries/${D_FAIL}/resend`);
  assert.equal(r.status, 200);
  assert.equal(received.length, 1);
  const sent = received[0];
  assert.equal(sent.url, 'https://hook.example/nous');
  assert.deepEqual(JSON.parse(sent.body), PAYLOAD);
  const sig = crypto.createHmac('sha256', 'whsec_current').update(sent.body).digest('hex');
  assert.equal(sent.headers['X-Nous-Signature'], `sha256=${sig}`);
  assert.equal(sent.headers['X-Nous-Event-Id'], 'evt_1');
  assert.equal(r.body.delivery.resent_from, D_FAIL);
  assert.equal(r.body.delivery.ok, true);
  assert.equal(r.body.delivery.status_code, 204);
  assert.equal(r.body.result.ok, true);
  const stored = tables.webhook_deliveries.filter((d) => d.resent_from === D_FAIL);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].workspace_id, WS);
  // The outbox row is left alone.
  assert.deepEqual(Object.keys(tables.outbound_events[0]).sort(), ['event_type', 'id', 'payload', 'subscription_id', 'workspace_id']);
});

test('resend on the public API records a failed resend too', async () => {
  receiverStatus = 500;
  const r = await call('POST', `/v2/webhooks/deliveries/${D_FAIL}/resend`);
  assert.equal(r.status, 200);
  assert.equal(r.body.delivery.ok, false);
  assert.equal(r.body.delivery.status_code, 500);
  // The status line, never the receiver's body ('ack'): the result is shown to whoever pressed Resend.
  assert.equal(r.body.delivery.error, 'http_500');
  assert.equal(r.body.result.error, 'http_500');
});

test('resend refuses: another workspace 404, no payload 410, paused webhook 409, bad id 404', async () => {
  assert.equal((await call('POST', `/api/triggers/deliveries/${D_FOREIGN}/resend`)).status, 404);
  assert.equal((await call('POST', `/api/triggers/deliveries/${D_ORPHAN}/resend`)).status, 410);
  tables.trigger_subscriptions[0].active = false;
  assert.equal((await call('POST', `/api/triggers/deliveries/${D_FAIL}/resend`)).status, 409);
  assert.equal((await call('POST', '/api/triggers/deliveries/not-a-uuid/resend')).status, 404);
  assert.equal(received.length, 0, 'nothing was sent');
});

test('/v2/webhooks/:id/attempts is the per-attempt log; /:id/deliveries keeps its outbox shape', async () => {
  const a = await call('GET', `/v2/webhooks/${SUB}/attempts?limit=50`);
  assert.equal(a.status, 200);
  assert.equal(a.body.deliveries.length, 5);
  const d = await call('GET', `/v2/webhooks/${SUB}/deliveries`);
  assert.equal(d.status, 200);
  assert.deepEqual(d.body.deliveries.map((x) => x.id), [OE]);
});

test('deliveries: rows sharing a created_at are not skipped across a page boundary', async () => {
  const at = ago(5);
  const ids = ['00000000-0000-4000-8000-0000000000a3', '00000000-0000-4000-8000-0000000000a2', '00000000-0000-4000-8000-0000000000a1'];
  tables.webhook_deliveries = ids.map((id) => delivery(id, { created_at: at }));
  const first = await call('GET', `/api/triggers/${SUB}/deliveries?limit=2`);
  assert.deepEqual(first.body.deliveries.map((d) => d.id), ids.slice(0, 2));
  const second = await call('GET', `/api/triggers/${SUB}/deliveries?limit=2&before=${encodeURIComponent(first.body.next_before)}`);
  assert.deepEqual(second.body.deliveries.map((d) => d.id), [ids[2]]);
  assert.equal(second.body.next_before, null);
});

test('POST /api/triggers/:id/test sends now through the signed send, logs a webhook.test delivery, and resend replays it', async () => {
  receiverStatus = 204;
  const r = await call('POST', `/api/triggers/${SUB}/test`);
  assert.equal(r.status, 200);
  assert.equal(received.length, 1);
  const sent = received[0];
  assert.equal(sent.headers['X-Nous-Event-Type'], 'webhook.test');
  assert.equal(sent.headers['X-Nous-Signature'], `sha256=${crypto.createHmac('sha256', 'whsec_current').update(sent.body).digest('hex')}`);
  const body = JSON.parse(sent.body);
  assert.equal(body.type, 'webhook.test');
  assert.equal(body.id, r.body.event_id);
  assert.deepEqual(r.body.result, { ok: true, status_code: 204, error: null, duration_ms: r.body.result.duration_ms });
  assert.equal(r.body.delivery.event, 'webhook.test');
  assert.equal(r.body.delivery.workspace_id, undefined);
  // It is in the log the Webhooks page reads.
  const stored = tables.webhook_deliveries.find((d) => d.id === r.body.delivery.id);
  assert.deepEqual([stored.workspace_id, stored.subscription_id, stored.event, stored.ok], [WS, SUB, 'webhook.test', true]);
  const log = await call('GET', `/api/triggers/${SUB}/deliveries?limit=50`);
  assert.ok(log.body.deliveries.some((d) => d.id === r.body.delivery.id));
  // The outbox row is settled, so the worker will not send it again.
  const oe = tables.outbound_events.find((e) => e.event_type === 'webhook.test');
  assert.ok(oe.delivered_at);
  // Resend replays the same body. (The fake hands out non-uuid ids; give the row a real one.)
  stored.id = '88888888-8888-4888-8888-888888888888';
  const again = await call('POST', `/api/triggers/deliveries/${stored.id}/resend`);
  assert.equal(again.status, 200);
  assert.equal(received[1].body, sent.body);
});

test('POST /api/triggers/:id/test: failure reports the status line only; 404 / 409 / 429', async () => {
  receiverStatus = 500;
  const r = await call('POST', `/api/triggers/${SUB}/test`);
  assert.equal(r.status, 200);
  assert.equal(r.body.result.ok, false);
  assert.equal(r.body.result.error, 'http_500');
  assert.equal((await call('POST', `/api/triggers/${OTHER_WS}/test`)).status, 404);
  assert.equal((await call('POST', '/api/triggers/not-a-uuid/test')).status, 404);
  tables.trigger_subscriptions[0].active = false;
  assert.equal((await call('POST', `/api/triggers/${SUB}/test`)).status, 409);
  tables.trigger_subscriptions[0].active = true;
  // 50 per webhook per minute, per process, shared with /v2/webhooks/:id/test. Two were used
  // already (the test above and the 500 here); a paused webhook's 409 does not count.
  const codes = [];
  for (let i = 0; i < 49; i++) codes.push((await call('POST', `/api/triggers/${SUB}/test`)).status);
  assert.deepEqual(codes, [...Array(48).fill(200), 429]);
  assert.equal((await call('POST', `/v2/webhooks/${SUB}/test`)).status, 429);
});
