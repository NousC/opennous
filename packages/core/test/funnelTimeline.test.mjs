// Funnel timeline — rebuilding the stage ladder from interaction history.
//
// This is the piece that makes timing data available WITHOUT a backfill. The stage
// observations are lossy (pre-fix rows carry write time; backfilled activity writes no
// transition at all; stageDerivation only ever emits the current top rung), but the
// interactions themselves have always carried the provider's real event time. Replaying
// them chronologically recovers the ladder.
//
// Run: pnpm --filter @nous/core build && node --test packages/core/test/funnelTimeline.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reconstructLadder, stageOccupancies, kaplanMeierMedian, timeToWinRows } from '../dist/services/funnelTimeline.js';

const NOW = Date.parse('2026-08-30T12:00:00.000Z');
const DAY = 86_400_000;
const daysAgo = (n) => new Date(NOW - n * DAY).toISOString();
const daysAhead = (n) => new Date(NOW + n * DAY).toISOString();

const act = (type, at, raw = {}) => ({ property: `interaction.${type}`, observed_at: at, raw });
const ladder = (acts) => reconstructLadder(acts, { now: NOW });

test('a full journey rebuilds as a ladder, not a single snapshot', () => {
  // The exact case stageDerivation collapses: four rungs over five months become ONE
  // observation at the top rung, so every duration downstream reads as zero.
  const hops = ladder([
    act('linkedin_connected', daysAgo(150)),
    act('email_received', daysAgo(120), { reply_signal: 'positive' }),
    act('meeting_scheduled', daysAgo(90)),
    act('meeting_held', daysAgo(85)),
  ]);
  assert.deepEqual(hops.map(h => h.stage), ['connected', 'interested', 'meeting_booked', 'discovery']);
  assert.deepEqual(hops.map(h => h.at), [daysAgo(150), daysAgo(120), daysAgo(90), daysAgo(85)]);
});

test('ingest order does not matter — the SAME ladder comes back reversed or shuffled', () => {
  // The property that makes this immune to the newest-first provider ordering: the
  // reconstruction sorts on the events' own timestamps, so write order is irrelevant.
  const acts = [
    act('linkedin_connected', daysAgo(150)),
    act('email_received', daysAgo(120), { reply_signal: 'positive' }),
    act('meeting_scheduled', daysAgo(90)),
    act('meeting_held', daysAgo(85)),
  ];
  const forward = ladder(acts);
  const reversed = ladder([...acts].reverse());
  const shuffled = ladder([acts[2], acts[0], acts[3], acts[1]]);
  assert.deepEqual(reversed, forward);
  assert.deepEqual(shuffled, forward);
});

test('advance-only — a later low-rung touch never demotes', () => {
  const hops = ladder([
    act('meeting_held', daysAgo(60)),
    act('email_opened', daysAgo(10)),      // would map to 'connected'
  ]);
  assert.deepEqual(hops.map(h => h.stage), ['discovery']);
});

test('a terminal exit closes the ladder and nothing after it counts', () => {
  const hops = ladder([
    act('meeting_held', daysAgo(60)),
    act('deal_lost', daysAgo(30)),
    act('email_opened', daysAgo(5)),
  ]);
  assert.deepEqual(hops.map(h => h.stage), ['discovery', 'closed_lost']);
});

test('a win is captured as a hop with its real date', () => {
  const hops = ladder([
    act('meeting_held', daysAgo(90)),
    act('payment_received', daysAgo(20)),
  ]);
  assert.deepEqual(hops.map(h => h.stage), ['discovery', 'closed_won']);
  assert.equal(hops[1].at, daysAgo(20));
});

test('outbound noise never creates rungs', () => {
  // An outbound LinkedIn message is us talking to ourselves. A bounce and an auto-reply
  // are the opposite of engagement. None of them is a funnel position.
  const hops = ladder([
    act('linkedin_message', daysAgo(40), { is_outbound: true }),
    act('email_received', daysAgo(30), { reply_signal: 'bounce' }),
    act('email_received', daysAgo(20), { reply_signal: 'auto_reply' }),
  ]);
  assert.deepEqual(hops, []);
});

