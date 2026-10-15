// GET-885: a model provider failure in the Job Builder says something a person can act on, ops
// hear about it once per incident, and the builder's Claude calls go through OpenRouter.
// Fake clients and fake alert channels: no network, no env, no database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runBuilderTurn } from '../src/lib/jobBuilder/loop.mjs';
import { builderClient } from '../src/lib/jobBuilder/index.mjs';
import { makeProviderAlert, providerFailure } from '../src/lib/providerAlert.mjs';

const SESSION = { id: '22222222-2222-4222-8222-222222222222', revbox_id: 'b', messages: [], proposal: null, state: 'open' };

const sdkError = (status, type, message) => Object.assign(
  new Error(`${status ?? ''} ${JSON.stringify({ type: 'error', error: { type, message } })}`.trim()),
  { status, error: { type: 'error', error: { type, message } } },
);
const CREDIT = () => sdkError(400, 'invalid_request_error', 'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.');

// A client whose stream fails before it reports anything (how a billing or auth refusal arrives).
const failing = (err) => ({ calls: 0, messages: { stream() {
  this.calls = (this.calls ?? 0) + 1;
  return {
    async *[Symbol.asyncIterator]() { throw err; },
    finalMessage: async () => { throw err; },
  };
} } });

function deps({ client, alerts = [], metered = [] }) {
  return {
    client, model: { modelId: 'claude-sonnet-5', thinking: false }, provider: 'openrouter',
    helpers: {}, gate: async () => {}, meter: async (m) => { metered.push(m); },
    costOf: () => 0.01, toCredits: (usd) => usd * 100, validate: () => ({ ok: true }), save: async () => {},
    alert: (a) => { alerts.push(a); return true; }, today: '2026-10-15',
    selfHosted: false,   // Cloud's words; self-host's are in jobBuilderSelfHost.test.mjs
  };
}
async function turn(d) {
  const events = [];
  for await (const e of runBuilderTurn({ session: SESSION, message: 'Post our new deals to Slack', ctx: {}, deps: d })) events.push(e);
  return events;
}

test('billing: the user sees that the model is unavailable and that we know; ops get one alert', async () => {
  const alerts = [];
  const events = await turn(deps({ client: failing(CREDIT()), alerts }));
  const err = events.find(e => e.type === 'error');
  assert.equal(err.code, 'model_unavailable');
  assert.equal(err.message, "The job builder's AI model isn't available right now. We've been alerted and are fixing it.");
  assert.doesNotMatch(err.message, /credit|anthropic|openrouter|400/i);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].provider, 'openrouter');
  assert.equal(alerts[0].kind, 'billing');
  assert.equal(alerts[0].feature, 'revbox-job-builder');
  assert.equal(events.at(-1).type, 'done');
});

test('auth: same words for the user, an auth alert for ops', async () => {
  const alerts = [];
  const events = await turn(deps({ client: failing(sdkError(401, 'authentication_error', 'invalid x-api-key')), alerts }));
  assert.equal(events.find(e => e.type === 'error').code, 'model_unavailable');
  assert.equal(alerts[0].kind, 'auth');
});

test('rate limit / overloaded: try again in a minute', async () => {
  for (const e of [sdkError(429, 'rate_limit_error', 'rate limited'), sdkError(529, 'overloaded_error', 'Overloaded')]) {
    const events = await turn(deps({ client: failing(e) }));
    const err = events.find(x => x.type === 'error');
    assert.equal(err.code, 'model_busy');
    assert.equal(err.message, 'The AI model is busy. Try again in a minute.');
  }
});

test('anything else keeps the generic message, and no alert', async () => {
  const alerts = [];
  const events = await turn(deps({ client: failing(new Error('Cannot read properties of undefined')), alerts }));
  const err = events.find(e => e.type === 'error');
  assert.equal(err.code, 'builder_failed');
  assert.equal(err.message, 'The job builder hit an error. Try again.');
  assert.equal(alerts.length, 0);
});

test('providerFailure: the words per kind, for any surface', () => {
  const quiet = () => true;
  assert.deepEqual(providerFailure(CREDIT(), { provider: 'anthropic', feature: 'f', alert: quiet, selfHosted: false }),
    { kind: 'billing', code: 'model_unavailable', message: "The AI model isn't available right now. We've been alerted and are fixing it." });
  assert.equal(providerFailure(sdkError(429, 'rate_limit_error', 'x'), { provider: 'p', feature: 'f', alert: quiet }).code, 'model_busy');
  assert.equal(providerFailure(new Error('boom'), { provider: 'p', feature: 'f', alert: quiet }), null);
});

