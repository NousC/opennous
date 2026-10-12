// Webhook delivery log (GET-624): recording never fails a delivery, the 7-day stats math, the
// signed send, and Resend (same body, current secret, resent_from set).
//
// Run: pnpm --filter @nous/core build && node --test packages/core/test/webhookDeliveries.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  summarizeDeliveryStats, recordDeliveryAttempt, sendSignedDelivery, resendDelivery,
  signWebhookBody, eventIdOf, DELIVERY_ERROR_MAX, createResendLimiter, statusReason,
  sendTestDelivery, TEST_EVENT_TYPE,
} from '../dist/db/webhookDeliveries.js';

// A small supabase-js-shaped fake over in-memory tables: eq/lt/gte filters, order, limit,
// single/maybeSingle, insert/delete, head counts. `failInsert` makes inserts on a table error.
function fakeSupabase(tables = {}, { failInsert = new Set() } = {}) {
  let n = 0;
  return {
    tables,
    from(table) {
      tables[table] ??= [];
      const st = { filters: [], order: null, limit: null, mode: 'select', row: null, one: null, head: false, count: false };
      const b = {
        select(_cols, opts) { if (opts?.head) st.head = true; if (opts?.count) st.count = true; return b; },
        insert(row) { st.mode = 'insert'; st.row = row; return b; },
        delete(opts) { st.mode = 'delete'; if (opts?.count) st.count = true; return b; },
        update(patch) { st.mode = 'update'; st.row = patch; return b; },
        eq(c, v) { st.filters.push((r) => r[c] === v); return b; },
        lt(c, v) { st.filters.push((r) => r[c] < v); return b; },
        gte(c, v) { st.filters.push((r) => r[c] >= v); return b; },
        order(c, o) { st.order = { c, desc: o?.ascending === false }; return b; },
        limit(k) { st.limit = k; return b; },
        single() { st.one = 'single'; return b; },
        maybeSingle() { st.one = 'maybe'; return b; },
        then(res, rej) { return Promise.resolve(run()).then(res, rej); },
      };
      function run() {
        if (st.mode === 'insert') {
          if (failInsert.has(table)) return { data: null, error: { message: 'relation does not exist' } };
          const row = { id: `${table}-${++n}`, created_at: new Date().toISOString(), ...st.row };
          tables[table].push(row);
          return { data: st.one ? row : [row], error: null };
        }
        let rows = tables[table].filter((r) => st.filters.every((f) => f(r)));
        if (st.mode === 'update') {
          for (const r of rows) Object.assign(r, st.row);
          return { data: null, error: null };
        }
        if (st.mode === 'delete') {
          tables[table] = tables[table].filter((r) => !rows.includes(r));
          return { data: null, error: null, count: rows.length };
        }
        if (st.order) rows = [...rows].sort((a, z) => (a[st.order.c] < z[st.order.c] ? -1 : 1) * (st.order.desc ? -1 : 1));
        if (st.limit != null) rows = rows.slice(0, st.limit);
        if (st.head) return { data: null, error: null, count: rows.length };
        if (st.one) return { data: rows[0] ?? null, error: null };
        return { data: rows, error: null };
      }
      return b;
    },
  };
}

const okResult = { ok: true, status_code: 200, error: null, duration_ms: 12.4, permanent: false };

test('summarizeDeliveryStats: rate over attempts, null when nothing was sent', () => {
  assert.deepEqual(summarizeDeliveryStats(0, 0, null), { success_rate_7d: null, deliveries_7d: 0, failures_7d: 0, last_delivery_at: null });
  assert.deepEqual(summarizeDeliveryStats(12, 1, '2026-10-02T10:00:00Z'), { success_rate_7d: 0.9167, deliveries_7d: 12, failures_7d: 1, last_delivery_at: '2026-10-02T10:00:00Z' });
  assert.equal(summarizeDeliveryStats(4, 4, null).success_rate_7d, 0);
  assert.equal(summarizeDeliveryStats(3, 0, null).success_rate_7d, 1);
  // A failure count above the total (a race between the two count reads) is clamped.
  assert.equal(summarizeDeliveryStats(2, 5, null).failures_7d, 2);
});

