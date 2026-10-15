// The classifier's answer, checked against who was in the room.
//
// A real customer review ("Pendlebrook Labs | Portal Review", two Harborline people and one customer) was
// classified `internal` from the title and the first 1,500 characters. `internal` is neither graded
// nor read, so the call produced no page, no account standing and no risks — it vanished. These
// tests pin the two halves of the fix: the attendee list goes INTO the prompt, and the answer is
// checked AGAINST it afterwards.
//
// Run: node --test packages/core/test/callTypeRoom.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCallTypePrompt, callTypeAgainstRoom } from '../dist/services/callScoring.js';

test('the prompt names the people from other companies', () => {
  const p = buildCallTypePrompt('Pendlebrook Labs | Portal Review', 'hello everyone', {
    externals: ['ferdyp@pendlebrooklabs.example'],
  });
  assert.match(p, /ferdyp@pendlebrooklabs\.example/);
  assert.match(p, /This call is NOT internal/);
});

test('with nobody outside, the prompt says so rather than staying silent', () => {
  const p = buildCallTypePrompt('Team sync', 'hello', { externals: [] });
  assert.match(p, /none identified/);
  assert.doesNotMatch(p, /This call is NOT internal/);
});

test('the prompt still builds for callers that pass no attendees', () => {
  const p = buildCallTypePrompt('Some call', 'hello');
  assert.match(p, /TRANSCRIPT OPENING/);
  assert.match(p, /none identified/);
});

test('"internal" loses to a customer in the room, and is read rather than graded', () => {
  assert.equal(callTypeAgainstRoom('internal', { hasExternalAttendee: true }), 'business_review');
});

test('"internal" stands when nobody outside was there', () => {
  assert.equal(callTypeAgainstRoom('internal', { hasExternalAttendee: false }), 'internal');
});

test('every other answer is left exactly as the model gave it', () => {
  for (const t of ['discovery', 'demo', 'proposal', 'onboarding', 'training', 'business_review', 'sales', 'support', 'other']) {
    assert.equal(callTypeAgainstRoom(t, { hasExternalAttendee: true }), t);
    assert.equal(callTypeAgainstRoom(t, { hasExternalAttendee: false }), t);
  }
});

test('the override never invents a grade — business_review is not a coaching type', async () => {
  const { isGradedCallType } = await import('../dist/services/callScoring.js');
  const overridden = callTypeAgainstRoom('internal', { hasExternalAttendee: true });
  // It is graded in the rubric sense, but callPlan routes it to a health read, never to a rep
  // score. What matters here is that we did not pick a type that puts a fabricated number on a
  // person: the override must land on a customer-read type.
  assert.equal(overridden, 'business_review');
  assert.equal(isGradedCallType('internal'), false);
});
