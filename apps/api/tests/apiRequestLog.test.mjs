// The per-key request log (GET-623): what a row says, that a session call writes none, and that
// logging can never touch the response. Pure where possible; the express tests run a real app on
// an ephemeral port with an injected sink, so no database is involved.
//
// Run: cd apps/api && node --test tests/apiRequestLog.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import express from 'express';
import {
  detectClient, ipPrefix, buildRow, routePattern, targetOf,
  createRequestLogBuffer, trackApiKeyRequest,
} from '../src/lib/apiRequestLog.mjs';

// ── Client detection ─────────────────────────────────────────────────────────

test('known clients are named from the User-Agent', () => {
  assert.equal(detectClient('claude-cli/2.1.4 (external, cli)'), 'Claude Code');
  assert.equal(detectClient('Claude-Code/1.0'), 'Claude Code');
  assert.equal(detectClient('Mozilla/5.0 Cursor/0.48.2 Chrome/132'), 'Cursor');
  assert.equal(detectClient('codex_cli_rs/0.30.0'), 'Codex');
  assert.equal(detectClient('n8n'), 'n8n');
  assert.equal(detectClient('Mozilla/5.0 (n8n workflow)'), 'n8n');
  assert.equal(detectClient('Zapier'), 'Zapier');
  assert.equal(detectClient('curl/8.7.1'), 'curl');
});

test('the MCP-forwarded agent name wins over the MCP process User-Agent', () => {
  // stdio: the MCP clientInfo name; the API itself sees the MCP's fetch ("node").
  assert.equal(detectClient('node', 'claude-code/2.1.4'), 'Claude Code');
  assert.equal(detectClient('node', 'cursor-vscode/1.0.0'), 'Cursor');
  assert.equal(detectClient('node', 'codex-mcp-client/0.30'), 'Codex');
  // An unknown forwarded name is still more useful than "node".
  assert.equal(detectClient('node', 'my-agent/1.0'), 'my-agent/1.0');
});

test('an unknown client is the raw User-Agent cut to 80 characters; nothing is null', () => {
  const ua = 'python-requests/2.32.3 ' + 'x'.repeat(200);
  assert.equal(detectClient(ua), ua.slice(0, 80));
  assert.equal(detectClient(ua).length, 80);
  // "curl" only as the product token, not anywhere in a string.
  assert.equal(detectClient('MyBot (uses libcurl)'), 'MyBot (uses libcurl)');
  assert.equal(detectClient(''), null);
  assert.equal(detectClient(null, null), null);
  assert.equal(detectClient(undefined, '   '), null);
});

// ── IP prefix ────────────────────────────────────────────────────────────────

test('IPv4 keeps two octets, IPv6 three groups', () => {
  assert.equal(ipPrefix('203.0.113.42'), '203.0');
  assert.equal(ipPrefix('::ffff:203.0.113.42'), '203.0');
  assert.equal(ipPrefix('2001:0db8:85a3:0000:0000:8a2e:0370:7334'), '2001:db8:85a3');
  assert.equal(ipPrefix('2001:db8::1'), '2001:db8:0');
  assert.equal(ipPrefix('::1'), '0:0:0');
  assert.equal(ipPrefix('fe80::1%en0'), 'fe80:0:0');
});

test('ipPrefix never returns a full address, and junk is null', () => {
  const samples = [
    '203.0.113.42', '10.1.2.3', '127.0.0.1', '::ffff:198.51.100.7',
    '2001:0db8:85a3:0000:0000:8a2e:0370:7334', '2a00:1450:4001:82a::200e', '::1', 'fe80::abcd:1',
  ];
  for (const ip of samples) {
    const p = ipPrefix(ip);
    assert.ok(p, `${ip} has a prefix`);
    assert.notEqual(p, ip);
    // Never more than 2 IPv4 octets / 3 IPv6 groups.
    if (p.includes('.')) assert.equal(p.split('.').length, 2, `${ip} → ${p}`);
    else assert.equal(p.split(':').length, 3, `${ip} → ${p}`);
    // And never something that parses as a full address again.
    assert.ok(!/^\d+\.\d+\.\d+\.\d+$/.test(p));
  }
  for (const bad of [null, undefined, '', 'localhost', '999.1.1.1', '1.2.3', 'not:an:ip', '::ffff:1.2.3.4.5', '64:ff9b::192.0.2.1']) {
    assert.equal(ipPrefix(bad), null, `${bad} → null`);
  }
});

