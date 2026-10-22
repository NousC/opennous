// The event log (GET-939): a page of the feed, its cursor, and an unknown cursor.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listEvents, feedView, feedHiddenTypes } from '../dist/db/eventLog.mjs';

// Records every filter the read applies; answers with the fixture rows for the table.
function fakeDb(rows, cursorRow = null) {
  const calls = [];
  return {
    calls,
    from(table) {
      const applied = [];
      const q = new Proxy({}, {
        get(_t, prop) {
          if (prop === 'then') return (resolve) => resolve({ data: rows, error: null });
          if (prop === 'maybeSingle') return async () => ({ data: cursorRow, error: null });
          return (...args) => { applied.push([prop, ...args]); calls.push([table, prop, ...args]); return q; };
        },
      });
      return q;
    },
  };
}

const ev = (i) => ({ id: `e${i}`, created_at: `2026-10-16T10:00:0${i}Z`, payload: { id: `e${i}`, type: 'deal.won' } });

test('a page is the payloads, and has_more when one more row came back', async () => {
  const db = fakeDb([ev(3), ev(2), ev(1)]);
  const page = await listEvents(db, 'ws', { limit: 2 });
  assert.deepEqual(page.events.map(e => e.id), ['e3', 'e2']);
  assert.equal(page.has_more, true);
  assert.ok(db.calls.some(([, op, n]) => op === 'limit' && n === 3), 'asks for one more than the page');
});

test('a family filters by prefix, an exact type by equality, an account by entity', async () => {
  const db = fakeDb([]);
  await listEvents(db, 'ws', { type: 'signal.*', entityId: 'acc' });
  assert.ok(db.calls.some(([, op, k, v]) => op === 'like' && k === 'type' && v === 'signal.%'));
  assert.ok(db.calls.some(([, op, k, v]) => op === 'eq' && k === 'entity_id' && v === 'acc'));
  const db2 = fakeDb([]);
  await listEvents(db2, 'ws', { type: 'deal.won' });
  assert.ok(db2.calls.some(([, op, k, v]) => op === 'eq' && k === 'type' && v === 'deal.won'));
});

test('a cursor continues strictly after the last event, ties broken by id', async () => {
  const db = fakeDb([ev(1)], { id: 'e2', created_at: '2026-10-16T10:00:02Z' });
  const page = await listEvents(db, 'ws', { startingAfter: 'e2' });
  assert.equal(page.has_more, false);
  const or = db.calls.find(([, op]) => op === 'or');
  assert.match(or[2], /created_at\.lt\."2026-10-16T10:00:02Z"/);
  assert.match(or[2], /and\(created_at\.eq\."2026-10-16T10:00:02Z",id\.lt\.e2\)/);
});

test('a cursor that is not an event here is reported, not read as page one', async () => {
  const page = await listEvents(fakeDb([ev(1)], null), 'ws', { startingAfter: 'gone' });
  assert.deepEqual(page, { events: [], has_more: false, unknown_cursor: true });
});

test("the feed leaves out one mailbox's reply and an approval's draft; the rest is the webhook body", () => {
  const reply = { id: 'e1', type: 'conversation.reply_received', account: { name: 'Acme' }, data: { source: 'gmail', subject: 'Re: offer', snippet: 'private', from: 'a@acme.example', thread_id: 't1' } };
  assert.deepEqual(feedView(reply).data, { source: 'gmail', thread_id: 't1' });
  assert.equal(feedView(reply).account.name, 'Acme');
  const approval = { id: 'e2', type: 'automation.approval_requested', data: { run_id: 'r1', automation: { name: 'Follow-up' }, to: 'b@x.example', body: 'draft' } };
  assert.deepEqual(feedView(approval).data, { run_id: 'r1', automation: { name: 'Follow-up' } });
  const signal = { id: 'e3', type: 'signal.budget_discussed', data: { title: 'No number yet' } };
  assert.equal(feedView(signal), signal);
});

test('a next step agreed (before GET-967) and people added (GET-1014) are not on the feed', async () => {
  const db = fakeDb([ev(1)]);
  await listEvents(db, 'ws', {});
  assert.ok(db.calls.some(([t, op, col, how, v]) => t === 'event_log' && op === 'not' && col === 'type' && how === 'in' && v === '(signal.next_step,people.added)'));
});

test('people added is read when asked for by type or family; a next step never is', () => {
  assert.deepEqual(feedHiddenTypes(null), ['signal.next_step', 'people.added']);
  assert.deepEqual(feedHiddenTypes('signal.*'), ['signal.next_step', 'people.added']);
  assert.deepEqual(feedHiddenTypes('people.added'), ['signal.next_step']);
  assert.deepEqual(feedHiddenTypes('people.*'), ['signal.next_step']);
});

test('a date range bounds when it happened; until is exclusive', async () => {
  const db = fakeDb([]);
  await listEvents(db, 'ws', { since: '2026-10-01T00:00:00.000Z', until: '2026-10-08T00:00:00.000Z' });
  assert.ok(db.calls.some(([, op, k, v]) => op === 'gte' && k === 'occurred_at' && v === '2026-10-01T00:00:00.000Z'));
  assert.ok(db.calls.some(([, op, k, v]) => op === 'lt' && k === 'occurred_at' && v === '2026-10-08T00:00:00.000Z'));
});

test('personal accounts and people are left out, and events with no entity stay', async () => {
  const db = fakeDb([]);
  await listEvents(db, 'ws', { excludeEntityIds: ['p1', 'p2'] });
  assert.ok(db.calls.some(([, op, v]) => op === 'or' && v === 'entity_id.is.null,entity_id.not.in.(p1,p2)'));
  const none = fakeDb([]);
  await listEvents(none, 'ws', {});
  assert.ok(!none.calls.some(([, op]) => op === 'or'), 'no exclusion, no filter');
});

test('a page is shown through the feed view', async () => {
  const row = { id: 'e1', created_at: 'x', payload: { id: 'e1', type: 'conversation.reply_received', data: { subject: 's', thread_id: 't' } } };
  const page = await listEvents(fakeDb([row]), 'ws', {});
  assert.deepEqual(page.events[0].data, { thread_id: 't' });
});
