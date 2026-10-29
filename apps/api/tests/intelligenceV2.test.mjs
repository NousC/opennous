// GET /v2/intelligence (GET-1042): the workspace's Intelligence files, whole, for an agent. The
// MCP's read_intelligence reads it. The reader is stubbed through the public hook, so this pins the
// route: the workspace comes from the key (what verifyApiKey sets), never from the request.
//
// Run: node --test apps/api/src/cloud/tests/intelligenceV2.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = 'http://fake-supabase.test';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-test';
process.env.ENCRYPTION_KEY = 'a'.repeat(64);

const { default: express } = await import('express');
const { intelligenceV2Router } = await import('../src/routes/v2/intelligence.mjs');
const { registerIntelligenceSource } = await import('@nous/core');
const { readIntelligence } = await import('@nous/core');

const WS = '11111111-1111-4111-8111-111111111111';
const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.workspaceId = WS; next(); });   // what verifyApiKey sets
app.use('/v2/intelligence', intelligenceV2Router);
const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
const base = `http://127.0.0.1:${server.address().port}`;
after(() => { registerIntelligenceSource(readIntelligence); server.close(); });
const get = async (path) => { const r = await fetch(base + path); return { status: r.status, body: await r.json() }; };

test('the files whole, for the key\'s workspace, cut to the agent budget', async () => {
  const asked = [];
  registerIntelligenceSource(async (_sb, ws, opts) => {
    asked.push({ ws, ...opts });
    return { text: '## Intelligence\n\n### Win/loss — Why we win\n\nSpeed to first value. [win_loss:a1]', used: [{ key: 'win_loss', section: 'why-we-win', blocks: ['a1'] }] };
  });
  const r = await get('/v2/intelligence');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body.text, /Speed to first value\. \[win_loss:a1\]/);
  assert.deepEqual(r.body.used, [{ key: 'win_loss', section: 'why-we-win', blocks: ['a1'] }]);
  assert.deepEqual(asked, [{ ws: WS, companyId: null, purpose: 'agent', budget: 12000 }]);
});

test('a workspace in the query is refused, not read', async () => {
  const r = await get(`/v2/intelligence?workspace_id=${'2'.repeat(8)}`);
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'unknown_query_param');
});

test('nothing learned yet: an empty answer that says so', async () => {
  registerIntelligenceSource(async () => null);
  const r = await get('/v2/intelligence');
  assert.equal(r.status, 200);
  assert.equal(r.body.text, null);
  assert.deepEqual(r.body.used, []);
});
