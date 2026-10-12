// Forecast layer 2 — the timing engine.
//
// Two additions over layer 1, and they answer different complaints:
//
//   Intent as a hazard multiplier — layer 1 gives two deals at the same stage, same amount,
//   same age the identical number, even when one had a call last week and the other has been
//   silent since June. Everyone at the company knows those are not the same deal.
//
//   Monte Carlo bands — layer 1 returns one confident-looking number sitting on a dozen
//   deals. If one of them is a $80k coin flip, the "expected" total is the average of two
//   outcomes and is itself an outcome that almost never happens.
//
// Run: pnpm --filter @nous/core build && node --test packages/core/test/forecastLayer2.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyIntentMultiplier, intentMultiplierFor, DEFAULT_INTENT_HAZARD,
  simulateForecast, forecastPipeline, buildConversionRates, winProbabilityByStage,
} from '../dist/services/forecast.js';
import { kaplanMeierCurve } from '../dist/services/funnelTimeline.js';

const won = (days) => ({ days, censored: false });
const stillOpen = (days) => ({ days, censored: true });

const model = () => {
  const rates = buildConversionRates([
    { from: 'negotiation', to: 'closed_won', reached_from: 100, reached_to: 60 },
    { from: 'discovery', to: 'demo', reached_from: 100, reached_to: 55 },
  ]);
  return {
    rates,
    winByStage: winProbabilityByStage(rates),
    curvesByStage: {
      negotiation: kaplanMeierCurve([won(10), won(20), won(30), won(45), stillOpen(90)]),
      discovery: kaplanMeierCurve([won(40), won(60), won(80), stillOpen(150)]),
    },
  };
};

// ── intent as a hazard multiplier ────────────────────────────────────────────

test('intent scales the hazard, and the result is always a probability', () => {
  // Multiplying p directly would give 0.8 x 1.7 = 1.36, which is not a probability. Scaling
  // the hazard keeps it in range by construction, for any positive multiplier.
  for (const p of [0.01, 0.3, 0.8, 0.99]) {
    for (const m of [0.1, 0.5, 1, 1.7, 5]) {
      const out = applyIntentMultiplier(p, m);
      assert.ok(out >= 0 && out <= 1, `p=${p} m=${m} -> ${out}`);
    }
  }
});

test('a multiplier of 1 changes nothing', () => {
  for (const p of [0, 0.25, 0.5, 1]) assert.equal(applyIntentMultiplier(p, 1), p);
});

test('hot speeds a deal up, dormant slows it down', () => {
  const base = 0.4;
  const hot = applyIntentMultiplier(base, DEFAULT_INTENT_HAZARD.Hot);
  const dormant = applyIntentMultiplier(base, DEFAULT_INTENT_HAZARD.Dormant);
  assert.ok(hot > base, `hot did not speed up: ${hot}`);
  assert.ok(dormant < base, `dormant did not slow down: ${dormant}`);
});

test('the bands are monotonic — hotter is never slower', () => {
  const order = ['Dormant', 'Aware', 'Warm', 'Hot', 'Red-hot'];
  for (let i = 0; i < order.length - 1; i++) {
    assert.ok(DEFAULT_INTENT_HAZARD[order[i]] < DEFAULT_INTENT_HAZARD[order[i + 1]],
      `${order[i]} is not slower than ${order[i + 1]}`);
  }
});

test('certainty and impossibility are unmoved by intent', () => {
  // No amount of momentum closes a dead deal, and a certain one cannot exceed certain.
  assert.equal(applyIntentMultiplier(0, 5), 0);
  assert.equal(applyIntentMultiplier(1, 0.1), 1);
});

test('an unknown or missing band is neutral, never a penalty', () => {
  // Most accounts carry no band. Treating that as cold would silently cut the forecast for
  // every workspace that has not run intent scoring yet.
  for (const b of [null, undefined, '', 'Nonsense']) assert.equal(intentMultiplierFor(b), 1);
});

test('a null timing probability stays null through the intent step', () => {
  assert.equal(applyIntentMultiplier(null, 1.4), null);
});

test('intent changes WHEN, never WHETHER — P(win) is untouched', () => {
  const deals = (band) => [{ entityId: 'a', amount: 50000, stage: 'negotiation', daysInStage: 10, intentBand: band }];
  const hot = forecastPipeline(deals('Hot'), model(), { horizonDays: 30 });
  const cold = forecastPipeline(deals('Dormant'), model(), { horizonDays: 30 });
  assert.equal(hot.deals[0].pWin, cold.deals[0].pWin, 'intent leaked into P(win)');
  assert.ok(hot.deals[0].pClose > cold.deals[0].pClose);
  assert.ok(hot.expected > cold.expected);
});

test('two identical deals are separated only by intent — the whole point of layer 2', () => {
  // Acme and Borealis: same stage, same amount, same 40 days. Acme replied on Wednesday,
  // Borealis has been silent since June. Layer 1 gives them the same number.
  const r = forecastPipeline([
    { entityId: 'acme', amount: 50000, stage: 'negotiation', daysInStage: 40, intentBand: 'Hot' },
    { entityId: 'borealis', amount: 50000, stage: 'negotiation', daysInStage: 40, intentBand: 'Dormant' },
  ], model(), { horizonDays: 30 });
  const acme = r.deals.find(d => d.entityId === 'acme');
  const borealis = r.deals.find(d => d.entityId === 'borealis');
  assert.ok(acme.contribution > borealis.contribution * 1.5,
    `not meaningfully separated: ${acme.contribution} vs ${borealis.contribution}`);
  // The pre-intent figure is retained on both, so the adjustment stays auditable.
  assert.equal(acme.pCloseBase, borealis.pCloseBase);
});

