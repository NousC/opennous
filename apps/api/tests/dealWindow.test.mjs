// GET-353: a deal we cannot place in time has no measurable behaviour, and the ledger must record
// nothing rather than `no`.
//
// A workspace that moved into HubSpot from another system has this shape. HubSpot's `createdate`
// is when the RECORD was made, so every migrated deal carries the migration month while closing
// years earlier — HubSpot itself cannot say when those deals opened. A ledger that falls back to
// the ACCOUNT's first observation then produces a window running backwards in time, so
// `t >= open && t <= close` matches nothing and every meeting feature comes out `no`.
//
// Blended, that makes meetings look like noise on won and lost deals alike, while among the
// deals that can actually be measured they separate clearly. Fabricated negatives outvote the
// real signal.
//
// This tests the predicate directly. An earlier version of this file drove buildOutcomeLedger
// through a fake PostgREST client, and that client was too thin to produce a single row — so the
// assertions never ran and the test passed while proving nothing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activityMeasurable } from '../src/lib/outcomeLedger.mjs';

const at = (s) => new Date(s).toISOString();
const COVERAGE = Date.parse('2024-11-01T00:00:00.000Z');   // the workspace's earliest observation

test('a backwards window is not measurable', () => {
  // The exact shape that broke: created at the migration, closed years earlier.
  assert.equal(
    activityMeasurable(at('2024-12-01'), at('2020-07-15'), COVERAGE), false,
    'a window that opens after it closes can contain no activity by construction',
  );
  // And isolated from the coverage rule: BOTH dates sit inside the period we hold activity for,
  // so only the ordering can reject this one. Without this case the previous assertion passes
  // even with the ordering guard deleted, because the 2020 close fails the coverage test first —
  // a test that cannot fail for the reason it names is not testing that reason.
  assert.equal(
    activityMeasurable(at('2026-06-01'), at('2026-01-05'), COVERAGE), false,
    'ordering alone must reject a backwards window',
  );
});

test('a deal with no usable open date is not measurable', () => {
  assert.equal(activityMeasurable(null, at('2026-03-01'), COVERAGE), false);
  assert.equal(activityMeasurable(undefined, at('2026-03-01'), COVERAGE), false);
});

test('a deal that closed before we captured anything is not measurable', () => {
  // Dates are coherent — it simply ended before our earliest observation, so there was never
  // anything to find. Recording `no meeting` here is a statement about our import window.
  assert.equal(
    activityMeasurable(at('2024-01-01'), at('2024-06-01'), COVERAGE), false,
    'the whole window predates the first activity we hold',
  );
});

test('a deal inside the window IS measurable', () => {
  assert.equal(activityMeasurable(at('2026-01-05'), at('2026-03-01'), COVERAGE), true);
});

test('a deal that straddles the start of coverage is measurable', () => {
  // Partial coverage still beats none: it closed after we started watching, so a meeting in the
  // observed part is real evidence. It may undercount, which is a different problem from lying.
  assert.equal(activityMeasurable(at('2024-09-01'), at('2025-09-01'), COVERAGE), true);
});

test('with no coverage information at all, only the window itself is judged', () => {
  assert.equal(activityMeasurable(at('2026-01-05'), at('2026-03-01'), null), true);
  assert.equal(activityMeasurable(at('2026-03-01'), at('2026-01-05'), null), false);
});

test('unparseable dates are not measurable', () => {
  assert.equal(activityMeasurable('not a date', at('2026-03-01'), COVERAGE), false);
  assert.equal(activityMeasurable(at('2026-01-05'), 'not a date', COVERAGE), false);
});
