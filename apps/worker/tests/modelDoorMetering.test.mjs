// Every model call is metered once (GET-957).
//
// llm_usage is how we learn what each step costs, and it undercounted: about thirty calls were
// never written to it, because a call was metered only when its call site remembered to. The door
// meters a call now, but only when told whose it is, because some call sites record their own
// usage (their own label, a request id the credit meter reads) and the door must not bill those
// twice. So every direct call says which it is:
//
//   meter: { workspaceId, userId?, requestId? }   the door writes the llm_usage row
//   meter: false                                  this call site records its own usage
//
// This fails on a call that says neither. Calls through a handed-around door
// (`generate: createMessage`) are not seen here; the code they are handed to meters them.
//
// Run: node --test apps/worker/tests/modelDoorMetering.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMessage, registerUsageSink, usageRowsFor, computeCost } from '@nous/core';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SCAN = ['apps/api/src', 'apps/api/scripts', 'apps/worker/src', 'apps/worker/scripts', 'packages/core/src'];
const DOOR = 'packages/core/src/llm/modelDoor.mjs';

function* files(dir) {
  let names;
  try { names = readdirSync(dir); } catch { return; }
  for (const n of names) {
    if (n === 'node_modules' || n === 'dist' || n.startsWith('.')) continue;
    const p = join(dir, n);
    if (statSync(p).isDirectory()) yield* files(p);
    else if (/\.(mjs|js|ts)$/.test(n) && !/\.test\./.test(n)) yield p;
  }
}

/** The text of the argument object at `open` (the index of its `{`), by brace matching. */
function objectAt(src, open) {
  let depth = 0, quote = null;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === '\\') { i++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { quote = c; continue; }
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return src.slice(open, i + 1);
  }
  return null;
}

/** Whether `meter` is a key at the object's top level (not inside a nested object). */
function declaresMeter(obj) {
  let depth = 0, quote = null;
  for (let i = 0; i < obj.length; i++) {
    const c = obj[i];
    if (quote) {
      if (c === '\\') { i++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { quote = c; continue; }
    if ('{[('.includes(c)) depth++;
    else if ('}])'.includes(c)) depth--;
    else if (depth === 1 && /[{,\s]/.test(obj[i - 1] ?? '') && /^meter\s*:/.test(obj.slice(i))) return true;
  }
  return false;
}

function callSites() {
  const out = [];
  for (const dir of SCAN) {
    for (const p of files(join(ROOT, dir))) {
      const rel = relative(ROOT, p);
      if (rel === DOOR) continue;
      const src = readFileSync(p, 'utf8');
      const re = /\bcreateMessage\s*\(\s*\{/g;
      let m;
      while ((m = re.exec(src))) {
        const line = src.slice(0, m.index).split('\n').length;
        const lineText = src.split('\n')[line - 1].trim();
        if (lineText.startsWith('//') || lineText.startsWith('*')) continue;
        const obj = objectAt(src, m.index + m[0].length - 1);
        out.push({ at: `${rel}:${line}`, meters: !!obj && declaresMeter(obj) });
      }
    }
  }
  return out;
}

test('every direct model call says who meters it', () => {
  const sites = callSites();
  assert.ok(sites.length > 40, `found only ${sites.length} call sites: is the scan broken?`);
  const missing = sites.filter(s => !s.meters).map(s => s.at);
  assert.deepEqual(missing, [], `these createMessage calls pass neither meter: { workspaceId } nor meter: false:\n  ${missing.join('\n  ')}`);
});

test('the scan reads meter only at the top level of the call', () => {
  assert.equal(declaresMeter("{ feature: 'x', meter: false }"), true);
  assert.equal(declaresMeter("{ feature: 'x', meter: { workspaceId } }"), true);
  assert.equal(declaresMeter("{ feature: 'x', opts: { meter: false } }"), false);
  assert.equal(declaresMeter("{ feature: 'meter: false' }"), false);
  assert.equal(declaresMeter("{ feature: 'x', parameter: 1 }"), false);
});

// ── The door itself ──────────────────────────────────────────────────────────────

function withDoor(fn) {
  return async () => {
    const KEYS = ['OPENROUTER_API_KEY', 'EXTRACTION_MODEL', 'EXTRACTION_FALLBACK_MODEL', 'LLM_BASE_URL'];
    const saved = Object.fromEntries(KEYS.map(k => [k, process.env[k]]));
    const realFetch = globalThis.fetch;
    const rows = [];
    process.env.OPENROUTER_API_KEY = 'sk-or-test-key-for-metering-0000000000';
    process.env.EXTRACTION_MODEL = 'deepseek/deepseek-v4.1-flash';
    delete process.env.EXTRACTION_FALLBACK_MODEL;
    delete process.env.LLM_BASE_URL;
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        id: 'gen-1', provider: 'Novita',
        choices: [{ message: { content: '[]' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1_000_000, completion_tokens: 1_000_000, cost: 0.25 },
      }),
    });
    registerUsageSink((r) => { rows.push(...r); });
    try { await fn(rows); } finally {
      registerUsageSink(null);
      globalThis.fetch = realFetch;
      for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    }
  };
}

const call = (extra) => createMessage({ feature: 'test-feature', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }], ...extra });

test('meter: { workspaceId } writes one row with the router\'s cost', withDoor(async (rows) => {
  await call({ meter: { workspaceId: 'ws-1', requestId: 'r-1' } });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].workspace_id, 'ws-1');
  assert.equal(rows[0].feature, 'test-feature');
  assert.equal(rows[0].model, 'deepseek/deepseek-v4.1-flash');
  assert.equal(rows[0].request_id, 'r-1');
  assert.equal(rows[0].cost_usd, 0.25);
}));

test('meter: false and no meter at all write nothing', withDoor(async (rows) => {
  await call({ meter: false });
  await call({});
  assert.equal(rows.length, 0);
}));

test('a call whose metering fails still answers', withDoor(async () => {
  registerUsageSink(() => { throw new Error('db down'); });
  const msg = await call({ meter: { workspaceId: 'ws-1' } });
  assert.equal(msg.content[0].text, '[]');
}));

// ── Prices ───────────────────────────────────────────────────────────────────────

test('the extraction model is priced: no cost from the router no longer records $0', () => {
  const usage = { input_tokens: 1_000_000, output_tokens: 1_000_000 };
  assert.equal(computeCost('deepseek/deepseek-v4.1-flash', usage), 0.04 + 0.144);
  assert.equal(computeCost('anthropic/claude-haiku-4.5', usage), 1 + 5);
  assert.equal(computeCost('some/unknown-model', usage), 0);
  assert.equal(computeCost('deepseek/deepseek-v4.1-flash', { ...usage, cost: 0.3 }), 0.3);
});

test('a replaced attempt that was billed gets its own row', () => {
  const msg = {
    model: 'z-ai/glm-5.2', usage: { input_tokens: 10, output_tokens: 10 }, cost_usd: 0.01,
    failed_attempts: [
      { model: 'deepseek/deepseek-v4.1-flash', usage: { input_tokens: 10, output_tokens: 10 }, cost_usd: 0.002 },
      { model: 'deepseek/deepseek-v4.1-flash', usage: null, cost_usd: null, reason: 'unavailable' },
    ],
  };
  const rows = usageRowsFor(msg, { workspaceId: 'ws-1', feature: 'f' });
  assert.deepEqual(rows.map(r => [r.model, r.cost_usd]), [['z-ai/glm-5.2', 0.01], ['deepseek/deepseek-v4.1-flash', 0.002]]);
});
