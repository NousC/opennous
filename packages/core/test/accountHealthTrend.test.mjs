// Account health trend and fixes (GET-804): engagement counts both 30-day windows from the same
// sources, a factor's meter follows its grade, past dates are scored from what was true then, the
// trend series merges backfilled points with stored daily snapshots, and the next step is the
// latest follow-up agreed in two weeks across every conversation.
//
// Run: (cd packages/core && npx tsc) && node --test packages/core/test/accountHealthTrend.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeAccountHealth, selectNextStep, engagementWindows, isTwoWayTouch, gradeMeter, GRADE_METER,
} from '../dist/services/accountHealthScore.mjs';
import {
  claimValidAt, accountHealthAsOf, backfillAccountHealth, buildHealthSeries, snapshotPoint, snapshotObservation, hasHistory,
} from '../dist/services/accountHealthHistory.mjs';

const DAY = 86_400_000;
const NOW = Date.parse('2026-10-09T12:00:00Z');
const iso = (d) => new Date(NOW + d * DAY).toISOString();
let n = 0;
const act = (type, days, contact_id = 'p1', extra = {}) => ({ id: `o${++n}`, activity_type: type, occurred_at: iso(days), contact_id, ...extra });
const note = (category, validDays, extra = {}) => ({
  id: `c${++n}`, source: 'signal_extraction', category, metadata: {}, content: `${category} fact`,
  created_at: iso(validDays), said_at: iso(validDays), invalid_at: null, ...extra,
});
const dana = { id: 'p1', name: 'Dana Reyes', title: 'VP Operations', role: null };

// ── Engagement windows ──────────────────────────────────────────────────────

test('both windows count meetings, calls and email either way on a conversation', () => {
  const activity = [
    act('email_received', -2), act('email_sent', -3), act('meeting_held', -10), act('call_made', -20),
    // The 30 before: a call and a thread, which GET-800 reported as 0.
    act('call_made', -35), act('email_sent', -40), act('email_received', -41), act('meeting_held', -50),
    // Never touches: a booking, a missed call, a bounce, an automated welcome.
    act('meeting_scheduled', -4), act('call_missed', -5), act('email_bounced', -36), act('welcome_email_sent', -45),
    // Outside both windows.
    act('email_received', -70),
  ];
  const w = engagementWindows({ activity, now: NOW });
  assert.equal(w.recent, 4);
  assert.equal(w.prior, 4);
  assert.equal(w.last_at, iso(-2));
});

test('a call page counts as a call, once, beside its own meeting row', () => {
  const activity = [act('meeting_held', -33, 'p1')];
  const calls = [
    { id: 'd1', title: 'Discovery', occurred_at: new Date(NOW - 33 * DAY + 3_600_000).toISOString() },   // the same call
    { id: 'd2', title: 'Review', occurred_at: iso(-45) },                                                 // a call with no row
  ];
  const w = engagementWindows({ activity, calls, now: NOW });
  assert.equal(w.prior, 2, 'the meeting row and the review page; the discovery page is the same call as the row');
  assert.equal(w.recent, 0);
});

test('our own email is not engagement until they have replied or met with us', () => {
  assert.equal(isTwoWayTouch('email_sent', { conversational: false }), false);
  assert.equal(isTwoWayTouch('email_sent', { conversational: true }), true);
  const cold = engagementWindows({ activity: [act('email_sent', -2), act('email_sent', -9)], now: NOW });
  assert.equal(cold.recent, 0, 'a cold sequence is not a conversation');
  const h = computeAccountHealth({ activity: [act('email_sent', -2)], now: NOW });
  assert.equal(h.smart.find(f => f.key === 'engagement').tone, 'unknown');
});

test('engagement verdict says the trend in plain words with both counts', () => {
  const activity = [
    ...Array.from({ length: 12 }, (_, i) => act('email_received', -(i + 1))),
    ...Array.from({ length: 3 }, (_, i) => act('meeting_held', -(35 + i))),
  ];
  const f = computeAccountHealth({ activity, stakeholders: [dana], now: NOW }).smart.find(x => x.key === 'engagement');
  assert.equal(f.level, 'Rising');
  assert.equal(f.verdict, 'Engagement is rising: 12 two-way touches in the last 30 days, up from 3');
  // The numbers moved into the Engagement panel's detail (GET-807).
  assert.deepEqual([f.detail.recent, f.detail.prior, f.detail.meetings], [12, 3, 3]);
});

