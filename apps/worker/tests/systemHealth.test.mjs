// System health history (GET-201): what gets kept, and that keeping it never breaks the
// pipeline. Fake supabase, no database, no model.
//
// Run: node --test apps/worker/tests/systemHealth.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recordPipelineEvent } from '../src/lib/pipelineEvents.mjs';
import { meterLLM } from '../src/utils/meterLLM.mjs';
import { recordSnapshot } from '../src/workers/invariants.mjs';
import { SIGNAL_WORTHY_TYPES } from '../src/signals/index.mjs';

function fakeSupabase({ rpcData = [], insertError = null } = {}) {
  const calls = { inserts: [], upserts: [], rpc: [] };
  return {
    calls,
    from: (table) => ({
      insert: async (row) => { calls.inserts.push({ table, row }); return { error: insertError }; },
      upsert: async (rows, opts) => { calls.upserts.push({ table, rows, opts }); return { error: null }; },
    }),
    rpc: async (fn, args) => { calls.rpc.push({ fn, args }); return { data: rpcData, error: null }; },
  };
}

test('a pipeline event is kept with its workspace, feature, model and reason', async () => {
  const sb = fakeSupabase();
  await recordPipelineEvent(sb, { workspaceId: 'ws1', kind: 'unavailable', feature: 'activity-signals-extract', model: 'z-ai/glm-5.2', detail: { status: 402 } });
  assert.deepEqual(sb.calls.inserts[0], {
    table: 'pipeline_events',
    row: { workspace_id: 'ws1', kind: 'unavailable', feature: 'activity-signals-extract', model: 'z-ai/glm-5.2', detail: { status: 402 } },
  });
});

test('an unknown kind is ignored, and a failed write never throws into the pipeline', async () => {
  const sb = fakeSupabase({ insertError: { message: 'relation "pipeline_events" does not exist' } });
  await recordPipelineEvent(sb, { kind: 'mystery' });
  assert.equal(sb.calls.inserts.length, 0);
  await assert.doesNotReject(recordPipelineEvent(sb, { kind: 'fallback' }));
});

test('metering a call the fallback answered records the fallback, even when the failed call billed nothing', async () => {
  const sb = fakeSupabase();
  await meterLLM(sb, 'ws1', 'signal-extraction', {
    model: 'z-ai/glm-5.2', usage: { input_tokens: 10, output_tokens: 5 }, cost_usd: 0.001,
    failed_attempts: [
      { model: 'deepseek/deepseek-v4.1-flash', reason: 'unavailable: openrouter 402', provider: null, cost_usd: null },
      { model: 'deepseek/deepseek-v4.1-flash', reason: 'empty answer (finish: length)', provider: 'Parasail', cost_usd: 0.004, usage: { input_tokens: 10, output_tokens: 7000 } },
    ],
  });
  const events = sb.calls.inserts.filter(i => i.table === 'pipeline_events');
  assert.equal(events.length, 2);
  assert.equal(events[0].row.detail.answered_by, 'z-ai/glm-5.2');
  const usage = sb.calls.inserts.filter(i => i.table === 'llm_usage');
  assert.equal(usage.length, 2, 'the answering call, plus the one billed failure');
});

test("the daily snapshot passes the worker's own extractable types and upserts one row per metric per day", async () => {
  const sb = fakeSupabase({ rpcData: [{ metric: 'extraction.inbound_sources', value: '1500' }, { metric: 'extraction.inbound_sources_with_claims', value: 300 }] });
  const rows = await recordSnapshot(sb, 'ws1', { day: new Date('2026-09-13T04:30:00Z') });
  assert.deepEqual(sb.calls.rpc[0].args.inbound_types.sort(), [...SIGNAL_WORTHY_TYPES].sort());
  assert.deepEqual(rows[0], { measured_on: '2026-09-13', workspace_id: 'ws1', metric: 'extraction.inbound_sources', value: 1500 });
  assert.equal(sb.calls.upserts[0].opts.onConflict, 'measured_on,workspace_id,metric');
});
