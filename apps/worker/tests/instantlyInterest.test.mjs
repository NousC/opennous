// A reply the Instantly webhook missed is filed with the disposition Instantly gave it (GET-1025).
//
// Run: cd apps/worker && node --test tests/instantlyInterest.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { instantlyInterestEvent, isPositiveInterest } from '../src/webhooks/handlers/instantly.mjs';

test("Instantly's interest status becomes the event its webhook sends", () => {
  assert.equal(instantlyInterestEvent(1), 'lead_interested');
  assert.equal(instantlyInterestEvent(2), 'lead_meeting_booked');
  assert.equal(instantlyInterestEvent(-1), 'lead_not_interested');
  assert.equal(instantlyInterestEvent('-2'), 'lead_wrong_person');
  assert.equal(instantlyInterestEvent(0), 'lead_out_of_office');
});

test('no status is a plain reply, which our classifier reads', () => {
  assert.equal(instantlyInterestEvent(null), 'reply_received');
  assert.equal(instantlyInterestEvent(undefined), 'reply_received');
  assert.equal(instantlyInterestEvent(99), 'reply_received');
});

test('positive means interested, a meeting, or won', () => {
  assert.deepEqual([1, 2, 3, 4, 0, -1, -2, -3, null].filter(isPositiveInterest), [1, 2, 3, 4]);
});
