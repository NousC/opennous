// The deal-health job's pure parts: which deals a run takes, in what order, and what each row gets.
//
// The order is the job's only resume point (no cursor), so it is pinned: never-scored first, then
// stalest, one account at a time, and a cap that defers rather than skips ahead.
//
// Run: node --test apps/worker/tests/dealHealthRefresh.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planDealHealthBatches, healthPatch } from '../src/workers/dealHealthRefresh.mjs';

const row = (entity_id, company_id, deal_health_at = null) => ({ entity_id, company_id, deal_health_at });

test('deals are grouped by account, so an account is read once for all its open deals', () => {
  const plan = planDealHealthBatches([row('d2', 'A'), row('d1', 'A'), row('d3', 'B')]);
  assert.deepEqual(plan.batches, [{ companyId: 'A', dealIds: ['d1', 'd2'] }, { companyId: 'B', dealIds: ['d3'] }]);
  assert.equal(plan.deals, 3);
  assert.equal(plan.deferred, 0);
});

test('never-scored accounts go first, then the stalest; an account sorts by its stalest deal', () => {
  const plan = planDealHealthBatches([
    row('d1', 'FRESH', '2026-10-02T03:35:00Z'),
    row('d2', 'OLD', '2026-09-01T00:00:00Z'),
    row('d3', 'MIXED', '2026-10-02T03:35:00Z'),
    row('d4', 'MIXED', null),
    row('d5', 'NEW', null),
  ]);
  assert.deepEqual(plan.batches.map(b => b.companyId), ['MIXED', 'NEW', 'OLD', 'FRESH']);
});

test('a deal with no account is skipped and counted: there is no deal page to match', () => {
  const plan = planDealHealthBatches([row('d1', null), row('d2', 'A'), row('d3', undefined)]);
  assert.deepEqual(plan.batches.map(b => b.companyId), ['A']);
  assert.equal(plan.noAccount, 2);
});

test('the cap defers whole accounts in order and never skips ahead to a fresher one', () => {
  const rows = [
    row('a1', 'A'), row('a2', 'A'),                                   // never scored
    row('b1', 'B', '2026-09-01T00:00:00Z'), row('b2', 'B', '2026-09-01T00:00:00Z'), row('b3', 'B', '2026-09-01T00:00:00Z'),
    row('c1', 'C', '2026-09-20T00:00:00Z'),                           // would fit, but is fresher than B
  ];
  const plan = planDealHealthBatches(rows, { cap: 4 });
  assert.deepEqual(plan.batches.map(b => b.companyId), ['A']);
  assert.equal(plan.deals, 2);
  assert.equal(plan.deferred, 4);
});

test('the first account is always taken, so a cap smaller than one account still moves', () => {
  const plan = planDealHealthBatches([row('a1', 'A'), row('a2', 'A'), row('a3', 'A'), row('b1', 'B')], { cap: 2 });
  assert.deepEqual(plan.batches, [{ companyId: 'A', dealIds: ['a1', 'a2', 'a3'] }]);
  assert.equal(plan.deferred, 1);
});

test('a spent cap takes nothing', () => {
  const plan = planDealHealthBatches([row('a1', 'A')], { cap: 0 });
  assert.deepEqual(plan.batches, []);
  assert.equal(plan.deferred, 1);
});

test('a repeated row is one deal, and an unreadable stamp counts as never scored', () => {
  const plan = planDealHealthBatches([row('a1', 'A'), row('a1', 'A'), row('b1', 'B', 'not a date'), row('c1', 'C', '2026-01-01T00:00:00Z')]);
  assert.deepEqual(plan.batches, [{ companyId: 'A', dealIds: ['a1'] }, { companyId: 'B', dealIds: ['b1'] }, { companyId: 'C', dealIds: ['c1'] }]);
});

test('an open deal gets its score and reason; anything else is emptied, and every row is stamped', () => {
  const at = '2026-10-02T03:35:00.000Z';
  assert.deepEqual(healthPatch({ status: 'open', score: 41.6, reason: 'Single-threaded' }, at),
    { deal_health_score: 42, deal_health_reason: 'Single-threaded', deal_health_at: at });
  // The page reads this deal as won: no score, but stamped so it stops jumping the queue.
  assert.deepEqual(healthPatch({ status: 'won', score: null, reason: null }, at),
    { deal_health_score: null, deal_health_reason: null, deal_health_at: at });
  // Not on the account any more (no candidate came back for it).
  assert.deepEqual(healthPatch(undefined, at), { deal_health_score: null, deal_health_reason: null, deal_health_at: at });
  // A score with no reason keeps the score.
  assert.deepEqual(healthPatch({ status: 'open', score: 70, reason: null }, at), { deal_health_score: 70, deal_health_reason: null, deal_health_at: at });
});
