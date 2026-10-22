import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { apiInternalBase } from '../src/lib/apiInternal.mjs';
import { runApiNotificationEmails } from '../src/workers/apiNotificationEmails.mjs';

// The worker reaches the API over the compose network (GET-1011). On a localhost self-host the
// public API_URL (https://api.localhost) resolves to the worker container itself, so every
// /internal/* call failed with ECONNREFUSED.

test('the internal URL wins over the public one', () => {
  assert.equal(apiInternalBase({ NOUS_API_INTERNAL_URL: 'http://api:3000', API_URL: 'https://api.acme.example' }), 'http://api:3000');
});

test('without the internal URL it falls back to API_URL, so Cloud keeps working', () => {
  assert.equal(apiInternalBase({ API_URL: 'https://api.acme.example/' }), 'https://api.acme.example');
});

test('neither set reads as not configured', () => {
  assert.equal(apiInternalBase({}), null);
  assert.equal(apiInternalBase({ NOUS_API_INTERNAL_URL: '  ', API_URL: '' }), null);
});

test('a trailing slash is dropped so paths join cleanly', () => {
  assert.equal(apiInternalBase({ NOUS_API_INTERNAL_URL: 'http://api:3000///' }), 'http://api:3000');
});

test('a worker sweep calls the API on the internal URL, not the public one', async () => {
  const prev = { s: process.env.WORKER_INTERNAL_SECRET, u: process.env.API_URL, i: process.env.NOUS_API_INTERNAL_URL };
  process.env.WORKER_INTERNAL_SECRET = 'test-secret';
  process.env.API_URL = 'https://api.acme.example';
  process.env.NOUS_API_INTERNAL_URL = 'http://api:3000';
  const urls = [];
  const fetchImpl = async (url) => { urls.push(url); return { ok: true, json: async () => ({ queued: [] }) }; };
  try {
    await runApiNotificationEmails(['usage_80'], { fetchImpl, send: async () => {} });
  } finally {
    for (const [k, v] of [['WORKER_INTERNAL_SECRET', prev.s], ['API_URL', prev.u], ['NOUS_API_INTERNAL_URL', prev.i]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
  assert.equal(urls.length, 1);
  assert.ok(urls[0].startsWith('http://api:3000/internal/'), urls[0]);
});

test('the compose file gives the worker the internal URL', () => {
  const compose = readFileSync(fileURLToPath(new URL('../../../docker-compose.yaml', import.meta.url)), 'utf8');
  const worker = compose.split(/\n  worker:\n/)[1].split(/\n  [a-z]+:\n/)[0];
  assert.match(worker, /NOUS_API_INTERNAL_URL: http:\/\/api:3000/);
});

test('the self-host Caddy does not route /internal/* from outside', () => {
  const caddy = readFileSync(fileURLToPath(new URL('../../../deploy/selfhost/Caddyfile', import.meta.url)), 'utf8');
  const apiBlock = caddy.split('{$API_DOMAIN} {')[1].split('\n}\n')[0];
  assert.match(apiBlock, /handle \/internal\/\* \{\s*respond 404\s*\}/);
});