test('the ops alert: one per provider and kind per 15 minutes, one structured line, no secrets', () => {
  let t = 1_000_000;
  const sent = [], logged = [];
  const alert = makeProviderAlert({ now: () => t, send: (title, detail, opts) => sent.push({ title, detail, opts }), log: (l) => logged.push(l) });
  const err = Object.assign(CREDIT(), { message: '400 Your credit balance is too low (key sk-or-v1-0123456789abcdef0123456789)' });
  assert.equal(alert({ provider: 'openrouter', kind: 'billing', feature: 'revbox-job-builder', err }), true);
  t += 60_000;
  assert.equal(alert({ provider: 'openrouter', kind: 'billing', feature: 'home-agent-turn', err }), false);   // a burst: once
  assert.equal(alert({ provider: 'openrouter', kind: 'auth', feature: 'revbox-job-builder', err }), true);    // another kind: its own
  t += 15 * 60_000;
  assert.equal(alert({ provider: 'openrouter', kind: 'billing', feature: 'revbox-job-builder', err }), true);  // a new window
  assert.equal(sent.length, 3);
  assert.match(logged[0], /^\[provider-alert\] openrouter billing feature=revbox-job-builder status=400 /);
  assert.equal(sent[0].opts.key, 'provider:openrouter:billing');
  assert.equal(sent[0].opts.level, 'error');
  for (const s of [...logged, ...sent.map(x => `${x.title} ${x.detail}`)]) assert.doesNotMatch(s, /sk-or-v1-0123/);
  assert.equal(alert({ provider: 'openrouter', kind: 'other', feature: 'x', err: new Error('x') }), false);  // nothing to page about
});

test('builderClient: OpenRouter when its key is set, with OpenRouter model ids and no Anthropic beta header', async () => {
  const made = [];
  class FakeLeak {
    constructor(opts) { this.opts = opts; made.push(opts); }
    async getClient() { const opts = this.opts; return { messages: { stream: (p) => ({ p, opts }) } }; }
  }
  const or = await builderClient({ env: { OPENROUTER_API_KEY: 'or-key', ANTHROPIC_API_KEY: 'a-key' }, SDK: FakeLeak });
  assert.equal(or.provider, 'openrouter');
  assert.equal(made[0].baseURL, 'https://openrouter.ai/api');
  assert.equal(made[0].authToken, 'or-key');
  assert.equal(made[0].apiKey, null);
  assert.equal(made[0].defaultHeaders['anthropic-beta'], undefined);
  assert.equal(or.client.messages.stream({ model: 'claude-sonnet-5' }).p.model, 'anthropic/claude-sonnet-5');

  const direct = await builderClient({ env: { ANTHROPIC_API_KEY: 'a-key' }, SDK: FakeLeak });
  assert.equal(direct.provider, 'anthropic');
  assert.equal(made[1].defaultHeaders['anthropic-beta'], 'extended-cache-ttl-2025-04-11');
  assert.equal(direct.client.messages.stream({ model: 'claude-sonnet-5' }).p.model, 'claude-sonnet-5');

  await assert.rejects(builderClient({ env: {}, SDK: FakeLeak }), /no model provider/);
});

test('a whole tool-using turn runs on the routed client: tool_use, tool_result, cache_control and effort pass through', async () => {
  const sent = [];
  const replies = [
    { id: 'm1', model: 'anthropic/claude-sonnet-5', stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 5 },
      content: [{ type: 'tool_use', id: 'tu_1', name: 'ask', input: { questions: [{ id: 'q1', header: 'Channel', question: 'Which channel?', options: [{ label: '#deals' }, { label: '#sales' }] }] } }] },
  ];
  const raw = { messages: { stream(p) {
    sent.push(structuredClone(p));
    const resp = replies.shift();
    return { async *[Symbol.asyncIterator]() {}, finalMessage: async () => resp };
  } } };
  const { routeClaudeClient } = await import('@nous/core');
  const metered = [];
  const d = { ...deps({ client: routeClaudeClient(raw, 'openrouter'), metered }), model: { modelId: 'claude-sonnet-5', thinking: true, effort: 'medium' } };
  const events = await turn(d);
  assert.equal(sent[0].model, 'anthropic/claude-sonnet-5');
  assert.equal(sent[0].output_config.effort, 'medium');
  assert.equal(sent[0].system[0].cache_control.ttl, '1h');
  assert.ok(sent[0].tools.length > 0);
  assert.ok(events.some(e => e.type === 'ask'));
  assert.equal(metered.length, 1);
  assert.equal(metered[0].response.model, 'anthropic/claude-sonnet-5');
});
