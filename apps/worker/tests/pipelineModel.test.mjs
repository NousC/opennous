// One door for the extraction pipeline's model calls (lib/llm.mjs), and one prompt builder.
//
// The pipeline hardcoded Haiku in seven places, and every failure — a dead key, an empty
// credit balance — came back as "no facts found". These pin the three things that fixed
// that: a model is one setting, an outage is its own error, and an unparseable answer is
// not an empty one. fetch is mocked; nothing here calls a real model.
//
// Run: node --test apps/worker/tests/pipelineModel.test.mjs

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMessage, pipelineModel, pipelineFallbackModel, parseJsonArray, ModelUnavailableError } from '../src/lib/llm.mjs';
import { buildActivitySignalsPrompt } from '../src/signals/index.mjs';

const realFetch = globalThis.fetch;
const env = { ...process.env };
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const k of ['EXTRACTION_MODEL', 'EXTRACTION_PROVIDER', 'OPENROUTER_API_KEY', 'EXTRACTION_TIMEOUT_MS', 'EXTRACTION_REASONING_HEADROOM', 'EXTRACTION_FALLBACK_MODEL', 'EXTRACTION_FALLBACK_PROVIDER']) {
    if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k];
  }
});

function mockOpenRouter(response, { status = 200, capture } = {}) {
  globalThis.fetch = async (url, init) => {
    capture?.(url, JSON.parse(init.body));
    return { ok: status < 400, status, statusText: 'x', json: async () => response };
  };
}

// ── model selection ──────────────────────────────────────────────────────────

test('pipelineModel defaults to Haiku, so nothing changes until the setting is set', () => {
  delete process.env.EXTRACTION_MODEL;
  assert.equal(pipelineModel(), 'claude-haiku-4-5-20251001');
});

test('pipelineModel reads EXTRACTION_MODEL per call — a config change needs no rebuild', () => {
  process.env.EXTRACTION_MODEL = 'z-ai/glm-5.2';
  assert.equal(pipelineModel(), 'z-ai/glm-5.2');
});

// ── OpenRouter response → the Anthropic shape the call sites read ────────────

