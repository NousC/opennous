// The outbound dispatcher writes one webhook_deliveries row per attempt (GET-624): a delivery
// records a row, retries record their attempt number, and a log insert that fails never breaks
// or retries the delivery itself. No network, no database: supabase and fetch are fakes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.SUPABASE_URL ??= 'http://fake-supabase.test';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'service-role-test';

const { deliverOne } = await import('../src/workers/triggerDelivery.mjs');

// Records every write; `failDeliveriesInsert` makes the log insert return an error.
function fakeSupabase({ failDeliveriesInsert = false, throwOnDeliveries = false } = {}) {
  const writes = [];
  return {
    writes,
    from(table) {
      if (throwOnDeliveries && table === 'webhook_deliveries') throw new Error('client exploded');
      const st = { table, op: null, row: null, filters: {} };
      const b = {
        insert(row) { st.op = 'insert'; st.row = row; return b; },
        update(row) { st.op = 'update'; st.row = row; return b; },
        select() { return b; },
        eq(c, v) { st.filters[c] = v; return b; },
        single() { return b; },
        then(res, rej) {
          writes.push(st);
          if (st.op === 'insert' && table === 'webhook_deliveries' && failDeliveriesInsert) {
            return Promise.resolve({ data: null, error: { message: 'relation "webhook_deliveries" does not exist' } }).then(res, rej);
          }
          return Promise.resolve({ data: st.op === 'insert' ? { id: 'wd-1', ...st.row } : null, error: null }).then(res, rej);
        },
      };
      return b;
    },
  };
}

const pending = (over = {}) => ({
  id: 'oe-1', workspace_id: 'ws-1', subscription_id: 'sub-1', event_type: 'deal.won',
  payload: { id: 'evt_9', type: 'deal.won' }, attempts: 0,
  url: 'https://hook.example/in', signing_secret: 'whsec_test', active: true, ...over,
});
const logRows = (sb) => sb.writes.filter((w) => w.table === 'webhook_deliveries' && w.op === 'insert').map((w) => w.row);
const outboxUpdates = (sb) => sb.writes.filter((w) => w.table === 'outbound_events' && w.op === 'update').map((w) => w.row);

test('a successful delivery marks the outbox delivered and records one attempt row', async () => {
  const sb = fakeSupabase();
  const sent = [];
  await deliverOne(sb, pending(), { fetchImpl: async (url, init) => { sent.push(init); return new Response('ok', { status: 200 }); } });

  assert.equal(sent.length, 1);
  const expected = crypto.createHmac('sha256', 'whsec_test').update(sent[0].body).digest('hex');
  assert.equal(sent[0].headers['X-Nous-Signature'], `sha256=${expected}`);
  assert.equal(sent[0].headers['X-Nous-Event-Id'], 'evt_9');

  assert.ok(outboxUpdates(sb)[0].delivered_at, 'outbox marked delivered');
  const rows = logRows(sb);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].ok, true);
  assert.equal(rows[0].status_code, 200);
  assert.equal(rows[0].attempt, 1);
  assert.equal(rows[0].error, null);
  assert.equal(rows[0].outbound_event_id, 'oe-1');
  assert.equal(rows[0].subscription_id, 'sub-1');
  assert.equal(rows[0].workspace_id, 'ws-1');
  assert.equal(rows[0].event, 'deal.won');
  assert.equal(rows[0].event_id, 'evt_9');
  assert.equal(typeof rows[0].duration_ms, 'number');
  assert.equal(rows[0].resent_from, null);
});

test('retries record each attempt with its number; a 5xx schedules a retry', async () => {
  const sb = fakeSupabase();
  const replies = [503, 502, 200];
  let attempts = 0;
  for (const status of replies) {
    await deliverOne(sb, pending({ attempts }), { fetchImpl: async () => new Response(status === 200 ? 'ok' : 'upstream down', { status }) });
    attempts++;
  }
  const rows = logRows(sb);
  assert.deepEqual(rows.map((r) => r.attempt), [1, 2, 3]);
  assert.deepEqual(rows.map((r) => r.ok), [false, false, true]);
  assert.deepEqual(rows.map((r) => r.status_code), [503, 502, 200]);
  // The status line only: the receiver's body ('upstream down') is not stored (GET-620 review).
  assert.equal(rows[0].error, 'http_503');
  const updates = outboxUpdates(sb);
  assert.equal(updates[0].attempts, 1);
  assert.equal(updates[0].dead_lettered_at, null, 'a 503 is retried, not dead-lettered');
});

test('a timeout or network error records a row with no status code', async () => {
  const sb = fakeSupabase();
  await deliverOne(sb, pending({ attempts: 2 }), { fetchImpl: async () => { throw new Error('ECONNRESET'); } });
  const [row] = logRows(sb);
  assert.deepEqual([row.ok, row.status_code, row.error, row.attempt], [false, null, 'ECONNRESET', 3]);
});

test('a failing log insert never breaks the delivery or its outbox state', async () => {
  for (const opts of [{ failDeliveriesInsert: true }, { throwOnDeliveries: true }]) {
    const sb = fakeSupabase(opts);
    let posts = 0;
    const r = await deliverOne(sb, pending(), { fetchImpl: async () => { posts++; return new Response('ok', { status: 200 }); } });
    assert.equal(posts, 1, 'sent exactly once');
    assert.equal(r.ok, true);
    assert.ok(outboxUpdates(sb)[0].delivered_at, 'still marked delivered');
  }
});
