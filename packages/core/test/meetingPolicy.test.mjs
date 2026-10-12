// How much of the pipeline a meeting is worth, decided by its age.
//
// The expensive mistake this guards against is silent: a meeting wrongly judged old loses its
// health read, its commitments and its page, and nothing anywhere says so. A meeting wrongly
// judged new costs a few cents. So every ambiguous case here must fall on the LIVE side.
//
// Run: node --test packages/core/test/meetingPolicy.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { meetingTreatment, writesCallArtifacts, ARCHIVAL_AFTER_DAYS } from '../dist/services/meetingPolicy.js';
import { HEALTH_WINDOW_DAYS } from '../dist/services/accountHealthState.js';

const DAY = 86_400_000;
const NOW = Date.parse('2026-09-18T12:00:00Z');
const ago = (d) => new Date(NOW - d * DAY).toISOString();

test('the cut is derived from the health windows, not chosen', () => {
  // If someone widens a health window and this stays put, we start dropping reads that would have
  // counted. Tying them together is what stops that being a silent regression.
  assert.equal(ARCHIVAL_AFTER_DAYS, Math.max(...Object.values(HEALTH_WINDOW_DAYS)));
  assert.equal(ARCHIVAL_AFTER_DAYS, 180);
});

test('a recent meeting gets everything', () => {
  assert.equal(meetingTreatment(ago(1), NOW), 'live');
  assert.equal(meetingTreatment(ago(120), NOW), 'live');
  assert.ok(writesCallArtifacts(ago(30), NOW));
});

test('a meeting past every health window is history', () => {
  // At 181 days even the widest signal — adoption, at 180 — would be filtered for age by
  // deriveAccountHealth the moment it was written.
  assert.equal(meetingTreatment(ago(181), NOW), 'archival');
  assert.equal(meetingTreatment(ago(365), NOW), 'archival');
  assert.equal(writesCallArtifacts(ago(300), NOW), false);
});

test('the boundary itself is live', () => {
  // Exactly 180 days old is still inside the adoption window. Strictly greater-than, so the
  // boundary case keeps its read rather than losing it to an off-by-one.
  assert.equal(meetingTreatment(ago(ARCHIVAL_AFTER_DAYS), NOW), 'live');
  assert.equal(meetingTreatment(new Date(NOW - ARCHIVAL_AFTER_DAYS * DAY - 1000), NOW), 'archival');
});

test('an unreadable date is live, never archival', () => {
  // The whole point: guessing "old" fails invisibly, guessing "new" costs cents. Every one of
  // these must land on the expensive side.
  for (const bad of [null, undefined, '', 'not a date', 'yesterday', NaN, {}]) {
    assert.equal(meetingTreatment(bad, NOW), 'live', `${String(bad)} should be treated as live`);
  }
});

test('a meeting dated in the future is a calendar artefact, not history', () => {
  assert.equal(meetingTreatment(new Date(NOW + 30 * DAY), NOW), 'live');
});

test('it accepts a Date as readily as a string', () => {
  assert.equal(meetingTreatment(new Date(NOW - 300 * DAY), NOW), 'archival');
  assert.equal(meetingTreatment(new Date(NOW - 10 * DAY), NOW), 'live');
});

test('the same meeting becomes archival on its own schedule', () => {
  // The rule is about age, so nobody has to maintain a date for it to keep applying correctly.
  const meeting = ago(100);
  assert.equal(meetingTreatment(meeting, NOW), 'live');
  assert.equal(meetingTreatment(meeting, NOW + 100 * DAY), 'archival');
});

// ── The summary window (30d) is a separate, tighter cut than the archival one ────
//
// The ruling, 2026-09-18: a backfill of the last 12 months gets no summary report; only the
// last 30 days do.
//
// Two cuts because they answer different questions. A summary is read by a person, and a person
// does not read last March. A health read feeds the account's standing, and a risk raised ninety
// days ago is still inside its own 120-day window — still live, still worth acting on.

test('only the last thirty days earn a summary', async () => {
  const { writesCallSummary, SUMMARY_AFTER_DAYS } = await import('../dist/services/meetingPolicy.js');
  assert.equal(SUMMARY_AFTER_DAYS, 30);
  assert.equal(writesCallSummary(ago(1), NOW), true);
  assert.equal(writesCallSummary(ago(30), NOW), true, 'the boundary keeps its summary');
  assert.equal(writesCallSummary(ago(31), NOW), false);
  assert.equal(writesCallSummary(ago(300), NOW), false);
});

test('the two windows are independent, and the middle band is the point', async () => {
  const { writesCallSummary } = await import('../dist/services/meetingPolicy.js');
  // 90 days: no summary anyone would read, but the health read still runs — its risks are inside
  // their own 120-day window, so they are live on the account today.
  assert.equal(writesCallSummary(ago(90), NOW), false, 'no summary');
  assert.equal(writesCallArtifacts(ago(90), NOW), true, 'but the health read, and its commitments, still run');
  // 300 days: neither.
  assert.equal(writesCallSummary(ago(300), NOW), false);
  assert.equal(writesCallArtifacts(ago(300), NOW), false);
});

test('an unreadable date writes the summary rather than silently dropping it', async () => {
  const { writesCallSummary } = await import('../dist/services/meetingPolicy.js');
  for (const bad of [null, undefined, '', 'not a date', NaN]) {
    assert.equal(writesCallSummary(bad, NOW), true, String(bad));
  }
  assert.equal(writesCallSummary(new Date(NOW + 5 * 86_400_000), NOW), true, 'a future date is not history');
});
