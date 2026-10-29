// Forecast layer 3 — fitting the win model on a workspace's closed deals (Cloud-only, GET-754
// slice 8). The training panel, the unfreeze schedule that keeps a 12-win workspace from learning
// noise, sign constraints that outrank a small sample, and a deterministic fit. Applying the model
// is public: test/winModel.test.mjs.
//
// Run: pnpm --filter @nous/core build && node --test packages/core/test/winModelFit.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WIN_FEATURES, DEFAULT_WIN_COEFFS, encodeWinFeatures } from '../dist/services/winModel.js';
import { trainingRowsFromLadder, unfrozenKeys, fitWinModel, PANEL_WEEKS_CAP } from '../dist/icp/winModelFit.js';

const NOW = Date.parse('2026-08-31T12:00:00.000Z');
const DAY = 86_400_000;
const daysAgo = (n) => new Date(NOW - n * DAY).toISOString();

// ─── the training panel ──────────────────────────────────────────────────────

const hop = (stage, at, rank = 0) => ({ stage, at, rank });

test('a won deal yields rows for every rung, all labelled 1', () => {
  const rows = trainingRowsFromLadder([
    hop('connected', daysAgo(100)),
    hop('discovery', daysAgo(60)),
    hop('closed_won', daysAgo(10)),
  ]);
  assert.ok(rows.length >= 2);
  assert.ok(rows.every(r => r.label === 1));
  assert.ok(rows.every(r => r.resolvedAt === daysAgo(10)));
  assert.ok(!rows.some(r => r.stage === 'closed_won'), 'the win itself became a row');
});

test('a lost deal yields rows labelled 0; a still-open deal yields NOTHING', () => {
  const lost = trainingRowsFromLadder([hop('discovery', daysAgo(60)), hop('closed_lost', daysAgo(10))]);
  assert.ok(lost.length >= 1 && lost.every(r => r.label === 0));
  const open = trainingRowsFromLadder([hop('discovery', daysAgo(60))]);
  assert.deepEqual(open, [], 'an unresolved deal has no answer and must not be labelled');
});

test('a won-then-churned deal is still a WIN, resolved at the close date', () => {
  // 'churned' is only reachable FROM closed_won, so this ladder is a former customer —
  // the sale succeeded. Keying off the last hop alone would call it a loss.
  const rows = trainingRowsFromLadder([
    hop('discovery', daysAgo(120)),
    hop('closed_won', daysAgo(60)),
    hop('churned', daysAgo(10)),
  ]);
  assert.ok(rows.length >= 1);
  assert.ok(rows.every(r => r.label === 1), 'won-then-churned must be labelled a win');
  assert.ok(rows.every(r => r.resolvedAt === daysAgo(60)), 'resolved at the WIN, not the churn');
  // Time on the customer side of the fence is not open-pipeline evidence.
  assert.ok(!rows.some(r => r.stage === 'closed_won' || r.stage === 'churned'));
});

test('a long rung yields WEEKLY panel rows — stall gets its variance', () => {
  // 5 weeks at discovery before winning: entry row + weekly rows while it sat there.
  const rows = trainingRowsFromLadder([hop('discovery', daysAgo(45)), hop('closed_won', daysAgo(10))]);
  const discovery = rows.filter(r => r.stage === 'discovery');
  assert.ok(discovery.length >= 4, `expected weekly rows, got ${discovery.length}`);
  // Ascending weekly spacing from entry.
  const times = discovery.map(r => Date.parse(r.enteredAt));
  for (let i = 1; i < times.length; i++) assert.equal(times[i] - times[i - 1], 7 * DAY);
});

test('the panel is capped so a year-long rung cannot flood the training set', () => {
  const rows = trainingRowsFromLadder([hop('discovery', daysAgo(400)), hop('closed_won', daysAgo(5))]);
  assert.ok(rows.filter(r => r.stage === 'discovery').length <= PANEL_WEEKS_CAP);
});

// ─── the unfreeze schedule ───────────────────────────────────────────────────

test('under 20 wins nothing unfreezes; 20-49 frees tier 1; 50+ frees all', () => {
  assert.deepEqual(unfrozenKeys(0), []);
  assert.deepEqual(unfrozenKeys(19), []);
  const t1 = unfrozenKeys(20);
  assert.deepEqual([...t1].sort(), ['age_ratio', 'days_quiet', 'icp_fit', 'intent']);
  assert.equal(unfrozenKeys(50).length, WIN_FEATURES.length);
});

// ─── fitting ─────────────────────────────────────────────────────────────────

