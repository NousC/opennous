import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publicApiBase } from '../src/lib/publicApiBase.mjs';

const KEYS = ['PUBLIC_API_URL', 'WORKER_URL', 'BACKEND_URL', 'API_DOMAIN', 'API_URL', 'PORT'];
function withEnv(env, fn) {
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, env);
  try { return fn(); } finally { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
}

test('production: skips the internal Docker host for the public domain (GET-666)', () => {
  assert.equal(withEnv({ API_URL: 'http://api:3000', API_DOMAIN: 'api.opennous.cloud' }, publicApiBase), 'https://api.opennous.cloud');
});
test('an explicit public URL wins', () => {
  assert.equal(withEnv({ PUBLIC_API_URL: 'https://hooks.example.com/', API_URL: 'http://api:3000' }, publicApiBase), 'https://hooks.example.com');
});
test('self-hosted with a public API_URL keeps it', () => {
  assert.equal(withEnv({ API_URL: 'https://nous.acme.com' }, publicApiBase), 'https://nous.acme.com');
});
test('local dev falls back to the configured internal address, then localhost', () => {
  assert.equal(withEnv({ API_URL: 'http://localhost:3000' }, publicApiBase), 'http://localhost:3000');
  assert.equal(withEnv({}, publicApiBase), 'http://localhost:3000');
});
