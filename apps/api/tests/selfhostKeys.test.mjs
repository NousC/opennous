// scripts/selfhost-keys.mjs writes every secret the bundled self-host stack needs. WORKER_SECRET
// was missing, which left all api <-> worker internal calls (deal overview, account summary,
// automations) off on every self-hosted install.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../../../scripts/selfhost-keys.mjs', import.meta.url));

function run(envFile) {
  const r = spawnSync(process.execPath, [script, envFile], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return Object.fromEntries(readFileSync(envFile, 'utf8').split('\n')
    .filter(l => /^[A-Z_]+=/.test(l)).map(l => l.split(/=(.*)/s).slice(0, 2)));
}

test('selfhost-keys writes a WORKER_SECRET and keeps it on a rerun', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nous-keys-'));
  const envFile = join(dir, 'nous.env');
  writeFileSync(envFile, 'APP_DOMAIN=app.example.com\nAPI_DOMAIN=api.example.com\nWORKER_SECRET=\n');
  const first = run(envFile);
  assert.match(first.WORKER_SECRET, /^[0-9a-f]{64}$/);
  const second = run(envFile);
  assert.equal(second.WORKER_SECRET, first.WORKER_SECRET);
});

test('selfhost-keys turns a CRLF nous.env (a Windows editor) into LF', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nous-keys-'));
  const envFile = join(dir, 'nous.env');
  writeFileSync(envFile, 'APP_DOMAIN=app.example.com\r\nAPI_DOMAIN=api.example.com\r\nANTHROPIC_API_KEY=sk-ant-x\r\n');
  const env = run(envFile);
  assert.ok(!readFileSync(envFile, 'utf8').includes('\r'));
  assert.equal(env.APP_DOMAIN, 'app.example.com');
  assert.equal(env.ANTHROPIC_API_KEY, 'sk-ant-x');
});