// Synthetic cohort builder: n wins + n losses, one row each, distinct resolution dates,
// with a chosen feature separating winners from losers.
const cohort = (n, winnerX, loserX) => {
  const rows = [];
  for (let i = 0; i < n; i++) {
    rows.push({ x: { ...encodeWinFeatures({}), ...winnerX }, pStage: 0.5, label: 1, resolvedAt: daysAgo(400 - i) });
    rows.push({ x: { ...encodeWinFeatures({}), ...loserX }, pStage: 0.5, label: 0, resolvedAt: daysAgo(399.5 - i) });
  }
  return rows;
};

test('under 20 wins the fit returns the defaults untouched — basis stays honest', () => {
  const fit = fitWinModel(cohort(10, { icp_fit: 1 }, { icp_fit: -1 }));
  assert.equal(fit.basis, 'default');
  assert.deepEqual(fit.coefficients, DEFAULT_WIN_COEFFS);
  assert.equal(fit.beatsBaseline, false);
});

test('with real volume and a real signal, the fit finds it and beats the baseline', () => {
  // 40 wins where fit is high, 40 losses where fit is low — an unmissable pattern.
  const fit = fitWinModel(cohort(40, { icp_fit: 1 }, { icp_fit: -1 }));
  assert.equal(fit.basis, 'fitted');
  assert.ok(fit.coefficients.icp_fit > DEFAULT_WIN_COEFFS.icp_fit,
    `signal not learned: ${fit.coefficients.icp_fit}`);
  assert.equal(fit.beatsBaseline, true, JSON.stringify(fit.holdout));
  assert.ok(fit.holdout && fit.holdout.rows >= 5);
});

test('a sign constraint holds even against the data — domain knowledge outranks 40 deals', () => {
  // Winners here all had LOW fit, losers HIGH — anti-predictive by construction. An
  // unconstrained fit would go negative; the constraint stops at zero, never below.
  const fit = fitWinModel(cohort(40, { icp_fit: -1 }, { icp_fit: 1 }));
  assert.equal(fit.basis, 'fitted');
  assert.ok(fit.coefficients.icp_fit >= 0, `sign constraint broken: ${fit.coefficients.icp_fit}`);
});

test('tier-2 features stay pinned in the 20-49 win band, whatever the data says', () => {
  // 25 wins, and competitor_present "predicts" winning absurdly well. Tier 2 is frozen at
  // this volume, so the coefficient must remain exactly the default.
  const fit = fitWinModel(cohort(25, { competitor_present: 1 }, { competitor_present: 0 }));
  assert.equal(fit.basis, 'fitted');
  assert.equal(fit.coefficients.competitor_present, DEFAULT_WIN_COEFFS.competitor_present);
});

test('same-day closes count as DISTINCT deals when dealId is present', () => {
  // Date-only CRM imports stamp every deal closed the same day with an identical
  // midnight ISO. Counting distinct wins by resolvedAt alone would collapse a whole
  // month-end batch into one win and pin the unfreeze gate shut forever.
  const midnight = '2026-03-31T00:00:00.000Z';
  const rows = [];
  for (let i = 0; i < 25; i++) {
    rows.push({ x: { ...encodeWinFeatures({}), icp_fit: 1 }, pStage: 0.5, label: 1,
      resolvedAt: midnight, dealId: `win-${i}` });
    rows.push({ x: { ...encodeWinFeatures({}), icp_fit: -1 }, pStage: 0.5, label: 0,
      resolvedAt: midnight, dealId: `loss-${i}` });
  }
  const fit = fitWinModel(rows);
  assert.equal(fit.trainingWins, 25, 'same-day wins collapsed into one');
  assert.equal(fit.trainingLosses, 25);
  assert.equal(fit.basis, 'fitted');
});

test('the fit is deterministic — same deals in, same model out', () => {
  const rows = cohort(30, { icp_fit: 1, days_quiet: 0.5 }, { icp_fit: -0.5, days_quiet: 2 });
  assert.deepEqual(fitWinModel(rows), fitWinModel(rows));
});

test('no contrast (all wins) falls back to defaults rather than fitting nonsense', () => {
  const rows = [];
  for (let i = 0; i < 30; i++) {
    rows.push({ x: encodeWinFeatures({}), pStage: 0.5, label: 1, resolvedAt: daysAgo(200 - i) });
  }
  const fit = fitWinModel(rows);
  assert.equal(fit.basis, 'default');
});

test('junk rows are dropped, not fitted', () => {
  const fit = fitWinModel([
    null, { x: null, pStage: 0.5, label: 1, resolvedAt: daysAgo(1) },
    { x: encodeWinFeatures({}), pStage: NaN, label: 0, resolvedAt: daysAgo(2) },
    { x: encodeWinFeatures({}), pStage: 0.5, label: 2, resolvedAt: daysAgo(3) },
  ]);
  assert.equal(fit.trainingRows, 0);
  assert.equal(fit.basis, 'default');
});
