// The evidence names the product, not the model (GET-402).
// Run: node --test packages/core/test/expansionProduct.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveExpansionProduct, catalogueFamiliesIn } from '../dist/services/expansionProduct.js';

const CAT = ['Lumen Navigator', 'Lumen QuickLane', 'Lumen Lead', 'Lumen Tag', 'Lumen Finance', 'Tag Scanning'];

test('the measured error: a Navigator quote filed as QuickLane is corrected', () => {
  const r = resolveExpansionProduct('Lumen QuickLane',
    'Odile demoed the Navigator extension, which Bertram expressed interest in adopting',
    'Bertram expressed interest in adopting the Navigator extension', CAT);
  assert.deepEqual(r, { product: 'Lumen Navigator', corrected: true });
});

test('a quote that names the model\'s own product is not "corrected"', () => {
  const r = resolveExpansionProduct('Lumen Navigator', 'Is there a cost for Lumen Navigator?', 'Asked the cost of Navigator', CAT);
  assert.deepEqual(r, { product: 'Lumen Navigator', corrected: false });
});

test('a quote naming two families does not pick one; the model\'s loose match stands', () => {
  const r = resolveExpansionProduct('QuickLane', 'we run Navigator and QuickLane at the other store', 'x', CAT);
  assert.deepEqual(r, { product: 'Lumen QuickLane', corrected: false });
});

test('a quote naming nothing falls back to the sentence, then to the model', () => {
  assert.deepEqual(resolveExpansionProduct('Lumen Tag', 'can we get that at the Westgate store too', 'Asked to add Lumen Tag at the Westgate store', CAT),
    { product: 'Lumen Tag', corrected: false });
  assert.deepEqual(resolveExpansionProduct('tag', 'can we get that too', 'they want more', CAT),
    { product: 'Lumen Tag', corrected: false });
});

test('nothing in the catalogue matches → null, the caller drops the signal', () => {
  assert.deepEqual(resolveExpansionProduct('Forecasting engine', 'Can engines be added?', 'x', CAT).product, null);
});

test('no catalogue → the model\'s word, as before', () => {
  assert.deepEqual(resolveExpansionProduct('Whatever', 'q', 't', []), { product: 'Whatever', corrected: false });
});

test('a generic last word does not match on its own', () => {
  // "lead" alone would match "lead-gen"; "Lumen Lead" must be said in full.
  assert.deepEqual(catalogueFamiliesIn('they asked about the lead-gen tool', CAT), []);
  assert.deepEqual(catalogueFamiliesIn('they asked about Lumen Lead', CAT), ['Lumen Lead']);
  // "Navigator" is distinctive enough on its own.
  assert.deepEqual(catalogueFamiliesIn('the navigator extension', CAT), ['Lumen Navigator']);
});
