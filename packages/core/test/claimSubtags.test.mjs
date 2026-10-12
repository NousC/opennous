// A category's sub-tags, declared once because there are two writers.
//
// The worker's persistFacts and the API's recordObservations each decided this independently and
// drifted: `role` (GET-340) and `change` (GET-327) shipped into the worker and were never added to
// the API, so every claim written through the plugin lost them — while the category itself landed
// correctly, which is what made it silent. Measured on one meeting: every claim landed and kept
// their quote and speaker, and `with_role` / `with_change` were both 0.
//
// Run: node --test packages/core/test/claimSubtags.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claimSubtagsFor, CLAIM_SUBTAGS, CLAIM_CATEGORY_KEYS } from '../dist/db/claimCategories.js';

test('the sub-tags shipped this week survive', () => {
  // The exact two that were being dropped.
  assert.deepEqual(claimSubtagsFor('authority', { role: 'decision_maker' }), { role: 'decision_maker' });
  assert.deepEqual(claimSubtagsFor('staff_change', { change: 'joined' }), { change: 'joined' });
});

test('the older ones still work', () => {
  assert.deepEqual(claimSubtagsFor('competitor', { stance: 'incumbent' }), { stance: 'incumbent' });
  assert.deepEqual(claimSubtagsFor('objection', { status: 'open', hardness: 'hard' }),
    { status: 'open', hardness: 'hard' });
});

test('a value outside the vocabulary is null, never coerced onto a neighbour', () => {
  // A model returning "influencer" is saying something true that nothing can display. Putting a
  // badge on a person nobody described that way is worse than putting none.
  assert.deepEqual(claimSubtagsFor('authority', { role: 'influencer' }), { role: null });
  assert.deepEqual(claimSubtagsFor('staff_change', { change: 'promoted' }), { change: null });
  assert.deepEqual(claimSubtagsFor('objection', { status: 'maybe', hardness: 'medium' }),
    { status: null, hardness: null });
});

test('a category with no sub-tags gets none', () => {
  for (const cat of ['pain', 'goal', 'adoption', 'seasonality', 'general']) {
    assert.deepEqual(claimSubtagsFor(cat, { role: 'champion', change: 'left' }), {},
      `${cat} should carry no sub-tags`);
  }
});

test('an absent field is null, so the shape is stable', () => {
  // Both writers spread this into metadata; a missing key and a null key must not produce two
  // different row shapes for the same category.
  assert.deepEqual(claimSubtagsFor('objection', {}), { status: null, hardness: null });
  assert.deepEqual(claimSubtagsFor('authority'), { role: null });
});

test('every declared sub-tag belongs to a real category', () => {
  // A sub-tag on a category that does not exist can never be stamped, and would look like a
  // working feature until someone checked the rows.
  for (const cat of Object.keys(CLAIM_SUBTAGS)) {
    assert.ok(CLAIM_CATEGORY_KEYS.includes(cat), `${cat} is not in the taxonomy`);
  }
});

test('junk does not throw', () => {
  // These arrive from a model, through an API, from a plugin someone else wrote.
  assert.deepEqual(claimSubtagsFor('authority', { role: 42 }), { role: null });
  assert.deepEqual(claimSubtagsFor('authority', { role: null }), { role: null });
  assert.deepEqual(claimSubtagsFor('', {}), {});
  assert.deepEqual(claimSubtagsFor('not_a_category', { role: 'champion' }), {});
});
