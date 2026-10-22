// /v2/events (GET-939): what a request becomes before it reads the log.
//
// Run: node --test apps/api/tests/v2Events.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEventsQuery } from '../src/routes/v2/events.mjs';

const ID = '0b6f8f5e-6a43-4c0e-9d6c-1b2a3c4d5e6f';

test('no filters: the newest 25', () => {
  assert.deepEqual(parseEventsQuery({}), { ok: true, filters: { type: null, entityId: null, startingAfter: null, limit: 25 } });
});

test('one type, a family, an account, a cursor and a limit', () => {
  assert.equal(parseEventsQuery({ type: 'deal.won' }).filters.type, 'deal.won');
  assert.equal(parseEventsQuery({ type: 'signal.*' }).filters.type, 'signal.*');
  const f = parseEventsQuery({ account: ID, starting_after: ID, limit: '100' }).filters;
  assert.deepEqual(f, { type: null, entityId: ID, startingAfter: ID, limit: 100 });
  // The signed-in page names its workspace; that is not a filter.
  assert.equal(parseEventsQuery({ workspaceId: ID }).ok, true);
});

test('refusals name what is wrong', () => {
  const t = parseEventsQuery({ type: 'charge.succeeded' });
  assert.equal(t.error, 'unknown_event_type');
  assert.ok(t.available.includes('signal.*') && t.available.includes('deal.won'));
  assert.equal(parseEventsQuery({ type: 'nope.*' }).error, 'unknown_event_type');
  assert.equal(parseEventsQuery({ account: 'Acme' }).error, 'invalid_account');
  assert.equal(parseEventsQuery({ starting_after: 'evt_1' }).error, 'invalid_cursor');
  assert.equal(parseEventsQuery({ limit: '0' }).error, 'invalid_limit');
  assert.equal(parseEventsQuery({ limit: '101' }).error, 'invalid_limit');
  assert.deepEqual(parseEventsQuery({ colour: 'red' }), { ok: false, error: 'unknown_parameter', parameter: 'colour' });
});

test('a date range (GET-1014): ISO times, refused when not a time', () => {
  const f = parseEventsQuery({ since: '2026-10-01', until: '2026-10-08T00:00:00Z' }).filters;
  assert.equal(f.since, '2026-10-01T00:00:00.000Z');
  assert.equal(f.until, '2026-10-08T00:00:00.000Z');
  assert.equal(parseEventsQuery({ since: 'last week' }).error, 'invalid_time');
  assert.equal(parseEventsQuery({ until: 'soon' }).error, 'invalid_time');
});
