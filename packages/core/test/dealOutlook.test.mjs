// The deal outlook — "how likely is this deal to close, within N days, and why".
//
// Two properties carry it: the explained P(win) is EXACTLY the forecast's P(win) (explaining a
// number must never change it), and P(won within N) is P(win) x the timing half, with a stage
// that has no closed-deal timing reported as unknown rather than zero.
//
// Run: pnpm --filter @nous/core build && node --test packages/core/test/dealOutlook.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_WIN_COEFFS, encodeWinFeatures, adjustWinProbability, explainWinProbability,
} from '../dist/services/winModel.js';
import { dealOutlookFromScores, MIN_TIMING_WINS } from '../dist/services/forecastRun.js';
import { buildConversionRates, winProbabilityByStage } from '../dist/services/forecast.js';
import { kaplanMeierCurve } from '../dist/services/funnelTimeline.js';

test('a deal we know nothing extra about has no drivers and keeps the stage base exactly', () => {
  const { pWin, drivers } = explainWinProbability(0.6, encodeWinFeatures({}), DEFAULT_WIN_COEFFS);
  assert.equal(pWin, 0.6);
  assert.deepEqual(drivers, []);
});

test('explaining P(win) never changes it, and names what pulled it down, biggest first', () => {
  const x = encodeWinFeatures({ competitorPresent: true, openObjections: 2, singleThreaded: true });
  const { pWin, drivers } = explainWinProbability(0.6, x, DEFAULT_WIN_COEFFS);
  assert.equal(pWin, adjustWinProbability(0.6, x, DEFAULT_WIN_COEFFS));
  assert.ok(pWin < 0.6);
  assert.deepEqual(drivers.map(d => d.key), ['open_objections', 'competitor_present', 'single_threaded']);
  assert.ok(drivers.every(d => d.pts < 0 && d.logit < 0));
});

test("a driver's points are what P(win) would lose if only that fact were neutral", () => {
  const x = encodeWinFeatures({ icpFit: 90, daysQuiet: 40 });
  const { pWin, drivers } = explainWinProbability(0.45, x, DEFAULT_WIN_COEFFS);
  for (const d of drivers) {
    const without = adjustWinProbability(0.45, { ...x, [d.key]: 0 }, DEFAULT_WIN_COEFFS);
    assert.equal(d.pts, Math.round((pWin - without) * 1000) / 10);
  }
  assert.ok(drivers.find(d => d.key === 'icp_fit').pts > 0);
  assert.ok(drivers.find(d => d.key === 'days_quiet').pts < 0);
});

const rates = buildConversionRates([]);
const winByStage = winProbabilityByStage(rates);
const scored = (entityId, stage, pWin, daysInStage = 5) => ({
  entityId, name: entityId, amount: null, stage, daysInStage, medianDaysInStage: null,
  intentBand: null, pWinBase: winByStage[stage], pWin, drivers: [], facts: {},
});
// Four closed-won negotiation deals, closing 10 / 20 / 40 / 80 days after entering the stage.
const negotiationCurve = kaplanMeierCurve([
  { days: 10, censored: false }, { days: 20, censored: false },
  { days: 40, censored: false }, { days: 80, censored: false },
]);

test('P(won within N days) = P(win) x P(closes within N); longer horizons never shrink it', () => {
  const model = { rates, winByStage, curvesByStage: { negotiation: negotiationCurve } };
  const out = dealOutlookFromScores([scored('a', 'negotiation', 0.5), scored('b', 'negotiation', 0.7)], model, [30, 90]);
  assert.deepEqual(out.horizons, [30, 90]);
  const b = out.deals.find(d => d.entityId === 'b');
  // 5 days in: of the deals still open at day 5, half had closed by day 35.
  assert.ok(Math.abs(b.pWinWithin[30] - 0.35) < 1e-9);
  assert.ok(Math.abs(b.pWinWithin[90] - 0.7) < 1e-9);
  assert.deepEqual(out.deals.map(d => d.entityId), ['b', 'a']);
});

