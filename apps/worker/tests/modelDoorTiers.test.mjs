// The model door's GET-242 additions: system prompts, the writing tier, cost for API metering.
// fetch is mocked; nothing here calls a real model.
//
// Run: node --test apps/worker/tests/modelDoorTiers.test.mjs

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMessage, messageText, writingModel, writingFallbackModel, tierModels } from '../src/lib/llm.mjs';

const realFetch = globalThis.fetch;
const KEYS = ['EXTRACTION_MODEL', 'EXTRACTION_FALLBACK_MODEL', 'EXTRACTION_PROVIDER', 'EXTRACTION_FALLBACK_PROVIDER',
  'WRITING_MODEL', 'WRITING_FALLBACK_MODEL', 'WRITING_PROVIDER', 'OPENROUTER_API_KEY'];
const saved = Object.fromEntries(KEYS.map(k => [k, process.env[k]]));
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

function mockByModel(answers, calls = []) {
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    const a = answers[body.model];
    if (a instanceof Error) return { ok: false, status: 502, statusText: 'x', json: async () => ({ error: { code: 502, message: a.message } }) };
    return { ok: true, status: 200, json: async () => ({ id: 'gen-1', provider: 'Host', choices: [{ message: { content: a }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.0042 } }) };
  };
}

test('a system prompt reaches an open model as the first message', async () => {
  process.env.OPENROUTER_API_KEY = 'k';
  process.env.EXTRACTION_MODEL = 'deepseek/deepseek-v4.1-flash';
  delete process.env.EXTRACTION_FALLBACK_MODEL;
  const calls = [];
  mockByModel({ 'deepseek/deepseek-v4.1-flash': 'positive' }, calls);
  const msg = await createMessage({ feature: 'reply-classify', max_tokens: 8, system: 'Classify.', messages: [{ role: 'user', content: 'yes please' }] });
  assert.deepEqual(calls[0].messages, [{ role: 'system', content: 'Classify.' }, { role: 'user', content: 'yes please' }]);
  assert.equal(messageText(msg), 'positive');
});

test('Anthropic-style system blocks and content blocks are flattened for open models', async () => {
  process.env.OPENROUTER_API_KEY = 'k';
  process.env.EXTRACTION_MODEL = 'z-ai/glm-5.2';
  const calls = [];
  mockByModel({ 'z-ai/glm-5.2': 'ok' }, calls);
  await createMessage({
    feature: 'x', max_tokens: 10,
    system: [{ type: 'text', text: 'A' }, { type: 'text', text: 'B' }],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }] }],
  });
  assert.equal(calls[0].messages[0].content, 'A\n\nB');
  assert.equal(calls[0].messages[1].content, 'one\ntwo');
});

test('the writing tier defaults to GLM 5.2 and falls back to the extraction model', () => {
  delete process.env.WRITING_MODEL; delete process.env.WRITING_FALLBACK_MODEL;
  process.env.EXTRACTION_MODEL = 'deepseek/deepseek-v4.1-flash';
  assert.equal(writingModel(), 'z-ai/glm-5.2');
  assert.equal(writingFallbackModel(), 'deepseek/deepseek-v4.1-flash');
  assert.deepEqual(tierModels('writing'), ['z-ai/glm-5.2', 'deepseek/deepseek-v4.1-flash']);
});

test('WRITING_MODEL is config, read per call', () => {
  process.env.WRITING_MODEL = 'moonshotai/kimi-k2.6';
  process.env.WRITING_FALLBACK_MODEL = 'z-ai/glm-5.2';
  assert.deepEqual(tierModels('writing'), ['moonshotai/kimi-k2.6', 'z-ai/glm-5.2']);
});

test('a writing call that loses its primary is answered by the fallback, and says so', async () => {
  process.env.OPENROUTER_API_KEY = 'k';
  delete process.env.WRITING_MODEL; delete process.env.WRITING_FALLBACK_MODEL;
  process.env.EXTRACTION_MODEL = 'deepseek/deepseek-v4.1-flash';
  const calls = [];
  mockByModel({ 'z-ai/glm-5.2': new Error('Provider returned error'), 'deepseek/deepseek-v4.1-flash': 'Subject line\n\nBody' }, calls);
  const msg = await createMessage({ feature: 'studio-email-draft', tier: 'writing', max_tokens: 1000, messages: [{ role: 'user', content: 'draft' }] });
  assert.deepEqual(calls.map(c => c.model), ['z-ai/glm-5.2', 'deepseek/deepseek-v4.1-flash']);
  assert.equal(msg.model, 'deepseek/deepseek-v4.1-flash');
  assert.equal(msg.failed_attempts[0].model, 'z-ai/glm-5.2');
});

test('the billed cost is on usage.cost (API metering) and cost_usd (worker metering)', async () => {
  process.env.OPENROUTER_API_KEY = 'k';
  process.env.EXTRACTION_MODEL = 'z-ai/glm-5.2';
  mockByModel({ 'z-ai/glm-5.2': 'x' });
  const msg = await createMessage({ feature: 'x', max_tokens: 10, messages: [{ role: 'user', content: 'y' }] });
  assert.equal(msg.usage.cost, 0.0042);
  assert.equal(msg.cost_usd, 0.0042);
});

test('accept rejects an off-taxonomy answer so the fallback gets its turn', async () => {
  process.env.OPENROUTER_API_KEY = 'k';
  process.env.EXTRACTION_MODEL = 'deepseek/deepseek-v4.1-flash';
  process.env.EXTRACTION_FALLBACK_MODEL = 'z-ai/glm-5.2';
  mockByModel({ 'deepseek/deepseek-v4.1-flash': 'I think this is positive-ish', 'z-ai/glm-5.2': 'positive' });
  const labels = new Set(['positive', 'negative']);
  const msg = await createMessage({ feature: 'reply-classify', max_tokens: 8, messages: [{ role: 'user', content: 'r' }], accept: (t) => labels.has(t.trim()) });
  assert.equal(messageText(msg), 'positive');
});
