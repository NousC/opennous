// Where an open deal stands follows the stage recorded on its people when that is further along, or
// closed (GET-1028); the rebuild from activity alone never saw a demo read from a call, or a deal
// that went quiet.
//
// Run: cd packages/core && npm run build && node --test test/recordedStage.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recordedStageFor } from '../dist/services/forecastRun.js';

const rebuilt = { stage: 'discovery', enteredAt: '2026-06-20T00:00:00Z' };

test('a recorded stage further up the ladder wins, dated when it was recorded', () => {
  assert.deepEqual(recordedStageFor(rebuilt, { stage: 'demo', at: '2026-07-01T00:00:00Z' }), { stage: 'demo', enteredAt: '2026-07-01T00:00:00Z' });
});

test('a lower recorded stage never pulls the deal back', () => {
  assert.deepEqual(recordedStageFor(rebuilt, { stage: 'interested', at: '2026-10-01T00:00:00Z' }), rebuilt);
});

test('a later close (went quiet) closes it; an older one does not', () => {
  assert.deepEqual(recordedStageFor(rebuilt, { stage: 'closed_lost', at: '2026-10-24T03:20:00Z' }), { stage: 'closed_lost', enteredAt: '2026-10-24T03:20:00Z' });
  assert.deepEqual(recordedStageFor(rebuilt, { stage: 'closed_lost', at: '2026-05-01T00:00:00Z' }), rebuilt);
});

test('legacy names are read as their stage; nothing recorded changes nothing', () => {
  assert.deepEqual(recordedStageFor(rebuilt, { stage: 'client', at: '2026-09-22T00:00:00Z' }), { stage: 'closed_won', enteredAt: '2026-09-22T00:00:00Z' });
  assert.deepEqual(recordedStageFor(rebuilt, { stage: null, at: null }), rebuilt);
});
