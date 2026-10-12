// A fifth of claims carried a category nobody defined.
//
// Dozens of invented values in prod — while `normalizeClaimCategory` AND
// `isValidClaimCategory` both already existed. Nothing called them on the way in. `saveNote` even
// defaulted to "General", capitalised and outside the vocabulary, so `General` rows sat beside
// `general` rows, invisible to every rollup filtering by key.
//
// The read path normalised, which is why nobody noticed: queries looked reasonable while the stored
// data was dirty.
//
// Run: node --test packages/core/test/claimCategoryBoundary.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeClaimCategory, isValidClaimCategory, CLAIM_CATEGORY_KEYS,
} from '../dist/db/claimCategories.js';

test('case and spacing are the same category typed by a different hand', () => {
  // The largest share of the leak: title-cased twins of real keys.
  assert.equal(normalizeClaimCategory('Timeline'), 'timeline');
  assert.equal(normalizeClaimCategory('Preferences'), 'preference');
  assert.equal(normalizeClaimCategory('Budget'), 'budget');
  assert.equal(normalizeClaimCategory('General'), 'general');
  assert.equal(normalizeClaimCategory('Pain Points'), 'pain');
  assert.equal(normalizeClaimCategory('Competitors'), 'competitor');
  assert.equal(normalizeClaimCategory('Objections'), 'objection');
  assert.equal(normalizeClaimCategory('  staff Changes  '), 'staff_change');
});

test('every real key survives itself', () => {
  // A normaliser that mangles a valid key is worse than none.
  for (const key of CLAIM_CATEGORY_KEYS) {
    assert.equal(normalizeClaimCategory(key), key, key);
    assert.ok(isValidClaimCategory(key), key);
  }
});

test('anything outside the vocabulary becomes general, never itself', () => {
  // Values of the kind a model invents. Storing them as-is is what broke the rollups.
  for (const bogus of ['Data Quality', 'Positioning', 'Discussed Q3 roadmap', 'Demo call held',
                       'Positive engagement signal', 'Research', 'ICP']) {
    assert.equal(normalizeClaimCategory(bogus), 'general', bogus);
  }
});

test('nothing at all is general, not a crash', () => {
  for (const empty of [null, undefined, '', '   ']) {
    assert.equal(normalizeClaimCategory(empty), 'general');
  }
});

test('the result is always a key something can query', () => {
  // The whole point. Whatever goes in, what comes out can be rolled up.
  for (const input of ['Timeline', 'nonsense', '', null, 'Pain Points', 'Demo call held']) {
    assert.ok(CLAIM_CATEGORY_KEYS.includes(normalizeClaimCategory(input)),
      `${String(input)} produced something unqueryable`);
  }
});

test('the label for `relationship` resolves too', () => {
  // The key is `relationship` and the label is "Connections"; both are in use in the wild.
  assert.equal(normalizeClaimCategory('Connections'), 'relationship');
  assert.equal(normalizeClaimCategory('relationship'), 'relationship');
});
