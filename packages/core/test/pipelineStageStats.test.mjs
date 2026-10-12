// Per-pipeline stage medians: the denominator behind "94 days in Negotiation". Pure tests of
// the grouping (per pipeline, never pooled), the honesty floors (small samples and mostly
// still-running stages stay silent), the zero-length rule, the re-sync collapse, and the lookup.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computePipelineStageStats, pipelineStageSampleSizes, typicalDaysFor, getPipelineStageStats,
  dealStageOccupanciesForStats, PIPELINE_STATS_MIN_SAMPLE, PIPELINE_STATS_MIN_OCCUPANCY_DAYS,
} from '../dist/db/pipelineStageStats.js';

const D = (days) => new Date(Date.UTC(2026, 0, 1) + days * 864e5).toISOString();
const NOW = Date.UTC(2026, 0, 1) + 100 * 864e5;

// n deals, each with one occupancy of `days` in `label`, in `pipelineRef`.
const deals = (pipelineRef, label, days, n, censored = false) =>
  Array.from({ length: n }, () => ({ pipelineRef, occupancies: [{ label, days, censored }] }));

test('the floor is the intelligence layer\'s floor and the zero-length cutoff is a day', () => {
  assert.equal(PIPELINE_STATS_MIN_SAMPLE, 8);
  assert.equal(PIPELINE_STATS_MIN_OCCUPANCY_DAYS, 1);
});

test('every deal is measured against its OWN pipeline; the same stage label is never pooled', () => {
  const rows = computePipelineStageStats([
    ...deals('default', 'Negotiation', 20, 8),
    ...deals('1290000071', 'Negotiation', 60, 8),
  ]);
  assert.deepEqual(rows, [
    { pipelineRef: '1290000071', stageLabel: 'Negotiation', medianDays: 60, sampleN: 8 },
    { pipelineRef: 'default',    stageLabel: 'Negotiation', medianDays: 20, sampleN: 8 },
  ]);
});

test('a deal with no pipeline counts under the empty key, and only there', () => {
  const rows = computePipelineStageStats([
    ...deals(null, 'Demo', 5, 8),
    ...deals('default', 'Demo', 40, 4),   // four in the sales pipeline: not enough on their own
  ]);
  assert.deepEqual(rows, [{ pipelineRef: '', stageLabel: 'Demo', medianDays: 5, sampleN: 8 }]);
});

test('below the sample floor there is no row: silence, not a guess', () => {
  assert.deepEqual(computePipelineStageStats(deals('default', 'Negotiation', 20, 7)), []);
  assert.equal(computePipelineStageStats(deals('default', 'Negotiation', 20, 8)).length, 1);
  // The floor is a parameter for callers that want a different one.
  assert.equal(computePipelineStageStats(deals('default', 'Negotiation', 20, 3), { minSample: 3 }).length, 1);
});

test('same-day occupancies are re-sync artefacts and never count, in the row or in the sample size', () => {
  const input = [...deals('default', 'Qualified', 10, 8), ...deals('default', 'Qualified', 0.2, 5)];
  assert.deepEqual(computePipelineStageStats(input), [{ pipelineRef: 'default', stageLabel: 'Qualified', medianDays: 10, sampleN: 8 }]);
  assert.deepEqual(pipelineStageSampleSizes(input), [{ pipelineRef: 'default', stageLabel: 'Qualified', sampleN: 8 }]);
  // Seven real ones plus five artefacts is seven, so no row.
  assert.deepEqual(computePipelineStageStats([...deals('default', 'Qualified', 10, 7), ...deals('default', 'Qualified', 0, 5)]), []);
});

test('a deal still sitting in a stage counts as "at least this long", not as a finished sample', () => {
  // Five finished at 5..9 days, five still running past 100. A plain median over the ten
  // would say 50; Kaplan-Meier says the half-way point is reached at 9.
  const input = [
    ...[5, 6, 7, 8, 9].map(days => ({ pipelineRef: 'default', occupancies: [{ label: 'Proposal', days, censored: false }] })),
    ...deals('default', 'Proposal', 100, 5, true),
  ];
  assert.deepEqual(computePipelineStageStats(input), [{ pipelineRef: 'default', stageLabel: 'Proposal', medianDays: 9, sampleN: 10 }]);
});

test('when most deals are still sitting there the median cannot be named, so there is no row', () => {
  const input = [...deals('default', 'Proposal', 3, 2), ...deals('default', 'Proposal', 40, 8, true)];
  assert.deepEqual(computePipelineStageStats(input), []);
  // ...but the sample size is still reported, so the job can say why it stayed silent.
  assert.deepEqual(pipelineStageSampleSizes(input), [{ pipelineRef: 'default', stageLabel: 'Proposal', sampleN: 10 }]);
});

