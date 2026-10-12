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
