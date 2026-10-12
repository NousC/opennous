// Unit tests for auto-reconcile P1: canonical mapping + authority-aware derivation.
// Pure functions, no DB.
//
// Run: pnpm --filter @nous/core build && node --test packages/core/test/authoritativeClaim.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapToCanonicalAxis, isAuthorityAxis, isConflictAxis, valuesGenuinelyDiffer } from '../dist/db/canonicalAxes.js';
import { deriveAuthoritativeClaim } from '../dist/db/claims.js';

const FIELD_MAP = [
  { source: 'salesforce', match_kind: 'state_field', source_key: 'lifecycle_stage', match: 'closed lost', match_type: 'eq', canonical_property: 'lifecycle', canonical_value: 'churned', event_validity: null },
  { source: 'salesforce', match_kind: 'state_field', source_key: 'lifecycle_stage', match: 'churn', match_type: 'prefix', canonical_property: 'lifecycle', canonical_value: 'churned', event_validity: null },
  { source: 'salesforce', match_kind: 'state_field', source_key: 'lifecycle_stage', match: 'closed won', match_type: 'eq', canonical_property: 'lifecycle', canonical_value: 'customer', event_validity: null },
  { source: 'stripe', match_kind: 'event', source_key: 'invoice.paid', match: null, match_type: 'eq', canonical_property: 'lifecycle', canonical_value: 'customer', event_validity: 1.0 },
];

test('mapToCanonical projects source vocab onto the lifecycle axis', () => {
  assert.deepEqual(
    mapToCanonicalAxis(FIELD_MAP, 'salesforce', 'state_field', 'lifecycle_stage', 'Churned'),
    { canonical_property: 'lifecycle', canonical_value: 'churned', event_validity: 1.0 },
  ); // prefix + casefold
  assert.equal(
    mapToCanonicalAxis(FIELD_MAP, 'salesforce', 'state_field', 'lifecycle_stage', 'Closed Won').canonical_value,
    'customer',
  );
  assert.equal(
    mapToCanonicalAxis(FIELD_MAP, 'stripe', 'event', 'invoice.paid', undefined).canonical_value,
    'customer',
  );
  assert.equal(mapToCanonicalAxis(FIELD_MAP, 'apollo', 'state_field', 'job_title', 'VP Sales'), null);
  assert.equal(mapToCanonicalAxis(FIELD_MAP, 'salesforce', 'state_field', 'lifecycle_stage', 'Prospect'), null);
});

const AUTHORITY = {
  salesforce: { authority: 0.5, eventGroundTruth: false },
  stripe: { authority: 0.95, eventGroundTruth: true },
};

const daysAgo = (n) => new Date(Date.now() - n * 86_400_000).toISOString();
const obs = (id, source, value, ageDays, sc = 1.0) => ({
  id, entity_id: 'e1', kind: 'state', property: 'lifecycle', value, source,
  method: 'inference', source_confidence: sc, observed_at: daysAgo(ageDays), ingested_at: daysAgo(ageDays),
});

test('the headline case: live Stripe payment beats a stale Salesforce churn', () => {
  const out = deriveAuthoritativeClaim(
    [obs('sf', 'salesforce', 'churned', 12), obs('st', 'stripe', 'customer', 0)],
    AUTHORITY,
  );
  assert.equal(out.value, 'customer');            // Stripe wins
  assert.ok(out.confidence >= 0.9);               // ~0.95 effective
  assert.equal(out.candidates.length, 2);         // both surfaced for the conflict card
  assert.equal(out.candidates[0].source, 'stripe');
  assert.ok(out.candidates[0].effective - out.candidates[1].effective >= 0.15); // margin → auto-resolve
});

test('the contrast case: a stale/invalid payment does NOT beat a fresh churn', () => {
  // Stripe payment 70d ago with a low event-validity (lapsed subscription) → weak.
  const out = deriveAuthoritativeClaim(
    [obs('sf', 'salesforce', 'churned', 0), obs('st', 'stripe', 'customer', 70, 0.3)],
    AUTHORITY,
  );
  assert.equal(out.value, 'churned');             // SF wins → would surface as a conflict
});

test('single source, no disagreement → one candidate', () => {
  const out = deriveAuthoritativeClaim([obs('st', 'stripe', 'customer', 0)], AUTHORITY);
  assert.equal(out.value, 'customer');
  assert.equal(out.candidates.length, 1);
});