// ── Row shape ────────────────────────────────────────────────────────────────

function fakeReq({ headers = {}, ...rest } = {}) {
  const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    apiKeyId: 'key-1', apiKeyWorkspaceId: 'ws-1', workspaceId: 'ws-1',
    baseUrl: '/v2/accounts', route: { path: '/:id' }, params: { id: 'acme.com' },
    body: {}, query: {}, ip: '203.0.113.42', originalUrl: '/v2/accounts/acme.com',
    headers: h, get: (n) => h[n.toLowerCase()],
    ...rest,
  };
}

test('a REST row stores the route pattern, never the filled-in path', () => {
  const row = buildRow(fakeReq({ headers: { 'User-Agent': 'curl/8.7.1' } }), { statusCode: 200, locals: {} }, 41.6);
  assert.equal(row.surface, 'rest');
  assert.equal(row.route, '/v2/accounts/:id');
  assert.equal(row.target, 'acme.com');
  assert.equal(row.status, 200);
  assert.equal(row.latency_ms, 42);
  assert.equal(row.client, 'curl');
  assert.equal(row.ip_prefix, '203.0');
  assert.equal(row.credits, 0);
  assert.equal(row.api_key_id, 'key-1');
  assert.equal(row.workspace_id, 'ws-1');
});

test('an MCP row stores the tool name as the route', () => {
  const req = fakeReq({
    baseUrl: '/v2/context', route: { path: '/' }, params: {}, body: { focus: 'sarah@acme.com' },
    headers: { 'X-Nous-Client': 'mcp', 'X-Nous-Tool': 'get_context', 'User-Agent': 'node', 'X-Nous-Agent': 'claude-code/2.1' },
  });
  const row = buildRow(req, { statusCode: 200, locals: { apiCredits: 2 } }, 10);
  assert.equal(row.surface, 'mcp');
  assert.equal(row.route, 'get_context');
  assert.equal(row.target, 'sarah@acme.com');
  assert.equal(row.client, 'Claude Code');
  assert.equal(row.credits, 2);
});

test('an MCP call with no or a malformed tool header falls back to the route pattern', () => {
  const req = fakeReq({ headers: { 'X-Nous-Client': 'mcp', 'X-Nous-Tool': 'DROP TABLE; --' } });
  assert.equal(buildRow(req, { statusCode: 200, locals: {} }, 1).route, '/v2/accounts/:id');
  assert.equal(buildRow(fakeReq({ headers: { 'X-Nous-Client': 'mcp' } }), { statusCode: 200, locals: {} }, 1).route, '/v2/accounts/:id');
});

test('routePattern on an unmatched route keeps only the mount, no ids', () => {
  assert.equal(routePattern({ baseUrl: '', route: undefined, originalUrl: '/v2/accounts/sarah@acme.com?x=1' }), '/v2/accounts');
  assert.equal(routePattern({ baseUrl: '/v2/query', route: { path: '/' } }), '/v2/query');
});

test('target is null when nothing cheap names it, and is truncated', () => {
  assert.equal(targetOf({ params: {}, body: {}, query: {} }), null);
  assert.equal(targetOf({ params: {}, body: [], query: {} }), null);
  assert.equal(targetOf({ params: { id: 'x'.repeat(500) } }).length, 120);
});

// ── Tracking ─────────────────────────────────────────────────────────────────

function fakeRes(statusCode = 200) {
  const res = new EventEmitter();
  res.statusCode = statusCode;
  res.locals = {};
  return res;
}

test('a request with no api key (session auth) is never logged', () => {
  const rows = [];
  const req = fakeReq({ apiKeyId: undefined });
  const res = fakeRes();
  assert.equal(trackApiKeyRequest(req, res, { enqueue: (r) => rows.push(r) }), false);
  res.emit('finish');
  assert.equal(rows.length, 0);
});

test('a keyed request writes exactly one row on finish, even if key auth ran twice', () => {
  const rows = [];
  const req = fakeReq();
  const res = fakeRes(404);
  let t = 1000;
  const opts = { enqueue: (r) => rows.push(r), now: () => t };
  assert.equal(trackApiKeyRequest(req, res, opts), true);
  assert.equal(trackApiKeyRequest(req, res, opts), false);
  assert.equal(rows.length, 0, 'nothing before the response finishes');
  t = 1250;
  res.emit('finish');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 404);
  assert.equal(rows[0].latency_ms, 250);
});

