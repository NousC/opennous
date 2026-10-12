// The decision the health-category backfill makes per row (GET-401). Pure, so the walk over the
// claims table is the only thing the script does that a test cannot.
//
// Run: node --test apps/worker/tests/backfillHealthCategories.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { healthRecategorisation } from '../scripts/backfillHealthCategories.mjs';

test('a health-read expansion becomes an expansion_signal ask', () => {
  const v = { category: 'buying_signal', content: 'x', metadata: { signal_type: 'health_expansion', quote: 'q' } };
  assert.deepEqual(healthRecategorisation(v), { category: 'expansion_signal', metadata: { stance: 'asked', product: null } });
});

test('a mined ask keeps its product and stance', () => {
  const v = { category: 'buying_signal', metadata: { signal_type: 'health_expansion', mined_from: 'o1', stance: 'asked', product: 'Lumen Rates' } };
  assert.deepEqual(healthRecategorisation(v), { category: 'expansion_signal', metadata: { stance: 'asked', product: 'Lumen Rates' } });
});

test('a mined decline — filed as objection, no tag on purpose — becomes expansion_signal/declined', () => {
  const v = { category: 'objection', metadata: { mined_from: 'o1', stance: 'declined', product: 'Lumen Quote' } };
  assert.deepEqual(healthRecategorisation(v), { category: 'expansion_signal', metadata: { stance: 'declined', product: 'Lumen Quote' } });
});

test('a health risk becomes risk_signal, graded at_risk when ungraded', () => {
  const v = { category: 'pain', metadata: { signal_type: 'health_risk' } };
  assert.deepEqual(healthRecategorisation(v), { category: 'risk_signal', metadata: { severity: 'at_risk' } });
  const graded = { category: 'pain', metadata: { signal_type: 'health_risk', severity: 'stated_churn' } };
  assert.deepEqual(healthRecategorisation(graded), { category: 'risk_signal', metadata: { severity: 'stated_churn' } });
});

test('an ask the verifier re-filed as a risk is graded friction', () => {
  // "The wrong list, not the wrong fact". Same grade the verifier
  // writes for new ones since GET-401.
  const v = { category: 'pain', metadata: { signal_type: 'health_risk', stance: null, product: null, reclassified_from: 'asked' } };
  assert.deepEqual(healthRecategorisation(v), { category: 'risk_signal', metadata: { severity: 'friction' } });
});

test('an ordinary claim, and a row already moved, are left alone', () => {
  assert.equal(healthRecategorisation({ category: 'pain', metadata: { quote: 'q' } }), null);
  assert.equal(healthRecategorisation({ category: 'objection', metadata: { status: 'open', stance: 'declined' } }), null,
    'an objection with a stance but no mined_from is not a mined decline');
  assert.equal(healthRecategorisation({ category: 'expansion_signal', metadata: { signal_type: 'health_expansion', stance: 'asked' } }), null);
  assert.equal(healthRecategorisation({ category: 'risk_signal', metadata: { signal_type: 'health_risk', severity: null } }), null);
  assert.equal(healthRecategorisation(null), null);
});