test('recordDeliveryAttempt writes one row, truncates the error, nulls it on success', async () => {
  const sb = fakeSupabase();
  const row = await recordDeliveryAttempt(sb, {
    workspaceId: 'ws', subscriptionId: 'sub', outboundEventId: 'oe', event: 'deal.won', eventId: 'ev', attempt: 2,
    result: { ok: false, status_code: 503, error: 'x'.repeat(900), duration_ms: 40, permanent: false },
  });
  assert.equal(row.attempt, 2);
  assert.equal(row.ok, false);
  assert.equal(row.status_code, 503);
  assert.equal(row.error.length, DELIVERY_ERROR_MAX);
  const ok = await recordDeliveryAttempt(sb, {
    workspaceId: 'ws', subscriptionId: 'sub', outboundEventId: 'oe', event: 'deal.won', eventId: 'ev', attempt: 3,
    result: { ...okResult, error: 'ignored' },
  });
  assert.equal(ok.error, null);
  assert.equal(ok.duration_ms, 12);
  assert.equal(sb.tables.webhook_deliveries.length, 2);
});

test('recordDeliveryAttempt never throws: an insert error or a thrown client both return null', async () => {
  const failing = fakeSupabase({}, { failInsert: new Set(['webhook_deliveries']) });
  const p = { workspaceId: 'ws', subscriptionId: 'sub', outboundEventId: null, event: 'deal.won', eventId: null, attempt: 1, result: okResult };
  assert.equal(await recordDeliveryAttempt(failing, p), null);
  const throwing = { from() { throw new Error('boom'); } };
  assert.equal(await recordDeliveryAttempt(throwing, p), null);
});

test('sendSignedDelivery signs the raw body and classifies the response', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, init }); return new Response('nope', { status: 410 }); };
  const r = await sendSignedDelivery({ url: 'https://hook.example/x', secret: 'whsec_a', eventType: 'deal.won', eventId: 'e1', payload: { id: 'e1', n: 1 }, fetchImpl });
  assert.equal(r.ok, false);
  assert.equal(r.status_code, 410);
  assert.equal(r.permanent, true);
  // The receiver's body ('nope') is never echoed: only the status line.
  assert.equal(r.error, 'http_410');
  assert.equal(calls[0].init.redirect, 'manual');
  const h = calls[0].init.headers;
  assert.equal(h['X-Nous-Signature'], `sha256=${crypto.createHmac('sha256', 'whsec_a').update(calls[0].init.body).digest('hex')}`);
  assert.equal(h['X-Nous-Event-Id'], 'e1');

  const net = await sendSignedDelivery({ url: 'https://hook.example/x', secret: 's', eventType: 't', eventId: 'e', payload: {}, fetchImpl: async () => { throw new Error('ECONNREFUSED'); } });
  assert.deepEqual([net.ok, net.status_code, net.error, net.permanent], [false, null, 'ECONNREFUSED', false]);
  const r429 = await sendSignedDelivery({ url: 'https://hook.example/x', secret: 's', eventType: 't', eventId: 'e', payload: {}, fetchImpl: async () => new Response('', { status: 429 }) });
  assert.equal(r429.permanent, false);
});

test('eventIdOf: event_id, then id, then the outbox id', () => {
  assert.equal(eventIdOf({ event_id: 'a', id: 'b' }, 'c'), 'a');
  assert.equal(eventIdOf({ id: 'b' }, 'c'), 'b');
  assert.equal(eventIdOf(null, 'c'), 'c');
});

