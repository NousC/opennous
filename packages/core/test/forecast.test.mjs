// Forecast layer 1 — base-rate weighted pipeline.
//
// The forecast is two probabilities multiplied: will it ever close, and will it close by the
// 31st. These tests pin the properties that make the number trustworthy rather than merely
// present — thin evidence stays near the prior, unknown stays unknown instead of becoming
// zero, and a deal that has already sat for months is not treated like a fresh one.
//
// Run: pnpm --filter @nous/core build && node --test packages/core/test/forecast.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  smoothRate, buildConversionRates, winProbabilityByStage, probCloseWithin,
  forecastPipeline, DEFAULT_STAGE_PRIORS, PRIOR_STRENGTH,
} from '../dist/services/forecast.js';
import { kaplanMeierCurve } from '../dist/services/funnelTimeline.js';

// Beta arithmetic lands a hair off exact decimals, so compare with a tolerance.
const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} !== ${b}`);

// ── smoothing: thin evidence must not shout ──────────────────────────────────

test('a stage with no data returns the bare prior', () => {
  near(smoothRate(0, 0, 0.4), 0.4);
});

test('three deals barely move off the prior', () => {
  // 2/3 raw = 67%. With twelve deals' worth of prior at 40%, the honest answer is much
  // closer to 40 than to 67. Reporting 67% off three deals is how a forecast loses trust.
  const raw = 2 / 3;
  const smoothed = smoothRate(2, 3, 0.4);
  assert.ok(smoothed < 0.5, `barely moved: ${smoothed}`);
  assert.ok(Math.abs(smoothed - 0.4) < Math.abs(smoothed - raw));
});

test('two hundred deals essentially ignore the prior', () => {
  const smoothed = smoothRate(120, 200, 0.4);
  assert.ok(Math.abs(smoothed - 0.6) < 0.02, `prior still dominating: ${smoothed}`);
});

test('more evidence always moves the rate closer to the truth', () => {
  // Same underlying 60% rate, measured over growing samples.
  const dists = [3, 30, 300].map(n => Math.abs(smoothRate(n * 0.6, n, 0.2) - 0.6));
  assert.ok(dists[0] > dists[1] && dists[1] > dists[2], `not converging: ${dists}`);
});

test('smoothed rates always sit in (0,1)', () => {
  for (const [w, t] of [[0, 0], [0, 50], [50, 50], [1, 1], [999, 999]]) {
    const r = smoothRate(w, t, 0.5);
    assert.ok(r > 0 && r < 1, `out of range for ${w}/${t}: ${r}`);
  }
});

test('impossible counts are clamped rather than producing a rate above 1', () => {
  // A conversion source can report more reaching the next rung than the current one when
  // stages get skipped. That must not become a 130% conversion rate.
  const r = smoothRate(80, 50, 0.5);
  assert.ok(r > 0 && r <= 1, `bad clamp: ${r}`);
});

// ── the chain ────────────────────────────────────────────────────────────────

test('every ladder rung gets a rate even with no data at all', () => {
  const rates = buildConversionRates([]);
  assert.equal(rates.length, 7);
  assert.deepEqual(rates.map(r => r.from), [
    'identified', 'connected', 'interested', 'meeting_booked', 'discovery', 'demo', 'negotiation',
  ]);
  for (const r of rates) {
    assert.equal(r.observed, null, 'invented an observed rate from nothing');
    assert.equal(r.priorWeight, 1, 'claimed data it does not have');
    near(r.rate, DEFAULT_STAGE_PRIORS[r.from]);
  }
});

test('observed rate is reported unsmoothed next to the smoothed one', () => {
  // 9/10 = 90%, against a 60% prior for this rung. Ten deals is not enough to claim 90%, so
  // the smoothed rate must sit between the two while `observed` still reports what was seen.
  const rates = buildConversionRates([
    { from: 'negotiation', to: 'closed_won', reached_from: 10, reached_to: 9 },
  ]);
  const neg = rates.find(r => r.from === 'negotiation');
  assert.equal(neg.observed, 0.9);
  assert.equal(neg.sample, 10);
  assert.ok(neg.rate > 0.6 && neg.rate < 0.9, `not pulled toward the prior: ${neg.rate}`);
});

test('when the data agrees with the prior, smoothing changes nothing', () => {
  // The negotiation prior is 60%. Observing exactly 60% should leave the rate untouched --
  // smoothing pulls toward the prior, so there is nowhere to pull.
  const rates = buildConversionRates([
    { from: 'negotiation', to: 'closed_won', reached_from: 10, reached_to: 6 },
  ]);
  const neg = rates.find(r => r.from === 'negotiation');
  near(neg.rate, 0.6);
  near(neg.observed, 0.6);
});

test('priorWeight falls as evidence accumulates', () => {
  const thin = buildConversionRates([{ from: 'discovery', to: 'demo', reached_from: 2, reached_to: 1 }]);
  const thick = buildConversionRates([{ from: 'discovery', to: 'demo', reached_from: 400, reached_to: 200 }]);
  const a = thin.find(r => r.from === 'discovery').priorWeight;
  const b = thick.find(r => r.from === 'discovery').priorWeight;
  assert.ok(a > 0.8 && b < 0.05, `weights wrong: thin=${a} thick=${b}`);
});

test('P(win) compounds down the funnel — later stages are strictly likelier', () => {
  const win = winProbabilityByStage(buildConversionRates([]));
  const ladder = ['identified', 'connected', 'interested', 'meeting_booked', 'discovery', 'demo', 'negotiation'];
  for (let i = 0; i < ladder.length - 1; i++) {
    assert.ok(win[ladder[i]] < win[ladder[i + 1]],
      `${ladder[i]} (${win[ladder[i]]}) should be less likely than ${ladder[i + 1]} (${win[ladder[i + 1]]})`);
  }
  assert.equal(win.closed_won, 1);
});

test('an early-stage account is worth a small fraction of a late-stage one', () => {
  const win = winProbabilityByStage(buildConversionRates([]));
  assert.ok(win.identified < 0.05, `identified far too optimistic: ${win.identified}`);
  assert.ok(win.negotiation > 0.5, `negotiation far too pessimistic: ${win.negotiation}`);
});

// ── timing ───────────────────────────────────────────────────────────────────

const curveOf = (rows) => kaplanMeierCurve(rows);
const won = (days) => ({ days, censored: false });
const stillOpen = (days) => ({ days, censored: true });

test('a longer horizon never lowers the probability', () => {
  const c = curveOf([won(10), won(20), won(30), won(40), stillOpen(60)]);
  const p30 = probCloseWithin(c, 0, 30);
  const p90 = probCloseWithin(c, 0, 90);
  assert.ok(p90 >= p30, `${p90} < ${p30}`);
});

test('a deal that has already sat for months is judged on what happened to its peers', () => {
  // Most deals here close inside 30 days. A deal 100 days in is unlike them, and asking the
  // raw curve would hand it the same optimistic answer as a fresh one.
  const c = curveOf([won(5), won(10), won(15), won(20), won(25), stillOpen(200)]);
  const fresh = probCloseWithin(c, 0, 30);
  const stale = probCloseWithin(c, 100, 30);
  assert.ok(fresh > stale, `stale deal not discounted: fresh=${fresh} stale=${stale}`);
});

test('an empty curve returns null, not a guess', () => {
  assert.equal(probCloseWithin([], 0, 30), null);
});

test('a zero or negative horizon is zero probability', () => {
  const c = curveOf([won(10), won(20)]);
  assert.equal(probCloseWithin(c, 0, 0), 0);
  assert.equal(probCloseWithin(c, 0, -5), 0);
});

test('probability always lands in [0,1]', () => {
  const c = curveOf([won(1), won(5), won(9), stillOpen(50)]);
  for (const [d, h] of [[0, 1], [0, 1000], [500, 30], [3, 7]]) {
    const p = probCloseWithin(c, d, h);
    if (p !== null) assert.ok(p >= 0 && p <= 1, `out of range at d=${d} h=${h}: ${p}`);
  }
});

// ── the whole forecast ───────────────────────────────────────────────────────

const model = () => {
  const rates = buildConversionRates([
    { from: 'negotiation', to: 'closed_won', reached_from: 100, reached_to: 60 },
    { from: 'discovery', to: 'demo', reached_from: 100, reached_to: 55 },
  ]);
  return {
    rates,
    winByStage: winProbabilityByStage(rates),
    curvesByStage: {
      negotiation: curveOf([won(10), won(20), won(30), won(45), stillOpen(90)]),
      discovery: curveOf([won(40), won(60), won(80), stillOpen(150)]),
    },
  };
};

test('the total is the sum of the per-deal contributions — fully explainable', () => {
  const r = forecastPipeline([
    { entityId: 'a', amount: 50000, stage: 'negotiation', daysInStage: 5 },
    { entityId: 'b', amount: 30000, stage: 'negotiation', daysInStage: 10 },
  ], model(), { horizonDays: 30 });
  const summed = r.deals.reduce((s, d) => s + d.contribution, 0);
  assert.ok(Math.abs(r.expected - summed) <= 1, `total does not match its parts: ${r.expected} vs ${summed}`);
});

test('the forecast never exceeds the raw open pipeline', () => {
  const r = forecastPipeline([
    { entityId: 'a', amount: 50000, stage: 'negotiation', daysInStage: 5 },
    { entityId: 'b', amount: 30000, stage: 'discovery', daysInStage: 10 },
  ], model(), { horizonDays: 30 });
  assert.ok(r.expected <= r.openPipeline, `${r.expected} > ${r.openPipeline}`);
  assert.equal(r.openPipeline, 80000);
});

test('a deal with no amount is reported, NOT counted as zero', () => {
  // Treating unknown as nothing is how a forecast ends up confidently low.
  const r = forecastPipeline([
    { entityId: 'a', amount: null, stage: 'negotiation', daysInStage: 5 },
    { entityId: 'b', amount: 30000, stage: 'negotiation', daysInStage: 5 },
  ], model(), { horizonDays: 30 });
  assert.equal(r.missingAmountCount, 1);
  assert.equal(r.openPipeline, 30000);
  assert.ok(r.deals.find(d => d.entityId === 'a').caveat, 'no caveat on the unknown deal');
});

test('a stage with no timing history contributes nothing and says why', () => {
  const r = forecastPipeline(
    [{ entityId: 'a', amount: 50000, stage: 'interested', daysInStage: 5 }],
    model(), { horizonDays: 30 },
  );
  assert.equal(r.expected, 0);
  assert.equal(r.deals[0].pClose, null);
  assert.match(r.deals[0].caveat, /timing/);
});

test('deals come back biggest contributor first', () => {
  const r = forecastPipeline([
    { entityId: 'small', amount: 1000, stage: 'negotiation', daysInStage: 5 },
    { entityId: 'big', amount: 90000, stage: 'negotiation', daysInStage: 5 },
  ], model(), { horizonDays: 30 });
  assert.equal(r.deals[0].entityId, 'big');
});

test('a late-stage deal outweighs an identical early-stage one', () => {
  const r = forecastPipeline([
    { entityId: 'late', amount: 50000, stage: 'negotiation', daysInStage: 5 },
    { entityId: 'early', amount: 50000, stage: 'discovery', daysInStage: 5 },
  ], model(), { horizonDays: 30 });
  const late = r.deals.find(d => d.entityId === 'late');
  const early = r.deals.find(d => d.entityId === 'early');
  assert.ok(late.contribution > early.contribution);
});

test('basis reports honestly how much is assumption', () => {
  const noData = forecastPipeline([], {
    rates: buildConversionRates([]), winByStage: {}, curvesByStage: {},
  }, { horizonDays: 30 });
  assert.equal(noData.basis, 'prior');

  const lots = buildConversionRates(
    ['identified', 'connected', 'interested', 'meeting_booked', 'discovery', 'demo', 'negotiation']
      .map(from => ({ from, to: 'x', reached_from: 500, reached_to: 250 })),
  );
  const learned = forecastPipeline([], { rates: lots, winByStage: {}, curvesByStage: {} }, { horizonDays: 30 });
  assert.equal(learned.basis, 'learned');
});

test('an empty pipeline forecasts zero without blowing up', () => {
  const r = forecastPipeline([], model(), { horizonDays: 30 });
  assert.equal(r.expected, 0);
  assert.equal(r.dealCount, 0);
  assert.equal(r.openPipeline, 0);
});