// ── Grade → meter ───────────────────────────────────────────────────────────

test('a factor\'s meter follows its grade: good green, warn amber, bad red, unknown grey', () => {
  assert.deepEqual(gradeMeter('good'), { bars: 3, color: '#2E7A4E' });
  assert.deepEqual(gradeMeter('warn'), { bars: 2, color: '#C08A3E' });
  assert.deepEqual(gradeMeter('bad'), { bars: 1, color: '#B0412E' });
  assert.deepEqual(gradeMeter('unknown'), { bars: 0, color: '#A9A8A2' });
  assert.deepEqual(gradeMeter('nonsense'), GRADE_METER.unknown);
  // "Rising" matched no meter word in GET-800 and drew three grey bars.
  const h = computeAccountHealth({ activity: [act('email_received', -2), act('meeting_held', -5)], now: NOW });
  const eng = h.smart.find(f => f.key === 'engagement');
  assert.equal(eng.level, 'Rising');
  assert.deepEqual(eng.meter, { bars: 3, color: '#2E7A4E' });
  for (const f of h.smart) assert.deepEqual(f.meter, gradeMeter(f.tone), f.key);
});

// ── Point-in-time scoring ───────────────────────────────────────────────────

test('a claim counts on a date only while it was valid', () => {
  const at = NOW - 20 * DAY;
  assert.equal(claimValidAt(note('blocker', -30), at), true);
  assert.equal(claimValidAt(note('blocker', -30, { invalid_at: iso(-25) }), at), false, 'retired before the date');
  assert.equal(claimValidAt(note('blocker', -10), at), false, 'created after the date');
  assert.equal(claimValidAt(note('blocker', -30, { invalid_at: iso(-5) }), at), true, 'retired after the date');
});

test('scoring as of a past date sees only that date\'s activity and claims', () => {
  const activity = [act('meeting_held', -40), act('email_received', -22)];
  const notes = [
    note('blocker', -35, { invalid_at: iso(-25) }),   // retired before day -20: excluded
    note('risk_signal', -10),                          // raised after day -20: excluded
    note('risk_signal', -30),                          // valid then: counts
  ];
  const then = accountHealthAsOf({ notes, activity, stakeholders: [dana], at: NOW - 20 * DAY });
  assert.equal(then.smart.find(f => f.key === 'blockers').value, '0 open');
  assert.equal(then.smart.find(f => f.key === 'risk_signals').value, '1 open');
  assert.equal(then.smart.find(f => f.key === 'engagement').reason.startsWith('2 two-way touches in the last 30 days'), true);
  const today = accountHealthAsOf({ notes, activity, stakeholders: [dana], at: NOW });
  assert.equal(today.smart.find(f => f.key === 'risk_signals').value, '2 open');
  assert.equal(accountHealthAsOf({ notes, activity, at: NOW - 59 * DAY }), null, 'nothing on record yet');
});

test('the backfill is weekly over 60 days, oldest first, and skips dates with nothing on record', () => {
  const activity = [act('meeting_held', -40), act('email_received', -12)];
  const pts = backfillAccountHealth({ activity, stakeholders: [dana], now: NOW, days: 60 });
  // Weekly points at -56 … -7; the first two predate the first meeting.
  assert.deepEqual(pts.map(p => Math.round((Date.parse(p.at) - NOW) / DAY)), [-35, -28, -21, -14, -7]);
  assert.ok(pts.every(p => p.source === 'backfill' && Number.isFinite(p.score) && p.label));
});

// ── Series ──────────────────────────────────────────────────────────────────

