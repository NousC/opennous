// What automations cost (GET-714): a run's credits are the wallet's conversion of its own model
// rows, split by step; other workspaces' and other runs' rows never count.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRunRequestId, creditsForRuns } from '../src/lib/automationCredits.mjs';

const R1 = '11111111-1111-4111-8111-111111111111';
const R2 = '22222222-2222-4222-8222-222222222222';

test('a request id names the run and the step', () => {
  assert.deepEqual(parseRunRequestId(`automation-run:${R1}:step:2`), { runId: R1, step: 2 });
  assert.equal(parseRunRequestId('studio-email-draft'), null);
});

test('a run costs the credits of its own rows, rounded up per step and in total', async () => {
  const rows = [
    { request_id: `automation-run:${R1}:step:2`, cost_usd: 0.004, occurred_at: '2026-10-05T10:00:00Z' },
    { request_id: `automation-run:${R1}:step:2`, cost_usd: 0.03, occurred_at: '2026-10-05T10:00:01Z' },
    { request_id: `automation-run:${R2}:step:1`, cost_usd: 0.5, occurred_at: '2026-10-05T10:00:02Z' },
  ];
  const q = { select: () => q, eq: () => q, like: () => q, gte: () => q, order: () => q, range: async () => ({ data: rows, error: null }) };
  const credits = await creditsForRuns({ from: () => q }, 'ws', [{ id: R1, started_at: '2026-10-05T09:00:00Z' }]);
  assert.deepEqual(credits.get(R1), { credits: 7, steps: [{ step: 2, credits: 7 }] });   // $0.034 → 7 credits at the plan's $0.005
  assert.equal(credits.has(R2), false);
});

// GET-881: the row-shaping call of an Add to table step (and a Slack layout's) is the run's cost too.
test('a run counts its dataset and Slack shaping calls, on the step that made them', async () => {
  assert.deepEqual(parseRunRequestId(`automation-run:${R1}:dataset:s3`), { runId: R1, step: null, stepId: 's3' });
  assert.deepEqual(parseRunRequestId(`automation-run:${R1}:slack:x`), { runId: R1, step: null, stepId: null });
  const rows = [
    { request_id: `automation-run:${R1}:step:1`, cost_usd: 0.02, occurred_at: '2026-10-05T10:00:00Z' },
    { request_id: `automation-run:${R1}:dataset:s3`, cost_usd: 0.01, occurred_at: '2026-10-05T10:00:01Z' },
    { request_id: `automation-run:${R1}:slack:x`, cost_usd: 0.005, occurred_at: '2026-10-05T10:00:02Z' },
  ];
  const q = { select: () => q, eq: () => q, like: () => q, gte: () => q, order: () => q, range: async () => ({ data: rows, error: null }) };
  // Without the run's step log the shaping calls still count toward the run.
  const plain = await creditsForRuns({ from: () => q }, 'ws', [{ id: R1, started_at: '2026-10-05T09:00:00Z' }]);
  assert.equal(plain.get(R1).credits, 7);   // $0.035
  // With it, the dataset call lands on the step whose id it names.
  const logged = await creditsForRuns({ from: () => q }, 'ws', [{ id: R1, started_at: '2026-10-05T09:00:00Z', step_log: [{ step: 1, id: 's1' }, { step: 3, id: 's3' }] }]);
  assert.equal(logged.get(R1).credits, 7);
  assert.deepEqual(logged.get(R1).steps.filter(s => s.step > 0), [{ step: 1, credits: 4 }, { step: 3, credits: 2 }]);
});
