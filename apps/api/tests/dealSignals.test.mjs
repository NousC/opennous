// GET-352: we tell the rep a deal is dead. We never tell the CRM.
//
// The shape these thresholds come from, on Harborline's open deals: over half had a close date
// already passed, about a quarter had never seen any activity, and a smaller slice was quiet over 45 days.
// A passed close date is the strongest signal by a distance — the rep said it would close by a
// date and it didn't, which needs no threshold we invented.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dealSignals, dealVerdict, stalePipeline, humanDays } from '../src/lib/dealSignals.mjs';

const NOW = Date.parse('2026-09-18T00:00:00.000Z');
const daysAgo = (n) => new Date(NOW - n * 86_400_000).toISOString();
const at = { now: NOW };

test('a decided deal is never second-guessed', () => {
  for (const status of ['won', 'lost', 'WON', 'Lost']) {
    assert.deepEqual(
      dealSignals({ status, close_date: daysAgo(400), last_activity_at: daysAgo(400) }, at), [],
      'status belongs to the CRM — a closed deal is not ours to reopen',
    );
  }
});

test('a passed close date is the headline, ahead of silence', () => {
  const v = dealVerdict({
    status: 'open', close_date: daysAgo(90), last_activity_at: daysAgo(60),
  }, at);
  assert.equal(v.headline.kind, 'close_date_passed');
  assert.equal(v.count, 2, 'it is also quiet, and that is still worth carrying');
  assert.match(v.headline.text, /Close date passed 3 months ago/);
  assert.match(v.headline.detail, /2026-06-20/, 'the evidence names the actual date');
});

test('a past-due date on a deal somebody is still working says the DATE is wrong', () => {
  // The shape: a deal years past its close date and worked two days ago. Calling that deal dead teaches a rep the flag is noise.
  const v = dealVerdict({
    status: 'open', close_date: daysAgo(1200), last_activity_at: daysAgo(2),
  }, at);
  assert.equal(v.headline.kind, 'close_date_stale');
  assert.match(v.headline.text, /out of date/);
  assert.match(v.headline.detail, /needs moving, not closing/);
  assert.equal(v.count, 1, 'it is not quiet, so silence is not among the reasons');
});

test('stale dates on live deals are not counted as rotten pipeline', () => {
  const s = stalePipeline([
    { status: 'open', pipeline_value: 40000, close_date: daysAgo(500), last_activity_at: daysAgo(1) },
  ], at);
  assert.equal(s.staleCount, 1, 'it still deserves a flag');
  assert.equal(s.pastDueValue, 0, 'but the forecast must not call a live deal rotten');
});

test('a deal nobody has ever touched says so', () => {
  const [first] = dealSignals({ status: 'open', close_date: null, last_activity_at: null }, at);
  assert.equal(first.kind, 'never_worked');
  assert.equal(first.days, null, 'there is no duration to state, and inventing one would be a lie');
});

test('silence only counts past the threshold', () => {
  const quiet = (days) => dealSignals({ status: 'open', last_activity_at: daysAgo(days) }, at)
    .map(s => s.kind);
  assert.deepEqual(quiet(44), [], 'a deal touched six weeks ago is a live deal');
  assert.deepEqual(quiet(45), ['quiet']);
  assert.deepEqual(quiet(200), ['quiet']);
  // The threshold is a starting point, not a truth, so it is tunable per workspace.
  assert.deepEqual(
    dealSignals({ status: 'open', last_activity_at: daysAgo(20) }, { now: NOW, quietDays: 14 })
      .map(s => s.kind),
    ['quiet'],
  );
});

test('single-threading is only mentioned when something else is already wrong', () => {
  const healthy = dealSignals(
    { status: 'open', last_activity_at: daysAgo(2), close_date: daysAgo(-30), contact_count: 1 }, at);
  assert.deepEqual(healthy, [],
    'a single-threaded deal someone worked yesterday is a live deal, not a warning');

  const dying = dealSignals(
    { status: 'open', last_activity_at: daysAgo(90), contact_count: 1 }, at).map(s => s.kind);
  assert.deepEqual(dying, ['quiet', 'single_threaded'], 'ranked last — it is the weakest reason');
});

test('a deal in good shape produces nothing at all', () => {
  assert.equal(
    dealVerdict({
      status: 'open', close_date: daysAgo(-30), last_activity_at: daysAgo(3), contact_count: 4,
    }, at),
    null,
  );
});

test('stale pipeline totals are honest about what is rotten', () => {
  const deals = [
    { status: 'open', pipeline_value: 100000, close_date: daysAgo(60), last_activity_at: daysAgo(70) },
    { status: 'open', pipeline_value: 50000, close_date: daysAgo(-30), last_activity_at: daysAgo(90) },
    { status: 'open', pipeline_value: 25000, close_date: daysAgo(-10), last_activity_at: daysAgo(1) },
    { status: 'won', pipeline_value: 999999, close_date: daysAgo(5), last_activity_at: daysAgo(5) },
  ];
  const s = stalePipeline(deals, at);
  assert.equal(s.openValue, 175000, 'the won deal is not open pipeline');
  assert.equal(s.staleValue, 150000);
  assert.equal(s.staleCount, 2);
  assert.equal(s.pastDueValue, 100000, 'only the one whose date actually passed');
  assert.equal(s.pastDueCount, 1);
});

test('durations read the way a person would say them', () => {
  assert.equal(humanDays(0), 'today');
  assert.equal(humanDays(1), '1 day');
  assert.equal(humanDays(44), '44 days');
  assert.equal(humanDays(90), '3 months');
  assert.equal(humanDays(400), 'over a year');
  assert.equal(humanDays(800), 'over 2 years');
});
