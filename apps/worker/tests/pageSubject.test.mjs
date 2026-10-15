// A call page is never filed on one of our own people.
//
// The account rule (GET-296/GET-313) decides WHICH account a call belongs to, and withholds the
// answer when it cannot be trusted. But the page writer then fell back to `primaryEntityId` — the
// first "buyer" — and on a workspace whose reps hold no seats, that is one of our own staff. So a
// customer's installation call filed itself on an Harborline employee, twice, the second time
// overwriting a page that had just been corrected to the right customer.
//
// Deciding the account in one place and filing the page in another is how a fix passes its tests
// and still lands wrong. This is the rule at the point of writing.
//
// Run: node --test apps/worker/tests/pageSubject.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pageSubject } from '../src/signals/callScore.mjs';

const OURS = new Set(['marlo', 'sorrel']);

test('one of our own people is never a page subject', () => {
  assert.equal(pageSubject('marlo', OURS), null);
  assert.equal(pageSubject('sorrel', OURS), null);
});

test('the customer company, and its contact, are kept', () => {
  assert.equal(pageSubject('ashgrove-health', OURS), 'ashgrove-health');
  assert.equal(pageSubject('ysolde-at-the-customer', OURS), 'ysolde-at-the-customer');
});

test('nothing in, nothing out — never a guess', () => {
  assert.equal(pageSubject(null, OURS), null);
  assert.equal(pageSubject(undefined, OURS), null);
  assert.equal(pageSubject('', OURS), null);
});

test('with nobody known to be ours, the subject stands', () => {
  // A workspace we hold no internal emails for must behave exactly as before, not lose every page.
  assert.equal(pageSubject('someone', new Set()), 'someone');
  assert.equal(pageSubject('someone', null), 'someone');
  assert.equal(pageSubject('someone', undefined), 'someone');
});

test('a malformed set is not trusted to mean "ours"', () => {
  // Anything that is not a Set is treated as "we do not know", which keeps the subject rather than
  // silently dropping every page on a caller's mistake.
  assert.equal(pageSubject('someone', ['someone']), 'someone');
  assert.equal(pageSubject('someone', { someone: true }), 'someone');
});