test('typicalDaysFor: exact (pipeline, stage) lookup; null for a missing row, a thin row, or no stage', () => {
  const stats = new Map([
    ['default', new Map([
      ['Negotiation', { pipelineRef: 'default', stageLabel: 'Negotiation', medianDays: 21, sampleN: 12, computedAt: D(0) }],
      ['Demo',        { pipelineRef: 'default', stageLabel: 'Demo',        medianDays: 4,  sampleN: 3,  computedAt: D(0) }],
    ])],
    ['', new Map([
      ['Negotiation', { pipelineRef: '', stageLabel: 'Negotiation', medianDays: 50, sampleN: 9, computedAt: D(0) }],
    ])],
  ]);
  assert.deepEqual(typicalDaysFor(stats, 'default', 'Negotiation'), { medianDays: 21, sampleN: 12 });
  assert.equal(typicalDaysFor(stats, 'default', 'Demo'), null);                 // under the floor
  assert.equal(typicalDaysFor(stats, 'default', 'Closed Won'), null);           // no row
  assert.equal(typicalDaysFor(stats, '1290000071', 'Negotiation'), null);       // other pipeline: never borrowed
  assert.equal(typicalDaysFor(stats, 'default', null), null);
  assert.equal(typicalDaysFor(stats, 'default', ''), null);
  // A deal with no pipeline looks up the empty key, whichever spelling of "none" it carries.
  assert.deepEqual(typicalDaysFor(stats, null, 'Negotiation'), { medianDays: 50, sampleN: 9 });
  assert.deepEqual(typicalDaysFor(stats, undefined, 'Negotiation'), { medianDays: 50, sampleN: 9 });
  assert.deepEqual(typicalDaysFor(stats, '', 'Negotiation'), { medianDays: 50, sampleN: 9 });
});

// Observations as the sync stores them: label in value, id + verdict in raw.
const obs = (label, day, stageId, status = 'open') => ({ value: label, observed_at: D(day), raw: { stage_id: stageId, status } });

test('dealStageOccupanciesForStats: a re-sync re-writing the same stage is one occupancy from the FIRST write', () => {
  const occ = dealStageOccupanciesForStats([
    obs('Negotiation', 0, 'neg'),
    obs('Negotiation', 19, 'neg'),      // the amount was edited on day 19; the stage did not change
    obs('Contract Sent', 30, 'cs'),
  ], { now: NOW });
  assert.deepEqual(occ.map(o => [o.label, Math.round(o.days), o.censored]), [
    ['Negotiation', 30, false],
    ['Contract Sent', 70, true],
  ]);
});

test('dealStageOccupanciesForStats: a genuine return to an earlier stage stays two occupancies', () => {
  const occ = dealStageOccupanciesForStats([
    obs('Demo', 0, 'demo'), obs('Proposal', 10, 'prop'), obs('Demo', 20, 'demo'),
  ], { now: NOW });
  assert.deepEqual(occ.map(o => [o.label, Math.round(o.days), o.censored]), [
    ['Demo', 10, false], ['Proposal', 10, false], ['Demo', 80, true],
  ]);
});

test('dealStageOccupanciesForStats: a later duplicate carrying the won verdict still ends the timeline', () => {
  // The history row could not resolve the stage index (verdict null); the current-state row can.
  const occ = dealStageOccupanciesForStats([
    obs('Negotiation', 0, 'neg'),
    obs('Closed Won', 50, 'cw', null),
    obs('Closed Won', 60, 'cw', 'won'),
  ], { now: NOW });
  assert.deepEqual(occ.map(o => [o.label, Math.round(o.days), o.censored]), [['Negotiation', 50, false]]);
});

test('dealStageOccupanciesForStats: the same label in different pipelines is different stages when the ids say so', () => {
  const occ = dealStageOccupanciesForStats([
    obs('Won', 0, 'exp-won'), obs('Won', 10, 'sp-won'),
  ], { now: NOW });
  assert.equal(occ.length, 2);
});

// A PostgREST-shaped stub: every builder call chains, the awaited call returns the result.
function fakeSupabase(result) {
  const q = { select: () => q, eq: () => q, order: () => q, range: async () => result };
  return { from: () => q };
}

test('getPipelineStageStats: a table the migration has not created yet reads as nothing computed', async () => {
  for (const code of ['42P01', 'PGRST205']) {
    const stats = await getPipelineStageStats(fakeSupabase({ data: null, error: { code, message: 'missing' } }), 'ws');
    assert.equal(stats.size, 0);
  }
  await assert.rejects(
    () => getPipelineStageStats(fakeSupabase({ data: null, error: { code: '42501', message: 'denied' } }), 'ws'),
    /denied/,
  );
});

test('getPipelineStageStats: rows come back keyed pipeline then stage, ready for typicalDaysFor', async () => {
  const stats = await getPipelineStageStats(fakeSupabase({ data: [
    { pipeline_ref: 'default', stage_label: 'Negotiation', median_days: 21, sample_n: 12, computed_at: D(0) },
    { pipeline_ref: '',        stage_label: 'Negotiation', median_days: 50, sample_n: 9,  computed_at: D(0) },
  ], error: null }), 'ws');
  assert.deepEqual([...stats.keys()].sort(), ['', 'default']);
  assert.deepEqual(typicalDaysFor(stats, 'default', 'Negotiation'), { medianDays: 21, sampleN: 12 });
  assert.deepEqual(typicalDaysFor(stats, null, 'Negotiation'), { medianDays: 50, sampleN: 9 });
  assert.equal(stats.get('default').get('Negotiation').computedAt, D(0));
});
