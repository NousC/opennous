// Account health factor panel (GET-807): every factor carries the items behind it (the blockers,
// the decision makers, the risks, the weekly conversations), a one-line summary, and a "what would
// improve it" line picked from the data. A blocker said more than 21 days ago with no later
// mention is marked aging.
//
// Run: (cd packages/core && npx tsc) && node --test packages/core/test/accountHealthPanel.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeAccountHealth, claimItems, weeklyConversations, improveFor, AGING_DAYS,
} from '../dist/services/accountHealthScore.mjs';

const DAY = 86_400_000;
const NOW = Date.parse('2026-10-09T12:00:00Z');
const iso = (d) => new Date(NOW + d * DAY).toISOString();
let n = 0;
const note = (category, days, metadata = {}, extra = {}) => ({
  id: `c${++n}`, source: 'signal_extraction', category, metadata, content: `${category} fact ${n}`,
  created_at: iso(days), said_at: iso(days), ...extra,
});
const act = (type, days, contact_id = 'p1') => ({ id: `o${++n}`, activity_type: type, occurred_at: iso(days), contact_id });
const dana = { id: 'p1', name: 'Dana Reyes', title: 'VP Operations', role: null };
const sam = { id: 'p2', name: 'Sam Okafor', title: 'Head of Finance', role: null };
const factor = (h, key) => h.smart.find(f => f.key === key);

// ── Items and the aging rule ────────────────────────────────────────────────

test('aging is three weeks', () => assert.equal(AGING_DAYS, 21));

test('blocker items carry content, quote, speaker, date and status; open first', () => {
  const notes = [
    note('blocker', -2, { status: 'resolved' }),
    note('blocker', -5, { status: 'open', quote: 'Legal has to sign off first', voiced_by_contact_id: 'p1' }, { label: 'Legal sign-off' }),
  ];
  const items = claimItems(notes, { category: 'blocker', stakeholders: [dana], now: NOW, aging: true });
  assert.equal(items.length, 2);
  assert.equal(items[0].status, 'open');
  assert.equal(items[0].label, 'Legal sign-off');
  assert.equal(items[0].quote, 'Legal has to sign off first');
  assert.equal(items[0].speaker, 'Dana Reyes');
  assert.equal(items[0].said_at, iso(-5));
  assert.equal(items[0].aging, false);
  assert.equal(items[1].status, 'resolved');
});

test('an open blocker said more than 21 days ago with no later mention is aging', () => {
  const old = note('blocker', -30, { status: 'open', speaker: 'Sam Okafor' });
  const items = claimItems([old], { category: 'blocker', stakeholders: [], now: NOW, aging: true });
  assert.equal(items[0].aging, true);
  assert.equal(items[0].age_days, 30);
  assert.equal(items[0].speaker, 'Sam Okafor');
});

test('a later mention keeps a blocker fresh: reaffirmed, or the same label said again', () => {
  const reaffirmed = note('blocker', -30, { status: 'open', reaffirmed_at: iso(-4) });
  const a = claimItems([reaffirmed], { category: 'blocker', now: NOW, aging: true });
  assert.equal(a[0].aging, false);
  const first = note('blocker', -40, { status: 'open' }, { label: 'Security review' });
  const again = note('blocker', -3, { status: 'open' }, { label: 'security review' });
  const b = claimItems([first, again], { category: 'blocker', now: NOW, aging: true });
  assert.equal(b.find(i => i.id === first.id).aging, false);
});

test('a resolved blocker is never aging, and risks are not graded for age', () => {
  const resolved = note('blocker', -60, { status: 'resolved' });
  assert.equal(claimItems([resolved], { category: 'blocker', now: NOW, aging: true })[0].aging, false);
  const risk = note('risk_signal', -60, {});
  assert.equal(claimItems([risk], { category: 'risk_signal', now: NOW })[0].aging, false);
});

