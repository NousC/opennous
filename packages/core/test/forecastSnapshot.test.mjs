// Forecast snapshots — the pure halves: period resolution and row shaping.
//
// The snapshot is the only record of what the forecast said while a period was still
// open, so the row's shape IS the grading contract: expected + the band + the per-deal
// detail, capped so big workspaces do not write megabyte rows.
//
// Run: pnpm --filter @nous/core build && node --test packages/core/test/forecastSnapshot.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePeriod, snapshotFromForecast, FORECAST_MODEL_VERSION } from '../dist/services/forecastRun.js';

const AUG = new Date('2026-08-20T15:30:00.000Z');

// ─── periods ─────────────────────────────────────────────────────────────────

test('default period is the current calendar month', () => {
  const p = resolvePeriod({}, AUG);
  assert.equal(p.label, 'month');
  assert.equal(p.start.toISOString().slice(0, 10), '2026-08-01');
  assert.equal(p.end.toISOString().slice(0, 10), '2026-08-31');
});

test('quarter spans the right three months', () => {
  const p = resolvePeriod({ period: 'quarter' }, AUG);
  assert.equal(p.label, 'quarter');
  assert.equal(p.start.toISOString().slice(0, 10), '2026-07-01');
  assert.equal(p.end.toISOString().slice(0, 10), '2026-09-30');
});

test('explicit dates win', () => {
  const p = resolvePeriod({ period_start: '2026-09-01', period_end: '2026-09-15' }, AUG);
  assert.equal(p.label, 'custom');
  assert.equal(p.end.toISOString().slice(0, 10), '2026-09-15');
});

test('a backwards or unparseable custom range falls back to the month, not an error', () => {
  for (const body of [
    { period_start: '2026-09-15', period_end: '2026-09-01' },
    { period_start: 'garbage', period_end: '2026-09-01' },
  ]) {
    assert.equal(resolvePeriod(body, AUG).label, 'month');
  }
});

test('a December month-end does not leak into January', () => {
  const p = resolvePeriod({}, new Date('2026-12-05T00:00:00.000Z'));
  assert.equal(p.end.toISOString().slice(0, 10), '2026-12-31');
});

// ─── row shaping ─────────────────────────────────────────────────────────────

const fakeRun = (dealCount) => ({
  period: { start: '2026-08-01T00:00:00.000Z', end: '2026-08-31T23:59:59.000Z', label: 'month', days_remaining: 11, calendar: 'calendar' },
  basis: 'blended',
  expected: 180000,
  bands: { p10: 130000, p50: 175000, p90: 245000, mean: 180000, iterations: 10000, concentration: 0.4 },
  dealCount,
  missingAmountCount: 1,
  openPipeline: 400000,
  model_version: FORECAST_MODEL_VERSION,
  deals: Array.from({ length: dealCount }, (_, i) => ({
    entityId: `e${i}`, name: `Deal ${i}`, amount: 1000 + i, stage: 'discovery',
    daysInStage: 5, pWinBase: 0.3, pWin: 0.351234567, pClose: 0.51234567,
    pCloseBase: 0.5, intentMultiplier: 1, intentBand: i === 0 ? 'Hot' : null,
    contribution: 10000 - i,
  })),
});

test('the snapshot row carries the grading contract: expected, band, basis, version', () => {
  const row = snapshotFromForecast('ws-1', fakeRun(3));
  assert.equal(row.workspace_id, 'ws-1');
  assert.equal(row.period_start, '2026-08-01');
  assert.equal(row.period_end, '2026-08-31');
  assert.equal(row.expected, 180000);
  assert.equal(row.p10, 130000);
  assert.equal(row.p90, 245000);
  assert.equal(row.basis, 'blended');
  assert.equal(row.model_version, FORECAST_MODEL_VERSION);
  assert.equal(row.deal_count, 3);
});

test('per-deal detail keeps both the base and adjusted probabilities — auditable later', () => {
  const row = snapshotFromForecast('ws-1', fakeRun(1));
  const d = row.deals[0];
  assert.equal(d.pWinBase, 0.3);
  assert.equal(d.pWin, 0.3512);           // rounded, not raw float noise
  assert.equal(d.pClose, 0.5123);
  assert.equal(d.intentBand, 'Hot');
});

test('the per-deal list is capped — a 5k-account workspace writes a bounded row', () => {
  const row = snapshotFromForecast('ws-1', fakeRun(500));
  assert.equal(row.deal_count, 500, 'the COUNT must stay truthful');
  assert.ok(row.deals.length <= 200, `deals not capped: ${row.deals.length}`);
});
