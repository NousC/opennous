// Record events (GET-559): emitEvent finds who listens, builds the record once and queues one
// delivery per subscription; history and duplicates stay quiet.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emitEvent, buildEventRecord } from '../dist/services/events.mjs';

const WS = '11111111-1111-1111-1111-111111111111';
const ACC = '22222222-2222-2222-2222-222222222222';
const JIM = '33333333-3333-3333-3333-333333333333';
const ANA = '44444444-4444-4444-4444-444444444444';
const OPEN = '55555555-5555-5555-5555-555555555555';
const WON = '66666666-6666-6666-6666-666666666666';

// A Supabase stand-in: every chain method returns the query; awaiting it answers with the
// table's fixture, narrowed by the eq filters it understands. Writes are recorded.
function fakeDb(tables) {
  const writes = [];
  return {
    writes,
    from(table) {
      const filters = [];
      const q = new Proxy({}, {
        get(_t, prop) {
          if (prop === 'then') {
            const rows = (tables[table] ?? []).filter(r => filters.every(([k, v]) => !(k in r) || r[k] === v));
            return (resolve) => resolve({ data: rows, error: null });
          }
          if (prop === 'maybeSingle' || prop === 'single') {
            return async () => {
              const rows = (tables[table] ?? []).filter(r => filters.every(([k, v]) => !(k in r) || r[k] === v));
              return { data: rows[0] ?? null, error: null };
            };
          }
          if (prop === 'upsert' || prop === 'insert') {
            return async (rows, opts) => { writes.push({ table, op: prop, rows, opts }); return { error: null }; };
          }
          if (prop === 'eq') return (k, v) => { filters.push([k, v]); return q; };
          return () => q;
        },
      });
      return q;
    },
  };
}

const NOW = new Date().toISOString();
const fixtures = () => ({
  trigger_subscriptions: [{ id: 'sub-1', created_at: '2026-01-01T00:00:00Z' }],
  entity_list_rows: [
    { entity_id: ACC, kind: 'account', name: 'Corrigan Systems', domain: 'corrigan-systems.example', industry: 'Software', deal_health: 71, icp_score: 82, open_deals: 1, pipeline_value: '12000', people_count: 2 },
    { entity_id: ANA, kind: 'person', company_id: ACC, name: 'Marisol Penhale', email: 'marisol@corrigan-systems.example', job_title: 'Controller' },
    { entity_id: JIM, kind: 'person', company_id: ACC, name: 'Hobart Quayle', email: 'hobart@corrigan-systems.example', job_title: 'GM' },
  ],
  predictions: [{ predicted_value: { score: 82, tier: 'A' } }],
  relationships: [{ from_entity_id: OPEN }, { from_entity_id: WON }],
  claims: [
    { entity_id: OPEN, property: 'name', value: 'Corrigan — Enterprise' },
    { entity_id: OPEN, property: 'stage', value: 'negotiation' },
    { entity_id: OPEN, property: 'value', value: { value: 12000 } },
    { entity_id: OPEN, property: 'close_date', value: '2026-10-30' },
    { entity_id: OPEN, property: 'owner_name', value: 'Odile Brenner' },
    { entity_id: WON, property: 'name', value: 'Corrigan — Pilot' },
    { entity_id: WON, property: 'status', value: 'won' },
    { entity_id: WON, property: 'close_date', value: '2026-03-01' },
  ],
});

