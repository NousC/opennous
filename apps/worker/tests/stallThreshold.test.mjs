// Stall detection against the pipeline's own median (services/revenueReport.mjs).
//
// A day count on its own says nothing: 40 days in Negotiation is a stall in a pipeline that
// typically clears it in 20 and business as usual in one that takes 45. These pin the bar
// (typical x 1.5, floored at 14, capped at 120, the flat 30 when there is no history) and the
// rule that every deal is measured against its OWN pipeline's population, never a pooled one.
// Pure: no DB, no network, no LLM.
//
// Run: node --test apps/worker/tests/stallThreshold.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stallThreshold, stallCheck } from '../src/services/revenueReport.mjs';

// The shape core getPipelineStageStats returns: pipelineRef → stage label → stat.
const statsOf = (...rows) => {
  const m = new Map();
  for (const [pipelineRef, stageLabel, medianDays, sampleN = 12] of rows) {
    const byLabel = m.get(pipelineRef) ?? m.set(pipelineRef, new Map()).get(pipelineRef);
    byLabel.set(stageLabel, { pipelineRef, stageLabel, medianDays, sampleN, computedAt: '2026-09-15T03:45:00.000Z' });
  }
  return m;
};

// An open deal as gatherAccounts shapes it: `current` is the last occupancy, censored = still there.
const openDeal = (days, { pipelineRef = 'default', label = 'Negotiation', censored = true } = {}) => ({
  id: 'd1', pipelineRef, current: { label, stageId: null, days, censored, enteredAt: '' },
});

test('no typical: the flat default bar', () => {
  assert.deepEqual(stallThreshold(null), { days: 30, basis: 'default' });
  assert.deepEqual(stallThreshold(undefined), { days: 30, basis: 'default' });
});

test('small median floors at 14 days', () => {
  assert.deepEqual(stallThreshold({ medianDays: 5, sampleN: 9 }), { days: 14, basis: 'pipeline_median', typicalDays: 5, sampleN: 9 });
});

test('normal median: 1.5x, rounded', () => {
  assert.deepEqual(stallThreshold({ medianDays: 20, sampleN: 12 }), { days: 30, basis: 'pipeline_median', typicalDays: 20, sampleN: 12 });
  assert.equal(stallThreshold({ medianDays: 21, sampleN: 12 }).days, 32);   // 31.5 rounds up
});

test('huge median caps at 120 days', () => {
  assert.deepEqual(stallThreshold({ medianDays: 200, sampleN: 30 }), { days: 120, basis: 'pipeline_median', typicalDays: 200, sampleN: 30 });
});

test('a 40-day deal is stalled against a 20-day median and not against a 45-day one', () => {
  const quick = statsOf(['default', 'Negotiation', 20]);
  const slow = statsOf(['default', 'Negotiation', 45]);
  const s1 = stallCheck(openDeal(40), quick);
  assert.equal(s1.stalled, true);
  assert.deepEqual(s1.threshold, { days: 30, basis: 'pipeline_median', typicalDays: 20, sampleN: 12 });
  const s2 = stallCheck(openDeal(40), slow);
  assert.equal(s2.stalled, false);
  assert.equal(s2.threshold.days, 68);   // round(67.5)
});

test('each deal is measured against its OWN pipeline, never a pooled one', () => {
  const stats = statsOf(['default', 'Negotiation', 20], ['expansion', 'Negotiation', 45]);
  assert.equal(stallCheck(openDeal(40, { pipelineRef: 'default' }), stats).stalled, true);
  assert.equal(stallCheck(openDeal(40, { pipelineRef: 'expansion' }), stats).stalled, false);
  // A deal with no pipeline_id looks up '' and finds nothing here: the flat 30-day bar.
  const noPipe = stallCheck(openDeal(40, { pipelineRef: null }), stats);
  assert.equal(noPipe.stalled, true);
  assert.equal(noPipe.threshold.basis, 'default');
});

test('a stat under the n=8 floor is not a typical: back to the default bar', () => {
  const thin = statsOf(['default', 'Negotiation', 45, 7]);
  const s = stallCheck(openDeal(40), thin);
  assert.equal(s.threshold.basis, 'default');
  assert.equal(s.stalled, true);
});

test('only a deal still sitting in the stage can be stalled', () => {
  const stats = statsOf(['default', 'Negotiation', 20]);
  assert.equal(stallCheck(openDeal(40, { censored: false }), stats).stalled, false);
  assert.equal(stallCheck({ id: 'd2', pipelineRef: 'default', current: null }, stats).stalled, false);
  assert.equal(stallCheck(openDeal(29), statsOf()).stalled, false);   // one day under the default bar
});
