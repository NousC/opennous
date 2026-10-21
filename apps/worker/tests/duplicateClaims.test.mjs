// The same fact is filed once (GET-961).
//
// On a real account one email thread was read about every hour for days, and each read filed the same
// facts again: "CS now works in motions" was on the account eleven times. Two causes, two fixes:
//   - the thread looked unread every hour: its newest email was stamped hours ahead, and a thread was
//     due while that stamp was later than the CLOCK TIME of the last read. The watermark is now the
//     newest message the last read saw.
//   - each re-read's copy was put to the model as "new or repeat?", and the model said new. A
//     look-alike of 0.92 or more in the same category is a repeat, settled by code.
//
// Run: node --test apps/worker/tests/duplicateClaims.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { threadIsDue } from '../src/workers/emailThreadsDaily.mjs';
import { sureRepeat, SURE_REPEAT_SIMILARITY } from '../src/signals/index.mjs';

test('a thread is due when a message is newer than the newest one the last read saw', () => {
  const last = '2026-10-15T11:17:00Z';
  assert.equal(threadIsDue(last, null), true, 'never read');
  assert.equal(threadIsDue(last, { readAt: '2026-10-15T12:00:00Z', lastMessageAt: '2026-10-14T09:00:00Z' }), true, 'a reply since');
  assert.equal(threadIsDue(null, null), false);
});

test('a message stamped in the future does not make a thread due every hour', () => {
  // Read at 01:48, 03:51, 04:48 … while the newest email said 11:17: the old rule found it due each time.
  const last = '2026-10-15T11:17:00Z';
  const readThatSawIt = { readAt: '2026-10-15T01:48:00Z', lastMessageAt: last };
  assert.equal(threadIsDue(last, readThatSawIt), false);
});

test('a marker written before the watermark existed falls back to when it was read', () => {
  assert.equal(threadIsDue('2026-10-15T11:17:00Z', { readAt: '2026-10-15T01:48:00Z' }), true);
  assert.equal(threadIsDue('2026-10-14T11:17:00Z', { readAt: '2026-10-15T01:48:00Z' }), false);
});

const cand = (id, category, similarity) => ({ id, category, content: 'x', row: { similarity } });

test('a near-identical claim in the same category is a repeat, without asking the model', () => {
  assert.equal(SURE_REPEAT_SIMILARITY, 0.92);
  assert.equal(sureRepeat('status_quo', [cand('a', 'status_quo', 0.88), cand('b', 'status_quo', 0.95)]), 'b');
  assert.equal(sureRepeat('Status Quo', [cand('b', 'status_quo', 0.93)]), 'b', 'category normalised');
});

test('anything less sure still goes to the model', () => {
  assert.equal(sureRepeat('status_quo', [cand('a', 'status_quo', 0.91)]), null, 'below the bar');
  assert.equal(sureRepeat('goal', [cand('a', 'status_quo', 0.99)]), null, 'another category');
  // Same-category claims offered for a time-bound category carry no similarity: never a sure repeat.
  assert.equal(sureRepeat('timeline', [{ id: 'a', category: 'timeline', content: 'x' }]), null);
  assert.equal(sureRepeat('pain', []), null);
});