function resendFixture({ active = true, outboxGone = false } = {}) {
  const payload = { id: 'evt_1', type: 'deal.won', data: { amount: 5000 } };
  return fakeSupabase({
    trigger_subscriptions: [{ id: 'sub1', workspace_id: 'ws', url: 'https://hook.example/in', signing_secret: 'whsec_rotated', active }],
    outbound_events: outboxGone ? [] : [{ id: 'oe1', workspace_id: 'ws', subscription_id: 'sub1', event_type: 'deal.won', payload }],
    webhook_deliveries: [{
      id: 'd1', workspace_id: 'ws', subscription_id: 'sub1', outbound_event_id: 'oe1', event: 'deal.won', event_id: 'evt_1',
      attempt: 6, status_code: 500, ok: false, error: 'down', duration_ms: 30, created_at: '2026-10-01T00:00:00Z', resent_from: null,
    }],
  });
}

test('resendDelivery replays the stored body, re-signed with the current secret, and records resent_from', async () => {
  const sb = resendFixture();
  const sent = [];
  const out = await resendDelivery(sb, 'ws', 'd1', { fetchImpl: async (url, init) => { sent.push({ url, init }); return new Response(null, { status: 204 }); } });
  assert.equal(out.status, 'sent');
  assert.equal(out.result.ok, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, 'https://hook.example/in');
  assert.deepEqual(JSON.parse(sent[0].init.body), sb.tables.outbound_events[0].payload);
  assert.equal(sent[0].init.headers['X-Nous-Signature'], `sha256=${signWebhookBody(sent[0].init.body, 'whsec_rotated')}`);
  assert.equal(sent[0].init.headers['X-Nous-Event-Id'], 'evt_1');
  assert.equal(out.delivery.resent_from, 'd1');
  assert.equal(out.delivery.outbound_event_id, 'oe1');
  assert.equal(out.delivery.ok, true);
  assert.equal(out.delivery.status_code, 204);
  assert.equal(sb.tables.webhook_deliveries.length, 2);
});

test('resendDelivery: other workspace → not_found; outbox gone → payload_gone; paused webhook → subscription_inactive', async () => {
  const never = async () => { throw new Error('must not send'); };
  assert.equal((await resendDelivery(resendFixture(), 'other-ws', 'd1', { fetchImpl: never })).status, 'not_found');
  assert.equal((await resendDelivery(resendFixture({ outboxGone: true }), 'ws', 'd1', { fetchImpl: never })).status, 'payload_gone');
  assert.equal((await resendDelivery(resendFixture({ active: false }), 'ws', 'd1', { fetchImpl: never })).status, 'subscription_inactive');
});

test('sendSignedDelivery: a 3xx is a failure, not followed', async () => {
  const r = await sendSignedDelivery({
    url: 'https://hook.example/x', secret: 's', eventType: 't', eventId: 'e', payload: {},
    fetchImpl: async () => new Response(null, { status: 302, headers: { Location: 'http://169.254.169.254/' } }),
  });
  assert.deepEqual([r.ok, r.status_code, r.error, r.permanent], [false, 302, 'redirect not followed', false]);
});

test('sendSignedDelivery: a non-2xx keeps the status line, never the body', async () => {
  const r = await sendSignedDelivery({
    url: 'https://hook.example/x', secret: 's', eventType: 't', eventId: 'e', payload: {},
    fetchImpl: async () => new Response('stack trace with secrets', { status: 503, statusText: 'Service Unavailable' }),
  });
  assert.equal(r.error, '503 Service Unavailable');
  assert.equal(statusReason(500, 'x'.repeat(200)).length, 80);
  const net = await sendSignedDelivery({ url: 'https://hook.example/x', secret: 's', eventType: 't', eventId: 'e', payload: {}, fetchImpl: async () => { throw new Error('y'.repeat(900)); } });
  assert.equal(net.error.length, DELIVERY_ERROR_MAX);
});

test('the resend limiter allows 10 per subscription per minute, then frees up', () => {
  const lim = createResendLimiter(10, 60_000);
  const t0 = 1_000_000;
  for (let i = 0; i < 10; i++) assert.equal(lim.allow('sub1', t0 + i), true);
  assert.equal(lim.allow('sub1', t0 + 100), false);
  assert.equal(lim.allow('sub2', t0 + 100), true, 'per subscription');
  assert.equal(lim.allow('sub1', t0 + 60_001), true, 'the window slides');
});

