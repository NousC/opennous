// One backfill pool per workspace (GET-571): a member's backfill gets what is left, not a fresh 6,000.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkBackfillBudget } from '../src/lib/backfillBudget.mjs';
import { ownerJobFilter } from '../src/lib/backfillStart.mjs';

test('the allowance is the pool minus what earlier backfills used', () => {
  const fresh = checkBackfillBudget({ planId: 'api', counts: { email_thread: 1000 } });
  assert.equal(fresh.allowance, 6_000);
  assert.equal(fresh.pool, 6_000);
  const second = checkBackfillBudget({ planId: 'api', counts: { email_thread: 1000 }, used: 5_000 });
  assert.equal(second.allowance, 1_000);
  assert.equal(second.poolUsed, 5_000);
  assert.equal(second.needsSupport, true, '2,000 credits do not fit in the 1,000 left');
  assert.equal(checkBackfillBudget({ planId: 'api', counts: { email_thread: 1 }, used: 9_999 }).allowance, 0);
});

test('Custom has no pool to run out of', () => {
  assert.equal(checkBackfillBudget({ planId: 'custom', counts: { email_thread: 50_000 }, used: 1e6 }).allowance, null);
});

test('a member sees their own job; the founder sees the workspace job', () => {
  const calls = [];
  const q = { eq: (...a) => { calls.push(['eq', ...a]); return q; }, is: (...a) => { calls.push(['is', ...a]); return q; } };
  ownerJobFilter(q, 'u1');
  ownerJobFilter(q, null);
  assert.deepEqual(calls, [['eq', 'state->>owner_user_id', 'u1'], ['is', 'state->>owner_user_id', null]]);
});
