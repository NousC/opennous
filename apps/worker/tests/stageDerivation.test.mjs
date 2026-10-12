// Stage derivation — the rung rules AND the timestamp each hop is dated to.
//
// The rung assertions are a regression guard: this worker is advance-only, so a false
// promotion parks an account at a stage forever. The timestamp assertions are new, and
// they are what the forecasting layer needs: the cron used to stamp every hop with its
// own tick time, so an account that advanced six weeks ago looked like it advanced
// tonight and every cycle-time measured zero.
//
// Run: node --test apps/worker/tests/stageDerivation.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveStage } from '../src/workers/stageDerivation.mjs';

const NOW = Date.parse('2026-08-30T12:00:00.000Z');
const DAY = 86_400_000;
const daysAgo = (n) => new Date(NOW - n * DAY).toISOString();
const daysAhead = (n) => new Date(NOW + n * DAY).toISOString();

const obs = (property, at, extra = {}) => ({ property, observed_at: at, raw: {}, value: {}, ...extra });
const run = (observations, current = 'identified', buying = []) =>
  deriveStage(observations, current, buying, { now: NOW });

// ── rung rules: unchanged behaviour ──────────────────────────────────────────

test('a held meeting derives discovery', () => {
  assert.equal(run([obs('interaction.meeting_held', daysAgo(5))]).stage, 'discovery');
});

test('a live booking derives meeting_booked', () => {
  assert.equal(run([obs('interaction.meeting_scheduled', daysAgo(2))]).stage, 'meeting_booked');
});

test('a cancelled booking does NOT promote', () => {
  const slot = daysAgo(2);
  const r = run([
    obs('interaction.meeting_scheduled', slot),
    obs('interaction.meeting_cancelled', slot),
  ]);
  assert.equal(r.stage, 'identified');
  assert.equal(r.at, null);
});

test('an inbound reply derives interested; an outbound message does not', () => {
  const inbound = run([obs('interaction.linkedin_message', daysAgo(3), { raw: { is_outbound: false } })]);
  assert.equal(inbound.stage, 'interested');
  const outbound = run([obs('interaction.linkedin_message', daysAgo(3), { raw: { is_outbound: true } })]);
  assert.equal(outbound.stage, 'identified');
});

test('a bounce or opt-out never derives interested', () => {
  for (const sig of ['bounce', 'unsubscribe', 'auto_reply', 'do_not_contact']) {
    const r = run([obs('interaction.email_received', daysAgo(3), { raw: { reply_signal: sig } })]);
    assert.notEqual(r.stage, 'interested', `${sig} promoted to interested`);
  }
});

test('a fresh buying signal derives negotiation, outranking a held meeting', () => {
  const r = run(
    [obs('interaction.meeting_held', daysAgo(5))],
    'identified',
    [{ last_observed_at: daysAgo(10), value: { category: 'buying_signal' } }],
  );
  assert.equal(r.stage, 'negotiation');
});

test('nothing qualifying leaves the stage alone with no timestamp', () => {
  const r = run([obs('interaction.email_opened', daysAgo(3))], 'interested');
  assert.equal(r.stage, 'interested');
  assert.equal(r.at, null);
});

// ── timestamps: the new behaviour ────────────────────────────────────────────

test('the hop is dated to the EARLIEST qualifying evidence, not the latest', () => {
  // Two calls happened. The account entered discovery at the FIRST one — 40 days of
  // time-in-stage, not 5. Taking the latest would understate every cycle time.
  const r = run([
    obs('interaction.meeting_held', daysAgo(5)),
    obs('interaction.meeting_held', daysAgo(40)),
  ]);
  assert.equal(r.stage, 'discovery');
  assert.equal(r.at, daysAgo(40));
});

test('the hop is NOT dated to now — the bug this replaces', () => {
  const r = run([obs('interaction.meeting_held', daysAgo(30))]);
  assert.equal(r.at, daysAgo(30));
  assert.notEqual(r.at, new Date(NOW).toISOString());
});

test('mixed evidence for one rung takes the earliest across all of it', () => {
  // interested can fire from LinkedIn, email, or a meeting_interest disposition.
  const r = run([
    obs('interaction.meeting_interest', daysAgo(4)),
    obs('interaction.email_received', daysAgo(21)),
    obs('interaction.linkedin_message', daysAgo(9), { raw: { is_outbound: false } }),
  ]);
  assert.equal(r.stage, 'interested');
  assert.equal(r.at, daysAgo(21));
});

