// Every /v2 call a tool makes names the tool and the MCP client (GET-623), so the API's per-key
// request log records `get_context` from `Claude Code`, not `/v2/context` from `node`.
//
// Run: node --test apps/mcp/tests/callContext.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

const seen = [];
const api = http.createServer((req, res) => {
  seen.push({ path: req.url.split('?')[0], headers: req.headers });
  req.resume();
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
});

let client;
before(async () => {
  await new Promise((r) => api.listen(0, '127.0.0.1', r));
  process.env.NOUS_API_URL = `http://127.0.0.1:${api.address().port}`;
  process.env.NOUS_API_KEY = 'pk_test';
  const { createServer } = await import('../src/server.js');
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createServer().connect(a);
  client = new Client({ name: 'claude-code', version: '2.1.4' });
  await client.connect(b);
});
after(async () => { await client?.close(); api.close(); });

test('a tool call sends X-Nous-Tool and the MCP client name as X-Nous-Agent', async () => {
  seen.length = 0;
  await client.callTool({ name: 'get_context', arguments: { focus: 'sarah@acme.com', intent: 'draft_email' } });
  assert.ok(seen.length >= 1, 'the tool reached the API');
  for (const s of seen) {
    assert.equal(s.headers['x-nous-client'], 'mcp');
    assert.equal(s.headers['x-nous-tool'], 'get_context');
    assert.equal(s.headers['x-nous-agent'], 'claude-code/2.1.4');
  }
});

test('the tool header follows the tool, call by call', async () => {
  seen.length = 0;
  await client.callTool({ name: 'whoami', arguments: {} });
  assert.ok(seen.length >= 1);
  assert.ok(seen.every((s) => s.headers['x-nous-tool'] === 'whoami'));
});

test('outside a tool call, no tool header is sent', async () => {
  const { get } = await import('../src/client.js');
  seen.length = 0;
  await get('/v2/workspace/status');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].headers['x-nous-tool'], undefined);
});

test('the hosted server forwards the caller User-Agent when there is no clientInfo', async () => {
  const { runWithApiKey, get } = await import('../src/client.js');
  seen.length = 0;
  await runWithApiKey('pk_other', () => get('/v2/workspace/status'), { agent: 'n8n/1.80 \u0000evil' });
  assert.equal(seen[0].headers['x-nous-agent'], 'n8n/1.80 evil');
  assert.equal(seen[0].headers.authorization, 'Bearer pk_other');
});
