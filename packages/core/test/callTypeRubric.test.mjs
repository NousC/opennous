// A call is judged on the job it was (GET-287). One sales rubric graded a customer check-in on
// whether it closed, which is how hundreds of Harborline's business reviews and training calls were
// being marked down for not doing a job nobody on them was doing.
//
// Run: pnpm --filter @nous/core build && node --test packages/core/test/callTypeRubric.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rubricDimensionsFor, defaultRubric, validateRubric, SCORED_CALL_TYPES } from '../dist/db/coachingRubric.js';
import { parseCallType, isGradedCallType, GRADED_CALL_TYPES } from '../dist/services/callScoring.js';

const keys = (t, role) => rubricDimensionsFor(t, role).map(d => d.key);

test('a business review is not graded on closing', () => {
  const k = keys('business_review');
  assert.ok(k.includes('value_delivered'));
  assert.ok(k.includes('risk'));
  assert.ok(!k.includes('close'), 'a QBR has nothing to close');
  assert.ok(!k.includes('objection_handling'), 'nobody is objecting in a check-in');
});

test('a demo is graded on hitting THEIR world, not on discovering it', () => {
  const k = keys('demo');
  assert.ok(k.includes('tailoring'));
  assert.ok(!k.includes('discovery'), 'discovery belongs to the call before this one');
});

test('discovery leans on what was learned; closing on the decision', () => {
  const disc = rubricDimensionsFor('discovery');
  assert.equal(disc.find(d => d.key === 'discovery')?.weight, 35);
  assert.ok(keys('proposal').includes('decision_process'));
});

test('training and onboarding are judged on the customer, not the rep pitch', () => {
  assert.ok(keys('training').includes('hands_on'));
  assert.ok(keys('onboarding').includes('time_to_value'));
});

test('an SDR keeps the prospecting rubric on an early call, but not on a QBR', () => {
  assert.ok(keys('discovery', 'sdr').includes('meeting_secured'));
  assert.ok(keys('business_review', 'sdr').includes('value_delivered'));
});

test('an unknown or missing type falls back to the role default', () => {
  assert.deepEqual(keys(null, 'account_executive'), keys('sales', 'account_executive'));
  assert.deepEqual(keys('nonsense', 'sdr'), keys(null, 'sdr'));
});

test('every shipped rubric is a valid rubric', () => {
  for (const t of SCORED_CALL_TYPES) {
    assert.equal(validateRubric(rubricDimensionsFor(t)), null, `${t} rubric must sum to 100`);
    assert.equal(validateRubric(defaultRubric('default', t).dimensions), null, t);
  }
});

test('the classifier reads a word, an alias, or refuses', () => {
  assert.equal(parseCallType('business_review'), 'business_review');
  assert.equal(parseCallType('  Demo.\n'), 'demo');
  assert.equal(parseCallType('QBR'), 'business_review');
  assert.equal(parseCallType('kickoff'), 'onboarding');
  assert.equal(parseCallType('negotiation'), 'proposal');
  // Never guess "sales" out of noise: an unreadable answer is 'other', which is not scored.
  assert.equal(parseCallType('¯\\_(ツ)_/¯'), 'other');
  assert.equal(parseCallType(''), 'other');
  assert.equal(parseCallType(null), 'other');
});

test('support, internal and other are real calls that are simply not graded', () => {
  for (const t of ['support', 'internal', 'other']) assert.equal(isGradedCallType(t), false, t);
  for (const t of GRADED_CALL_TYPES) assert.equal(isGradedCallType(t), true, t);
});

test('the classifier answer survives the JSON the model runner demands', () => {
  // The shared runner only accepts an object containing "call_type" — a bare word was rejected as
  // unusable, every fallback was burned, and the call came back unclassified. Both shapes now read.
  assert.equal(parseCallType('{"call_type":"business_review"}'), 'business_review');
  assert.equal(parseCallType('```json\n{"call_type": "demo"}\n```'), 'demo');
  assert.equal(parseCallType('{"call_type":"qbr"}'), 'business_review');
  assert.equal(parseCallType('demo'), 'demo');
  assert.equal(parseCallType('{"call_type":"nonsense"}'), 'other');
});
