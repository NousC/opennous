// Claude through OpenRouter by default, Anthropic direct only when OpenRouter is not configured
// (GET-885). Pure: env passed in, fake clients, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  openRouterClaudeId, claudeIdFromOpenRouter, claudeProvider, claudeClientOptions, routeClaudeClient,
  OPENROUTER_MESSAGES_BASE,
} from '../dist/index.js';

test('openRouterClaudeId: the ids this codebase uses map to OpenRouter catalogue ids', () => {
  assert.equal(openRouterClaudeId('claude-sonnet-5'), 'anthropic/claude-sonnet-5');
  assert.equal(openRouterClaudeId('claude-opus-4-8'), 'anthropic/claude-opus-4.8');
  assert.equal(openRouterClaudeId('claude-haiku-4-5'), 'anthropic/claude-haiku-4.5');
  assert.equal(openRouterClaudeId('claude-haiku-4-5-20251001'), 'anthropic/claude-haiku-4.5');
  assert.equal(openRouterClaudeId('claude-opus-5-5'), 'anthropic/claude-opus-5.5');
  assert.equal(openRouterClaudeId('anthropic/claude-sonnet-5'), 'anthropic/claude-sonnet-5');   // already one
  assert.equal(openRouterClaudeId('z-ai/glm-5.2'), 'z-ai/glm-5.2');                               // not Claude: untouched
});

test('claudeIdFromOpenRouter: back to the id the price table is keyed by', () => {
  assert.equal(claudeIdFromOpenRouter('anthropic/claude-sonnet-5'), 'claude-sonnet-5');
  assert.equal(claudeIdFromOpenRouter('anthropic/claude-opus-4.8'), 'claude-opus-4-8');
  assert.equal(claudeIdFromOpenRouter('anthropic/claude-haiku-4.5'), 'claude-haiku-4-5');
  assert.equal(claudeIdFromOpenRouter('claude-sonnet-4-5-20250929'), 'claude-sonnet-4-5');
  assert.equal(claudeIdFromOpenRouter('claude-sonnet-5'), 'claude-sonnet-5');
  assert.equal(claudeIdFromOpenRouter(null), null);
});

test('claudeProvider: OpenRouter when its key is set, Anthropic only without it, CLAUDE_PROVIDER overrides', () => {
  assert.equal(claudeProvider({ OPENROUTER_API_KEY: 'k', ANTHROPIC_API_KEY: 'a' }), 'openrouter');
  assert.equal(claudeProvider({ OPENROUTER_API_KEY: 'k' }), 'openrouter');
  assert.equal(claudeProvider({ ANTHROPIC_API_KEY: 'a' }), 'anthropic');
  assert.equal(claudeProvider({}), null);
  assert.equal(claudeProvider({ OPENROUTER_API_KEY: 'k', ANTHROPIC_API_KEY: 'a', CLAUDE_PROVIDER: 'anthropic' }), 'anthropic');
  // An override naming a provider with no key does not strand the install.
  assert.equal(claudeProvider({ OPENROUTER_API_KEY: 'k', CLAUDE_PROVIDER: 'anthropic' }), 'openrouter');
  // LLM_API_KEY is OpenRouter's key only when the endpoint is OpenRouter.
  assert.equal(claudeProvider({ LLM_API_KEY: 'k' }), 'openrouter');
  assert.equal(claudeProvider({ LLM_API_KEY: 'k', LLM_BASE_URL: 'http://localhost:11434/v1' }), null);
});

test('claudeClientOptions: OpenRouter gets a bearer token and its base URL, never the Anthropic key or beta header', () => {
  const beta = { 'anthropic-beta': 'extended-cache-ttl-2025-04-11' };
  const or = claudeClientOptions({ env: { OPENROUTER_API_KEY: 'or-key', ANTHROPIC_API_KEY: 'a-key' }, headers: beta });
  assert.equal(or.provider, 'openrouter');
  assert.equal(or.options.baseURL, OPENROUTER_MESSAGES_BASE);
  assert.equal(OPENROUTER_MESSAGES_BASE, 'https://openrouter.ai/api');   // the SDK appends /v1/messages
  assert.equal(or.options.authToken, 'or-key');
  assert.equal(or.options.apiKey, null);   // null, not undefined: the SDK would read ANTHROPIC_API_KEY
  assert.equal(or.options.defaultHeaders['anthropic-beta'], undefined);

  const direct = claudeClientOptions({ env: { ANTHROPIC_API_KEY: 'a-key' }, headers: beta });
  assert.equal(direct.provider, 'anthropic');
  assert.equal(direct.options.apiKey, 'a-key');
  assert.equal(direct.options.baseURL, undefined);
  assert.equal(direct.options.defaultHeaders['anthropic-beta'], 'extended-cache-ttl-2025-04-11');

  assert.equal(claudeClientOptions({ env: {} }), null);
});

test('routeClaudeClient: OpenRouter gets OpenRouter model ids on create and stream; the rest of the request is untouched', async () => {
  const seen = [];
  const fake = { messages: {
    create: async (p, o) => { seen.push(['create', p, o]); return { model: p.model, content: [] }; },
    stream: (p, o) => { seen.push(['stream', p, o]); return { p }; },
  } };
  const c = routeClaudeClient(fake, 'openrouter');
  assert.equal(c.provider, 'openrouter');
  const params = { model: 'claude-sonnet-5', max_tokens: 10, feature: 'x', tools: [{ name: 't' }], output_config: { effort: 'medium' }, messages: [] };
  await c.messages.create(params, { signal: 1 });
  c.messages.stream({ ...params, model: 'claude-opus-4-8' });
  assert.equal(seen[0][1].model, 'anthropic/claude-sonnet-5');
  assert.equal(seen[0][1].feature, 'x');
  assert.deepEqual(seen[0][1].tools, [{ name: 't' }]);
  assert.deepEqual(seen[0][2], { signal: 1 });
  assert.equal(seen[1][1].model, 'anthropic/claude-opus-4.8');
  assert.equal(params.model, 'claude-sonnet-5');   // the caller's object is not changed

  const d = routeClaudeClient(fake, 'anthropic');
  await d.messages.create(params);
  assert.equal(seen[2][1].model, 'claude-sonnet-5');
});

test('the model door: a claude- id goes to OpenRouter as its OpenRouter id, comes back under ours with the billed cost', async () => {
  const { registerAnthropicClient, createMessage, ModelUnavailableError } = await import('../dist/index.js');
  const asked = [];
  registerAnthropicClient({ messages: { create: async (p) => {
    asked.push(p);
    return { model: 'anthropic/claude-haiku-4.5', stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 2, cost: 0.0021 }, content: [{ type: 'text', text: 'ok' }] };
  } } }, { acceptsFeature: false, provider: 'openrouter' });
  try {
    const msg = await createMessage({ feature: 't', model: 'claude-haiku-4-5', fallback: false, max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(asked[0].model, 'anthropic/claude-haiku-4.5');
    assert.equal(msg.model, 'claude-haiku-4-5');
    assert.equal(msg.cost_usd, 0.0021);

    // Out of credit on OpenRouter (402) is an outage the door's fallback handles, not a bug.
    registerAnthropicClient({ messages: { create: async () => { throw Object.assign(new Error('402 {"type":"error","error":{"type":"billing_error","message":"Insufficient credits"}}'), { status: 402 }); } } }, { acceptsFeature: false, provider: 'openrouter' });
    await assert.rejects(createMessage({ feature: 't', model: 'claude-haiku-4-5', fallback: false, max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] }), ModelUnavailableError);
  } finally {
    registerAnthropicClient(null);
  }
});
