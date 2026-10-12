// Phase 4.2 — point-in-time reconstruction. Because observations are append-only, a past
// belief is re-derivable from the observations that existed at that instant. These lock the
// core pure derivation for both paths (recency + authority axis): the same history, clipped
// to an earlier `asOf`, yields the EARLIER belief.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveClaimsFromObservations } from '../dist/db/claims.js';

const daysAgo = (n) => new Date(Date.now() - n * 86_400_000).toISOString();
const obs = (id, property, value, ageDays, source = 'crm') => ({
  id, entity_id: 'e1', kind: 'state', property, value, source,
  method: 'api', source_confidence: 1.0, observed_at: daysAgo(ageDays), ingested_at: daysAgo(ageDays),
});

// A history where both a recency property (department) and an authority axis (lifecycle)
// changed over time.
const HISTORY = [
  obs('a', 'department', 'Sales', 40),
  obs('b', 'department', 'RevOps', 5),
  obs('c', 'lifecycle', 'churned', 60, 'salesforce'),
  obs('d', 'lifecycle', 'customer', 1, 'stripe'),
];
const AUTH = {
  lifecycle: {
    stripe: { authority: 0.95, eventGroundTruth: true },
    salesforce: { authority: 0.5, eventGroundTruth: false },
  },
};

const asOf = (list, iso) => list.filter((o) => o.observed_at <= iso);
const valueOf = (derived, prop) => derived.find((d) => d.property === prop)?.derived.value;

test('the current belief reflects the latest observations', () => {
  const d = deriveClaimsFromObservations(HISTORY, AUTH);
  assert.equal(valueOf(d, 'department'), 'RevOps');   // recency wins
  assert.equal(valueOf(d, 'lifecycle'), 'customer');  // stripe authority + fresh
});

test('as-of 30 days ago reconstructs the belief as it stood then', () => {
  const d = deriveClaimsFromObservations(asOf(HISTORY, daysAgo(30)), AUTH);
  assert.equal(valueOf(d, 'department'), 'Sales');    // RevOps not yet observed at that point
  assert.equal(valueOf(d, 'lifecycle'), 'churned');   // only the Salesforce churn existed then
});

test('as-of before any observation yields nothing', () => {
  const d = deriveClaimsFromObservations(asOf(HISTORY, daysAgo(90)), AUTH);
  assert.equal(d.length, 0);
});

test('each property derives independently (no cross-contamination)', () => {
  const d = deriveClaimsFromObservations(HISTORY, AUTH);
  assert.equal(d.length, 2);
  assert.deepEqual(new Set(d.map((x) => x.property)), new Set(['department', 'lifecycle']));
});