test('resendDelivery: a refused limiter is rate_limited and sends nothing', async () => {
  const sb = resendFixture();
  let sent = 0;
  const out = await resendDelivery(sb, 'ws', 'd1', { fetchImpl: async () => { sent++; return new Response('', { status: 200 }); }, allow: (id) => id !== 'sub1' });
  assert.equal(out.status, 'rate_limited');
  assert.equal(sent, 0);
});

function testFixture({ active = true } = {}) {
  return fakeSupabase({
    trigger_subscriptions: [{ id: 'sub1', workspace_id: 'ws', url: 'https://hook.example/in', signing_secret: 'whsec_t', active }],
    outbound_events: [],
    webhook_deliveries: [],
  });
}
const TEST_BODY = { id: 'evt_test', type: 'webhook.test', occurred_at: '2026-10-03T09:00:00.000Z', data: { note: 'x' } };

test('sendTestDelivery signs and sends once, parks then settles the outbox row, and logs the attempt', async () => {
  const sb = testFixture();
  const sent = [];
  const now = Date.parse('2026-10-03T09:00:00Z');
  const out = await sendTestDelivery(sb, 'ws', 'sub1', {
    payload: TEST_BODY, entityId: 'acct1', now,
    fetchImpl: async (url, init) => { sent.push({ url, init }); return new Response('ok body', { status: 200 }); },
  });
  assert.equal(out.status, 'sent');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].init.redirect, 'manual');
  assert.equal(sent[0].init.headers['X-Nous-Event-Type'], TEST_EVENT_TYPE);
  assert.equal(sent[0].init.headers['X-Nous-Event-Id'], 'evt_test');
  assert.equal(sent[0].init.headers['X-Nous-Signature'], `sha256=${signWebhookBody(sent[0].init.body, 'whsec_t')}`);
  const [oe] = sb.tables.outbound_events;
  assert.equal(oe.event_type, 'webhook.test');
  assert.equal(oe.entity_id, 'acct1');
  assert.deepEqual(oe.payload, TEST_BODY);
  // Parked a day out at insert, so the worker never sends it too; settled delivered after.
  assert.equal(oe.next_attempt_at, new Date(now + 86_400_000).toISOString());
  assert.ok(oe.delivered_at);
  assert.equal(oe.attempts, 1);
  const [d] = sb.tables.webhook_deliveries;
  assert.deepEqual([d.event, d.event_id, d.ok, d.status_code, d.outbound_event_id, d.attempt], ['webhook.test', 'evt_test', true, 200, oe.id, 1]);
  assert.equal(out.delivery.id, d.id);
});

test('sendTestDelivery: a failed test is dead-lettered (never retried) and logged with the status line only', async () => {
  const sb = testFixture();
  const out = await sendTestDelivery(sb, 'ws', 'sub1', {
    payload: TEST_BODY, fetchImpl: async () => new Response('secret stack', { status: 500, statusText: 'Internal Server Error' }),
  });
  assert.equal(out.status, 'sent');
  assert.equal(out.result.error, '500 Internal Server Error');
  const [oe] = sb.tables.outbound_events;
  assert.ok(oe.dead_lettered_at);
  assert.equal(oe.delivered_at, undefined);
  assert.equal(sb.tables.webhook_deliveries[0].error, '500 Internal Server Error');
});

test('sendTestDelivery refuses: other workspace, paused webhook, limiter — and sends nothing', async () => {
  const never = async () => { throw new Error('must not send'); };
  assert.equal((await sendTestDelivery(testFixture(), 'other', 'sub1', { payload: TEST_BODY, fetchImpl: never })).status, 'not_found');
  assert.equal((await sendTestDelivery(testFixture({ active: false }), 'ws', 'sub1', { payload: TEST_BODY, fetchImpl: never })).status, 'subscription_inactive');
  const sb = testFixture();
  assert.equal((await sendTestDelivery(sb, 'ws', 'sub1', { payload: TEST_BODY, fetchImpl: never, allow: () => false })).status, 'rate_limited');
  assert.equal(sb.tables.outbound_events.length, 0);
});