test('an opt-out reply lands as a disqualified exit', () => {
  const hops = ladder([act('email_received', daysAgo(10), { reply_signal: 'unsubscribe' })]);
  assert.deepEqual(hops.map(h => h.stage), ['disqualified']);
});

test('a future-dated booking is clamped and stays in sequence', () => {
  // observed_at on a booking is the meeting START. Sorting on the raw value would shove
  // it past everything else; clamping first keeps it where it belongs.
  const hops = ladder([
    act('linkedin_connected', daysAgo(20)),
    act('meeting_scheduled', daysAhead(7)),
  ]);
  assert.deepEqual(hops.map(h => h.stage), ['connected', 'meeting_booked']);
  assert.ok(Date.parse(hops[1].at) <= NOW, 'booking hop was future-dated');
});

test('no qualifying activity returns an empty ladder, not a phantom rung', () => {
  assert.deepEqual(ladder([]), []);
  assert.deepEqual(ladder([act('email_sent', daysAgo(5))]), []);
});

// ── occupancies: the censoring fix ───────────────────────────────────────────

test('time-in-stage is measured between hops', () => {
  const occ = stageOccupancies(ladder([
    act('linkedin_connected', daysAgo(100)),
    act('email_received', daysAgo(70), { reply_signal: 'positive' }),
    act('meeting_held', daysAgo(40)),
  ]), { now: NOW });
  assert.equal(occ[0].stage, 'connected');
  assert.equal(Math.round(occ[0].days), 30);
  assert.equal(occ[1].stage, 'interested');
  assert.equal(Math.round(occ[1].days), 30);
});

test('the still-open rung IS emitted, flagged censored — the bias being fixed', () => {
  // /v2/pipeline/intelligence drops this row entirely (its loop runs i < len-1), which is
  // why its medians read low: the deals stuck longest are the ones still sitting there.
  const occ = stageOccupancies(ladder([
    act('linkedin_connected', daysAgo(100)),
    act('meeting_held', daysAgo(40)),
  ]), { now: NOW });
  const open = occ.find(o => o.censored);
  assert.ok(open, 'the open occupancy was dropped');
  assert.equal(open.stage, 'discovery');
  assert.equal(Math.round(open.days), 40);
});

test('a closed deal has no censored row — nothing is spent in a terminal', () => {
  const occ = stageOccupancies(ladder([
    act('meeting_held', daysAgo(60)),
    act('deal_won', daysAgo(10)),
  ]), { now: NOW });
  assert.equal(occ.length, 1);
  assert.equal(occ[0].stage, 'discovery');
  assert.equal(occ[0].censored, false);
  assert.equal(Math.round(occ[0].days), 50);
});

test('censored durations are never negative — the survival invariant', () => {
  for (const n of [0, 1, 30, 365]) {
    const occ = stageOccupancies(ladder([act('meeting_held', daysAgo(n))]), { now: NOW });
    for (const o of occ) assert.ok(o.days >= 0, `negative duration at ${n} days`);
  }
});

// ── Kaplan-Meier median: the censoring correction ────────────────────────────

test('with no still-open deals it matches the ordinary median', () => {
  const rows = [10, 20, 30, 40, 50].map(days => ({ days, censored: false }));
  assert.equal(kaplanMeierMedian(rows), 30);
});

test('still-open deals push the median UP, they do not vanish', () => {
  // Three closed fast, two still running long. The naive median over closed-only says 20.
  // The truth is slower than that, because the two long ones have not finished yet.
  const closedOnly = [
    { days: 10, censored: false },
    { days: 20, censored: false },
    { days: 30, censored: false },
  ];
  const withOpen = [
    ...closedOnly,
    { days: 200, censored: true },
    { days: 220, censored: true },
  ];
  const naive = kaplanMeierMedian(closedOnly);
  const corrected = kaplanMeierMedian(withOpen);
  assert.equal(naive, 20);
  assert.ok(corrected === null || corrected >= naive,
    `censoring lowered the median: ${corrected} < ${naive}`);
});

