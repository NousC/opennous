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
  applyIntentMultiplier, intentMultiplierFor, DEFAULT_INTENT_HAZARD, buildConversionRates, winProbabilityByStage,
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





// ── Monte Carlo bands ────────────────────────────────────────────────────────
