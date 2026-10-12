// The two pure decisions in the risk grader (GET-402): which rows need a grade, and what a batch
// reply is allowed to write. Run: node --test apps/worker/tests/gradeRiskSeverity.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { needsGrade, parseGrades } from '../scripts/gradeRiskSeverity.mjs';

test('a backfilled miner risk and a Fellow health-read risk need a grade', () => {
  assert.equal(needsGrade({ category: 'risk_signal', metadata: { severity: 'at_risk', mined_from: 'o1', signal_type: 'health_risk' } }), true);
  assert.equal(needsGrade({ category: 'risk_signal', metadata: { severity: 'at_risk', signal_type: 'health_risk', meeting_id: 'm1' } }), true);
});

test('a row a model already graded is skipped, so the pass is idempotent', () => {
  assert.equal(needsGrade({ category: 'risk_signal', metadata: { severity: 'friction', severity_source: 'graded' } }), false);
});

test('a Noema-extracted risk keeps the extractor\'s grade', () => {
  // The extractor read the whole conversation; a re-grade from the quote is a worse reading.
  assert.equal(needsGrade({ category: 'risk_signal', metadata: { severity: 'stated_churn', extraction_source: 'gmail' } }), false);
});

test('anything that is not a risk_signal is not touched', () => {
  assert.equal(needsGrade({ category: 'pain', metadata: { signal_type: 'health_risk' } }), false);
  assert.equal(needsGrade({ category: 'expansion_signal', metadata: { stance: 'asked' } }), false);
});

test('a reply is parsed leniently and graded strictly', () => {
  const g = parseGrades('Here you go:\n[{"i":0,"severity":"stated_churn"},{"i":1,"severity":"severe"},{"i":"2","severity":"friction"},{"severity":"at_risk"}]');
  assert.deepEqual([...g.entries()], [[0, 'stated_churn'], [2, 'friction']]);
  assert.equal(parseGrades('no json here').size, 0);
});