test('a fresh event with a listener queues one signed-ready delivery carrying the record', async () => {
  const db = fakeDb(fixtures());
  const n = await emitEvent(db, {
    workspaceId: WS, type: 'conversation.reply_received', personId: JIM, accountId: ACC,
    occurredAt: NOW, dedupeKey: '<msg-1@mail>', data: { subject: 'Re: pricing' },
  });
  assert.equal(n, 1);
  const w = db.writes.find(x => x.table === 'outbound_events');
  assert.equal(w.op, 'upsert');
  assert.equal(w.opts.onConflict, 'workspace_id,subscription_id,external_id');
  const [row] = w.rows;
  assert.equal(row.subscription_id, 'sub-1');
  assert.equal(row.external_id, 'conversation.reply_received:<msg-1@mail>');
  const p = row.payload;
  assert.equal(p.type, 'conversation.reply_received');
  assert.ok(p.id && p.api_version);
  assert.equal(p.account.name, 'Corrigan Systems');
  assert.deepEqual(p.account.icp, { score: 82, tier: 'A' });
  assert.equal(p.people[0].name, 'Hobart Quayle', 'the person the event is about comes first');
  assert.equal(p.deal.name, 'Corrigan — Enterprise', 'the open deal, not the won pilot');
  assert.equal(p.deal.amount, 12000);
  assert.deepEqual(p.deal.owner, { name: 'Odile Brenner', email: null });
  assert.equal(p.deals_count, 2);
  assert.ok(Array.isArray(p.evidence.claims) && Array.isArray(p.evidence.facts));
  assert.deepEqual(p.data, { subject: 'Re: pricing' });
});

test('history stays quiet: an event older than its window queues nothing', async () => {
  const db = fakeDb(fixtures());
  const old = new Date(Date.now() - 72 * 3_600_000).toISOString();
  assert.equal(await emitEvent(db, { workspaceId: WS, type: 'conversation.call_ended', accountId: ACC, occurredAt: old, dedupeKey: 'm1' }), 0);
  assert.equal(db.writes.length, 0);
});

test('a deal close weeks old still goes out when the caller widens the window', async () => {
  const db = fakeDb(fixtures());
  const closed = new Date(Date.now() - 20 * 86_400_000).toISOString();
  assert.equal(await emitEvent(db, {
    workspaceId: WS, type: 'deal.won', accountId: ACC, dealId: WON, occurredAt: closed,
    dedupeKey: `${WON}:closed_won`, maxAgeHours: 45 * 24,
  }), 1);
  const p = db.writes.find(x => x.table === 'outbound_events').rows[0].payload;
  assert.equal(p.deal.name, 'Corrigan — Pilot', 'a named deal is the one sent');
});

test('a subscription hears nothing from before the week it was created', async () => {
  const f = fixtures();
  f.trigger_subscriptions = [{ id: 'sub-new', created_at: new Date().toISOString() }];
  const db = fakeDb(f);
  const closed = new Date(Date.now() - 20 * 86_400_000).toISOString();
  assert.equal(await emitEvent(db, {
    workspaceId: WS, type: 'deal.lost', accountId: ACC, occurredAt: closed, dedupeKey: 'x', maxAgeHours: 45 * 24,
  }), 0);
});

test('nobody listening: nothing is queued, but the event is logged for the Events page (GET-939)', async () => {
  const f = fixtures();
  f.trigger_subscriptions = [];
  const db = fakeDb(f);
  assert.equal(await emitEvent(db, { workspaceId: WS, type: 'deal.won', accountId: ACC, occurredAt: NOW, dedupeKey: 'k' }), 0);
  assert.deepEqual(db.writes.map(w => w.table), ['event_log']);
  const [w] = db.writes;
  assert.equal(w.opts.onConflict, 'workspace_id,external_id');
  assert.equal(w.rows.external_id, 'deal.won:k');
  assert.equal(w.rows.entity_id, ACC);
  assert.equal(w.rows.id, w.rows.payload.id, 'the row id is the envelope id');
  assert.equal(w.rows.payload.account.name, 'Corrigan Systems');
});

test('a listener: the event is logged once and the delivery carries the same id (GET-939)', async () => {
  const db = fakeDb(fixtures());
  assert.equal(await emitEvent(db, { workspaceId: WS, type: 'deal.won', accountId: ACC, occurredAt: NOW, dedupeKey: 'k' }), 1);
  const log = db.writes.find(x => x.table === 'event_log');
  const out = db.writes.find(x => x.table === 'outbound_events');
  assert.equal(out.rows[0].payload.id, log.rows.id);
});

