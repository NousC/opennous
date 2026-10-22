// GET-331: the worker authenticates to the api with a shared secret, and a route mounted behind
// verifySupabaseAuth can never accept that — the middleware rejects it before the route's own
// secret check runs.
//
// That failure is completely silent. /api/routines/tick returned 401 every five minutes from the
// day it shipped, so scheduled routines and meeting briefs had never once executed in production,
// and the only evidence was one line in the worker log that read like a transient error.
//
// This reads both sides of the contract — every worker→api call that sends the secret, and every
// mount in the api that requires a user token — and fails if they ever overlap again. It is a
// grep, not a server: no database, no boot, nothing to keep running.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..');
const API_INDEX = join(REPO, 'apps', 'api', 'src', 'index.mjs');
// Cloud's mounts (GET-754), when this checkout has the Workspace layer.
const API_CLOUD_INDEX = join(REPO, 'apps', 'api', 'src', 'cloud', 'index.mjs');
const WORKER_SRC = join(REPO, 'apps', 'worker', 'src');

/** Every .mjs under a directory, recursively. */
function sourceFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else if (name.endsWith('.mjs')) out.push(p);
  }
  return out;
}

/** Paths the worker calls with `x-worker-secret`, e.g. "/internal/routines/tick". */
function workerSecretPaths() {
  const paths = [];
  for (const file of sourceFiles(WORKER_SRC)) {
    const src = readFileSync(file, 'utf8');
    // fetch(`${apiInternalBase()}/some/path`, { ... 'x-worker-secret' ... }); the internal URL
    // helper since GET-1011, process.env.API_URL before it, `${base}` where it is read once.
    for (const m of src.matchAll(/fetch\(`\$\{(?:process\.env\.API_URL|apiInternalBase\(\)|base)\}([^`]+)`\s*,\s*\{([\s\S]{0,400}?)\}\s*\)/g)) {
      if (/x-worker-secret/i.test(m[2])) paths.push({ path: m[1], file: file.slice(REPO.length + 1) });
    }
  }
  return paths;
}

/** Mount prefixes in the api that require a user token, e.g. "/api/routines". */
function userAuthedMounts() {
  const src = [API_INDEX, API_CLOUD_INDEX].filter(existsSync).map((f) => readFileSync(f, 'utf8')).join('\n');
  const mounts = [];
  for (const m of src.matchAll(/app\.use\(\s*'([^']+)'\s*,([^\n]*)\)/g)) {
    if (/verifySupabaseAuth/.test(m[2])) mounts.push(m[1]);
  }
  return mounts;
}

test('no worker→api call targets a route behind user auth', () => {
  const calls = workerSecretPaths();
  const authed = userAuthedMounts();

  assert.ok(calls.length > 0, 'parsed no worker→api calls — the matcher has drifted from the code');
  assert.ok(authed.length > 0, 'parsed no authed mounts — the matcher has drifted from the code');

  const broken = calls.filter(c => authed.some(m => c.path === m || c.path.startsWith(m + '/')));
  assert.deepEqual(
    broken.map(b => `${b.path} (${b.file})`), [],
    'These worker calls send x-worker-secret to a route mounted behind verifySupabaseAuth, which ' +
    'only accepts a user token. They will 401 forever, silently. Move the endpoint under ' +
    '/internal/... with its own secret guard, as /internal/motion and /internal/personal-sync do.',
  );
});
