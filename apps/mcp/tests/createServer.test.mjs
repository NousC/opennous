// The server must be constructible. That is the whole test, and it is here because its
// absence cost us a live outage.
//
// A `const` schema was declared below its own first use inside createServer(). Nothing catches
// that statically — the file parses, imports fine, and every tool description reads correctly.
// It throws only when the function actually runs, which on the hosted server is once per
// request, so mcp.opennous.cloud returned 502 on every call and the published npm package
// crashed on start for every plugin user.
//
// Run: node --test apps/mcp/tests/createServer.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, SERVER_VERSION } from '../src/server.js';

test('createServer() builds without throwing', () => {
  // Twice, because it runs per request and a schema built in the wrong scope can pass once
  // and fail on the second construction.
  assert.ok(createServer());
  assert.ok(createServer());
});

test('the server reports a version', () => {
  assert.match(SERVER_VERSION, /^\d+\.\d+\.\d+$/);
});