test('a future-dated booking still reports its start time — the caller clamps it', () => {
  // deriveStage reports the evidence as-is; transitionAt() does the clamping on write.
  // Asserting the raw value here keeps the two responsibilities separate and visible.
  const r = run([obs('interaction.meeting_scheduled', daysAhead(7))]);
  assert.equal(r.stage, 'meeting_booked');
  assert.equal(r.at, daysAhead(7));
});

test('a negotiation hop dates to the buying signal that drove it', () => {
  const r = run([], 'identified', [{ last_observed_at: daysAgo(12), value: {} }]);
  assert.equal(r.stage, 'negotiation');
  assert.equal(r.at, daysAgo(12));
});

test('a buying signal with only computed_at still dates correctly', () => {
  const r = run([], 'identified', [{ last_observed_at: null, computed_at: daysAgo(8), value: {} }]);
  assert.equal(r.stage, 'negotiation');
  assert.equal(r.at, daysAgo(8));
});

test('every derived hop carries a timestamp — none fall back silently to now', () => {
  // If a rung ever fires with at=null the caller silently stamps now(), which is the
  // exact failure being fixed. Guard it for every rung.
  const cases = [
    [[obs('interaction.meeting_held', daysAgo(5))], 'discovery'],
    [[obs('interaction.meeting_scheduled', daysAgo(5))], 'meeting_booked'],
    [[obs('interaction.email_received', daysAgo(5))], 'interested'],
    [[obs('interaction.linkedin_connected', daysAgo(50))], 'connected'],
    [[obs('interaction.proposal_sent', daysAgo(5))], 'negotiation'],
  ];
  for (const [observations, expected] of cases) {
    const r = run(observations);
    assert.equal(r.stage, expected);
    assert.ok(r.at, `${expected} derived with no timestamp`);
  }
});

// ── outcome rungs: the replay/backfill regression ────────────────────────────
//
// deriveStage had no outcome rung at all and windowed everything to 30-60 days,
// so a deal whose close was replayed rather than observed live could only ever
// reach 'negotiation' and its real result was lost. These lock the fix.

test('a signed proposal derives closed_won', () => {
  assert.equal(run([obs('interaction.proposal_signed', daysAgo(10))]).stage, 'closed_won');
});

test('a lost deal derives closed_lost', () => {
  assert.equal(run([obs('interaction.deal_lost', daysAgo(10))]).stage, 'closed_lost');
});

test('an outcome OUTSIDE the 60-day ladder window still derives — a deal that closed last year is still closed', () => {
  for (const [prop, expected] of [
    ['interaction.proposal_signed', 'closed_won'],
    ['interaction.deal_won', 'closed_won'],
    ['interaction.payment_received', 'closed_won'],
    ['interaction.deal_lost', 'closed_lost'],
    ['interaction.deal_disqualified', 'disqualified'],
  ]) {
    assert.equal(run([obs(prop, daysAgo(300))]).stage, expected, `${prop} at 300 days`);
  }
});

test('an outcome outranks a fresh buying signal — a closed deal is not still negotiating', () => {
  const r = run(
    [obs('interaction.proposal_signed', daysAgo(200))],
    'identified',
    [{ last_observed_at: daysAgo(1) }],
  );
  assert.equal(r.stage, 'closed_won');
});

test('the outcome hop is dated to the outcome event, not to now', () => {
  const closedAt = daysAgo(120);
  assert.equal(run([obs('interaction.deal_lost', closedAt)]).at, closedAt);
});

test('the EARLIEST outcome wins when several exist', () => {
  const first = daysAgo(200);
  const r = run([
    obs('interaction.deal_lost', daysAgo(50)),
    obs('interaction.proposal_signed', first),
  ]);
  assert.equal(r.stage, 'closed_won');
  assert.equal(r.at, first);
});

test('churn only follows a win — it cannot apply to an account that never bought', () => {
  assert.notEqual(run([obs('interaction.subscription_canceled', daysAgo(10))], 'interested').stage, 'churned');
  assert.equal(run([obs('interaction.subscription_canceled', daysAgo(10))], 'closed_won').stage, 'churned');
});

test('disqualified cannot apply once a deal is real — past meeting_booked it is a loss, not an unqualified lead', () => {
  assert.notEqual(run([obs('interaction.deal_disqualified', daysAgo(5))], 'discovery').stage, 'disqualified');
  assert.equal(run([obs('interaction.deal_disqualified', daysAgo(5))], 'interested').stage, 'disqualified');
});

test('ladder rungs still win when there is no outcome at all', () => {
  assert.equal(run([obs('interaction.meeting_held', daysAgo(5))]).stage, 'discovery');
});
