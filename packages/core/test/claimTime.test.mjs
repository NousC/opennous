// Claims know when they were said, age by what they are, and the current position reads first
// (GET-770). Found on the Acme call of 2026-10-07: a Sep 29 "needs this turnaround for another
// couple of months" stayed live and `fresh` after Dana said they were ready to take it to the
// other stakeholders, and the chat advised a short pilot on the strength of it.
//
// Run: pnpm --filter @nous/core build && node --test packages/core/test/claimTime.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  halfLifeDays, isTimeBound, noteFreshness, noteDecaysAt, resolveSaidAt,
  orderCurrentFirst, currentPositions, TIME_BOUND_CATEGORIES,
} from '../dist/db/claimTime.js';
import { CLAIM_CATEGORY_KEYS } from '../dist/db/claimCategories.js';

const NOW = Date.parse('2026-10-08T12:00:00Z');
const daysAgo = (n) => new Date(NOW - n * 86_400_000).toISOString();

test('every category has a half-life, and a position ages faster than a standing fact', () => {
  for (const k of CLAIM_CATEGORY_KEYS) assert.ok(halfLifeDays(k) > 0, k);
  assert.ok(halfLifeDays('buying_signal') < halfLifeDays('firmographic'));
  assert.ok(halfLifeDays('timeline') < halfLifeDays('relationship'));
  // An unknown or legacy label still ages, on the general clock.
  assert.equal(halfLifeDays('Pain Points'), halfLifeDays('pain'));
  assert.equal(halfLifeDays('nonsense'), halfLifeDays('general'));
});

test('the time-bound categories are the ones a later statement can replace', () => {
  for (const k of ['buying_signal', 'timeline', 'budget', 'objection', 'goal', 'competitor', 'risk_signal', 'expansion_signal']) {
    assert.ok(isTimeBound(k), k);
  }
  for (const k of ['discovery', 'relationship', 'firmographic', 'proficiency']) assert.ok(!isTimeBound(k), k);
  for (const k of TIME_BOUND_CATEGORIES) assert.ok(CLAIM_CATEGORY_KEYS.includes(k), `${k} is a real category`);
});

test('freshness is read from when it was SAID and what it is, not stamped once at write', () => {
  // Nine days old: still fresh for a standing fact, already aging for a buying signal.
  assert.equal(noteFreshness('firmographic', daysAgo(9), NOW), 'fresh');
  assert.equal(noteFreshness('buying_signal', daysAgo(9), NOW), 'fresh');
  assert.equal(noteFreshness('buying_signal', daysAgo(20), NOW), 'aging');
  assert.equal(noteFreshness('buying_signal', daysAgo(400), NOW), 'expired');
  assert.equal(noteFreshness('relationship', daysAgo(200), NOW), 'fresh');
  // No date at all reads as unknown age, never as fresh.
  assert.equal(noteFreshness('goal', null, NOW), 'suspect');
});

test('decays_at is when a fact stops being something to act on', () => {
  const said = '2026-09-29T15:00:00.000Z';
  const at = Date.parse(noteDecaysAt('goal', said));
  assert.equal(at, Date.parse(said) + 2 * halfLifeDays('goal') * 86_400_000);
});

test('said-at: the source date when it is real, now when it is missing, junk or in the future', () => {
  assert.equal(resolveSaidAt('2026-09-29T15:00:00Z', NOW), '2026-09-29T15:00:00.000Z');
  assert.equal(resolveSaidAt(null, NOW), new Date(NOW).toISOString());
  assert.equal(resolveSaidAt('not a date', NOW), new Date(NOW).toISOString());
  assert.equal(resolveSaidAt('2027-01-01T00:00:00Z', NOW), new Date(NOW).toISOString());
  // A clock a few minutes ahead is not the future.
  assert.equal(resolveSaidAt(new Date(NOW + 60_000).toISOString(), NOW), new Date(NOW + 60_000).toISOString());
});

const fact = (category, content, date) => ({ category, content, date });

test('the current position comes first: fresh before stale, newest first within a tier', () => {
  const facts = [
    fact('firmographic', 'Acme has ~400 live customers.', daysAgo(30)),
    fact('goal', 'Needs the turnaround for another couple of months.', daysAgo(9)),
    fact('buying_signal', 'Wants to present it to the other stakeholders.', daysAgo(1)),
    fact('buying_signal', 'Asked for the DPA.', daysAgo(60)),
  ];
  const ordered = orderCurrentFirst(facts, NOW).map(f => f.content);
  assert.equal(ordered[0], 'Wants to present it to the other stakeholders.');
  assert.equal(ordered.at(-1), 'Asked for the DPA.');
});

test('current positions: the newest live fact per time-bound category, nothing expired, nothing standing', () => {
  const facts = [
    fact('buying_signal', 'Wants to present it to the other stakeholders.', daysAgo(1)),
    fact('buying_signal', 'Asked for the DPA.', daysAgo(24)),
    fact('goal', 'Wants the Slack stats pushed daily.', daysAgo(1)),
    fact('timeline', 'Evaluating this quarter.', daysAgo(400)),
    fact('discovery', 'Found us on Hacker News.', daysAgo(2)),
  ];
  const pos = currentPositions(facts, NOW);
  assert.deepEqual(pos.map(f => f.content).sort(), [
    'Wants the Slack stats pushed daily.',
    'Wants to present it to the other stakeholders.',
  ]);
});

// ── When it happened (GET-1051) ────────────────────────────────────────────────────────────

test('occurredLabel: a day, a period, an open bound; nothing for a state or an undated event', async () => {
  const { occurredLabel } = await import('../dist/db/claimTime.js');
  assert.equal(occurredLabel({ fact_kind: 'event', occurred_start: '2026-03-14', occurred_end: '2026-03-14' }), '2026-03-14');
  assert.equal(occurredLabel({ fact_kind: 'event', occurred_start: '2026-03-01', occurred_end: '2026-03-31' }), '2026-03-01 to 2026-03-31');
  assert.equal(occurredLabel({ fact_kind: 'event', occurred_start: '2024-01-01' }), 'from 2024-01-01');
  assert.equal(occurredLabel({ fact_kind: 'event', occurred_end: '2026-12-31' }), 'until 2026-12-31');
  assert.equal(occurredLabel({ occurred_start: '2026-03-01', occurred_end: '2026-03-31' }), '2026-03-01 to 2026-03-31', 'written before fact_kind existed');
  assert.equal(occurredLabel({ fact_kind: 'state', occurred_start: '2026-03-01' }), undefined);
  assert.equal(occurredLabel({ fact_kind: 'event' }), undefined);
  assert.equal(occurredLabel({ fact_kind: 'event', occurred_start: 'March' }), undefined);
  assert.equal(occurredLabel(null), undefined);
});