test('a sink that throws is swallowed', () => {
  const req = fakeReq();
  const res = fakeRes();
  trackApiKeyRequest(req, res, { enqueue: () => { throw new Error('boom'); } });
  assert.doesNotThrow(() => res.emit('finish'));
});

// ── The buffer ───────────────────────────────────────────────────────────────

const quiet = { error: () => {} };

test('the buffer flushes at the row threshold, in one batch', async () => {
  const batches = [];
  const buf = createRequestLogBuffer({ insert: async (b) => { batches.push(b); return { error: null }; }, flushRows: 3, flushMs: 60_000, logger: quiet });
  buf.enqueue({ n: 1 }); buf.enqueue({ n: 2 });
  assert.equal(batches.length, 0);
  buf.enqueue({ n: 3 });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(batches, [[{ n: 1 }, { n: 2 }, { n: 3 }]]);
  assert.equal(buf.size(), 0);
});

test('the buffer flushes on its timer', async () => {
  const batches = [];
  const buf = createRequestLogBuffer({ insert: async (b) => { batches.push(b); return { error: null }; }, flushRows: 100, flushMs: 20, logger: quiet });
  buf.enqueue({ n: 1 });
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(batches, [[{ n: 1 }]]);
});

test('an insert error or a rejected insert is logged and dropped, never thrown', async () => {
  const logged = [];
  const logger = { error: (...a) => logged.push(a.join(' ')) };
  const failing = createRequestLogBuffer({ insert: async () => ({ error: { message: 'permission denied', code: '42501' } }), flushMs: 60_000, logger });
  failing.enqueue({ n: 1 });
  assert.equal(await failing.flush(), 0);
  const throwing = createRequestLogBuffer({ insert: async () => { throw new Error('socket hang up'); }, flushMs: 60_000, logger });
  throwing.enqueue({ n: 1 });
  assert.equal(await throwing.flush(), 0);
  assert.equal(logged.length, 2);
  assert.match(logged[0], /permission denied/);
  assert.equal(failing.size(), 0, 'the failed batch is not retried forever');
});

test('the buffer is bounded when the database is down', async () => {
  const buf = createRequestLogBuffer({ insert: async () => ({ error: null }), flushRows: 1e9, flushMs: 60_000, maxBuffered: 5, logger: quiet });
  for (let i = 0; i < 12; i++) buf.enqueue({ n: i });
  assert.equal(buf.size(), 5);
  await buf.flush();
});

// ── End to end through express: logging can never touch the response ───────

async function serve(app, fn) {
  const server = createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try { return await fn(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise((r) => server.close(r)); }
}

function appWith({ keyed, sink }) {
  const app = express();
  app.use(express.json());
  app.use('/v2/accounts', (req, res, next) => {
    if (keyed) { req.apiKeyId = 'key-1'; req.apiKeyWorkspaceId = 'ws-1'; }
    trackApiKeyRequest(req, res, { enqueue: sink });
    next();
  }, (() => {
    const r = express.Router();
    r.get('/:id', (req, res) => res.json({ ok: true, id: req.params.id }));
    return r;
  })());
  return app;
}

test('a failing logger does not change the response', async () => {
  const app = appWith({ keyed: true, sink: () => { throw new Error('db down'); } });
  await serve(app, async (base) => {
    const r = await fetch(`${base}/v2/accounts/acme.com`);
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { ok: true, id: 'acme.com' });
  });
});

test('through express: a keyed call logs the mounted route pattern; a session call logs nothing', async () => {
  const rows = [];
  await serve(appWith({ keyed: true, sink: (r) => rows.push(r) }), async (base) => {
    await (await fetch(`${base}/v2/accounts/acme.com`, { headers: { 'User-Agent': 'curl/8.7.1' } })).json();
  });
  await new Promise((r) => setImmediate(r));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].route, '/v2/accounts/:id');
  assert.equal(rows[0].client, 'curl');
  assert.equal(rows[0].status, 200);

  const none = [];
  await serve(appWith({ keyed: false, sink: (r) => none.push(r) }), async (base) => {
    await (await fetch(`${base}/v2/accounts/acme.com`)).json();
  });
  await new Promise((r) => setImmediate(r));
  assert.equal(none.length, 0);
});