test('a stage with no timing history reports null (unknown, not zero) and ranks by its P(win) ceiling', () => {
  const model = { rates, winByStage, curvesByStage: { negotiation: negotiationCurve } };
  const out = dealOutlookFromScores(
    [scored('timed', 'negotiation', 0.4), scored('likely-but-untimed', 'demo', 0.9)], model, [30]);
  const untimed = out.deals.find(d => d.entityId === 'likely-but-untimed');
  assert.equal(untimed.pWinWithin[30], null);
  assert.equal(untimed.timingBasis, 'no_history');
  assert.equal(out.deals.find(d => d.entityId === 'timed').timingBasis, 'judged');
  // 0.9 to win, timing unknown, is not buried under 0.4 x 0.5 = 0.2 within 30 days.
  assert.deepEqual(out.deals.map(d => d.entityId), ['likely-but-untimed', 'timed']);
});

test('under MIN_TIMING_WINS won deals behind the curve, the window is not judged', () => {
  const thin = dealOutlookFromScores([scored('b', 'negotiation', 0.7)],
    { rates, winByStage, curvesByStage: { negotiation: negotiationCurve }, timingWinsByStage: { negotiation: MIN_TIMING_WINS - 1 } }, [30]);
  assert.equal(thin.deals[0].pWinWithin[30], null);
  assert.equal(thin.deals[0].timingBasis, 'too_few_wins');
  assert.equal(thin.deals[0].timingWins, MIN_TIMING_WINS - 1);

  const enough = dealOutlookFromScores([scored('b', 'negotiation', 0.7)],
    { rates, winByStage, curvesByStage: { negotiation: negotiationCurve }, timingWinsByStage: { negotiation: MIN_TIMING_WINS } }, [30]);
  assert.ok(Math.abs(enough.deals[0].pWinWithin[30] - 0.35) < 1e-9);
  assert.equal(enough.deals[0].timingBasis, 'judged');
});

test('a deal older than every win the curve has seen is not judged, rather than read as 0%', () => {
  // Wins at 10/20/40/80 days, plus two deals still open at 100 and 120: survival never reaches
  // zero, so past day 80 the curve is flat and would answer 0% for any window.
  const flatTail = kaplanMeierCurve([
    { days: 10, censored: false }, { days: 20, censored: false }, { days: 40, censored: false },
    { days: 80, censored: false }, { days: 100, censored: true }, { days: 120, censored: true },
  ]);
  const model = { rates, winByStage, curvesByStage: { negotiation: flatTail }, timingWinsByStage: { negotiation: 6 } };
  // The latest negotiation win closed 80 days in; this deal has sat there 85.
  const out = dealOutlookFromScores([scored('stalled', 'negotiation', 0.6, 85), scored('fresh', 'negotiation', 0.5, 5)], model, [30, 90]);
  const stalled = out.deals.find(d => d.entityId === 'stalled');
  assert.equal(stalled.timingBasis, 'past_history');
  assert.equal(stalled.timingLastWinDay, 80);
  assert.equal(stalled.pWinWithin[30], null);
  assert.equal(stalled.pWinWithin[90], null);
  assert.equal(out.deals.find(d => d.entityId === 'fresh').timingBasis, 'judged');
});

test('an unknown value encodes neutral: a missing ICP score is not a zero ICP score', () => {
  const x = encodeWinFeatures({
    ageRatio: null, daysQuiet: null, icpFit: null, icpPain: null, icpAbility: null,
    intentScore: null, stakeholderCount: null, openObjections: null,
  });
  assert.ok(Object.values(x).every(v => v === 0));
  assert.deepEqual(explainWinProbability(0.45, x, DEFAULT_WIN_COEFFS).drivers, []);
  // A real zero still counts as a real zero.
  assert.equal(encodeWinFeatures({ icpFit: 0 }).icp_fit, -1);
});

test('with no timing anywhere, deals rank by overall chance to win', () => {
  const model = { rates, winByStage, curvesByStage: {} };
  const out = dealOutlookFromScores(
    [scored('low', 'demo', 0.2), scored('high', 'discovery', 0.6), scored('mid', 'negotiation', 0.4)], model, [30]);
  assert.deepEqual(out.deals.map(d => d.entityId), ['high', 'mid', 'low']);
  assert.ok(out.deals.every(d => d.pWinWithin[30] === null));
});
