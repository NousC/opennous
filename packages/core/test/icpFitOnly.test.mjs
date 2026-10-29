// ICP is fit only (GET-689): who they are moves the ICP score; timing (hiring, funding,
// intent) and engagement (pipe.*) do not. Exclusions always count, whatever they read.
//
// Run: pnpm --filter @nous/core build && node --test packages/core/test/icpFitOnly.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { icpSignals, countsTowardIcp, layerForFeature } from '../dist/db/scorecard.js';
import { scoreToPrediction, modelVersion } from '../dist/icp/scorecard.js';

const sig = (key, weight, rule) => ({
  id: key, workspace_id: 'w', key, label: key, weight, rule,
  coverage: 0, added_in: null, active: true, created_at: '', updated_at: '',
});

const RULES = [
  sig('saas', 20, { feature: 'industry', op: 'eq', value: 'saas' }),
  sig('stack', 10, { feature: 'signal.stack', op: 'exists' }),
  sig('hiring', 15, { feature: 'signal.hiring', op: 'exists' }),
  sig('replied', 15, { feature: 'pipe.replied', op: 'exists' }),
  sig('agency', -20, { feature: 'pipe.is_agency', op: 'exists', disqualify: true }),
];

test('timing and engagement are intent, stack is fit', () => {
  assert.equal(layerForFeature('signal.stack'), 'fit');
  assert.equal(layerForFeature('pipe.replied'), 'intent');
  assert.equal(countsTowardIcp('signal.hiring'), false);
  assert.equal(countsTowardIcp('industry'), true);
  assert.deepEqual(icpSignals(RULES).map(s => s.key), ['saas', 'stack', 'agency']);
});

test('a reply or a hiring spike does not move the ICP score', () => {
  const base = scoreToPrediction({ industry: 'saas' }, RULES);
  const busy = scoreToPrediction({ industry: 'saas', 'signal.hiring': 1, 'pipe.replied': true }, RULES);
  assert.equal(busy.score, base.score);
});

test('an exclusion still excludes, even on a pipe.* feature', () => {
  const r = scoreToPrediction({ industry: 'saas', 'pipe.is_agency': true }, RULES);
  assert.deepEqual(r.excluded?.map?.(e => e.key) ?? r.firedSignals.filter(f => f.key === 'agency').map(f => f.key), ['agency']);
  assert.ok(r.score < scoreToPrediction({ industry: 'saas' }, RULES).score);
});

test('the scorer version is part of the model version', () => {
  assert.match(modelVersion(RULES), /^sc_/);
});
