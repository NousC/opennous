import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEAL_WINDOW_MONTHS, lostCutoff, lostCutoffISO, dealWindowFilter, inDealWindow,
  ACTIVITY_WINDOW_DAYS, accountWindowFilter,
} from '../src/lib/dealListWindow.mjs';

// What the workspace's LISTS show. Pure: no DB.
//
// Not a preference — a contract. The flattened path filters in SQL and the claims path filters in
// memory, and a workspace whose two paths disagreed would show a different pipeline depending on
// how big it is. Checked on Harborline when this landed: both paths returned the same deals, under half of the total.
//
// Distinct from dealWindow.test.mjs, which is GET-353's "can we measure this deal's behaviour at
// all" window. Same word, different question.

const NOW = new Date('2026-09-20T00:00:00.000Z');
const CUTOFF = lostCutoff(NOW);
const at = (iso, status) => ({ status, close_date: iso });

test('the window is twelve months back from now', () => {
  assert.equal(DEAL_WINDOW_MONTHS, 12);
  assert.equal(lostCutoffISO(NOW), '2025-09-20T00:00:00.000Z');
});

test('open is shown at any age, including long past its close date', () => {
  assert.equal(inDealWindow(at('2026-12-01', 'open'), CUTOFF), true);
  // More than half of Harborline's open deals are already past their close date. Ageing them out would
  // hide exactly the rot the board exists to show.
  assert.equal(inDealWindow(at('2022-01-01', 'open'), CUTOFF), true);
  assert.equal(inDealWindow({ status: 'open', close_date: null }, CUTOFF), true);
});

test('won is shown at any age — a customer is a customer whenever they bought', () => {
  assert.equal(inDealWindow(at('2026-09-19', 'won'), CUTOFF), true);
  // Only a minority of customer accounts won inside the window; the rest bought earlier and most
  // still pay. A recency rule here would empty the customer list.
  assert.equal(inDealWindow(at('2020-05-21', 'won'), CUTOFF), true);
  assert.equal(inDealWindow({ status: 'won', close_date: null }, CUTOFF), true);
});

test('lost is shown only inside the window, and the boundary is inclusive', () => {
  assert.equal(inDealWindow(at('2026-09-19', 'lost'), CUTOFF), true);
  assert.equal(inDealWindow(at('2025-09-20T00:00:00.000Z', 'lost'), CUTOFF), true);
  assert.equal(inDealWindow(at('2025-09-19T23:59:59.000Z', 'lost'), CUTOFF), false);
  assert.equal(inDealWindow(at('2023-04-02', 'lost'), CUTOFF), false);
});

test('a loss we cannot date is out; an unreadable date is not a recent date', () => {
  assert.equal(inDealWindow({ status: 'lost', close_date: null }, CUTOFF), false);
  assert.equal(inDealWindow({ status: 'lost', close_date: 'not a date' }, CUTOFF), false);
});

test('a deal whose status we never learned is shown, not swallowed', () => {
  assert.equal(inDealWindow({ status: null, close_date: '2019-01-01' }, CUTOFF), true);
  assert.equal(inDealWindow({ status: undefined, close_date: null }, CUTOFF), true);
});

test('the SQL filter spells out the statuses, so a null status survives it too', () => {
  const filter = dealWindowFilter(NOW);
  assert.equal(
    filter,
    'status.is.null,status.eq.open,status.eq.won,and(status.eq.lost,close_date.gte.2025-09-20T00:00:00.000Z)',
  );
  // `status.neq.lost` is NULL — not true — for a row with no status, and would drop it silently.
  assert.ok(!filter.includes('neq'));
});

test('the two paths agree deal by deal', () => {
  const deals = [
    at('2026-02-01', 'open'), at('2021-07-07', 'won'), at('2026-01-15', 'lost'),
    at('2023-03-03', 'lost'), { status: 'lost', close_date: null },
  ];
  assert.deepEqual(deals.map(d => inDealWindow(d, CUTOFF)), [true, true, true, false, false]);
});

// An account earns its place by holding a deal the lists show, OR by being worked right now.
// Without the second clause Harborline lost hundreds of accounts that had been touched in the previous
// week, most of them with real two-way contact — the top of the funnel, before anyone opens a
// deal record for it.
test('the account filter admits an account nobody has opened a deal for yet, if it is being worked', () => {
  const now = new Date('2026-09-20T00:00:00.000Z');
  const f = accountWindowFilter(now);
  assert.match(f, /last_activity_at\.gte\./, 'recent activity must earn a place on its own');
  // 45 days back from the clock passed in, not from today.
  assert.match(f, /last_activity_at\.gte\.2026-08-06/);
  // And the deal clauses are untouched.
  for (const clause of ['open_deals.gt.0', 'won_deals.gt.0', 'child_deals.gt.0', 'last_lost_at.gte.']) {
    assert.ok(f.includes(clause), `${clause} must survive`);
  }
});

test('the activity window is shorter than the deal window, and deliberately', () => {
  // Re-admitting twelve months of activity would undo the cut the deal window just made: on
  // Harborline 12 months of activity covers most accounts, 45 days covers a small slice of that.
  assert.ok(ACTIVITY_WINDOW_DAYS < DEAL_WINDOW_MONTHS * 30,
    'the point is to show live work, not to restore the history the deal window removed');
});
