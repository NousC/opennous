// Layered ICP scorer — the properties that make it "progressive": a layer with no
// fired signal is UNKNOWN (null), never 0 or a neutral 50; Priority multiplies only
// the KNOWN layers (geometric mean) so a partially-observed account isn't nuked; and
// `missing` is the enrichment worklist. See product/icp-model-layered-redesign.md.
//
// Run: pnpm --filter @nous/core build && node --test packages/core/test/scoreByLayer.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { layerForFeature } from '../dist/db/scorecard.js';
import { scoreByLayer } from '../dist/icp/scorecard.js';

const sig = (key, weight, rule, layer) => ({
  id: key, workspace_id: 'w', key, label: key, weight, rule,
  coverage: 0, added_in: null, active: true, layer, created_at: '', updated_at: '',
});

// A catalog spanning three layers. Pain/Intent are `scaled` signal.* rules that
// only fire when the observed signal feature is present.
const CATALOG = [
  sig('revenue_owner', 10, { feature: 'is_revenue_owner', op: 'exists' }, 'fit'),
  sig('b2b_saas', 8, { feature: 'company_type', op: '==', value: 'b2b_saas' }, 'fit'),
  sig('friction', 12, { feature: 'signal.friction', op: 'scaled' }, 'pain'),
  sig('hiring', 8, { feature: 'signal.hiring', op: 'scaled' }, 'intent'),
];

test('layerForFeature routes signal.* to the right layer', () => {
  assert.equal(layerForFeature('signal.friction'), 'pain');
  assert.equal(layerForFeature('signal.hiring'), 'intent');
  assert.equal(layerForFeature('signal.momentum'), 'intent');
  assert.equal(layerForFeature('company_type'), 'fit');
  assert.equal(layerForFeature(undefined), 'fit');
});

test('LinkedIn-only: Fit resolves, everything else is UNKNOWN (not 0, not 50)', () => {
  const r = scoreByLayer({ is_revenue_owner: true, company_type: 'b2b_saas' }, CATALOG);

  assert.equal(r.layers.fit.known, true);
  assert.ok(r.layers.fit.score > 50, 'fit score reflects the fired signals');

  // The load-bearing property: an unobserved layer is null, never 0 and never the
  // raw-0 → 50 neutral that scoreLead would otherwise return.
  assert.equal(r.layers.pain.known, false);
  assert.equal(r.layers.pain.score, null);
  assert.equal(r.layers.intent.score, null);
  assert.equal(r.layers.ability.score, null);

  // Priority is computed over KNOWN layers only → equals Fit when it's the only one.
  assert.equal(r.priority, r.layers.fit.score);

  // The enrichment worklist.
  assert.deepEqual([...r.missing].sort(), ['ability', 'intent', 'pain']);
});

test('enriched: Pain + Intent light up, Priority is the geometric mean of known layers', () => {
  const r = scoreByLayer(
    { is_revenue_owner: true, company_type: 'b2b_saas', 'signal.friction': 8, 'signal.hiring': 9 },
    CATALOG,
  );
  assert.equal(r.layers.pain.known, true);
  assert.equal(r.layers.intent.known, true);
  assert.ok(r.layers.pain.score > 50);
  assert.ok(r.layers.intent.score > 50);
  assert.deepEqual(r.missing, ['ability']);

  // Priority sits between the lowest and highest known layer (a mean, not a raw
  // product that would collapse as layers are added).
  const known = [r.layers.fit.score, r.layers.pain.score, r.layers.intent.score];
  assert.ok(r.priority >= Math.min(...known) && r.priority <= Math.max(...known));
});

test('Priority is a mean (bounded by the layers), NOT a collapsing raw product', () => {
  const r = scoreByLayer(
    { is_revenue_owner: true, company_type: 'b2b_saas', 'signal.friction': 10 }, CATALOG,
  );
  const fit = r.layers.fit.score, pain = r.layers.pain.score;
  // A mean sits between its inputs — never below the weaker layer the way a raw
  // product (fit/100 × pain/100 × 100) would.
  const rawProduct = Math.round((fit / 100) * (pain / 100) * 100);
  assert.ok(r.priority > rawProduct, 'geometric mean beats the collapsing raw product');
  assert.ok(r.priority >= Math.min(fit, pain) && r.priority <= Math.max(fit, pain));
});

test('a near-zero (excluded) layer vetoes Priority downward', () => {
  const withDisq = [
    ...CATALOG,
    sig('is_agency', -8, { feature: 'is_agency', op: 'exists', disqualify: true }, 'fit'),
  ];
  const r = scoreByLayer(
    { is_revenue_owner: true, company_type: 'b2b_saas', is_agency: true, 'signal.friction': 10 },
    withDisq,
  );
  // Fit is disqualified (capped low); the multiplicative combination must drag
  // Priority down even though Pain is strong.
  assert.ok(r.layers.fit.excluded.length > 0);
  assert.ok(r.layers.fit.score <= 25);
  assert.ok(r.priority < r.layers.pain.score, 'the excluded Fit layer vetoes Priority');
});

test('nothing known → Priority null (no fake number from an empty profile)', () => {
  const r = scoreByLayer({}, CATALOG);
  assert.equal(r.priority, null);
  assert.equal(r.band, null);
  assert.equal(r.missing.length, 4);
});
