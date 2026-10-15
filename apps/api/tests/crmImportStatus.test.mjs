// The connect-time CRM import as a job the owner can see (GET-853): running, failed with why, or
// done, read back from its own log rows; a run that went quiet for hours is interrupted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { importStateFrom, IMPORT_STALE_MS } from '../src/lib/connectIngest.mjs';

const now = Date.parse('2026-10-12T12:00:00Z');
const ago = (ms) => new Date(now - ms).toISOString();

test('no row: none, or running when this process is pulling', () => {
  assert.equal(importStateFrom(null, { now }).state, 'none');
  assert.equal(importStateFrom(null, { now, inFlight: true }).state, 'running');
});

test('a step row is running until it goes stale, then it is an interrupted failure', () => {
  assert.equal(importStateFrom({ event_type: 'sync_scoped', occurred_at: ago(60_000) }, { now }).state, 'running');
  const stale = importStateFrom({ event_type: 'sync_started', occurred_at: ago(IMPORT_STALE_MS + 1) }, { now });
  assert.equal(stale.state, 'failed');
  assert.match(stale.error, /stopped before it finished/);
  assert.equal(importStateFrom({ event_type: 'sync_settling', occurred_at: ago(IMPORT_STALE_MS + 1) }, { now, inFlight: true }).state, 'running');
});

test('a failure carries its reason; complete and partial are done', () => {
  const f = importStateFrom({ event_type: 'sync_failed', summary: 'hubspot connect sync failed — 401', occurred_at: ago(0) }, { now });
  assert.deepEqual([f.state, f.error], ['failed', 'hubspot connect sync failed — 401']);
  assert.equal(importStateFrom({ event_type: 'sync_complete', occurred_at: ago(0) }, { now }).state, 'done');
  const p = importStateFrom({ event_type: 'sync_partial', occurred_at: ago(0) }, { now });
  assert.deepEqual([p.state, p.partial], ['done', true]);
});
