// The two categories promoted out of `general` on 2026-09-19, and the line between them.
//
// They were promoted together because they are the two halves of what `general` was really
// holding: in a sample of Harborline's `general` claims, a sizeable share were a standing attribute
// of the business and a smaller share were a dated result. Splitting them is the whole point — "they onboard 90
// seats a month" is what the business IS, "June was their best month" is how it WENT — so the risk
// is not that the taxonomy lacks a home, it is that the two homes blur into one.
//
// Run: node --test packages/core/test/firmographicVsPerformance.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CLAIM_CATEGORIES, CLAIM_CATEGORY_KEYS, ACCOUNT_ROLLUP_CATEGORIES,
  normalizeClaimCategory, claimCategoryPromptBlock, claimSubtagsFor,
} from '../dist/db/claimCategories.js';

const byKey = k => CLAIM_CATEGORIES.find(c => c.key === k);

test('both exist and survive normalization', () => {
  for (const k of ['firmographic', 'performance']) {
    assert.ok(CLAIM_CATEGORY_KEYS.includes(k), `${k} missing from the taxonomy`);
    assert.equal(normalizeClaimCategory(k), k, `${k} must not be coerced`);
  }
});

test('both are about the COMPANY, never the person who said it', () => {
  // A location count and a record month describe the business. `either` would be an invitation to
  // guess, and the guess lands the fact on one attendee's page where the account cannot see it —
  // the failure GET-223 and GET-366 both record.
  assert.equal(byKey('firmographic').about, 'company');
  assert.equal(byKey('performance').about, 'company');
});

test('both roll up to the account even when tagged about:person', () => {
  // The backstop for a mis-tagged `about`. Without it the fact exists, on the wrong record, and
  // the account reads empty.
  assert.ok(ACCOUNT_ROLLUP_CATEGORIES.includes('firmographic'));
  assert.ok(ACCOUNT_ROLLUP_CATEGORIES.includes('performance'));
});

test('each description rules the other one out by name', () => {
  // The boundary has to be IN the prompt, not in our heads — the model only sees these strings.
  const firmo = byKey('firmographic').description;
  const perf = byKey('performance').description;
  assert.match(firmo, /performance/, 'firmographic must point at performance');
  assert.match(perf, /firmographic/, 'performance must point at firmographic');
  // And each must separate itself from its other close neighbour.
  assert.match(firmo, /status_quo/, 'firmographic must separate itself from the tools they run');
  assert.match(perf, /adoption/, "performance must separate itself from our product's results");
  assert.match(perf, /seasonality/, 'performance must separate itself from a recurring rhythm');
});

test('the examples are on the right side of the line', () => {
  // The prompt teaches by example at least as much as by description, so a mismatched example is
  // worse than none. A standing shape vs a dated result.
  assert.match(byKey('firmographic').example, /high-volume|about \d+ \w+ a month|\d+ (employees|locations|seats|customers)/);
  assert.match(byKey('performance').example, /best sales month|this year/);
});

test('both reach the extractor prompt', () => {
  const block = claimCategoryPromptBlock();
  assert.match(block, /- firmographic — /);
  assert.match(block, /- performance — /);
});

test('neither carries sub-tags, so both writers stay a no-op', () => {
  // If either grows a closed vocabulary later (performance → direction up/down/flat is the
  // obvious one), it goes in CLAIM_SUBTAGS and BOTH writers pick it up for free. Until then the
  // shape must be empty rather than half-declared.
  assert.deepEqual(claimSubtagsFor('firmographic', { direction: 'up' }), {});
  assert.deepEqual(claimSubtagsFor('performance', { direction: 'up' }), {});
});

test('the worked cases from the corpus land where they should', () => {
  // Invented content in the shape of what sat in the `general` pile, with the category each belongs in. This is
  // documentation as much as assertion: it is the boundary, in the words people actually used.
  const firmographic = [
    'Ashcombe Systems adds about 55 seats a month, all self-serve',
    'Larkfield Health historically averaged 120-180 finance apps a month',
    'Corvane Systems has two locations',
    'Brackenfold Labs has roughly 25 people on the sales team',
    'About 20% of Corvane Systems buyers drive in from out of town',
  ];
  const performance = [
    'Renewals in the first quarter beat their own target',
    'Web enquiries are up: about 300 month to date, against roughly 200 at this point last year',
    'Wexcombe Software missed the partner bonus in June',
    'Both offices were busier in July than in June',
  ];
  // The routing itself is the model's judgement, graded by the Assay, not something a unit test
  // can assert. What it CAN pin is the property that separates the two sets: a performance claim
  // is anchored to a period, a firmographic one is not. If a worked case ever stops satisfying
  // that, the boundary has moved and the descriptions above need to move with it.
  assert.equal(new Set([...firmographic, ...performance]).size,
    firmographic.length + performance.length, 'the worked cases must not overlap');
  const PERIOD = /June|July|this year|month to date|last year|quarter/i;
  assert.ok(performance.every(s => PERIOD.test(s)),
    'every performance case names the period it measures');
  assert.ok(firmographic.every(s => !PERIOD.test(s)),
    'a firmographic case that names a period is really a performance case');
});
