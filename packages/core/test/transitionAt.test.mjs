// Stage-transition timestamps — the foundation the forecasting layer stands on.
//
// A pipeline_stage observation must be dated to WHEN THE ACCOUNT MOVED, not to when
// the write happened to run. Everything downstream that measures time (cycle time,
// time-in-stage, the survival/hazard curves behind "will it close by the 31st")
// reads this field, so a stamp of `now()` on a replayed month collapses that month
// into a single instant and every duration reads as zero.
//
// Run: pnpm --filter @nous/core build && node --test packages/core/test/transitionAt.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { transitionAt } from '../dist/db/pipelineStage.js';

const NOW = Date.parse('2026-08-30T12:00:00.000Z');

test('a real past event time is preserved, not replaced with now', () => {
  // The whole point: six months of replayed history stays six months wide.
  assert.equal(transitionAt('2026-03-14T09:30:00.000Z', NOW), '2026-03-14T09:30:00.000Z');
  assert.equal(transitionAt('2026-08-29T23:59:59.000Z', NOW), '2026-08-29T23:59:59.000Z');
});

test('a future event time is clamped to now', () => {
  // A meeting booked today for next Tuesday arrives with observed_at = the meeting
  // START (pollers/calendar.mjs). The account advanced to meeting_booked TODAY. Left
  // unclamped this dates the hop forward and time-in-stage goes negative.
  assert.equal(transitionAt('2026-09-08T15:00:00.000Z', NOW), new Date(NOW).toISOString());
});

test('an event exactly at now is unchanged', () => {
  assert.equal(transitionAt(new Date(NOW).toISOString(), NOW), new Date(NOW).toISOString());
});

test('missing or unparseable input falls back to now, never null', () => {
  // observations.observed_at is NOT NULL — a null here is a failed insert, which would
  // silently drop the transition rather than mis-date it.
  for (const bad of [undefined, null, '', 'not-a-date', 'yesterday']) {
    assert.equal(transitionAt(bad, NOW), new Date(NOW).toISOString());
  }
});

test('output is always a valid ISO string', () => {
  for (const input of [undefined, 'garbage', '2026-03-14T09:30:00.000Z', '2099-01-01T00:00:00.000Z']) {
    const out = transitionAt(input, NOW);
    assert.ok(Number.isFinite(Date.parse(out)), `not ISO-parseable: ${out}`);
  }
});

test('never returns a time in the future — the invariant the survival math needs', () => {
  // Property test: whatever goes in, the result cannot be ahead of now. Negative
  // time-in-stage is the one output the hazard model cannot recover from.
  const inputs = [
    '2020-01-01T00:00:00.000Z', '2026-08-30T11:59:59.000Z', '2026-08-30T12:00:01.000Z',
    '2030-06-01T00:00:00.000Z', 'garbage', undefined,
  ];
  for (const i of inputs) {
    assert.ok(Date.parse(transitionAt(i, NOW)) <= NOW, `future-dated for input ${i}`);
  }
});