test('the blockers factor lists its items and says how old the aging one is', () => {
  const notes = [
    note('blocker', -22, { status: 'open' }),
    note('blocker', -3, { status: 'open' }),
    note('blocker', -1, { status: 'open' }),
  ];
  const f = factor(computeAccountHealth({ notes, activity: [act('meeting', -2)], stakeholders: [dana], now: NOW }), 'blockers');
  assert.equal(f.items.length, 3);
  assert.equal(f.summary, '3 open, one is three weeks old');
  assert.equal(f.items.filter(i => i.aging).length, 1);
});

test('decision maker items are the people and roles, with status and quote', () => {
  const notes = [
    note('authority', -5, { role: 'economic_buyer', quote: 'Sam signs anything over budget' }, { entity_id: 'p2' }),
    note('authority', -3, { role: 'decision_maker' }, { entity_id: 'p1' }),
  ];
  const f = factor(computeAccountHealth({ notes, activity: [act('meeting', -2, 'p1')], stakeholders: [dana, sam], now: NOW }), 'decision_makers');
  assert.deepEqual(f.items.map(i => [i.name, i.status]), [['Sam Okafor', 'not_contacted'], ['Dana Reyes', 'engaged']]);
  assert.equal(f.items[0].quote, 'Sam signs anything over budget');
  assert.equal(f.summary, '1 of 2 engaged');
});

// ── Engagement ──────────────────────────────────────────────────────────────

test('weekly conversations: eight weeks, oldest first, this week last', () => {
  const ts = [NOW - DAY, NOW - 2 * DAY, NOW - 8 * DAY, NOW - 50 * DAY, NOW - 70 * DAY];
  assert.deepEqual(weeklyConversations(ts, NOW), [1, 0, 0, 0, 0, 0, 1, 2]);   // day 50 is the eighth week back; day 70 is outside
});

test('engagement carries its detail and the account has no separate numbers row', () => {
  const h = computeAccountHealth({ activity: [act('meeting', -1), act('email_received', -9), act('email_received', -40)], stakeholders: [dana], now: NOW });
  const f = factor(h, 'engagement');
  assert.equal(f.detail.recent, 2);
  assert.equal(f.detail.prior, 1);
  assert.equal(f.detail.meetings, 1);
  assert.equal(f.detail.last_at, iso(-1));
  assert.equal(f.detail.weeks.length, 8);
  assert.equal(f.detail.weeks[7], 1);
  assert.equal(f.stats, undefined);
  assert.deepEqual(h.numeric, []);
});

// ── What would improve it ───────────────────────────────────────────────────

test('blockers: improve names the oldest open blocker', () => {
  const items = claimItems([
    note('blocker', -3, { status: 'open' }, { label: 'Pricing approval' }),
    note('blocker', -25, { status: 'open' }, { label: 'Security review' }),
    note('blocker', -40, { status: 'resolved' }, { label: 'Old thing' }),
  ], { category: 'blocker', now: NOW, aging: true });
  assert.match(improveFor('blockers', { items }), /Security review/);
  assert.equal(improveFor('blockers', { items: [] }), null);
});

test('decision makers: improve names the first unengaged decider, the economic buyer before a champion', () => {
  const items = [
    { name: 'Dana Reyes', title: 'VP Operations', role: 'champion', status: 'not_engaged' },
    { name: null, title: 'CEO', role: 'economic_buyer', status: 'not_contacted', unnamed: true },
  ];
  assert.match(improveFor('decision_makers', { items }), /the CEO/);
  assert.equal(improveFor('decision_makers', { items: [{ name: 'Dana Reyes', role: 'decision_maker', status: 'engaged' }] }), null);
  assert.match(improveFor('decision_makers', { items: [] }), /who signs off/i);
});

test('risks: improve names the newest open risk; engagement: only when it is slipping', () => {
  const items = claimItems([
    note('risk_signal', -20, {}, { label: 'Budget freeze' }),
    note('risk_signal', -2, {}, { label: 'Champion leaving' }),
  ], { category: 'risk_signal', now: NOW });
  assert.match(improveFor('risk_signals', { items }), /Champion leaving/);
  assert.equal(improveFor('engagement', { trend: 'rising', daysQuiet: 1 }), null);
  assert.match(improveFor('engagement', { trend: 'cold', daysQuiet: 70 }), /70 days ago/);
});