test('intent can be switched off, to show what it changed', () => {
  const deals = [{ entityId: 'a', amount: 50000, stage: 'negotiation', daysInStage: 10, intentBand: 'Hot' }];
  const off = forecastPipeline(deals, model(), { horizonDays: 30, intentHazard: false });
  assert.equal(off.deals[0].intentMultiplier, 1);
  assert.equal(off.deals[0].pClose, off.deals[0].pCloseBase);
});

test('a workspace-specific multiplier table overrides the defaults', () => {
  // The hook for a fitted coefficient once a workspace has enough closed deals.
  const deals = [{ entityId: 'a', amount: 50000, stage: 'negotiation', daysInStage: 10, intentBand: 'Hot' }];
  const custom = forecastPipeline(deals, model(), { horizonDays: 30, intentTable: { Hot: 3.0 } });
  const dflt = forecastPipeline(deals, model(), { horizonDays: 30 });
  assert.equal(custom.deals[0].intentMultiplier, 3.0);
  assert.ok(custom.deals[0].pClose > dflt.deals[0].pClose);
});

// ── Monte Carlo bands ────────────────────────────────────────────────────────

test('percentiles are ordered and bracket the mean', () => {
  const b = simulateForecast([
    { amount: 50000, probability: 0.6 },
    { amount: 30000, probability: 0.4 },
    { amount: 20000, probability: 0.8 },
  ]);
  assert.ok(b.p10 <= b.p50 && b.p50 <= b.p90, `${b.p10} ${b.p50} ${b.p90}`);
  assert.ok(b.mean >= b.p10 && b.mean <= b.p90, `mean ${b.mean} outside its own band`);
});

test('the simulated mean matches the arithmetic expectation', () => {
  const b = simulateForecast(
    [{ amount: 100000, probability: 0.5 }, { amount: 40000, probability: 0.25 }],
    { iterations: 20000 },
  );
  assert.equal(b.mean, 60000);   // 100k*0.5 + 40k*0.25
});

test('the same input gives the same answer every time', () => {
  // An unseeded simulation drifts on every refresh and cannot be reproduced in a bug report.
  const deals = [{ amount: 50000, probability: 0.5 }, { amount: 25000, probability: 0.3 }];
  assert.deepEqual(simulateForecast(deals), simulateForecast(deals));
});

test('a lumpy pipeline gets a WIDE band, a diversified one a tight band', () => {
  // The reason a band exists. One coin-flip deal is nearly bimodal; twenty small ones average
  // out. Same expected value, completely different confidence.
  const lumpy = simulateForecast([{ amount: 200000, probability: 0.5 }]);
  const spread = simulateForecast(Array.from({ length: 20 }, () => ({ amount: 10000, probability: 0.5 })));
  const width = (b) => (b.p90 - b.p10) / Math.max(1, b.mean);
  assert.ok(width(lumpy) > width(spread) * 2,
    `lumpy=${width(lumpy)} spread=${width(spread)} — concentration not reflected`);
});

test('concentration flags when one deal IS the forecast', () => {
  const lumpy = simulateForecast([
    { amount: 200000, probability: 0.5 }, { amount: 2000, probability: 0.5 },
  ]);
  const even = simulateForecast(Array.from({ length: 10 }, () => ({ amount: 10000, probability: 0.5 })));
  assert.ok(lumpy.concentration > 0.9, `should be dominated by one deal: ${lumpy.concentration}`);
  assert.ok(even.concentration < 0.2, `should read as diversified: ${even.concentration}`);
});

test('a certain deal collapses the band onto its amount', () => {
  const b = simulateForecast([{ amount: 75000, probability: 1 }]);
  assert.equal(b.p10, 75000);
  assert.equal(b.p50, 75000);
  assert.equal(b.p90, 75000);
});

test('no priced deals gives zeros, not NaN', () => {
  for (const input of [[], [{ amount: 0, probability: 0.5 }], [{ amount: 100, probability: 0 }]]) {
    const b = simulateForecast(input);
    assert.equal(b.mean, 0);
    assert.equal(b.p50, 0);
    assert.ok(Number.isFinite(b.p90));
  }
});

test('the forecast carries its own band, from the same probabilities as the total', () => {
  const r = forecastPipeline([
    { entityId: 'a', amount: 50000, stage: 'negotiation', daysInStage: 5, intentBand: 'Hot' },
    { entityId: 'b', amount: 30000, stage: 'negotiation', daysInStage: 20, intentBand: 'Warm' },
  ], model(), { horizonDays: 30 });
  assert.ok(r.bands, 'no band on the result');
  assert.ok(r.bands.p10 <= r.bands.p50 && r.bands.p50 <= r.bands.p90);
  // The headline number and the band must never disagree — one source, two readings.
  assert.ok(Math.abs(r.bands.mean - r.expected) <= 1,
    `band mean ${r.bands.mean} does not match expected ${r.expected}`);
});

test('deals with no amount are excluded from the band, not simulated as zero', () => {
  const r = forecastPipeline([
    { entityId: 'a', amount: 50000, stage: 'negotiation', daysInStage: 5 },
    { entityId: 'b', amount: null, stage: 'negotiation', daysInStage: 5 },
  ], model(), { horizonDays: 30 });
  assert.equal(r.missingAmountCount, 1);
  assert.ok(r.bands.p90 > 0, 'the priced deal vanished from the simulation');
});