test('series merges backfill and snapshots by day: the snapshot wins its day, live wins today', () => {
  const backfill = [
    { at: iso(-14), score: 55, label: 'Needs attention', source: 'backfill' },
    { at: iso(-7), score: 60, label: 'Needs attention', source: 'backfill' },
  ];
  const snapshots = [
    snapshotPoint({ observed_at: new Date(NOW - 7 * DAY + 3_600_000).toISOString(), value: { score: 64, label: 'Needs attention' } }),
    snapshotPoint({ observed_at: iso(-1), value: { score: 70, label: 'Healthy' } }),
    snapshotPoint({ observed_at: new Date(NOW - 3_600_000).toISOString(), value: { score: 71, label: 'Healthy' } }),
    snapshotPoint({ observed_at: iso(-2), value: { nothing: true } }),
  ];
  const series = buildHealthSeries({ backfill, snapshots, current: { score: 72, label: 'Healthy' }, now: NOW });
  assert.deepEqual(series.map(p => [Math.round((Date.parse(p.at) - NOW) / DAY), p.score, p.source]), [
    [-14, 55, 'backfill'], [-7, 64, 'snapshot'], [-1, 70, 'snapshot'], [0, 72, 'live'],
  ]);
  assert.equal(hasHistory(series, NOW), true);
  assert.equal(hasHistory(buildHealthSeries({ current: { score: 72 }, now: NOW }), NOW), false, 'only today: the first score');
});

test('the daily snapshot is a dated state observation keyed by the day', () => {
  const h = computeAccountHealth({ activity: [act('email_received', -2)], now: NOW });
  const o = snapshotObservation('ws1', 'acme', h, NOW);
  assert.equal(o.kind, 'state');
  assert.equal(o.property, 'account_health_score');
  assert.equal(o.entityId, 'acme');
  assert.equal(o.externalId, 'account_health_score:acme:2026-10-09');
  assert.equal(o.value.score, h.score);
  assert.equal(o.value.label, h.band);
  assert.deepEqual(o.value.factors.map(f => f.key), ['engagement', 'decision_makers', 'blockers', 'risk_signals']);
  assert.equal(snapshotObservation('ws1', 'acme', null, NOW), null);
});

// ── Next step ───────────────────────────────────────────────────────────────

test('a call two days ago with a follow-up beats a newer email that agreed nothing', () => {
  const call = act('meeting_held', -2, 'p1', { summary: 'Pricing call' });
  const email = act('email_received', -1, 'p1', { summary: 'Thanks for the time' });
  const step = selectNextStep({
    activity: [call, email],
    nextSteps: [{ title: 'Send the revised proposal', status: 'open', occurred_at: call.occurred_at, due_at: iso(1), source_observation_id: call.id }],
    now: NOW,
  });
  assert.equal(step.status, 'agreed');
  assert.equal(step.title, 'Send the revised proposal');
  assert.equal(step.agreed_at, call.occurred_at);
  assert.equal(step.conversation.kind, 'meeting');
  assert.equal(step.due_at, iso(1));
});

test('the latest agreed follow-up wins across calls, call pages and emails', () => {
  const email = act('email_received', -3, 'p1');
  const step = selectNextStep({
    activity: [act('meeting_held', -9), email],
    calls: [{ id: 'd1', title: 'Weekly sync', occurred_at: iso(-6) }],
    nextSteps: [
      { title: 'Share the rollout plan', status: 'open', occurred_at: iso(-9), due_at: iso(2) },
      { title: 'Confirm the pilot seats', status: 'open', occurred_at: iso(-3), due_at: iso(4), source_observation_id: email.id },
      { title: 'Intro the security lead', status: 'open', occurred_at: iso(-6), due_at: null },
      { title: 'Done already', status: 'done', occurred_at: iso(-1), due_at: null },
    ],
    now: NOW,
  });
  assert.equal(step.title, 'Confirm the pilot seats', 'agreed in the email three days ago, the most recent');
  assert.equal(step.conversation.kind, 'email');
  assert.deepEqual(step.items, ['Confirm the pilot seats']);
});

test('no follow-up agreed in fourteen days: says so, never a stale task', () => {
  const step = selectNextStep({
    activity: [act('meeting_held', -3)],
    nextSteps: [{ title: 'Send the pricing sheet', status: 'open', occurred_at: iso(-20), due_at: iso(3) }],
    now: NOW,
  });
  assert.equal(step.status, 'none');
  assert.equal(step.reason, 'No next step agreed in the last two weeks');
  assert.equal(step.title, null);
});