test('an OpenRouter answer comes back in the Anthropic shape, with real cost and host', async () => {
  process.env.OPENROUTER_API_KEY = 'test';
  mockOpenRouter({
    provider: 'Novita',
    choices: [{ message: { content: '[{"content":"Odessa T. builds MERN apps."}]' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1600, completion_tokens: 900, completion_tokens_details: { reasoning_tokens: 700 }, cost: 0.00213 },
  });
  const msg = await createMessage({ feature: 't', model: 'z-ai/glm-5.2', max_tokens: 400, messages: [{ role: 'user', content: 'x' }] });
  assert.equal(msg.content[0].text, '[{"content":"Odessa T. builds MERN apps."}]');
  assert.equal(msg.usage.input_tokens, 1600);
  assert.equal(msg.usage.output_tokens, 900, 'output includes reasoning — it is billed');
  assert.equal(msg.usage.reasoning_tokens, 700);
  assert.equal(msg.cost_usd, 0.00213);
  assert.equal(msg.provider, 'Novita');
});

test('open models get reasoning headroom, so thinking cannot eat the whole answer budget', async () => {
  process.env.OPENROUTER_API_KEY = 'test';
  let sent;
  mockOpenRouter({ choices: [{ message: { content: '[]' } }], usage: {} }, { capture: (_u, b) => { sent = b; } });
  await createMessage({ model: 'moonshotai/kimi-k2.6', max_tokens: 400, messages: [{ role: 'user', content: 'x' }] });
  assert.ok(sent.max_tokens >= 400 + 16000, 'a 6,000 headroom lost a sixth of answers to reasoning');
  assert.deepEqual(sent.usage, { include: true });
});

test('EXTRACTION_REASONING_HEADROOM tunes the thinking budget', async () => {
  process.env.OPENROUTER_API_KEY = 'test';
  process.env.EXTRACTION_REASONING_HEADROOM = '2000';
  let sent;
  mockOpenRouter({ choices: [{ message: { content: '[]' } }], usage: {} }, { capture: (_u, b) => { sent = b; } });
  await createMessage({ model: 'moonshotai/kimi-k2.6', max_tokens: 400, messages: [{ role: 'user', content: 'x' }] });
  assert.equal(sent.max_tokens, 2400);
});

test('EXTRACTION_PROVIDER pins the serving host with no silent fallback', async () => {
  process.env.OPENROUTER_API_KEY = 'test';
  process.env.EXTRACTION_PROVIDER = 'DeepInfra, Together';
  let sent;
  mockOpenRouter({ choices: [{ message: { content: '[]' } }], usage: {} }, { capture: (_u, b) => { sent = b; } });
  await createMessage({ model: 'qwen/qwen3.5-397b-a17b', max_tokens: 400, messages: [{ role: 'user', content: 'x' }] });
  assert.deepEqual(sent.provider, { order: ['DeepInfra', 'Together'], allow_fallbacks: false });
});

// ── an outage is not "no facts" ──────────────────────────────────────────────

test('an OpenRouter HTTP error is a ModelUnavailableError, not an empty answer', async () => {
  process.env.OPENROUTER_API_KEY = 'test';
  mockOpenRouter({ error: { code: 402, message: 'Insufficient credits' } }, { status: 402 });
  await assert.rejects(
    createMessage({ model: 'z-ai/glm-5.2', max_tokens: 10, messages: [{ role: 'user', content: 'x' }] }),
    (err) => err instanceof ModelUnavailableError && err.status === 402,
  );
});

test('a network failure is a ModelUnavailableError', async () => {
  process.env.OPENROUTER_API_KEY = 'test';
  globalThis.fetch = async () => { throw new Error('ECONNRESET'); };
  await assert.rejects(
    createMessage({ model: 'z-ai/glm-5.2', max_tokens: 10, messages: [{ role: 'user', content: 'x' }] }),
    ModelUnavailableError,
  );
});

test('a hung call times out as a ModelUnavailableError instead of holding the worker', async () => {
  process.env.OPENROUTER_API_KEY = 'test';
  process.env.EXTRACTION_TIMEOUT_MS = '30';
  globalThis.fetch = (_url, init) => new Promise((_res, rej) => {
    init.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });
  await assert.rejects(
    createMessage({ model: 'z-ai/glm-5.2', max_tokens: 10, messages: [{ role: 'user', content: 'x' }] }),
    (err) => err instanceof ModelUnavailableError && err.status === 'timeout',
  );
});

test('a missing OpenRouter key is a ModelUnavailableError, not a crash', async () => {
  delete process.env.OPENROUTER_API_KEY;
  await assert.rejects(
    createMessage({ model: 'z-ai/glm-5.2', max_tokens: 10, messages: [{ role: 'user', content: 'x' }] }),
    ModelUnavailableError,
  );
});

// ── the fallback model ───────────────────────────────────────────────────────

const PRIMARY = 'deepseek/deepseek-v4.1-flash';
const SECOND = 'z-ai/glm-5.2';

/** fetch that answers per model: `answers[model]` is a response body, or 'down' / 'hang'. */
function mockByModel(answers, calls = []) {
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    const a = answers[body.model];
    if (a === 'down') return { ok: false, status: 503, statusText: 'x', json: async () => ({ error: { code: 503, message: 'no host' } }) };
    return { ok: true, status: 200, statusText: 'ok', json: async () => a };
  };
  return calls;
}
const answer = (text, extra = {}) => ({ choices: [{ message: { content: text }, finish_reason: 'stop' }], usage: { cost: 0.001 }, ...extra });
const ask = (opts = {}) => createMessage({ feature: 't', model: PRIMARY, max_tokens: 400, messages: [{ role: 'user', content: 'x' }], ...opts });

test('no fallback set: one model, exactly as before', async () => {
  process.env.OPENROUTER_API_KEY = 'test';
  const calls = mockByModel({ [PRIMARY]: answer('') });
  const msg = await ask();
  assert.equal(calls.length, 1);
  assert.equal(msg.content[0].text, '');
});

test('the fallback answers when the primary comes back empty, and the wasted call is kept for metering', async () => {
  process.env.OPENROUTER_API_KEY = 'test';
  process.env.EXTRACTION_MODEL = PRIMARY;
  process.env.EXTRACTION_FALLBACK_MODEL = SECOND;
  mockByModel({
    [PRIMARY]: { choices: [{ message: { content: '' }, finish_reason: 'length' }], usage: { cost: 0.004 }, provider: 'Parasail' },
    [SECOND]: answer('[{"content":"Peregrine Wexley manages Trellisdata tables for 60+ clients."}]'),
  });
  const msg = await ask({ accept: t => parseJsonArray(t) !== null });
  assert.equal(msg.model, SECOND);
  assert.equal(msg.failed_attempts.length, 1);
  assert.equal(msg.failed_attempts[0].model, PRIMARY);
  assert.equal(msg.failed_attempts[0].cost_usd, 0.004);
  assert.match(msg.failed_attempts[0].reason, /empty answer \(finish: length\)/);
});

test('the fallback answers when the primary is unreachable', async () => {
  process.env.OPENROUTER_API_KEY = 'test';
  process.env.EXTRACTION_MODEL = PRIMARY;
  process.env.EXTRACTION_FALLBACK_MODEL = SECOND;
  mockByModel({ [PRIMARY]: 'down', [SECOND]: answer('[]') });
  const msg = await ask();
  assert.equal(msg.model, SECOND);
  assert.match(msg.failed_attempts[0].reason, /^unavailable/);
});

test('an answer the caller cannot use (no JSON array) goes to the fallback', async () => {
  process.env.OPENROUTER_API_KEY = 'test';
  process.env.EXTRACTION_MODEL = PRIMARY;
  process.env.EXTRACTION_FALLBACK_MODEL = SECOND;
  mockByModel({ [PRIMARY]: answer('The user wants me to extract durable CRM intelligence…'), [SECOND]: answer('[]') });
  const msg = await ask({ accept: t => parseJsonArray(t) !== null });
  assert.equal(msg.model, SECOND);
});

test('a real "nothing found" ([]) is an answer, not a failure — no second call', async () => {
  process.env.OPENROUTER_API_KEY = 'test';
  process.env.EXTRACTION_MODEL = PRIMARY;
  process.env.EXTRACTION_FALLBACK_MODEL = SECOND;
  const calls = mockByModel({ [PRIMARY]: answer('[]'), [SECOND]: answer('[{"content":"x"}]') });
  const msg = await ask({ accept: t => parseJsonArray(t) !== null });
  assert.equal(calls.length, 1);
  assert.equal(msg.model, PRIMARY);
});

test('both down is still an outage, never an empty answer', async () => {
  process.env.OPENROUTER_API_KEY = 'test';
  process.env.EXTRACTION_MODEL = PRIMARY;
  process.env.EXTRACTION_FALLBACK_MODEL = SECOND;
  mockByModel({ [PRIMARY]: 'down', [SECOND]: 'down' });
  await assert.rejects(ask(), ModelUnavailableError);
});

test('fallback:false calls exactly one model (evals compare models, they must not blend them)', async () => {
  process.env.OPENROUTER_API_KEY = 'test';
  process.env.EXTRACTION_MODEL = PRIMARY;
  process.env.EXTRACTION_FALLBACK_MODEL = SECOND;
  const calls = mockByModel({ [PRIMARY]: answer(''), [SECOND]: answer('[]') });
  await ask({ fallback: false });
  assert.equal(calls.length, 1);
});

test('each model is pinned to its own hosts', async () => {
  process.env.OPENROUTER_API_KEY = 'test';
  process.env.EXTRACTION_MODEL = PRIMARY;
  process.env.EXTRACTION_FALLBACK_MODEL = SECOND;
  process.env.EXTRACTION_PROVIDER = 'Parasail, Venice';
  process.env.EXTRACTION_FALLBACK_PROVIDER = 'Together';
  const calls = mockByModel({ [PRIMARY]: 'down', [SECOND]: answer('[]') });
  await ask();
  assert.deepEqual(calls[0].provider.order, ['Parasail', 'Venice']);
  assert.deepEqual(calls[1].provider.order, ['Together']);
});

test('a fallback equal to the primary is no fallback', () => {
  process.env.EXTRACTION_MODEL = PRIMARY;
  process.env.EXTRACTION_FALLBACK_MODEL = PRIMARY;
  assert.equal(pipelineFallbackModel(), null);
});

// ── unparseable is not empty ─────────────────────────────────────────────────

test('parseJsonArray: a bare [] is a real "nothing found"', () => {
  assert.deepEqual(parseJsonArray('[]'), []);
});

test('parseJsonArray: finds the array inside fences or prose', () => {
  assert.deepEqual(parseJsonArray('```json\n[{"a":1}]\n```'), [{ a: 1 }]);
  assert.deepEqual(parseJsonArray('Here you go: [{"a":1}] hope that helps'), [{ a: 1 }]);
});

test('parseJsonArray: no parseable array is null — a failure, never mistaken for []', () => {
  assert.equal(parseJsonArray(''), null);
  assert.equal(parseJsonArray('I could not find any facts.'), null);
  assert.equal(parseJsonArray('[{"content": "truncated mid-fa'), null);
});

test('parseJsonArray: an object-wrapped array is read, not lost — open models often wrap', () => {
  assert.deepEqual(parseJsonArray('{"facts": [{"content": "x"}]}'), [{ content: 'x' }]);
});

// ── the prompt builder production and the comparison share ───────────────────

test('buildActivitySignalsPrompt keeps the subject rules that stopped the wrong-person claims', () => {
  const { prompt } = buildActivitySignalsPrompt({
    contactName: 'Odessa T.', company: 'Acme', type: 'linkedin_message', summary: 'Hi Theo, I build MERN apps.',
  });
  assert.match(prompt, /Extract durable CRM intelligence about Odessa T\./);
  assert.match(prompt, /Odessa T\. is the ONLY possible subject/);
  assert.match(prompt, /that name is the RECIPIENT, not Odessa T\./);
  assert.match(prompt, /Contact: Odessa T\. at Acme/);
  assert.match(prompt, /Message: "Hi Theo, I build MERN apps\."/);
  assert.match(prompt, /a message that Odessa T\. sent to our team/);
});

test('buildActivitySignalsPrompt scales the fact ceiling and output budget by source type', () => {
  const dm = buildActivitySignalsPrompt({ contactName: 'A B', type: 'linkedin_message', summary: 'x' });
  const call = buildActivitySignalsPrompt({ contactName: 'A B', type: 'meeting_held', summary: 'x' });
  assert.equal(dm.maxFacts, 4);
  assert.equal(call.maxFacts, 12);
  assert.ok(call.maxTokens > dm.maxTokens);
  assert.match(call.prompt, /notes\/transcript from a meeting with A B/);
});
