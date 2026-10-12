// The two customer-success categories (GET-401), and the boundaries that keep them apart from
// the three categories that had been holding them.
//
// These were not mined out of `general` like proficiency, adoption and seasonality (GET-327). They
// never reached `general`: the health reads filed an expansion ask as `buying_signal`, a risk as
// `pain`, a decline as `objection`, with the real kind in `metadata.signal_type`. A promotion rule
// that mines `general` cannot see a category the taxonomy is absorbing under another name. So the
// bar these had to clear was different — and the test that matters is the one the CS page learned
// the hard way: a decline is recorded, never read as an ask.
//
// Run: node --test packages/core/test/csCategories.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CLAIM_CATEGORIES, CLAIM_SUBTAGS, CLAIM_FREE_TEXT, ACCOUNT_ROLLUP_CATEGORIES,
  normalizeClaimCategory, isValidClaimCategory, claimCategoryPromptBlock,
  claimSubtagsFor, claimFreeTextFor,
} from '../dist/db/claimCategories.js';
import { HEALTH_CATEGORY } from '../dist/services/accountHealthState.js';

const NEW = ['expansion_signal', 'risk_signal'];
const byKey = (k) => CLAIM_CATEGORIES.find(c => c.key === k);

test('both are in the taxonomy, normalise to themselves, and reach the extractor prompt', () => {
  const block = claimCategoryPromptBlock();
  for (const k of NEW) {
    assert.ok(byKey(k), `${k} missing`);
    assert.equal(normalizeClaimCategory(k), k);
    assert.equal(isValidClaimCategory(k), true);
    assert.match(block, new RegExp(`- ${k} — `));
  }
});

test('the health map points at them, not at the borrowed bins', () => {
  // Before: risk → pain, expansion → buying_signal, adoption → status_quo.
  assert.equal(HEALTH_CATEGORY.risk, 'risk_signal');
  assert.equal(HEALTH_CATEGORY.expansion, 'expansion_signal');
  assert.equal(HEALTH_CATEGORY.adoption, 'adoption');
});

test('the old tags and the words a model reaches for all land on the new keys', () => {
  assert.equal(normalizeClaimCategory('health_expansion'), 'expansion_signal');
  assert.equal(normalizeClaimCategory('health_risk'), 'risk_signal');
  assert.equal(normalizeClaimCategory('upsell'), 'expansion_signal');
  assert.equal(normalizeClaimCategory('churn risk'), 'risk_signal');
  assert.equal(normalizeClaimCategory('Expansion Signal'), 'expansion_signal');
});

test('each names the neighbours it was carved out of', () => {
  // expansion_signal vs buying_signal (a prospect closing), goal (theirs, not ours), pain (a
  // feature request about something they own)
  const e = byKey('expansion_signal').description;
  assert.match(e, /buying_signal/); assert.match(e, /goal/); assert.match(e, /pain/);
  // risk_signal vs pain (the product), objection (a prospect's reason not to start), adoption
  const r = byKey('risk_signal').description;
  assert.match(r, /pain/); assert.match(r, /objection/); assert.match(r, /adoption/);
  // and the three that used to hold them now say so
  assert.match(byKey('buying_signal').description, /expansion_signal/);
  assert.match(byKey('pain').description, /risk_signal/);
  assert.match(byKey('objection').description, /expansion_signal/);
});

test('a decline is a stance, never a dropped signal or an ask', () => {
  assert.deepEqual(CLAIM_SUBTAGS.expansion_signal.stance, ['asked', 'considering', 'declined']);
  assert.deepEqual(claimSubtagsFor('expansion_signal', { stance: 'declined' }), { stance: 'declined' });
  // A signal with no stance is stored with stance null — it does NOT become an ask by default.
  // That default is the one bug the CS page cannot ship with: the miner's first sample run
  // returned "declined to continue after the pilot" with no stance at all.
  assert.deepEqual(claimSubtagsFor('expansion_signal', {}), { stance: null });
  assert.deepEqual(claimSubtagsFor('expansion_signal', { stance: 'interested' }), { stance: null });
});

test('severity is a closed set that ranks the at-risk list', () => {
  assert.deepEqual(CLAIM_SUBTAGS.risk_signal.severity, ['stated_churn', 'at_risk', 'friction']);
  assert.deepEqual(claimSubtagsFor('risk_signal', { severity: 'stated_churn' }), { severity: 'stated_churn' });
  assert.deepEqual(claimSubtagsFor('risk_signal', { severity: 'high' }), { severity: null });
});

test('product is free text, declared once for both writers, like competitor.entity', () => {
  assert.deepEqual(CLAIM_FREE_TEXT.expansion_signal, ['product']);
  assert.deepEqual(CLAIM_FREE_TEXT.competitor, ['entity']);
  assert.deepEqual(claimFreeTextFor('expansion_signal', { product: '  Lumen Assist ' }), { product: 'Lumen Assist' });
  assert.deepEqual(claimFreeTextFor('expansion_signal', {}), { product: null });
  assert.deepEqual(claimFreeTextFor('competitor', { entity: 'Gong' }), { entity: 'Gong' });
  assert.deepEqual(claimFreeTextFor('pain', { product: 'x', entity: 'y' }), {});
  // Capped, so a model that pastes a sentence into the field cannot blow up a chip.
  assert.equal(claimFreeTextFor('expansion_signal', { product: 'a'.repeat(200) }).product.length, 60);
});

test('both roll up to the account: the CS lists read the company entity in one batched read', () => {
  for (const k of NEW) assert.ok(ACCOUNT_ROLLUP_CATEGORIES.includes(k), `${k} not in the rollup`);
  assert.equal(byKey('expansion_signal').about, 'company');
  assert.equal(byKey('risk_signal').about, 'company');
});
