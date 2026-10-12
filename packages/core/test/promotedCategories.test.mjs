// The three categories promoted on 2026-09-18 (GET-327), and the boundaries they have to hold.
//
// Each was mined out of `general` over two weeks of Harborline's Fellow corpus and cleared the
// promotion rule on evidence: >=3 accounts, >=8 claims, not expressible in an existing category,
// changes a decision, and a claim rather than an attribute.
//
// Test 3 — "not expressible in an existing category" — is the one that decays silently. A new
// category whose description overlaps an old one does not add a distinction, it adds a coin flip:
// the model files the same fact under either, and the distribution becomes noise. So the neighbours
// each one could collapse into are named here, in the words that keep them apart.
//
// Run: node --test packages/core/test/promotedCategories.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CLAIM_CATEGORIES, normalizeClaimCategory, isValidClaimCategory, claimCategoryPromptBlock,
} from '../dist/db/claimCategories.js';

const PROMOTED = ['proficiency', 'adoption', 'seasonality'];
const byKey = (k) => CLAIM_CATEGORIES.find(c => c.key === k);

test('all three are in the taxonomy and normalise to themselves', () => {
  for (const k of PROMOTED) {
    assert.ok(byKey(k), `${k} missing from CLAIM_CATEGORIES`);
    assert.equal(normalizeClaimCategory(k), k);
    assert.equal(isValidClaimCategory(k), true);
  }
});

test('all three reach the extractor prompt', () => {
  // The prompt block is generated from the taxonomy, so a category absent from the list is a
  // category the model is never asked for. That is the quiet way a promotion does nothing at all.
  const block = claimCategoryPromptBlock();
  for (const k of PROMOTED) assert.match(block, new RegExp(`- ${k} — `));
});

test('each one names the neighbour it must not collapse into', () => {
  // proficiency vs preference and goal: able to, not likes or wants to
  assert.match(byKey('proficiency').description, /preference/);
  assert.match(byKey('proficiency').description, /goal/);
  // adoption vs goal and proficiency: actually in use, not intends to or could
  assert.match(byKey('adoption').description, /goal/);
  assert.match(byKey('adoption').description, /proficiency/);
  // seasonality vs timeline: the rhythm of a year, not a date
  assert.match(byKey('seasonality').description, /timeline/);
});

test('each carries a concrete example, because the prompt teaches by example', () => {
  for (const k of PROMOTED) {
    const c = byKey(k);
    assert.ok(c.example.length > 20, `${k} example is too thin to teach from`);
    assert.ok(!/^e\.g\./i.test(c.example), `${k} example should be a sentence, not a label`);
  }
});

test('about is set where the claim can only be one thing', () => {
  // Proficiency is a property of a person; seasonality of a business. Adoption is genuinely either —
  // a team adopts, and so does a company.
  assert.equal(byKey('proficiency').about, 'person');
  assert.equal(byKey('seasonality').about, 'company');
  assert.equal(byKey('adoption').about, 'either');
});

test('keys stay snake_case and unique — they are queried, not displayed', () => {
  const keys = CLAIM_CATEGORIES.map(c => c.key);
  assert.equal(new Set(keys).size, keys.length, 'duplicate category key');
  for (const k of keys) assert.match(k, /^[a-z][a-z_]*$/, `${k} is not a queryable key`);
});
