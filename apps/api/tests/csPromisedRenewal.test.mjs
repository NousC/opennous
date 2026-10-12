// Customer Success Phase 5: "We promised", the renewal date, and the active-users trend.
//
// Invariants, not thresholds:
//   1. What we owe a customer is its own list. It never becomes a risk reason and never moves an
//      account onto the at-risk list (2026-10-01: to-dos alone put dozens of accounts there).
//   2. A chase (they owe us) is not a promise, and an undated email to-do that has not slipped is a
//      to-do, not a promise.
//   3. A trend needs a real "before". No history, no number; never a zero standing in for one.
//   4. A renewal that has passed is not a renewal.
//
// Run: node --test apps/api/tests/csPromisedRenewal.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyCustomers, promiseOf, rankPromises, activeUsersTrend, trendWindow, upcomingRenewal,
} from '../src/lib/csHealth.mjs';
import { renewsWithin } from '../src/lib/csReport.mjs';

const NOW = Date.parse('2026-10-02T15:00:00Z');
const DAY = 86_400_000;
const claim = (property, value, computed_at = '2026-09-20T10:00:00Z') => ({ entity_id: 'e1', property, value, computed_at });
const ours = (over = {}) => ({ owner_kind: 'user', status: 'open', title: 'Send the vendor credentialing steps', ...over });

test('an overdue promise of ours is a "We promised" reason that says how late it is', () => {
  const p = promiseOf(claim('action_item.email_abc', ours({ due_at: '2026-09-20', source_type: 'email' })), NOW);
  assert.equal(p.kind, 'promised');
  assert.equal(p.overdue_days, 12);
  assert.equal(p.detail, '12 days overdue');
  assert.equal(p.tier, 2);
});

test('a commitment from a call counts even before it is due', () => {
  const p = promiseOf(claim('action_item.meeting_9_0', ours({ source_type: 'meeting', occurred_at: '2026-09-28T16:00:00Z', quote: "I'll send it Friday" })), NOW);
  assert.ok(p);
  assert.equal(p.overdue_days, null);
  assert.equal(p.at, '2026-09-28T16:00:00Z', 'dated by when it was said');
  assert.equal(p.quote, "I'll send it Friday");
});

test('a chase, a closed item, their to-do, or an undated email to-do is not a promise', () => {
  assert.equal(promiseOf(claim('action_item.e1', ours({ awaiting_them: true, source_type: 'meeting' })), NOW), null);
  assert.equal(promiseOf(claim('action_item.e2', ours({ status: 'done', source_type: 'meeting' })), NOW), null);
  assert.equal(promiseOf(claim('action_item.e3', ours({ owner_kind: 'prospect', source_type: 'meeting' })), NOW), null);
  assert.equal(promiseOf(claim('action_item.e4', ours({ source_type: 'email' })), NOW), null);
  assert.equal(promiseOf(claim('action_item.e5', ours({ source_type: 'email', due_at: '2026-10-09' })), NOW), null, 'not due yet');
  assert.equal(promiseOf(claim('note.x', ours({ source_type: 'meeting' })), NOW), null);
});

test('the most overdue promise leads, then the newest', () => {
  const ranked = rankPromises([
    { text: 'a', overdue_days: null, at: '2026-09-30' },
    { text: 'b', overdue_days: 3, at: '2026-09-01' },
    { text: 'c', overdue_days: 20, at: '2026-08-01' },
    { text: 'd', overdue_days: null, at: '2026-09-25' },
  ]);
  assert.deepEqual(ranked.map(r => r.text), ['c', 'b', 'a', 'd']);
});

