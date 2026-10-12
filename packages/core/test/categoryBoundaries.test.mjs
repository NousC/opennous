// Two categories whose descriptions overlap do not give the model a choice, they give it a coin
// flip — and the distribution turns to noise while everything still looks fine.
//
// Proficiency, adoption and seasonality shipped on 2026-09-18 with boundaries written INTO them,
// and `status_quo` was left as it was. A sample of status_quo claims then showed about a fifth
// of them were really adoption ("Odette uses the portal regularly", "just the two closers log in",
// "has not yet used the reporting feature") and one was seasonality (a year-end shutdown). They
// landed there because "the tools they have in place" is true of our own product too, and nothing
// said otherwise.
//
// The lesson is an ordering rule: promoting a category obliges a pass over the incumbents it
// borders. These tests hold both sides of each border, so the next promotion cannot skip it.
//
// Run: node --test packages/core/test/categoryBoundaries.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CLAIM_CATEGORIES, claimCategoryPromptBlock } from '../dist/db/claimCategories.js';

const desc = (k) => CLAIM_CATEGORIES.find(c => c.key === k).description;

test('status_quo is their process, not their tools and not our product', () => {
  // The single change that moved ~20% of this category to where it belongs, then (GET-776) the
  // tools themselves moved to tech_stack.
  assert.match(desc('status_quo'), /tech_stack/);
  assert.match(desc('status_quo'), /OUR product/);
});

test('status_quo names each neighbour it was absorbing', () => {
  for (const neighbour of ['adoption', 'proficiency', 'seasonality']) {
    assert.match(desc('status_quo'), new RegExp(neighbour, 'i'), `status_quo must exclude ${neighbour}`);
  }
});

test('the exclusions are mutual — adoption and proficiency point back', () => {
  // A border stated on one side only still leaves the model guessing from the other.
  assert.match(desc('adoption'), /proficiency/i);
  assert.match(desc('proficiency'), /preference|goal/i);
  assert.match(desc('seasonality'), /timeline/i);
});

test('its example is one of THEIR tools, since the prompt teaches by example', () => {
  const ex = CLAIM_CATEGORIES.find(c => c.key === 'status_quo').example;
  assert.doesNotMatch(ex, /harborline|our portal|our product/i, 'the example must not be our own product');
  assert.ok(ex.length > 20);
});

test('every category description is distinct — no two are the same text', () => {
  const seen = new Map();
  for (const c of CLAIM_CATEGORIES) {
    const key = c.description.toLowerCase().replace(/[^a-z]/g, '').slice(0, 80);
    assert.ok(!seen.has(key), `${c.key} and ${seen.get(key)} open with the same description`);
    seen.set(key, c.key);
  }
});

test('the narrowed wording reaches the extractor prompt', () => {
  // The prompt is generated from the taxonomy, so a narrowing that never reaches the model is a
  // narrowing that never happened.
  const block = claimCategoryPromptBlock();
  assert.match(block, /- status_quo — .*NOT the tools they use/i);
});

test('adoption says whose claim it is, because "either" is an invitation to guess', () => {
  // Both adoption claims from the Quillmere Auto Centre call were filed on the COMPANY — including
  // "Brielle says she is the only person who really uses it", which is about Brielle. Her page
  // showed nothing while the facts about her sat one level up.
  const d = desc('adoption');
  assert.match(d, /about=person/i);
  assert.match(d, /about=company/i);
});