// ── Phase 2: the axes generalize past lifecycle ──────────────────────────────

test('the axis registry is generalized, with a conflict-surfacing subset', () => {
  for (const p of ['lifecycle', 'reachability_status', 'job_title', 'employee_count']) {
    assert.equal(isAuthorityAxis(p), true, `${p} should reconcile by authority`);
  }
  assert.equal(isAuthorityAxis('phone'), false);      // untouched properties stay on recency
  assert.equal(isConflictAxis('reachability_status'), true);
  assert.equal(isConflictAxis('lifecycle'), true);

  // job_title now DOES surface. It was excluded because free text would flood the panel with
  // "VP Sales" vs "VP of Sales" — a real concern, and the reason the whole surface produced
  // zero rows in its life: the axes that were safe were also the ones nothing disagreed on.
  // The flooding is prevented by valuesGenuinelyDiffer instead, which is the guard that
  // should have been there all along.
  assert.equal(isConflictAxis('job_title'), true);
  assert.equal(isConflictAxis('company'), true);
});

test('a conflict needs a REAL difference, not a different spelling', () => {
  // The panel's whole value is that opening it is worth the reader's time.
  assert.equal(valuesGenuinelyDiffer('VP Sales', 'VP of Sales'), false);
  assert.equal(valuesGenuinelyDiffer('Acme Inc.', 'Acme'), false);
  assert.equal(valuesGenuinelyDiffer('  head of revenue ', 'Head of Revenue'), false);

  // And it must still catch the disagreements that matter.
  assert.equal(valuesGenuinelyDiffer('Director', 'VP Sales'), true);
  assert.equal(valuesGenuinelyDiffer('Acme', 'Globex'), true);

  // An absence is not a disagreement — half the record missing is a gap, not a conflict.
  assert.equal(valuesGenuinelyDiffer(null, 'VP Sales'), false);
  assert.equal(valuesGenuinelyDiffer('', 'Acme'), false);
});

const reach = (id, source, value, ageDays) => ({
  id, entity_id: 'e1', kind: 'state', property: 'reachability_status', value, source,
  method: source === 'neverbounce' ? 'verification' : 'enrichment',
  source_confidence: 1.0, observed_at: daysAgo(ageDays), ingested_at: daysAgo(ageDays),
});

test('reachability: a real verifier beats a NEWER enrichment guess (the recency bug fixed)', () => {
  const authority = {
    neverbounce: { authority: 0.95, eventGroundTruth: false },
    apollo: { authority: 0.45, eventGroundTruth: false },
  };
  const out = deriveAuthoritativeClaim(
    [reach('nb', 'neverbounce', 'invalid', 5), reach('ap', 'apollo', 'valid', 0)],  // apollo guess is newer
    authority,
  );
  assert.equal(out.value, 'invalid');   // the verifier still wins — recency does not override trust
  assert.equal(out.candidates[0].source, 'neverbounce');
});

const title = (id, source, value, ageDays) => ({
  id, entity_id: 'e1', kind: 'state', property: 'job_title', value, source,
  method: 'enrichment', source_confidence: 1.0, observed_at: daysAgo(ageDays), ingested_at: daysAgo(ageDays),
});
const TITLE_AUTH = {
  linkedin: { authority: 0.9, eventGroundTruth: false },
  hubspot: { authority: 0.5, eventGroundTruth: false },
};

test('job_title: fresh LinkedIn beats a fresh CRM title', () => {
  const out = deriveAuthoritativeClaim(
    [title('li', 'linkedin', 'VP Sales', 2), title('hs', 'hubspot', 'Sales Manager', 1)],
    TITLE_AUTH,
  );
  assert.equal(out.value, 'VP Sales');
});

test('job_title: but a STALE LinkedIn title loses to a fresh CRM one (freshness decay)', () => {
  // LinkedIn 120d old (suspect, ×0.5): 0.9×0.5 = 0.45  <  fresh HubSpot: 0.5×1.0 = 0.5
  const out = deriveAuthoritativeClaim(
    [title('li', 'linkedin', 'VP Sales', 120), title('hs', 'hubspot', 'Chief Revenue Officer', 1)],
    TITLE_AUTH,
  );
  assert.equal(out.value, 'Chief Revenue Officer');   // the newer real change wins once LinkedIn goes stale
});
