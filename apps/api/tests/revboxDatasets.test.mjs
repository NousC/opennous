// RevBox datasets (GET-874), the API side: the two table steps are workflow-engine steps the server
// accepts in a box job's flow but never from the public /v2 workflows API, and the dataset routes check
// the dataset key before anything reaches the database. The behaviour behind the routes (access,
// visibility, paging, CSV) is tested in packages/core/test/revboxDatasets.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { STEP_TYPES, INTERNAL_STEP_TYPES, checkFlow } from '../src/lib/flows.mjs';
import { workflowsV2Router } from '../src/routes/v2/workflows.mjs';
import { revboxesRouter } from '../src/routes/api/revboxes.mjs';

async function serve(mount, router, user) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { Object.assign(req, user); next(); });
  app.use(mount, router);
  const server = http.createServer(app);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(r => server.close(r)) };
}

test('the table steps are known steps, internal like revbox_delivery', () => {
  for (const t of ['dataset_append', 'dataset_read']) {
    assert.ok(STEP_TYPES.has(t));
    assert.ok(INTERNAL_STEP_TYPES.has(t));
  }
  const flow = checkFlow({ steps: [
    { id: 'rows', type: 'dataset_read', config: { dataset_key: 'win_loss', window: 'last_month' } },
    { id: 'report', type: 'agent', config: { mode: 'write', prompt: 'Report.' } },
    { id: 'row', type: 'dataset_append', config: { dataset_key: 'win_loss', dedupe_from: 'deal' } },
  ] });
  assert.equal(flow.ok, true);
});

// Accepting one is refused by buildColumns' INTERNAL_STEP_TYPES check, as for revbox_delivery.
test('/v2/workflows does not offer the table steps', async () => {
  const srv = await serve('/v2/workflows', workflowsV2Router, { workspaceId: 'ws', memberUserId: 'u1', viewerScope: 'admin' });
  try {
    const t = await (await fetch(`${srv.url}/v2/workflows/triggers`)).json();
    const offered = t.step_types.map(s => s.type);
    assert.ok(!offered.includes('dataset_append') && !offered.includes('dataset_read'));
    assert.ok(offered.includes('agent'));
  } finally { await srv.close(); }
});

test('a dataset route refuses a key that is not a slug before it reads anything', async () => {
  const srv = await serve('/api/revboxes', revboxesRouter, { workspaceId: 'ws', internalUserId: 'u1' });
  try {
    for (const path of ['Bad-Key/rows', 'x%27%3B/export.csv', '1abc/rows']) {
      const r = await fetch(`${srv.url}/api/revboxes/11111111-1111-4111-8111-111111111111/datasets/${path}`);
      assert.equal(r.status, 400, path);
      assert.equal((await r.json()).error, 'Invalid identifier.');
    }
    const put = await fetch(`${srv.url}/api/revboxes/not-a-uuid/datasets/win_loss`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(put.status, 400);
  } finally { await srv.close(); }
});