test('a mostly-open pipeline returns null instead of inventing a number', () => {
  // One deal closed in 5 days, nine still running. Reporting "5 days" would be a lie built
  // from a single data point. Null says "we cannot tell yet", which is the truth.
  const rows = [
    { days: 5, censored: false },
    ...Array.from({ length: 9 }, (_, i) => ({ days: 100 + i, censored: true })),
  ];
  assert.equal(kaplanMeierMedian(rows), null);
});

test('empty input returns null', () => {
  assert.equal(kaplanMeierMedian([]), null);
  assert.equal(kaplanMeierMedian(null), null);
});

test('all-open returns null — nothing has finished, so nothing is known', () => {
  const rows = [1, 2, 3].map(days => ({ days, censored: true }));
  assert.equal(kaplanMeierMedian(rows), null);
});

test('negative or junk durations are ignored rather than skewing the curve', () => {
  const rows = [
    { days: -5, censored: false },
    { days: NaN, censored: false },
    { days: 10, censored: false },
    { days: 20, censored: false },
    { days: 30, censored: false },
  ];
  assert.equal(kaplanMeierMedian(rows), 20);
});

test('end to end: reconstruct, measure, and take a censored median', () => {
  // Two accounts closed out of discovery quickly, one is still sitting there after months.
  const closedFast = (exitDays) => stageOccupancies(
    ladder([act('meeting_held', daysAgo(exitDays + 10)), act('deal_won', daysAgo(10))]),
    { now: NOW },
  );
  const stuck = stageOccupancies(ladder([act('meeting_held', daysAgo(200))]), { now: NOW });
  const rows = [...closedFast(20), ...closedFast(30), ...stuck]
    .filter(o => o.stage === 'discovery');
  assert.equal(rows.filter(r => r.censored).length, 1, 'the stuck account was dropped');
  const med = kaplanMeierMedian(rows);
  assert.ok(med === null || med >= 20, `median ignored the stuck account: ${med}`);
});

// ── time to win: the forecast's timing input ─────────────────────────────────

test('a won account yields a real duration from every rung it passed', () => {
  const rows = timeToWinRows(ladder([
    act('linkedin_connected', daysAgo(100)),
    act('meeting_held', daysAgo(60)),
    act('deal_won', daysAgo(10)),
  ]), { now: NOW });
  const byStage = Object.fromEntries(rows.map(r => [r.stage, r]));
  assert.equal(Math.round(byStage.connected.days), 90);
  assert.equal(Math.round(byStage.discovery.days), 50);
  assert.ok(rows.every(r => !r.censored), 'a win should not be censored');
});

test('a still-open account is censored at today, not dropped', () => {
  const rows = timeToWinRows(ladder([act('meeting_held', daysAgo(45))]), { now: NOW });
  assert.equal(rows.length, 1);
  assert.equal(Math.round(rows[0].days), 45);
  assert.equal(rows[0].censored, true);
});

test('a LOST account is censored at the loss, not counted as a win', () => {
  // It was genuinely in the running for 50 days. Dropping it loses that; counting it as a
  // win would be a lie. Censoring says "stopped being observable here", which is the truth.
  const rows = timeToWinRows(ladder([
    act('meeting_held', daysAgo(60)),
    act('deal_lost', daysAgo(10)),
  ]), { now: NOW });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].stage, 'discovery');
  assert.equal(Math.round(rows[0].days), 50);
  assert.equal(rows[0].censored, true, 'a loss must not read as a win');
});

test('closed rungs are endpoints, never rows of their own', () => {
  const rows = timeToWinRows(ladder([
    act('meeting_held', daysAgo(60)),
    act('deal_won', daysAgo(10)),
  ]), { now: NOW });
  assert.ok(!rows.some(r => r.stage === 'closed_won'), 'closed_won became an occupancy');
});

test('an empty ladder yields nothing', () => {
  assert.deepEqual(timeToWinRows([], { now: NOW }), []);
});

test('durations are never negative', () => {
  for (const n of [0, 5, 400]) {
    const rows = timeToWinRows(ladder([act('meeting_held', daysAgo(n))]), { now: NOW });
    for (const r of rows) assert.ok(r.days >= 0, `negative at ${n}`);
  }
});
