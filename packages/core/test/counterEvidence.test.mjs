// Counter-evidence detectors — the half of the trust layer that must not lie.
//
// A detector that misses something is a weaker answer. A detector that FIRES WRONGLY puts a
// confident, cited, false statement in the "evidence against" column — which is worse than
// having no column at all, because the whole feature's value is that the against column can
// be believed. So most of these tests are about the cases where a detector must STAY SILENT.
//
// Run: pnpm --filter @nous/core build && node --test packages/core/test/counterEvidence.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectSignals, assessSufficiency } from '../dist/counterEvidence.js';

const NOW = Date.parse('2026-09-11T12:00:00Z');
const daysAgo = (n) => new Date(NOW - n * 86400000).toISOString();

// Rows arrive newest-first, the way the query orders them.
const rows = (...list) => list.sort((a, b) => (a.observed_at < b.observed_at ? 1 : -1));
const obs = (property, value, dayAgo, extra = {}) => ({
  id: `${property}-${dayAgo}`,
  property,
  value,
  source: 'hubspot',
  observed_at: daysAgo(dayAgo),
  source_ref: null,
  ...extra,
});

const find = (sigs, key) => sigs.find(s => s.key === key) ?? null;

test('a close date pushed out repeatedly is counter-evidence, and counts the moves', () => {
  const sigs = detectSignals(rows(
    obs('close_date', '2026-09-15', 40),
    obs('close_date', '2026-10-15', 20),
    obs('close_date', '2026-11-01', 3),
  ), NOW);
  const s = find(sigs, 'close_date_slipped');
  assert.ok(s, 'expected a slip signal');
  assert.equal(s.side, 'contradicts');
  assert.match(s.headline, /moved 2 times/);
  // The specifics are what make it checkable rather than an assertion.
  assert.match(s.detail, /Sep 15, 2026 → Oct 15, 2026 → Nov 1, 2026/);
});

test('a close date PULLED FORWARD is not a slip', () => {
  // The bug this guards: counting any change as a slip turns an accelerating deal into a
  // stalling one, in the column a reader trusts most.
  const sigs = detectSignals(rows(
    obs('close_date', '2026-11-01', 30),
    obs('close_date', '2026-09-20', 2),
  ), NOW);
  assert.equal(find(sigs, 'close_date_slipped'), null);
});

test('a nightly sync re-observing the same close date is not a move', () => {
  const sigs = detectSignals(rows(
    obs('close_date', '2026-10-01', 5),
    obs('close_date', '2026-10-01', 4),
    obs('close_date', '2026-10-01', 3),
  ), NOW);
  assert.equal(find(sigs, 'close_date_slipped'), null);
});

test('a stage that went backwards is counter-evidence; forward is support', () => {
  const back = detectSignals(rows(
    obs('pipeline_stage', 'negotiation', 20),
    obs('pipeline_stage', 'discovery', 4),
  ), NOW);
  const r = find(back, 'stage_regressed');
  assert.ok(r);
  assert.equal(r.side, 'contradicts');
  assert.match(r.detail, /negotiation → discovery/);

  const fwd = detectSignals(rows(
    obs('pipeline_stage', 'discovery', 20),
    obs('pipeline_stage', 'negotiation', 4),
  ), NOW);
  assert.equal(find(fwd, 'stage_regressed'), null);
  assert.equal(find(fwd, 'stage_advanced')?.side, 'supports');
});

test('silence counts our outbound SINCE their last reply', () => {
  const sigs = detectSignals(rows(
    obs('interaction.email_received', { body: 'thanks' }, 30),
    obs('interaction.email_sent', {}, 20),
    obs('interaction.email_sent', {}, 12),
    obs('interaction.email_sent', {}, 5),
  ), NOW);
  const q = find(sigs, 'gone_quiet');
  assert.ok(q);
  assert.match(q.detail, /3 outbound since/);
});

test('an account we have never emailed is not "going dark"', () => {
  // Otherwise every freshly imported account arrives already condemned.
  const sigs = detectSignals(rows(obs('job_title', 'VP Sales', 90)), NOW);
  assert.equal(find(sigs, 'gone_quiet'), null);
});

test('a recent reply means not quiet', () => {
  const sigs = detectSignals(rows(
    obs('interaction.email_sent', {}, 10),
    obs('interaction.email_received', {}, 2),
  ), NOW);
  assert.equal(find(sigs, 'gone_quiet'), null);
});

test('an opt-out outweighs an objection', () => {
  const optOut = detectSignals(rows(obs('interaction.reply', { signal: 'do_not_contact' }, 1)), NOW);
  const objection = detectSignals(rows(obs('interaction.reply', { signal: 'objection' }, 1)), NOW);
  assert.ok(find(optOut, 'negative_reply').weight > find(objection, 'negative_reply').weight);
});

test('a cancelled meeting that was rebooked is not counter-evidence', () => {
  const sigs = detectSignals(rows(
    obs('interaction.meeting_cancelled', {}, 10),
    obs('interaction.meeting_booked', {}, 8),
  ), NOW);
  assert.equal(find(sigs, 'meeting_cancelled'), null);
});

test('a meeting held last year is not present-tense support', () => {
  const stale = detectSignals(rows(obs('interaction.meeting_held', {}, 200)), NOW);
  assert.equal(find(stale, 'recent_meeting'), null);
  const fresh = detectSignals(rows(obs('interaction.meeting_held', {}, 3)), NOW);
  assert.equal(find(fresh, 'recent_meeting').side, 'supports');
});

test('every signal carries the specifics that make it checkable', () => {
  const sigs = detectSignals(rows(
    obs('close_date', '2026-09-15', 40),
    obs('close_date', '2026-11-01', 3),
    obs('interaction.reply', { signal: 'objection' }, 2),
  ), NOW);
  assert.ok(sigs.length >= 2);
  for (const s of sigs) {
    assert.ok(s.headline && s.detail, `${s.key} must say what and why`);
    assert.ok(s.weight > 0 && s.weight <= 1, `${s.key} weight in range`);
    assert.ok(['supports', 'contradicts'].includes(s.side));
  }
});

// ── Sufficiency: the gate that lets the product say "I don't know" ──

test('an empty record is insufficient and says what would help', () => {
  const s = assessSufficiency({ sourceCount: 0, lastEvidenceAt: null, signals: 0, now: NOW });
  assert.equal(s.enough, false);
  assert.ok(s.what_would_help.length, 'an "unclear" with no next step is a shrug');
});

test('evidence older than a month cannot carry a present-tense verdict', () => {
  const s = assessSufficiency({ sourceCount: 3, lastEvidenceAt: daysAgo(45), signals: 4, now: NOW });
  assert.equal(s.enough, false);
  assert.match(s.reason, /45 days ago/);
});

test('one system agreeing with itself is not corroboration', () => {
  const s = assessSufficiency({ sourceCount: 1, lastEvidenceAt: daysAgo(2), signals: 3, now: NOW });
  assert.equal(s.enough, false);
  assert.match(s.reason, /one system/);
});

test('recent evidence from two systems is enough to say something', () => {
  const s = assessSufficiency({ sourceCount: 2, lastEvidenceAt: daysAgo(2), signals: 3, now: NOW });
  assert.equal(s.enough, true);
});
