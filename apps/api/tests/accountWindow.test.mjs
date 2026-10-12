// The accounts list window: which accounts earn a place, and which are a lead list in disguise.
//
// The rule that changed on 2026-09-21 is the last clause. An account with no deal in any state
// used to qualify on `last_activity_at` — any touch, including our own outbound — which on
// Harborline admitted hundreds of accounts we had emailed, few of which had actually answered. It now asks
// for an inbound touch instead, with one deliberate exception for a re-opened dead account.
//
// These assert the PREDICATE, not the rows. The filter is a PostgREST `or` string, so what can
// break is a clause going missing, an `and(...)` group losing its parentheses, or the unmigrated
// fallback quietly changing — and all three are visible in the string.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  accountWindowFilter, dealWindowFilter, inDealWindow,
  activityCutoff, lostCutoff, ACTIVITY_WINDOW_DAYS, DEAL_WINDOW_MONTHS,
} from '../src/lib/dealListWindow.mjs';

const NOW = new Date('2026-09-21T12:00:00.000Z');
const LOST = lostCutoff(NOW).toISOString();      // 2025-09-21
const TOUCH = activityCutoff(NOW).toISOString(); // 2026-08-07

/** Split an `or` filter the way PostgREST does: on commas OUTSIDE any and(...) group. */
function topLevelClauses(filter) {
  const out = [];
  let depth = 0, start = 0;
  for (let i = 0; i < filter.length; i++) {
    const ch = filter[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === ',' && depth === 0) { out.push(filter.slice(start, i)); start = i + 1; }
  }
  out.push(filter.slice(start));
  assert.equal(depth, 0, 'unbalanced parentheses');
  return out;
}

test('without the migration the rule is exactly what it was before', () => {
  // An unmigrated database must keep today's lists rather than 400 on a missing column.
  const f = accountWindowFilter(NOW);
  assert.equal(f,
    `open_deals.gt.0,won_deals.gt.0,child_deals.gt.0,last_lost_at.gte.${LOST},`
    + `last_activity_at.gte.${TOUCH}`);
  assert.ok(!f.includes('last_inbound_at'), 'must never name a column that does not exist yet');
});

test('with the migration a never-dealt account must have ANSWERED', () => {
  const f = accountWindowFilter(NOW, { inbound: true });
  assert.ok(f.includes(`last_inbound_at.gte.${TOUCH}`), 'inbound clause present');
  // The blanket touch clause must be gone as a clause of its OWN. Leaving it would OR the old
  // rule back in and the outbound-only accounts would return. It is still allowed inside the
  // re-engagement group, where it is guarded by having had a deal.
  assert.ok(!topLevelClauses(f).some(c => c.startsWith('last_activity_at.')),
    'a bare last_activity_at clause would re-admit every account we merely emailed');
});

test('a dead deal being re-worked still qualifies on a plain touch', () => {
  const f = accountWindowFilter(NOW, { inbound: true });
  assert.ok(f.includes(`and(last_lost_at.not.is.null,last_activity_at.gte.${TOUCH})`),
    'the re-engagement clause is guarded by having had a deal at all');
});

test('the four deal clauses survive both modes', () => {
  for (const opts of [undefined, { inbound: true }]) {
    const f = accountWindowFilter(NOW, opts);
    for (const clause of ['open_deals.gt.0', 'won_deals.gt.0', 'child_deals.gt.0', `last_lost_at.gte.${LOST}`]) {
      assert.ok(f.includes(clause), `${clause} missing from ${JSON.stringify(opts)}`);
    }
  }
});

test('the filter is six whole clauses, none of them truncated', () => {
  // A malformed and(...) group changes the filter's meaning silently rather than erroring, so
  // the shape is asserted rather than assumed.
  assert.deepEqual(topLevelClauses(accountWindowFilter(NOW, { inbound: true })), [
    'open_deals.gt.0',
    'won_deals.gt.0',
    'child_deals.gt.0',
    `last_lost_at.gte.${LOST}`,
    `and(last_lost_at.not.is.null,last_activity_at.gte.${TOUCH})`,
    `last_inbound_at.gte.${TOUCH}`,
  ]);
  assert.equal(topLevelClauses(accountWindowFilter(NOW)).length, 5, 'the unmigrated rule has five');
});

test('the cutoffs are the documented ones', () => {
  assert.equal(ACTIVITY_WINDOW_DAYS, 45);
  assert.equal(DEAL_WINDOW_MONTHS, 12);
  assert.equal(activityCutoff(NOW).toISOString(), '2026-08-07T12:00:00.000Z');
  assert.equal(lostCutoff(NOW).toISOString(), '2025-09-21T12:00:00.000Z');
});

test('the deal window itself is untouched by this change', () => {
  assert.equal(dealWindowFilter(NOW),
    `status.is.null,status.eq.open,status.eq.won,and(status.eq.lost,close_date.gte.${LOST})`);
  assert.equal(inDealWindow({ status: 'open', close_date: null }, lostCutoff(NOW)), true);
  assert.equal(inDealWindow({ status: 'won', close_date: '2019-01-01' }, lostCutoff(NOW)), true);
  assert.equal(inDealWindow({ status: 'lost', close_date: '2026-09-01' }, lostCutoff(NOW)), true);
  assert.equal(inDealWindow({ status: 'lost', close_date: '2023-01-01' }, lostCutoff(NOW)), false);
  assert.equal(inDealWindow({ status: 'lost', close_date: null }, lostCutoff(NOW)), false);
});