test('already logged, a new subscriber: sent the logged body, no record rebuilt, not logged twice (GET-939)', async () => {
  const f = fixtures();
  const logged = { id: 'evt-1', type: 'deal.won', account: { entity_id: ACC, name: 'As logged' } };
  f.event_log = [{ id: 'evt-1', payload: logged }];
  f.entity_list_rows = []; // a rebuild would lose the account name
  const db = fakeDb(f);
  assert.equal(await emitEvent(db, { workspaceId: WS, type: 'deal.won', accountId: ACC, occurredAt: NOW, dedupeKey: 'k' }), 1);
  assert.deepEqual(db.writes.map(w => w.table), ['outbound_events']);
  assert.equal(db.writes[0].rows[0].payload, logged);
});

test('already logged and nobody new to send to: nothing written', async () => {
  const f = fixtures();
  f.trigger_subscriptions = [];
  f.event_log = [{ id: 'evt-1', payload: { id: 'evt-1' } }];
  const db = fakeDb(f);
  assert.equal(await emitEvent(db, { workspaceId: WS, type: 'deal.won', accountId: ACC, occurredAt: NOW, dedupeKey: 'k' }), 0);
  assert.equal(db.writes.length, 0);
});

test('an event without a dedupe key is refused rather than sent twice', async () => {
  const db = fakeDb(fixtures());
  assert.equal(await emitEvent(db, { workspaceId: WS, type: 'deal.won', accountId: ACC, occurredAt: NOW }), 0);
});

test('a person-only event finds the account they work at', async () => {
  const db = fakeDb(fixtures());
  const r = await buildEventRecord(db, WS, { personId: ANA });
  assert.equal(r.account?.entity_id, ACC);
  assert.equal(r.people[0].name, 'Marisol Penhale');
});

test('already sent to a subscription: skipped before any record is built', async () => {
  const f = fixtures();
  f.outbound_events = [{ subscription_id: 'sub-1', external_id: 'deal.won:k1' }];
  f.event_log = [{ id: 'evt-k1', payload: { id: 'evt-k1' } }];
  const db = fakeDb(f);
  assert.equal(await emitEvent(db, { workspaceId: WS, type: 'deal.won', accountId: ACC, occurredAt: NOW, dedupeKey: 'k1' }), 0);
  assert.equal(db.writes.length, 0);
});

test('every listener already had it (sent before the log existed): not logged as new (GET-939)', async () => {
  const f = fixtures();
  f.outbound_events = [{ subscription_id: 'sub-1', external_id: 'deal.won:old' }];
  const db = fakeDb(f);
  assert.equal(await emitEvent(db, { workspaceId: WS, type: 'deal.won', accountId: ACC, occurredAt: NOW, dedupeKey: 'old' }), 0);
  assert.equal(db.writes.length, 0);
});

test('older than the log keeps: sent to a listener, but not logged on top of the feed (GET-939)', async () => {
  const db = fakeDb(fixtures());
  const closed = new Date(Date.now() - 40 * 86_400_000).toISOString();
  assert.equal(await emitEvent(db, { workspaceId: WS, type: 'deal.won', accountId: ACC, occurredAt: closed, dedupeKey: 'late', maxAgeHours: 45 * 24 }), 1);
  assert.deepEqual(db.writes.map(w => w.table), ['outbound_events']);
});

test('an account or person marked personal makes no event: nothing logged, nothing queued (GET-1014)', async () => {
  for (const marked of [ACC, ANA]) {
    const f = fixtures();
    f.claims.push({ entity_id: marked, property: 'is_personal', value: true });
    const db = fakeDb(f);
    const n = await emitEvent(db, {
      workspaceId: WS, type: 'signal.buying_signal', accountId: ACC, personId: ANA,
      occurredAt: NOW, data: { title: 'Wants it next month' }, dedupeKey: `personal-${marked}`,
    });
    assert.equal(n, 0);
    assert.equal(db.writes.length, 0);
  }
});
