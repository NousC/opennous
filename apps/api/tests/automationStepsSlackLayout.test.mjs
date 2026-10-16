// The worker reaches the API's Slack poster through POST /internal/automation-steps/slack (GET-543).
// A Slack layout (GET-858) rides along: the step's format, the AI's content and the ids the
// approval buttons carry. Without a layout the body is what it always was.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';

process.env.SUPABASE_URL ??= 'http://127.0.0.1:1';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-key';
process.env.WORKER_SECRET = 'worker-secret';
const { automationStepsInternalRouter } = await import('../src/routes/automationSteps.mjs');
const { registerAutomationSlack } = await import('../src/lib/automationSteps.mjs');

async function post(body) {
  const app = express();
  app.use(express.json());
  app.use('/internal/automation-steps', automationStepsInternalRouter);
  const server = http.createServer(app).listen(0);
  try {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/internal/automation-steps/slack`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-worker-secret': 'worker-secret' }, body: JSON.stringify(body),
    });
    return r.json();
  } finally { server.close(); }
}

test('a layout is forwarded to the poster; a plain post is unchanged', async () => {
  const seen = [];
  registerAutomationSlack(async (a) => { const { supabase: _s, ...rest } = a; seen.push(rest); return { ok: true }; });
  const run = '33333333-3333-4333-8333-333333333333';
  assert.deepEqual(await post({ workspaceId: 'ws', channelId: 'C1', text: 'Daily usage', format: 'report', content: { title: 'Daily usage' }, runId: run, stepId: 'post', scopeId: 'box' }), { ok: true });
  assert.equal(seen[0].format, 'report');
  assert.deepEqual(seen[0].content, { title: 'Daily usage' });
  assert.equal(seen[0].runId, run);
  assert.equal(seen[0].stepId, 'post');
  // A reference an engine extension adds (GET-910) is passed on as it came.
  assert.equal(seen[0].scopeId, 'box');
  await post({ workspaceId: 'ws', channelId: 'C1', text: 'hi' });
  assert.deepEqual(seen[1], { workspaceId: 'ws', channel: '', channelId: 'C1', userId: null, text: 'hi' });
  // Content that is not an object is not a layout.
  await post({ workspaceId: 'ws', channelId: 'C1', text: 'hi', format: 'report', content: 'oops' });
  assert.equal(seen[2].format, undefined);
});
