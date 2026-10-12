// A wrong due date is worse than no due date.
//
// The model hands over an under-specified phrase while holding the missing half in the title it
// wrote a second earlier. The shape seen in prod, on a call dated 2026-08-31:
//
//   title "Book the October review for Monday the 5th at 10 AM"
//   due_phrase "the 5th"                                → 2026-09-05, a month early
//
// `commitments_overdue` sorts the attention list on this field, so a task dated a month early
// reports itself overdue while the customer is still waiting, and the rep learns to distrust the
// column. Several dated commitments in that sample were wrong this way.
//
// Run: node --test packages/core/test/dueDateAgreement.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dueDateAgreeingWith, monthsMentioned, resolveDuePhrase } from '../dist/dateResolve.js';

test('the real case: a date a month early is dropped', () => {
  const resolved = resolveDuePhrase('the 5th', new Date('2026-08-31T14:00:00Z'), 'America/New_York');
  assert.match(resolved, /^2026-09-05/, 'the resolver is right about the phrase it was given');
  assert.equal(
    dueDateAgreeingWith(resolved, 'Book the October review for Monday the 5th at 10 AM'),
    null,
    'the title says October and the date says September — we do not know, so we say nothing',
  );
});

test('a date the text agrees with survives', () => {
  assert.equal(dueDateAgreeingWith('2026-10-05', 'Schedule the October check-in'), '2026-10-05');
  assert.equal(dueDateAgreeingWith('2026-09-10', 'Meet with Oskar on September 10th'), '2026-09-10');
});

test('text that names no month cannot disagree', () => {
  // The common case by far, and it must pass untouched — this check exists to catch a
  // contradiction, not to demand corroboration.
  for (const title of ['Send the export fix', 'Follow up next week', '', null, undefined]) {
    assert.equal(dueDateAgreeingWith('2026-09-05', title), '2026-09-05');
  }
});

test('no date in means no date out', () => {
  assert.equal(dueDateAgreeingWith(null, 'October check-in'), null);
  assert.equal(dueDateAgreeingWith(undefined, 'anything'), null);
  assert.equal(dueDateAgreeingWith('', 'October'), null);
});

test('any named month matching is enough', () => {
  // "Move the September review to October" names two. The date belongs to one of them and we
  // cannot tell which, so agreeing with either is not a contradiction.
  assert.equal(dueDateAgreeingWith('2026-10-05', 'Move the September review to October'), '2026-10-05');
  assert.equal(dueDateAgreeingWith('2026-09-05', 'Move the September review to October'), '2026-09-05');
  assert.equal(dueDateAgreeingWith('2026-11-05', 'Move the September review to October'), null);
});

test('a word that merely starts like a month is not a month', () => {
  // The same trap dateResolve already documents: a trailing wildcard turned "deck 3" into
  // December 3rd and "marketing 20" into March 20th.
  assert.deepEqual(monthsMentioned('Send the marketing deck and the january notes'), [0], 'only january');
  assert.equal(dueDateAgreeingWith('2026-09-05', 'Send the marketing deck'), '2026-09-05');
  assert.equal(dueDateAgreeingWith('2026-09-05', 'Review the deck 3 times'), '2026-09-05');
});

test('abbreviations count', () => {
  assert.deepEqual(monthsMentioned('due Oct 5'), [9]);
  assert.equal(dueDateAgreeingWith('2026-09-05', 'Ship it in Oct'), null);
  assert.equal(dueDateAgreeingWith('2026-10-05', 'Ship it in Oct'), '2026-10-05');
});

test('a full timestamp is read off the string, not through a Date', () => {
  // A timestamp near a month boundary must not be shifted into the neighbouring month by a
  // timezone on the way past, which is exactly how this class of bug starts.
  assert.equal(dueDateAgreeingWith('2026-10-01T02:00:00Z', 'October deadline'), '2026-10-01T02:00:00Z');
  assert.equal(dueDateAgreeingWith('2026-09-30T23:30:00Z', 'October deadline'), null);
});

test('an unrecognisable date shape is left alone, not dropped', () => {
  // This check exists to remove a value we know is wrong. Something it cannot parse is not
  // something it knows is wrong.
  assert.equal(dueDateAgreeingWith('next Tuesday', 'October check-in'), 'next Tuesday');
});
