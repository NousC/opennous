// The door's OpenAI-compatible endpoint (GET-837): LLM_BASE_URL + LLM_API_KEY point every
// non-`claude-` model at any OpenAI-compatible server (OpenRouter by default, or OpenAI, Groq,
// Together, a local Ollama). fetch is mocked; nothing here calls a real model.
//
// Run: node --test apps/worker/tests/modelDoorEndpoint.test.mjs

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMessage, messageText, modelEndpoint, modelSetupStatus } from '../src/lib/llm.mjs';

const realFetch = globalThis.fetch;
const KEYS = ['LLM_BASE_URL', 'LLM_API_KEY', 'OPENROUTER_API_KEY', 'ANTHROPIC_API_KEY', 'EXTRACTION_MODEL',
  'EXTRACTION_FALLBACK_MODEL', 'EXTRACTION_PROVIDER', 'WRITING_MODEL', 'WRITING_FALLBACK_MODEL', 'INSIGHT_BOARD_MODEL',
  'EXTRACTION_REASONING_HEADROOM'];
const saved = Object.fromEntries(KEYS.map(k => [k, process.env[k]]));
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});
const clear = () => { for (const k of KEYS) delete process.env[k]; };

function mock(calls) {
  globalThis.fetch = async (url, init) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    return { ok: true, status: 200, json: async () => ({ id: 'x', choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }) };
  };
}

test('default endpoint is OpenRouter on OPENROUTER_API_KEY, unchanged', () => {
  clear();
  process.env.OPENROUTER_API_KEY = 'or';
  const e = modelEndpoint();
  assert.equal(e.url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(e.key, 'or');
  assert.equal(e.openRouter, true);
});

test('LLM_BASE_URL sends open models to that server, with LLM_API_KEY, and no OpenRouter-only fields', async () => {
  clear();
  process.env.LLM_BASE_URL = 'https://api.example-llm.com/v1/';
  process.env.LLM_API_KEY = 'secret';
  process.env.EXTRACTION_MODEL = 'some-model';
  process.env.EXTRACTION_PROVIDER = 'HostA';
  const calls = [];
  mock(calls);
  const msg = await createMessage({ feature: 't', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(messageText(msg), 'ok');
  assert.equal(calls[0].url, 'https://api.example-llm.com/v1/chat/completions');
  assert.equal(calls[0].headers.Authorization, 'Bearer secret');
  assert.equal(calls[0].body.provider, undefined);
  assert.equal(calls[0].body.usage, undefined);
  assert.equal(calls[0].body.max_tokens, 100, 'no OpenRouter reasoning headroom by default');
});

test('a local server (Ollama) works with no key at all', async () => {
  clear();
  process.env.LLM_BASE_URL = 'http://ollama:11434/v1';
  process.env.EXTRACTION_MODEL = 'qwen2.5:32b';
  const calls = [];
  mock(calls);
  const msg = await createMessage({ feature: 't', max_tokens: 50, messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(messageText(msg), 'ok');
  assert.equal(calls[0].headers.Authorization, undefined);
});

test('setup status: which model runs each job and whether its key is there', () => {
  clear();
  process.env.ANTHROPIC_API_KEY = 'sk-ant-api03-' + 'x'.repeat(40);
  const s = modelSetupStatus();
  const by = Object.fromEntries(s.jobs.map(j => [j.tier, j]));
  assert.equal(by.extraction.route, 'anthropic');
  assert.equal(by.extraction.ready, true);
  // Writing defaults to GLM via OpenRouter: no key, so it is not ready and falls back to Haiku.
  assert.equal(by.writing.route, 'openai_compatible');
  assert.equal(by.writing.ready, false);
  assert.equal(by.writing.fallback, by.extraction.model);
  assert.equal(s.providers.anthropic, true);
  assert.equal(s.providers.openaiCompatible, false);
});

test('the Insights board runs on the reading model when there is no OpenRouter key', () => {
  clear();
  process.env.ANTHROPIC_API_KEY = 'sk-ant-api03-' + 'x'.repeat(40);
  const by = Object.fromEntries(modelSetupStatus().jobs.map(j => [j.tier, j]));
  assert.equal(by.insights.model, by.extraction.model);
  assert.equal(by.insights.ready, true);
  process.env.OPENROUTER_API_KEY = 'sk-or-v1-' + 'y'.repeat(40);
  const withKey = Object.fromEntries(modelSetupStatus().jobs.map(j => [j.tier, j]));
  assert.equal(withKey.insights.model, 'anthropic/claude-haiku-4.5', 'unchanged where OpenRouter is set (Cloud)');
});

test('a placeholder or too-short key counts as missing in the setup status', () => {
  clear();
  for (const v of ['sk-ant-placeholder', 'sk-ant-...', 'your-key-here', 'short']) {
    process.env.ANTHROPIC_API_KEY = v;
    assert.equal(modelSetupStatus().providers.anthropic, false, v);
  }
  process.env.ANTHROPIC_API_KEY = 'sk-ant-api03-' + 'z'.repeat(40);
  assert.equal(modelSetupStatus().providers.anthropic, true);
});
