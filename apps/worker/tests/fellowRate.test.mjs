// Fellow's 3 requests/second belongs to the KEY, not to each worker holding it.
//
// The backfill used to sleep 350ms after every call, which is right for one worker and wrong for
// every other number: at --concurrency 4 each of four workers paced itself to ~3/s and the key
// issued about 12/s. Fellow answers that with 429s, the retry backs off 2s/4s/6s, and the fourth
// attempt returns the 429 — at which point the recording reads as missing and the meeting is
// dropped as `recording_unavailable`. Turning concurrency UP lost meetings.
//
// This models the reservation arithmetic the fix uses, so the property that matters is pinned:
// N concurrent callers cost the same request rate as one.
//
// Run: node --test apps/worker/tests/fellowRate.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

// The same reservation the script performs, against a clock we control.
function makeLimiter(rps, clock) {
  let nextSlotAt = 0;
  return () => {
    const now = clock.now;
    const slot = Math.max(now, nextSlotAt);
    nextSlotAt = slot + 1000 / rps;
    return slot;                   // the instant this request is allowed out
  };
}

test('slots are handed out 1/rps apart, however many callers ask', () => {
  const clock = { now: 0 };
  const take = makeLimiter(3, clock);
  const slots = [take(), take(), take(), take(), take(), take()];
  // The first goes out now; each one after it is a third of a second behind the last.
  assert.equal(slots[0], 0);
  for (let i = 1; i < slots.length; i++) {
    assert.ok(slots[i] - slots[i - 1] >= 1000 / 3 - 1e-9,
      `slot ${i} came ${slots[i] - slots[i - 1]}ms after the last — under the 333ms budget`);
  }
  // Six requests at 3/s occupy at least the five gaps between them.
  assert.ok(slots[5] >= 5 * (1000 / 3) - 1e-9);
});

test('four workers in flight still cost three requests per second', () => {
  const clock = { now: 0 };
  const take = makeLimiter(3, clock);
  // Four workers each fire two requests at t=0, the way --concurrency 4 does.
  const issued = Array.from({ length: 8 }, () => take());
  const lastSlot = issued[issued.length - 1];
  // 8 requests at 3/s cannot complete before 7/3 seconds. The old per-worker sleep issued all
  // eight inside 350ms, which is what earned the 429s.
  assert.ok(lastSlot >= 7 * (1000 / 3) - 1e-9, `8 requests finished at ${lastSlot}ms — over budget`);
});

test('an idle gap does not bank credit for a burst', () => {
  const clock = { now: 0 };
  const take = makeLimiter(3, clock);
  take();                       // one request at t=0
  clock.now = 60_000;           // a quiet minute
  const a = take(), b = take();
  assert.equal(a, 60_000, 'the first request after a gap goes out immediately');
  assert.ok(b - a >= 1000 / 3 - 1e-9, 'the one behind it still waits its turn');
});
