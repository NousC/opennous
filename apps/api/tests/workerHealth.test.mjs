// Is the worker still alive? The verdict behind GET /readyz/workers.
//
// Written after the worker stopped at 02:05 on 2026-09-17 and nothing noticed for three hours:
// /readyz answered 200 the whole time because it checks the database, and the database was fine.
//
// Pure: no database, no clock of its own.
//
// Run: node --test apps/api/tests/workerHealth.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { heartbeatVerdict, staleAfterMsFromEnv, DEFAULT_STALE_AFTER_MS } from '../src/lib/workerHealth.mjs';

const NOW = Date.parse('2026-09-17T05:00:00.000Z');
const ago = (ms) => new Date(NOW - ms).toISOString();
const MIN = 60_000;

test('a recent heartbeat is ready', () => {
  assert.equal(heartbeatVerdict(ago(30_000), NOW).ok, true);
  assert.equal(heartbeatVerdict(ago(4 * MIN), NOW).ok, true);
  assert.equal(heartbeatVerdict(ago(30_000), NOW).age_seconds, 30);
});

test('the three-hour outage is caught, and says how long', () => {
  const v = heartbeatVerdict(ago(179 * MIN), NOW);
  assert.equal(v.ok, false);
  assert.match(v.error, /179 minute/);
});

test('the boundary is the tolerance, inclusive', () => {
  assert.equal(heartbeatVerdict(ago(DEFAULT_STALE_AFTER_MS), NOW).ok, true);
  assert.equal(heartbeatVerdict(ago(DEFAULT_STALE_AFTER_MS + 1000), NOW).ok, false);
});

test('a worker that has never run is not ready', () => {
  // A first deploy clears this within a minute. Not clearing IS the outage.
  const v = heartbeatVerdict(null, NOW);
  assert.equal(v.ok, false);
  assert.equal(v.error, 'no heartbeat recorded');
});

test('an unreadable timestamp is not ready, and never throws', () => {
  const v = heartbeatVerdict('not a date', NOW);
  assert.equal(v.ok, false);
  assert.match(v.error, /unreadable/);
});

test('clock skew into the future is not a stopped worker', () => {
  // A heartbeat a few seconds ahead of the API's clock must not read as a negative age or,
  // worse, page someone. Ages clamp at zero.
  const v = heartbeatVerdict(new Date(NOW + 10_000).toISOString(), NOW);
  assert.equal(v.ok, true);
  assert.equal(v.age_seconds, 0);
});

test('the window is configurable, with a floor of two minutes', () => {
  assert.equal(staleAfterMsFromEnv({}), 5 * MIN);
  assert.equal(staleAfterMsFromEnv({ WORKER_STALE_AFTER_MINUTES: '15' }), 15 * MIN);
  // A one-minute window against a one-minute cadence would alarm on every slow tick.
  assert.equal(staleAfterMsFromEnv({ WORKER_STALE_AFTER_MINUTES: '1' }), 2 * MIN);
  assert.equal(staleAfterMsFromEnv({ WORKER_STALE_AFTER_MINUTES: 'nonsense' }), 5 * MIN);
});
