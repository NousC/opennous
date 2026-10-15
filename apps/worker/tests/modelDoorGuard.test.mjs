// Every model call goes through the model door (GET-242).
//
// On 2026-09-12 the Anthropic credit ran out. The extraction pipeline had just moved behind
// @nous/core's createMessage and kept working; about forty calls that built their own
// `new Anthropic()` failed silently for days — reply labels, the action-item judge, coaching,
// thread titles, Studio drafts, the Slack agent. A door only helps if nothing walks around it,
// so this test fails the moment a new direct call appears.
//
// The exceptions are the tool-using agent loops, which speak each provider's tool protocol and
// are routed by apps/api/src/lib/model.mjs + cloud/lib/harness.mjs, not by the single-turn door.
//
// Run: node --test apps/worker/tests/modelDoorGuard.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SCAN = ['apps/api/src', 'apps/api/scripts', 'apps/worker/src', 'apps/worker/scripts', 'packages/core/src'];

// file → why it may talk to a provider SDK directly.
const ALLOWED = {
  'packages/core/src/llm/modelDoor.mjs': 'the door itself',
  'apps/api/src/lib/ownModel.mjs': "the customer's own Claude/ChatGPT key (GET-528): their account by design, never routed through ours",
  'packages/core/src/llm/claudeRoute.mjs': 'routes Claude clients to OpenRouter (or Anthropic direct): maps the model id and passes the call through (GET-885)',
  'apps/api/src/lib/llm.mjs': "registers the API's instrumented Anthropic client with the door",
  'apps/worker/src/lib/llm.mjs': "registers the worker's instrumented Anthropic client with the door",
  'apps/api/src/cloud/lib/playgroundAgent.mjs': 'tool-using agent loops; the Anthropic branch runs only when lib/model.mjs resolves an Anthropic model',
  'apps/api/src/cloud/lib/sandboxExecutor.mjs': 'tool-using sandbox agent loop (Anthropic tool protocol), routed through OpenRouter by claudeRoute (GET-885)',
  'apps/api/src/cloud/lib/harness.mjs': 'tool-using agent loop against OpenAI-compatible /chat/completions (routed by lib/model.mjs)',
  // The RevBox Job Builder (GET-868): a streaming tool-use loop, model from lib/model.mjs, every call metered through recordRevboxUsage.
  'apps/api/src/cloud/lib/jobBuilder/index.mjs': 'builds the Job Builder client (tool-using agent loop, model from lib/model.mjs)',
  'apps/api/src/cloud/lib/jobBuilder/loop.mjs': 'the Job Builder tool-use loop; each call metered through recordRevboxUsage',
};

const PATTERNS = [
  [/new\s+Anthropic\s*\(/, 'new Anthropic('],
  [/\.messages\.(create|stream)\s*\(/, '.messages.create/stream('],
  [/from\s+['"]@anthropic-ai\/sdk['"]/, "import from '@anthropic-ai/sdk'"],
  [/import\s+Anthropic\b[^;]*from\s+['"]useleak['"]/, "default import from 'useleak'"],
  // GET-257: an OpenAI-compatible endpoint called by hand walks around the door just the same —
  // insights ran on GLM 4.7 that way, with no fallback, no host pin and a recorded cost of $0.
  [/\/chat\/completions/, "direct fetch to /chat/completions"],
];

function* files(dir) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* files(p);
    else if (/\.(mjs|js|ts)$/.test(name) && !/\.test\.|\.d\.ts$/.test(name)) yield p;
  }
}

test('no model call bypasses the door', () => {
  const offenders = [];
  for (const base of SCAN) {
    let root;
    try { root = join(ROOT, base); statSync(root); } catch { continue; }
    for (const file of files(root)) {
      const rel = relative(ROOT, file).split('\\').join('/');
      if (ALLOWED[rel]) continue;
      const src = readFileSync(file, 'utf8');
      for (const [re, label] of PATTERNS) {
        if (re.test(src)) offenders.push(`${rel}: ${label}`);
      }
    }
  }
  assert.deepEqual(offenders, [], `Model calls must go through createMessage (lib/llm.mjs → @nous/core):\n  ${offenders.join('\n  ')}`);
});

// An open-source build has no src/cloud/ (GET-754): a Cloud exception is stale only when its
// app's cloud folder is there and the file is not.
const cloudMissing = (rel) => {
  const m = /^(apps\/[^/]+\/src\/cloud)\//.exec(rel);
  return !!m && !existsSync(join(ROOT, m[1]));
};

test('every allowed file still exists (a stale exception is a hole)', () => {
  for (const rel of Object.keys(ALLOWED)) {
    if (cloudMissing(rel)) continue;
    assert.doesNotThrow(() => statSync(join(ROOT, rel)), `${rel} is allow-listed but gone — remove it from ALLOWED`);
  }
});
