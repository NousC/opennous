// Forecast layer 3 — calibrated win probability.
//
// The properties that make this safe to ship before any data exists: a deal with nothing
// known is UNTOUCHED (neutral encodes to an exact no-op) and the hand-set defaults only nudge.
// Fitting the model on closed deals: test/winModelFit.test.mjs.
//
// Run: pnpm --filter @nous/core build && node --test packages/core/test/winModel.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  WIN_FEATURES, DEFAULT_WIN_COEFFS, encodeWinFeatures, adjustWinProbability,
  daysQuietAt, engagementTrendAt, latestValueAt,
} from '../dist/services/winModel.js';

const NOW = Date.parse('2026-08-31T12:00:00.000Z');
const DAY = 86_400_000;
const daysAgo = (n) => new Date(NOW - n * DAY).toISOString();

// ─── encoding: unknown must be neutral ───────────────────────────────────────

test('an account with nothing known encodes to all zeros', () => {
  const x = encodeWinFeatures({});
  for (const f of WIN_FEATURES) assert.equal(x[f.key], 0, `${f.key} not neutral on empty input`);
});

test('facts encode in the direction a seller would expect', () => {
  const x = encodeWinFeatures({
    ageRatio: 3,             // badly stalled
    daysQuiet: 67,           // two months silent
    engagementTrend: 'cold',
    icpFit: 90,              // great fit
    stakeholderCount: 5,     // well threaded
    singleThreaded: false,
    openObjections: 2,
    competitorPresent: true,
    inbound: true,
  });
  assert.ok(x.age_ratio > 0, 'stall should encode positive (its coefficient is negative)');
  assert.ok(x.days_quiet > 0);
  assert.equal(x.engagement_trend, -1);
  assert.ok(x.icp_fit > 0);
  assert.ok(x.stakeholders > 0);
  assert.equal(x.single_threaded, 0);
  assert.equal(x.open_objections, 2);
  assert.equal(x.competitor_present, 1);
  assert.equal(x.inbound, 1);
});

// ─── applying: the Acme vs Borealis separation, now on WHETHER ───────────────

test('neutral features are an EXACT no-op — the safe-on-defaults invariant', () => {
  const x = encodeWinFeatures({});
  for (const p of [0.03, 0.2, 0.6, 0.97]) {
    assert.equal(adjustWinProbability(p, x, DEFAULT_WIN_COEFFS), p);
  }
});

test('a strong account is adjusted up, a weak one down, from the same stage', () => {
  const strong = encodeWinFeatures({ icpFit: 90, stakeholderCount: 4, inbound: true, engagementTrend: 'rising' });
  const weak = encodeWinFeatures({ daysQuiet: 70, openObjections: 3, competitorPresent: true, singleThreaded: true, ageRatio: 3 });
  const pStrong = adjustWinProbability(0.6, strong, DEFAULT_WIN_COEFFS);
  const pWeak = adjustWinProbability(0.6, weak, DEFAULT_WIN_COEFFS);
  assert.ok(pStrong > 0.6, `strong account not lifted: ${pStrong}`);
  assert.ok(pWeak < 0.6, `weak account not discounted: ${pWeak}`);
});

test('the adjustment is clamped — no feature pile-up can make a 3% deal near-certain', () => {
  const absurd = Object.fromEntries(WIN_FEATURES.map(f => [f.key, 100]));
  const coeffs = Object.fromEntries(WIN_FEATURES.map(f => [f.key, 5]));
  const p = adjustWinProbability(0.03, absurd, coeffs);
  // +2 logits max on 3% is ~19% — meaningfully more, nowhere near certain.
  assert.ok(p > 0.03 && p < 0.25, `clamp failed: ${p}`);
});

test('certainty and impossibility are unmoved', () => {
  const x = encodeWinFeatures({ icpFit: 99 });
  assert.equal(adjustWinProbability(0, x, DEFAULT_WIN_COEFFS), 0);
  assert.equal(adjustWinProbability(1, x, DEFAULT_WIN_COEFFS), 1);
});

test('output is always inside (0,1) for any sane stage probability', () => {
  const hot = encodeWinFeatures({ icpFit: 100, stakeholderCount: 9, inbound: true });
  for (const p of [0.01, 0.5, 0.99]) {
    const out = adjustWinProbability(p, hot, DEFAULT_WIN_COEFFS);
    assert.ok(out > 0 && out < 1, `escaped (0,1): ${out}`);
  }
});

// ─── the point-in-time helpers ───────────────────────────────────────────────

test('daysQuietAt only sees events at or before the as-of moment', () => {
  const times = [daysAgo(50), daysAgo(20), daysAgo(2)];
  // As of 10 days ago, the last visible touch was 20 days ago -> 10 days quiet.
  assert.equal(Math.round(daysQuietAt(times, NOW - 10 * DAY)), 10);
  assert.equal(daysQuietAt([daysAgo(1)], NOW - 10 * DAY), null, 'future event leaked into the past');
});

test('engagementTrendAt reads the two 30-day windows before the as-of moment', () => {
  const rising = [daysAgo(5), daysAgo(8), daysAgo(12), daysAgo(40)];
  assert.equal(engagementTrendAt(rising, NOW), 'rising');
  const cold = [daysAgo(100), daysAgo(90)];
  assert.equal(engagementTrendAt(cold, NOW), 'cold');
  // The same events read differently from a different vantage point in time.
  assert.notEqual(engagementTrendAt(cold, NOW - 85 * DAY), 'cold');
});

test('latestValueAt returns the newest value at-or-before the date, else null', () => {
  const series = [
    { at: daysAgo(60), value: 40 },
    { at: daysAgo(30), value: 55 },
    { at: daysAgo(5), value: 80 },
  ];
  assert.equal(latestValueAt(series, daysAgo(10)), 55);
  assert.equal(latestValueAt(series, daysAgo(1)), 80);
  assert.equal(latestValueAt(series, daysAgo(90)), null);
});