test('what we owe never makes an account at risk, and never appears as a risk reason', () => {
  const acct = (id) => ({ companyId: id, name: id, wonDeals: 1, openDeals: 0, daysQuiet: 5, products: [],
    // The old reader still hands over tier-1 "owed" reasons; they must not become risk.
    reasons: [{ tier: 1, kind: 'owed', text: 'Turn on the valuation feed', detail: null }, { tier: 1, kind: 'owed', text: 'Install the quote widget', detail: null }] });
  const health = new Map([['busy', { status: 'client', mrr: 300, active_users_30d: 4 }]]);
  const promises = new Map([['busy', [
    promiseOf(claim('action_item.meeting_1_0', ours({ source_type: 'meeting', title: 'Turn on the valuation feed' })), NOW),
    promiseOf(claim('action_item.email_2', ours({ title: 'Install the quote widget', due_at: '2026-09-01' })), NOW),
  ]]]);
  const { atRisk, active } = classifyCustomers([acct('busy')], health, { hasHealth: true, promises });
  assert.deepEqual(atRisk, []);
  const row = active[0];
  assert.ok(!row.riskReasons.some(r => r.kind === 'owed' || r.kind === 'promised'));
  assert.deepEqual(row.promisedReasons.map(r => r.text), ['Install the quote widget', 'Turn on the valuation feed']);
  assert.equal(row.promisedTotal, 2);
});

test('with no promises the lists are exactly what they were', () => {
  const health = new Map([['dead', { status: 'client', mrr: 300, active_users_30d: 0 }]]);
  const a = [{ companyId: 'dead', wonDeals: 1, daysQuiet: 5, reasons: [], products: [] }];
  const without = classifyCustomers(a, health, { hasHealth: true });
  const empty = classifyCustomers(a, health, { hasHealth: true, promises: new Map() });
  assert.deepEqual(without.atRisk.map(r => r.companyId), empty.atRisk.map(r => r.companyId));
  assert.deepEqual(without.active[0].promisedReasons, []);
});

test('the trend is today minus about a month ago, and only when a month ago exists', () => {
  const day = (n) => new Date(NOW - n * DAY).toISOString().slice(0, 10);
  assert.equal(activeUsersTrend(14, [{ captured_on: day(30), value: 20 }], NOW), -6);
  assert.equal(activeUsersTrend(14, [{ captured_on: day(28), value: 10 }, { captured_on: day(31), value: 11 }], NOW), 3, 'nearest to 30 days wins');
  assert.equal(activeUsersTrend(14, [{ captured_on: day(29), value: 10 }, { captured_on: day(31), value: 12 }], NOW), 2, 'a tie goes to the older one');
  assert.equal(activeUsersTrend(14, [{ captured_on: day(3), value: 20 }], NOW), null, 'last week is not last month');
  assert.equal(activeUsersTrend(14, [], NOW), null);
  // No figure today is not "nobody": num(null) is 0 and must not produce a fall to zero.
  assert.equal(activeUsersTrend(null, [{ captured_on: day(30), value: 20 }], NOW), null);
  assert.equal(activeUsersTrend(5, [{ captured_on: day(30), value: null }], NOW), null);
  assert.equal(activeUsersTrend('7', [{ captured_on: day(30), value: '7' }], NOW), 0);
  const w = trendWindow(NOW);
  assert.ok(w.fromDay <= day(30) && day(30) <= w.toDay);
});

test('a renewal that has passed is not a renewal; today still is', () => {
  assert.equal(upcomingRenewal({ renewal_date: '2026-10-28' }, NOW), '2026-10-28');
  assert.equal(upcomingRenewal({ renewal_date: '2026-10-02' }, NOW), '2026-10-02');
  assert.equal(upcomingRenewal({ renewal_date: '2026-09-28' }, NOW), null);
  assert.equal(upcomingRenewal({ renewal_date: '' }, NOW), null, "'' is a cleared date");
  assert.equal(upcomingRenewal({}, NOW), null);
  assert.equal(renewsWithin('2026-11-30', 60, NOW), true);
  assert.equal(renewsWithin('2026-12-02', 60, NOW), false);
  assert.equal(renewsWithin(null, 60, NOW), false);
});
