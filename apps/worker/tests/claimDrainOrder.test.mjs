// The claim queue drains by TARGET, not by arrival.
//
// claim_jobs holds one row per observation, so the same (entity, property) is enqueued again every
// time that fact is observed again — a deal's stage history, a re-import, an account that keeps
// receiving mail. All those copies are answered by ONE recompute, because recomputeClaim reads the
// entity's whole observation history and derives the current value from it.
//
// The engine has always collapsed duplicates inside a sweep. Draining in enqueued_at order defeated
// that: a workspace whose CRM import ran several times enqueued its copies hours apart, so they fell
// into separate sweeps and bought identical recomputes — several queued rows standing in for each
// answer.
//
// This asserts the ordering the sweep asks for, by reading it. processClaimJobs takes its client
// from getSupabaseClient() with no seam to inject through, and the regression it guards is a
// one-word edit back to enqueued_at — which no assertion against an empty fake queue would catch.
// A narrower, more honest test than one that pretends to exercise the drain.
//
// Run: node --test apps/worker/tests/claimDrainOrder.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../src/workers/claimEngine.mjs', import.meta.url), 'utf8');
const start = src.indexOf("from('claim_jobs')");
const query = src.slice(start, src.indexOf('BATCH_SIZE)', start));

test('the sweep is ordered by entity_id then property', () => {
  assert.ok(start > 0, 'the drain query moved — this test needs updating with it');
  assert.match(query, /\.order\('entity_id'/, 'ordered by entity_id first');
  assert.match(query, /\.order\('property'/, "then by property, so one target's rows are contiguous");
});

test('it is NOT ordered by arrival', () => {
  // The bug. Arrival order scatters a target's duplicates across the whole queue, so the
  // collapse below the query only ever catches copies enqueued in the same burst.
  assert.doesNotMatch(query, /\.order\('enqueued_at'/);
});

test('only pending rows are taken', () => {
  assert.match(query, /\.is\('picked_at', null\)/);
});
