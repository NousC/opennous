// The RevBox Job Builder's turn (GET-868), driven by a scripted model: no network, no database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { makeJobBuilder, collectTurn, turnInput } from '../src/lib/jobBuilder/index.mjs';
import { signalCatalog } from '@nous/core';
import { makeRevboxesV2Router } from '../src/routes/v2/revboxes.mjs';
import { MAX_ROUNDS, renderAnswers, runBuilderTurn, partialUsage, jobIntegrations } from '../src/lib/jobBuilder/loop.mjs';
import { runTool, revboxContextReader } from '../src/lib/jobBuilder/tools.mjs';
import { hubspotAccessForToken, capabilitiesFromScopes } from '../src/lib/jobBuilder/hubspotAccess.mjs';
import { sseFrame, streamEvents, makeRevboxBuilderRouter } from '../src/routes/api/revboxBuilder.mjs';

const BOX = '11111111-1111-4111-8111-111111111111';
const SESSION = '22222222-2222-4222-8222-222222222222';
const CUSTOM = '2-9000001';
const TU_FIELDS = ['pulls', 'approved', 'declined', 'pending', 'errors'].map(k => ({ name: `meterline_usage_${k}`, label: `Meterline usage ${k}`, type: 'number' }));

// ── A scripted Anthropic client ─────────────────────────────────────────────────
let n = 0;
const use = (name, input) => ({ type: 'tool_use', id: `tu_${++n}`, name, input });
const reply = (content, stop = content.some(b => b.type === 'tool_use') ? 'tool_use' : 'end_turn') =>
  ({ id: `msg_${++n}`, model: 'claude-sonnet-5', content, stop_reason: stop, usage: { input_tokens: 1000, output_tokens: 100 } });

function scriptedClient(script) {
  const calls = [];
  return {
    calls,
    messages: {
      stream(params) {
        calls.push(structuredClone(params));
        const resp = script.shift();
        if (!resp) throw new Error('script ran out');
        return {
          async *[Symbol.asyncIterator]() {
            for (const b of resp.content) if (b.type === 'text') yield { type: 'content_block_delta', delta: { type: 'text_delta', text: b.text } };
          },
          finalMessage: async () => resp,
        };
      },
    },
  };
}

function helpers() {
  return {
    connections: async () => [{ id: 'c1', slug: 'hubspot', label: 'HubSpot' }, { id: 'c2', slug: 'slack', label: 'Slack' }],
    revboxContext: async () => ({ box: { id: BOX, name: 'Meterline', objective: 'CS handoff' }, context: [], jobs: [] }),
    hubspotObjects: async () => ({ connected: true, objects: [{ id: 'companies', label: 'Companies' }, { id: 'contacts', label: 'Contacts' }, { id: 'deals', label: 'Deals' }, { id: CUSTOM, label: 'Account Daily Usage', custom: true }] }),
    hubspotFields: async (_ctx, object) => object === CUSTOM
      ? [...TU_FIELDS, { name: 'date', label: 'Date', type: 'date' }, { name: 'company_name', label: 'Company name', type: 'string' }]
      : [{ name: 'name', label: 'Name', type: 'string' }],
    hubspotAccess: async () => ({ connected: true, method: 'token_info', capabilities: capabilitiesFromScopes(['crm.objects.companies.read', 'crm.objects.custom.read', 'crm.schemas.custom.read']), missing: [] }),
    hubspotRead: async (_ctx, cfg) => ({ ok: true, read: 42, count: 12, totals: {}, text: `${cfg.object_label}: 12 accounts` }),
    slackTargets: async () => ({ connected: true, channels: [{ id: 'C0TU', name: 'meterline-cs', member: true }, { id: 'C0CS', name: 'cs-handoffs', member: true }, { id: 'C0GEN', name: 'general', member: true }], people: [] }),
    mailboxes: async () => [],
    searchAccounts: async () => [],
    customSignals: async () => [],
    signalLabels: () => ({ churn_risk: 'Churn risk' }),
    signalCatalog: async () => signalCatalog({ custom: [{ id: 'cs1', key: 'pricing_pushback', name: 'Pricing pushback', rule: 'The buyer pushes back on price.', active: true }] }),
  };
}

// The engine's session store, in memory (packages/core/src/db/revboxBuilder.mjs's signatures).
function engine({ validate } = {}) {
  const sessions = new Map();
  const log = { saves: [], validations: [], approvals: [] };
  return {
    log, sessions,
    createBuilderSession: async (_sb, { revboxId, jobId }) => { const s = { id: SESSION, revbox_id: revboxId, job_id: jobId, messages: [], proposal: null, state: 'open' }; sessions.set(s.id, s); return s; },
    getBuilderSession: async (_sb, { sessionId }) => structuredClone(sessions.get(sessionId) ?? null),
    // As core: only the fields given are written.
    saveBuilderSession: async (_sb, args) => {
      const { sessionId, workspaceId: _w, ...patch } = args;
      log.saves.push({ ...patch, args });
      Object.assign(sessions.get(sessionId), structuredClone(Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined))));
    },
    approveBuilderProposal: async (_sb, args) => { log.approvals.push(args); return { routine: { id: 'r1', name: args.proposal.name, enabled: false } }; },
    listRevboxRoutines: async () => [],
    validateBuilderProposal: (proposal, ids) => { log.validations.push({ proposal, ids }); return validate ? validate(proposal, ids, log.validations.length) : { ok: true, errors: [] }; },
  };
}

function builder({ script, eng = engine(), gate = async () => {}, meter } = {}) {
  const client = scriptedClient(script);
  const metered = [];
  const b = makeJobBuilder({
    engine: eng, client, helpers: helpers(), gate,
    meter: meter ?? (async (m) => { metered.push(m); }),
    model: { modelId: 'claude-sonnet-5', thinking: false },
    costOf: () => 0.01, toCredits: (usd) => Math.ceil(usd / 0.02), today: '2026-10-14',
  });
  return { b, client, eng, metered };
}

async function turn(b, args) {
  const base = { sb: {}, workspaceId: 'ws', userId: 'u1', revboxId: BOX };
  const opened = await b.openSession({ ...base, sessionId: args.sessionId ?? null });
  const events = [];
  for await (const e of b.runTurn({ ...base, ...opened, message: args.message ?? null, answers: args.answers ?? null, hints: args.hints ?? null })) events.push(e);
  return events;
}

const REFERENCE_PROPOSAL = {
  name: 'Meterline daily summary',
  summary: 'Every morning at 08:00 New York time: read yesterday\'s Meterline numbers per account, write the summary, post it to #meterline-cs.',
  trigger: { kind: 'clock', config: { frequency: 'daily', at: '08:00' }, timezone: 'America/New_York', label: 'Every day at 08:00 (New York)' },
  steps: [
    { id: 'read', type: 'hubspot', config: { action: 'read', object: CUSTOM, object_label: 'Account Daily Usage', fields: TU_FIELDS.map(f => f.name), field_labels: TU_FIELDS.map(f => ({ name: f.name, label: f.label })), group_by: 'company_name', date_property: 'date', window: 'yesterday', compare: true } },
    { id: 'summary', type: 'agent', config: { mode: 'write', model: 'opennous', prompt: 'Write the VP summary from {{steps.read.output}}.' } },
    { id: 'post', type: 'slack', config: { action: 'channel', channel_id: 'C0TU', channel: 'meterline-cs', text: '{{steps.summary.output}}' } },
  ],
  display: [
    { step_id: 'read', tool: 'hubspot', title: 'Read Account Daily Usage', detail: '5 Meterline fields · per account · yesterday vs the day before' },
    { step_id: 'summary', tool: 'opennous', title: 'Write the summary' },
    { step_id: 'post', tool: 'slack', title: 'Post to #meterline-cs' },
  ],
  uses_box_delivery: false,
  warnings: [], assumptions: ['Weekends are reported as quiet days.'], estimated_credits_per_run: 2,
};

// ── (a) The Meterline reference ────────────────────────────────────────────────

test('Meterline: find the custom object, preview it, ask about the channel, then propose the reference flow', async () => {
  const ask = use('ask', { questions: [
    { id: 'channel', header: 'Channel', question: 'There is no #meterline-cs-handoff. Where should the report go?', options: [{ label: '#meterline-cs (Recommended)' }, { label: '#cs-handoffs' }] },
    { id: 'tone', header: 'Report', question: 'How should the report read?', options: [{ label: 'VP summary (Recommended)' }, { label: 'Full table' }] },
  ] });
  const script = [
    reply([{ type: 'text', text: 'Looking in HubSpot.' }, use('hubspot_find', { query: 'meterline' }), use('hubspot_access', {})]),
    reply([use('hubspot_preview', { object: CUSTOM, object_label: 'Account Daily Usage', fields: TU_FIELDS.map(f => f.name), group_by: 'company_name', date_property: 'date', window: 'yesterday' }), use('slack_channels', { query: 'Meterline CS handoff' })]),
    reply([ask]),
  ];
  const { b, client, eng, metered } = builder({ script });
  const events = await turn(b, { message: 'Set up a job that pulls Meterline account summaries from HubSpot and creates a report every morning for me into the Slack channel "Meterline CS handoff".' });

  assert.deepEqual(events[0], { type: 'session', session_id: SESSION });
  assert.ok(events.some(e => e.type === 'status' && e.text === 'Looking for meterline in HubSpot…'));
  const found = events.find(e => e.type === 'tool' && e.name === 'hubspot_find' && e.state === 'done');
  assert.equal(found.summary, 'Found Account Daily Usage (5 meterline fields)');
  const slack = events.find(e => e.type === 'tool' && e.name === 'slack_channels' && e.state === 'done');
  assert.match(slack.summary, /No channel named exactly "Meterline CS handoff"; 2 close matches/);
  assert.deepEqual(events.find(e => e.type === 'text'), { type: 'text', text: 'Looking in HubSpot.' });
  const asked = events.find(e => e.type === 'ask');
  assert.equal(asked.questions.length, 2);
  assert.equal(asked.questions[0].options[0].label, '#meterline-cs (Recommended)');
  assert.deepEqual(events.slice(-2), [{ type: 'credits', credits: 2 }, { type: 'done' }]);   // 3 calls x $0.01
  assert.equal(client.calls.length, 3);
  assert.equal(metered.length, 3);
  assert.equal(new Set(metered.map(m => m.requestId)).size, 3);
  assert.ok(metered.every(m => m.requestId.startsWith(`revbox-job-builder:${SESSION}:`)));
  // The slack result reached the model, short, with both close channels.
  const slackResult = client.calls[2].messages.at(-1).content.find(b => b.type === 'tool_result' && b.content.includes('C0TU'));
  assert.ok(slackResult.content.includes('C0CS') && !slackResult.content.includes('C0GEN'));
  // Prompt caching: the system prefix on the hour, one breakpoint on the tail.
  assert.deepEqual(client.calls[0].system[0].cache_control, { type: 'ephemeral', ttl: '1h' });
  assert.equal(client.calls[1].messages.flatMap(m => Array.isArray(m.content) ? m.content : []).filter(b => b.cache_control).length, 1);
  // Saved after the turn, ending on the open ask.
  assert.equal(eng.log.saves.length, 1);
  assert.equal(eng.log.saves[0].messages.at(-1).content.at(-1).name, 'ask');

  // Turn 2: the answers come back and the model proposes the reference flow.
  script.push(reply([use('propose_job', REFERENCE_PROPOSAL)]));
  const events2 = await turn(b, { sessionId: SESSION, answers: [{ id: 'channel', selected: ['#meterline-cs (Recommended)'] }, { id: 'tone', selected: [], other: 'Short, for the VP' }] });
  assert.equal(events2.some(e => e.type === 'session'), false);
  const firstUser = client.calls[3].messages.at(-1);
  assert.equal(firstUser.role, 'user');
  assert.equal(firstUser.content[0].type, 'tool_result');
  assert.equal(firstUser.content[0].tool_use_id, ask.id);
  assert.match(firstUser.content[0].content, /Where should the report go\?\n-> #meterline-cs \(Recommended\)/);
  assert.match(firstUser.content[0].content, /Other: Short, for the VP/);
  const proposal = events2.find(e => e.type === 'proposal').proposal;
  assert.equal(proposal.steps[0].config.object, CUSTOM);
  assert.equal(proposal.steps[2].config.channel_id, 'C0TU');
  assert.deepEqual(proposal.trigger.config, { frequency: 'daily', at: '08:00' });
  assert.ok(eng.log.validations[0].ids.slackChannelIds.includes('C0TU'));
  assert.equal(eng.sessions.get(SESSION).proposal.name, 'Meterline daily summary');

  // Approve sends the saved proposal to the engine, with the card's inline rename.
  const out = await b.approve({ sb: {}, workspaceId: 'ws', userId: 'u1', revboxId: BOX, sessionId: SESSION, name: '  TU morning report ' });
  assert.equal(out.routine.name, 'TU morning report');
  assert.equal(eng.log.approvals[0].proposal.steps.length, 3);

  // A message after a proposal closes the proposal's tool_use, then carries the words.
  script.push(reply([{ type: 'text', text: 'Changed.' }]));
  await turn(b, { sessionId: SESSION, message: 'Make it 07:30' });
  const tail = client.calls[4].messages.at(-1).content;
  assert.equal(tail[0].type, 'tool_result');
  assert.equal(tail[1].text, 'Make it 07:30');
});

// ── (b) Validation errors go back to the model ─────────────────────────────────

test('a proposal that fails validation is returned to the model as an error, and the fix is proposed', async () => {
  const bad = { ...REFERENCE_PROPOSAL, steps: REFERENCE_PROPOSAL.steps.map(s => s.id === 'post' ? { ...s, config: { ...s.config, channel_id: 'C0BAD' } } : s) };
  const eng = engine({ validate: (p, ids) => ids.slackChannelIds.includes(p.steps[2].config.channel_id) ? { ok: true, errors: [] } : { ok: false, errors: ['Step "post": channel_id C0BAD is not a Slack channel this workspace has.'] } });
  const first = use('propose_job', bad);
  const { b, client } = builder({ eng, script: [reply([first]), reply([use('propose_job', REFERENCE_PROPOSAL)])] });
  const events = await turn(b, { message: 'Meterline report every morning' });
  assert.equal(eng.log.validations.length, 2);
  const failed = events.find(e => e.type === 'tool' && e.name === 'propose_job' && e.state === 'error');
  assert.match(failed.summary, /C0BAD/);
  const fed = client.calls[1].messages.at(-1).content[0];
  assert.equal(fed.tool_use_id, first.id);
  assert.equal(fed.is_error, true);
  assert.match(fed.content, /did not validate[\s\S]*C0BAD/);
  assert.equal(events.filter(e => e.type === 'proposal').length, 1);
  assert.equal(events.find(e => e.type === 'proposal').proposal.steps[2].config.channel_id, 'C0TU');
});

test('an ask with one option is refused back to the model', async () => {
  const { b, client } = builder({ script: [reply([use('ask', { questions: [{ id: 'x', header: 'X', question: 'Which?', options: [{ label: 'Only' }] }] })]), reply([{ type: 'text', text: 'ok' }])] });
  const events = await turn(b, { message: 'hi' });
  assert.equal(events.some(e => e.type === 'ask'), false);
  assert.match(client.calls[1].messages.at(-1).content[0].content, /2 to 5 options/);
});

// ── (c) Credits ─────────────────────────────────────────────────────────────────

test('insufficient credits: an error event, and no model call', async () => {
  const gate = async () => { throw Object.assign(new Error('You have used your credits.'), { status: 402 }); };
  const { b, client, eng } = builder({ gate, script: [reply([{ type: 'text', text: 'never' }])] });
  const events = await turn(b, { message: 'Set up a job' });
  assert.deepEqual(events, [
    { type: 'session', session_id: SESSION },
    { type: 'error', code: 'insufficient_credits', message: 'You have used your credits.' },
    { type: 'done' },
  ]);
  assert.equal(client.calls.length, 0);
  // The message is kept (GET-889): saved once, ending on the user's words, so it shows on reopen.
  assert.equal(eng.log.saves.length, 1);
  assert.deepEqual(eng.log.saves[0].messages.at(-1), { role: 'user', content: [{ type: 'text', text: 'Set up a job' }] });
});

test('a failed meter write stops the turn before any further paid call', async () => {
  const { b, client } = builder({ meter: async () => { throw new Error('ledger down'); }, script: [reply([use('hubspot_objects', {})]), reply([{ type: 'text', text: 'never' }])] });
  const events = await turn(b, { message: 'go' });
  assert.equal(client.calls.length, 1);
  assert.equal(events.find(e => e.type === 'error').code, 'metering_failed');
  assert.equal(events.at(-1).type, 'done');
});

test(`the loop stops after ${MAX_ROUNDS} rounds and says so; the last round is told it is the last`, async () => {
  const script = Array.from({ length: MAX_ROUNDS + 2 }, () => reply([use('hubspot_objects', {})]));
  const { b, client, eng } = builder({ script });
  const events = await turn(b, { message: 'go' });
  assert.equal(client.calls.length, MAX_ROUNDS);
  assert.match(client.calls.at(-1).system[0].text, /last step this turn/);
  assert.match(events.filter(e => e.type === 'text').at(-1).text, /could not finish/);
  // Saved transcript ends on the tool results (valid for the next turn).
  assert.equal(eng.log.saves[0].messages.at(-1).role, 'user');
  // And the next turn merges into that user message rather than adding a second one.
  const s = eng.sessions.get(SESSION);
  const ask2 = scriptedClient([reply([{ type: 'text', text: 'ok' }])]);
  const b2 = makeJobBuilder({ engine: eng, client: ask2, helpers: helpers(), gate: async () => {}, meter: async () => {}, model: { modelId: 'm' }, costOf: () => 0, toCredits: () => 0 });
  await turn(b2, { sessionId: s.id, message: 'next' });
  const msgs = ask2.calls[0].messages;
  assert.equal(msgs.filter((m, i) => i && m.role === 'user' && msgs[i - 1].role === 'user').length, 0);
});

test('answers render as readable text', () => {
  const t = renderAnswers([{ id: 'time', selected: ['08:00 (Recommended)'] }], [{ id: 'time', question: 'When should it run?' }]);
  assert.equal(t, 'When should it run?\n-> 08:00 (Recommended)');
});

test('collectTurn: the non-streaming shape', () => {
  const out = collectTurn([{ type: 'session', session_id: 's' }, { type: 'ask', questions: [{ id: 'q' }] }, { type: 'done' }]);
  assert.equal(out.session_id, 's');
  assert.equal(out.state, 'asking');
  assert.deepEqual(out.questions, [{ id: 'q' }]);
});

// ── (d) HubSpot access ─────────────────────────────────────────────────────────

function fakeFetch(routes) {
  const seen = [];
  const fn = async (url) => {
    const path = url.replace('https://api.hubapi.com', '');
    seen.push(path);
    const hit = Object.entries(routes).find(([p]) => path.startsWith(p));
    const [status, body] = hit ? hit[1] : [404, {}];
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  };
  fn.seen = seen;
  return fn;
}

test('hubspot_access: an OAuth token without the custom-object scopes says so', async () => {
  const fetchImpl = fakeFetch({ '/oauth/v1/access-tokens/': [200, { hub_id: 1, scopes: ['crm.objects.companies.read', 'crm.objects.deals.read', 'crm.objects.custom.read', 'crm.objects.companies.write'] }] });
  const a = await hubspotAccessForToken({ token: 'oauth-token', oauth: true }, { fetchImpl });
  assert.equal(a.method, 'token_info');
  assert.equal(a.capabilities.read_companies, true);
  assert.equal(a.capabilities.read_contacts, false);
  assert.equal(a.capabilities.read_custom_objects, false);   // schemas scope missing
  assert.equal(a.capabilities.write_notes, true);
  assert.deepEqual(a.missing.find(m => m.capability === 'read_custom_objects').scopes, ['crm.objects.custom.read', 'crm.schemas.custom.read']);
  assert.equal(a.fix.label, 'Reconnect HubSpot');
});

test('hubspot_access: a private-app token is probed, and a 403 means a missing scope', async () => {
  const fetchImpl = fakeFetch({
    '/crm/v3/objects/companies': [200, { results: [] }], '/crm/v3/objects/contacts': [200, { results: [] }],
    '/crm/v3/objects/deals': [403, { message: 'scope' }], '/crm/v3/schemas': [403, { message: 'scope' }],
  });
  const a = await hubspotAccessForToken({ token: 'pat-na1-xyz', oauth: false }, { fetchImpl });
  assert.equal(a.method, 'probe');
  assert.ok(!fetchImpl.seen.some(p => p.startsWith('/oauth')));
  assert.equal(a.capabilities.read_companies, true);
  assert.equal(a.capabilities.read_deals, false);
  assert.equal(a.capabilities.read_custom_objects, false);
  assert.equal(a.capabilities.write_notes, null);
  assert.deepEqual(a.missing.map(m => m.capability).sort(), ['read_custom_objects', 'read_deals']);
});

test('hubspot_access: schemas readable but the custom object records refused -> no custom read', async () => {
  const fetchImpl = fakeFetch({
    '/crm/v3/objects/2-9000001': [403, {}], '/crm/v3/objects/': [200, { results: [] }],
    '/crm/v3/schemas': [200, { results: [{ objectTypeId: '2-9000001' }] }],
  });
  const a = await hubspotAccessForToken({ token: 'pat-na1-xyz' }, { fetchImpl });
  assert.equal(a.capabilities.read_custom_objects, false);
});

test('hubspot_access: an expired token and no connection', async () => {
  const expired = await hubspotAccessForToken({ token: 'oauth' }, { fetchImpl: fakeFetch({ '/oauth/v1/access-tokens/': [401, {}] }) });
  assert.equal(expired.expired, true);
  const none = await hubspotAccessForToken(null);
  assert.equal(none.connected, false);
  assert.deepEqual(capabilitiesFromScopes(['contacts']).read_deals, true);   // the legacy scope
});

// ── (e) SSE framing ────────────────────────────────────────────────────────────

test('SSE: each event is one data frame, headers say event-stream, the stream ends', async () => {
  const writes = [];
  let head = null, ended = false;
  const res = { writableEnded: false, writeHead: (s, h) => { head = { s, h }; }, write: (c) => writes.push(c), end() { ended = true; this.writableEnded = true; } };
  async function* events() { yield { type: 'session', session_id: 's' }; yield { type: 'text', text: 'a\nb' }; yield { type: 'done' }; }
  await streamEvents(res, events());
  assert.equal(head.s, 200);
  assert.equal(head.h['Content-Type'], 'text/event-stream');
  assert.equal(head.h['Cache-Control'], 'no-cache, no-transform');
  assert.deepEqual(writes, ['data: {"type":"session","session_id":"s"}\n\n', 'data: {"type":"text","text":"a\\nb"}\n\n', 'data: {"type":"done"}\n\n']);
  assert.ok(ended);
  assert.equal(sseFrame({ type: 'credits', credits: 3 }), 'data: {"type":"credits","credits":3}\n\n');
});

async function serve(router, user = { workspaceId: 'ws', internalUserId: 'u1' }) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { Object.assign(req, user); next(); });
  app.use('/api/revboxes', router);
  const server = http.createServer(app);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(r => server.close(r)) };
}

test('the route streams a turn as SSE, and refuses before streaming with JSON', async () => {
  const { b } = builder({ script: [reply([{ type: 'text', text: 'Hello.' }])] });
  const srv = await serve(makeRevboxBuilderRouter({ builder: b, getSb: () => ({}) }));
  try {
    const r = await fetch(`${srv.url}/api/revboxes/${BOX}/builder`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'Set up a job' }) });
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /text\/event-stream/);
    const frames = (await r.text()).split('\n\n').filter(Boolean).map(f => JSON.parse(f.replace(/^data: /, '')));
    assert.deepEqual(frames.map(f => f.type), ['session', 'text', 'credits', 'done']);

    const missing = await fetch(`${srv.url}/api/revboxes/${BOX}/builder/33333333-3333-4333-8333-333333333333`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'x' }) });
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), { error: 'This builder session was not found.', code: 'session_not_found' });

    const empty = await fetch(`${srv.url}/api/revboxes/${BOX}/builder`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
    assert.equal(empty.status, 400);
    const badId = await fetch(`${srv.url}/api/revboxes/not-a-box/builder`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'x' }) });
    assert.equal(badId.status, 400);

    const noProposal = await fetch(`${srv.url}/api/revboxes/${BOX}/builder/${SESSION}/approve`, { method: 'POST' });
    assert.equal(noProposal.status, 409);
  } finally { await srv.close(); }
});

test('an engine without the session functions answers 503 job_builder_not_ready', async () => {
  const b = makeJobBuilder({ engine: {}, client: scriptedClient([]) });
  await assert.rejects(b.openSession({ sb: {}, workspaceId: 'ws', userId: 'u', revboxId: BOX }), e => e.status === 503 && e.code === 'job_builder_not_ready');
});

// ── Review fixes ────────────────────────────────────────────────────────────────

test('a turn saves the transcript and proposal only, never the session state', async () => {
  const { b, eng } = builder({ script: [reply([{ type: 'text', text: 'Hello.' }])] });
  await turn(b, { message: 'Set up a job' });
  assert.equal(eng.log.saves.length, 1);
  assert.equal('state' in eng.log.saves[0].args, false);
  assert.ok(Array.isArray(eng.log.saves[0].args.messages));
  assert.ok('proposal' in eng.log.saves[0].args);
  // An approved session stays approved when a turn that was still running saves afterwards.
  eng.sessions.get(SESSION).state = 'approved';
  const { b: late } = builder({ eng, script: [reply([{ type: 'text', text: 'late' }])] });
  for await (const _ of late.runTurn({ sb: {}, workspaceId: 'ws', userId: 'u1', revboxId: BOX, session: structuredClone({ ...eng.sessions.get(SESSION), state: 'open' }), message: 'x' }));
  assert.equal(eng.sessions.get(SESSION).state, 'approved');
});

// A stream that reports message_start (input tokens, cache writes) and some text, then dies.
function dyingClient({ abort = null } = {}) {
  return { messages: { stream() {
    return {
      async *[Symbol.asyncIterator]() {
        yield { type: 'message_start', message: { model: 'claude-sonnet-5', usage: { input_tokens: 1200, cache_creation_input_tokens: 3000, cache_read_input_tokens: 0, output_tokens: 1 } } };
        yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Looking' } };
        yield { type: 'message_delta', usage: { output_tokens: 40 } };
        if (abort) abort.abort();
        throw Object.assign(new Error(abort ? 'Request was aborted.' : 'overloaded'), { name: abort ? 'APIUserAbortError' : 'APIError' });
      },
      finalMessage: async () => { throw new Error('finalMessage must not be reached'); },
    };
  } } };
}
function partialDeps({ client, signal = null, metered }) {
  return {
    client, model: { modelId: 'claude-sonnet-5', thinking: false }, helpers: helpers(), gate: async () => {},
    meter: async (m) => { metered.push(m); }, costOf: (_m, u) => (u.input_tokens + u.cache_creation_input_tokens + u.output_tokens) / 1e6,
    toCredits: () => 0, validate: () => ({ ok: true, errors: [] }), save: async () => {}, signal, today: '2026-10-14',
  };
}
const SESSION_ROW = { id: SESSION, revbox_id: BOX, messages: [], proposal: null, state: 'open' };

test('an errored stream is still metered, once, with the usage it reported', async () => {
  const metered = [];
  const events = [];
  for await (const e of runBuilderTurn({ session: SESSION_ROW, message: 'go', ctx: {}, deps: partialDeps({ client: dyingClient(), metered }) })) events.push(e);
  assert.equal(metered.length, 1);
  assert.equal(metered[0].response.partial, true);
  assert.deepEqual({ ...metered[0].response.usage }, { input_tokens: 1200, output_tokens: 40, cache_creation_input_tokens: 3000, cache_read_input_tokens: 0 });
  assert.equal(metered[0].costUsd, 4240 / 1e6);
  assert.match(metered[0].requestId, new RegExp(`^revbox-job-builder:${SESSION}:`));
  assert.equal(events.find(e => e.type === 'error').code, 'builder_failed');
});

test('an aborted stream (signal) is metered; a reader that walks away mid-stream is metered too', async () => {
  const ac = new AbortController();
  const metered = [];
  for await (const _ of runBuilderTurn({ session: SESSION_ROW, message: 'go', ctx: {}, deps: partialDeps({ client: dyingClient({ abort: ac }), signal: ac.signal, metered }) }));
  assert.equal(metered.length, 1);
  assert.equal(metered[0].response.usage.cache_creation_input_tokens, 3000);

  // The SSE client disconnects on the first text event: the generator is returned, and the call is metered.
  const left = [];
  for await (const e of runBuilderTurn({ session: SESSION_ROW, message: 'go', ctx: {}, deps: partialDeps({ client: dyingClient(), metered: left }) })) if (e.type === 'text') break;
  assert.equal(left.length, 1);
  assert.equal(left[0].response.usage.input_tokens, 1200);
});

test('a finished call is metered once; a stream that never started is not metered', async () => {
  const { b, metered } = builder({ script: [reply([{ type: 'text', text: 'Hello.' }])] });
  await turn(b, { message: 'x' });
  assert.equal(metered.length, 1);
  assert.equal(metered[0].response.partial, undefined);
  assert.equal(partialUsage({}, {}), null);
  assert.equal(partialUsage({ currentMessage: { usage: { input_tokens: 5, output_tokens: 0 } } }, {}).input_tokens, 5);
});

test('revbox_context reads document rows through getDocument\'s wrapper and drops hidden accounts\' documents', async () => {
  const docs = {
    d1: { document: { id: 'd1', title: 'Renewal plan', body_md: 'Renew Meterline in Q4.', subject_entity_id: 'acct-visible' } },
    d2: { document: { id: 'd2', title: 'Secret account', body_md: 'Hidden notes.', subject_entity_id: 'acct-hidden' } },
    d3: { document: { id: 'd3', title: 'Playbook', body_md: 'No subject.', subject_entity_id: null } },
  };
  const read = revboxContextReader({
    revboxDetails: async () => ({ box: { id: BOX, name: 'Meterline' }, context: [{ title: 'Typed note', body: 'Inline' }, { document_id: 'd1' }, { document_id: 'd2' }, { document_id: 'd3' }, { document_id: 'gone' }], jobs: [] }),
    getDocument: async (_sb, _ws, id) => docs[id] ?? null,
    revboxWorkspaceRole: async () => ({ role: 'member' }),
    viewerVisibleAccountSet: async () => ({ unrestricted: false, ids: new Set(['acct-visible']) }),
  });
  const ctx = { sb: {}, workspaceId: 'ws', userId: 'u1', revboxId: BOX };
  const out = await runTool('revbox_context', {}, { helpers: { revboxContext: read }, ctx, cached: null });
  const titles = out.result.reference_documents.map(d => d.title);
  assert.deepEqual(titles, ['Typed note', 'Renewal plan', 'Playbook']);
  assert.equal(out.result.reference_documents[1].text, 'Renew Meterline in Q4.');
  assert.ok(!JSON.stringify(out.result).includes('Hidden notes'));
  // An unrestricted viewer (admin) sees every document.
  const admin = revboxContextReader({ revboxDetails: async () => ({ box: { id: BOX, name: 'T' }, context: [{ document_id: 'd2' }] }), getDocument: async (_s, _w, id) => docs[id], revboxWorkspaceRole: async () => ({ role: 'admin' }), viewerVisibleAccountSet: async () => ({ unrestricted: true, ids: new Set() }) });
  assert.deepEqual((await admin(ctx)).context, [{ title: 'Secret account', body: 'Hidden notes.' }]);
});

test('propose_job: validation gets the named targets and the box destinations; the proposal event and session carry its facts; approve re-checks with the same', async () => {
  const facts = [{ step_id: 'read', type: 'hubspot', target: 'HubSpot: Read Account Daily Usage' }, { step_id: 'summary', type: 'agent', target: 'AI (opennous)' }, { step_id: 'post', type: 'slack', target: '#meterline-cs (C0TU)' }];
  const eng = engine({ validate: () => ({ ok: true, errors: [], facts }) });
  const proposal = { ...REFERENCE_PROPOSAL, uses_box_delivery: true };
  const h = helpers();
  h.revboxBox = async () => ({ id: BOX, name: 'Meterline', delivery: [{ id: 'd1', kind: 'slack', target: '#cs-handoffs' }] });
  const b = makeJobBuilder({
    engine: eng, client: scriptedClient([reply([use('propose_job', proposal)])]), helpers: h, gate: async () => {}, meter: async () => {},
    model: { modelId: 'claude-sonnet-5', thinking: false }, costOf: () => 0, toCredits: () => 0, today: '2026-10-14',
  });
  const events = await turn(b, { message: 'Set it up, every morning' });
  const ids = eng.log.validations[0].ids;
  assert.deepEqual(ids.slackChannelIds, ['C0TU', 'C0CS', 'C0GEN']);
  assert.deepEqual(ids.slackChannels[0], { id: 'C0TU', name: 'meterline-cs' });
  assert.deepEqual(ids.boxDestinations, [{ id: 'd1', kind: 'slack', target: '#cs-handoffs' }]);
  assert.deepEqual(events.find(e => e.type === 'proposal').proposal.facts, facts);
  assert.deepEqual(eng.sessions.get(SESSION).proposal.facts, facts);
  assert.equal(eng.log.saves[0].args.userId, 'u1');

  await b.approve({ sb: {}, workspaceId: 'ws', userId: 'u1', revboxId: BOX, sessionId: SESSION });
  const a = eng.log.approvals[0];
  assert.deepEqual(a.boxDestinations, [{ id: 'd1', kind: 'slack', target: '#cs-handoffs' }]);
  assert.deepEqual(a.slackChannelIds, ['C0TU', 'C0CS', 'C0GEN']);
  assert.equal('facts' in a.proposal, false);   // approve derives its own facts from the steps

  // Without box delivery, no destinations are looked up.
  const eng2 = engine();
  const b2 = makeJobBuilder({ engine: eng2, client: scriptedClient([reply([use('propose_job', REFERENCE_PROPOSAL)])]), helpers: h, gate: async () => {}, meter: async () => {}, model: { modelId: 'm', thinking: false }, costOf: () => 0, toCredits: () => 0 });
  const ev2 = await turn(b2, { message: 'x, daily' });
  assert.equal('boxDestinations' in eng2.log.validations[0].ids, false);
  assert.equal('facts' in ev2.find(e => e.type === 'proposal').proposal, false);
});

// ── Composer hints, the signal catalog and the trigger event ────────────────────

const MEETING_PROPOSAL = (signalKey, extra = {}) => ({
  name: 'Meeting follow-up to Slack',
  summary: 'After every meeting, write the summary and post it to #cs-handoffs.',
  trigger: { signal_key: signalKey, kind: 'call_ended', config: {}, label: 'After every meeting', ...extra },
  steps: [
    { id: 'summary', type: 'agent', config: { mode: 'write', model: 'opennous', prompt: 'Summarize the meeting.' } },
    { id: 'post', type: 'slack', config: { action: 'channel', channel_id: 'C0CS', channel: 'cs-handoffs', text: '{{steps.summary.output}}' } },
  ],
  display: [{ step_id: 'summary', tool: 'ai', title: 'Write the summary' }, { step_id: 'post', tool: 'slack', title: 'Post to #cs-handoffs' }],
});

test('hints are parsed from the body (and refused when malformed)', () => {
  assert.deepEqual(turnInput({ message: 'x', hints: { integrations: ['HubSpot', 'slack', 'slack'], signal: 'meeting.done:granola' } }).hints, { integrations: ['hubspot', 'slack'], signal: 'meeting.done:granola', signals: ['meeting.done:granola'] });
  assert.equal(turnInput({ message: 'x' }).hints, null);
  assert.deepEqual(turnInput({ message: 'x', hints: { signal: null } }).hints, { integrations: [], signal: null, signals: [] });
  for (const bad of ['x', [], { integrations: 'hubspot' }, { integrations: [1] }, { signal: 5 }, { signal: 'has spaces' }]) {
    assert.throws(() => turnInput({ message: 'x', hints: bad }), e => e.status === 400 && e.code === 'invalid_hints');
  }
});

test('a hint flows into the turn\'s user message as plain context', async () => {
  const { b, client } = builder({ script: [reply([{ type: 'text', text: 'ok' }])] });
  await turn(b, { message: 'Send me a recap', hints: { integrations: ['hubspot', 'slack'], signal: 'meeting.done:granola' } });
  const first = client.calls[0].messages[0].content.find(c => c.type === 'text').text;
  assert.match(first, /Integrations the user attached: hubspot, slack\./);
  assert.match(first, /Trigger the user picked: Meeting done · Granola \(signal "meeting\.done:granola"\)/);
  assert.match(first, /unless the user's words clearly say otherwise/);
  assert.match(first, /Send me a recap$/);

  const { b: b2, client: c2 } = builder({ script: [reply([{ type: 'text', text: 'ok' }])] });
  await turn(b2, { message: 'Weekly pipeline digest', hints: { integrations: [], signal: null } });
  assert.match(c2.calls[0].messages[0].content[0].text, /none\. If their words do not say what starts the job[\s\S]*Something else[\s\S]*Never default to a schedule/);
  // No hints: the user's words alone.
  const { b: b3, client: c3 } = builder({ script: [reply([{ type: 'text', text: 'ok' }])] });
  await turn(b3, { message: 'Just this' });
  assert.equal(c3.calls[0].messages[0].content[0].text, 'Just this');
});

test('"after every meeting": set_trigger(meeting.done) emits the trigger, then the proposal carries the catalog\'s call_ended trigger and signal_key', async () => {
  const script = [
    reply([use('signal_catalog', {}), use('set_trigger', { signal: 'meeting.done' })]),
    reply([use('propose_job', MEETING_PROPOSAL('meeting.done', { config: { junk: true } }))]),
  ];
  const { b, client, eng } = builder({ script });
  const events = await turn(b, { message: 'After every meeting, post a summary to #cs-handoffs' });
  const triggers = events.filter(e => e.type === 'trigger');
  assert.deepEqual(triggers, [{ type: 'trigger', signal: 'meeting.done', signals: ['meeting.done'], label: 'Meeting done' }, { type: 'trigger', signal: 'meeting.done', signals: ['meeting.done'], label: 'Meeting done' }]);
  // The first trigger event comes mid-turn, before the proposal; the second right before it.
  const at = (pred) => events.findIndex(pred);
  assert.ok(at(e => e.type === 'trigger') < at(e => e.type === 'proposal'));
  assert.equal(events[at(e => e.type === 'proposal') - 1].type, 'trigger');
  const p = events.find(e => e.type === 'proposal').proposal;
  assert.equal(p.trigger.kind, 'call_ended');
  assert.equal(p.trigger.signal_key, 'meeting.done');
  // set_trigger's result told the model the exact trigger; the catalog result listed the custom signal.
  const results = client.calls[1].messages.at(-1).content;
  assert.match(results.find(r => r.content.includes('"signal_key":"meeting.done"')).content, /"kind":"call_ended"/);
  assert.ok(results.some(r => r.content.includes('custom.pricing_pushback')));
  assert.equal(eng.sessions.get(SESSION).proposal.trigger.signal_key, 'meeting.done');
  assert.equal(collectTurn(events).trigger.signal, 'meeting.done');

  // A recorder named: the catalog's config (provider, tools) wins.
  const { b: b2 } = builder({ script: [reply([use('propose_job', MEETING_PROPOSAL('meeting.done:granola'))])] });
  const ev2 = await turn(b2, { message: 'After every Granola meeting' });
  assert.deepEqual(ev2.find(e => e.type === 'proposal').proposal.trigger.config, { provider: 'granola', tools: ['granola'] });
  assert.deepEqual(ev2.find(e => e.type === 'trigger'), { type: 'trigger', signal: 'meeting.done:granola', signals: ['meeting.done:granola'], label: 'Meeting done · Granola' });
});

test('a clock proposal settles to the schedule signal', async () => {
  const { b } = builder({ script: [reply([use('propose_job', REFERENCE_PROPOSAL)])] });
  const events = await turn(b, { message: 'x, daily' });
  assert.deepEqual(events.find(e => e.type === 'trigger'), { type: 'trigger', signal: 'schedule', signals: ['schedule'], label: 'Every day at 08:00 (New York)' });
  assert.equal(events.find(e => e.type === 'proposal').proposal.trigger.signal_key, 'schedule');
});

test('an unknown signal key is refused: set_trigger is a tool error, a proposal with it or the wrong kind does not validate', async () => {
  const script = [
    reply([use('set_trigger', { signal: 'meeting.finished' })]),
    reply([use('propose_job', MEETING_PROPOSAL('meeting.finished'))]),
    reply([use('propose_job', MEETING_PROPOSAL('deal.won'))]),
    reply([use('propose_job', { ...MEETING_PROPOSAL('x'), trigger: { kind: 'call_ended', config: {}, label: 'After a call' } })]),
    reply([{ type: 'text', text: 'Giving up.' }]),
  ];
  const { b, client } = builder({ script });
  const events = await turn(b, { message: 'go' });
  assert.equal(events.some(e => e.type === 'trigger'), false);
  assert.equal(events.some(e => e.type === 'proposal'), false);
  assert.match(events.find(e => e.type === 'tool' && e.name === 'set_trigger' && e.state === 'error').summary, /not a trigger in the signal catalog/);
  const res = (i) => client.calls[i].messages.at(-1).content[0];
  assert.equal(res(1).is_error, true);
  assert.match(res(1).content, /"meeting\.finished" is not a trigger/);
  assert.match(res(2).content, /signal_key: "meeting\.finished" is not a trigger/);
  assert.match(res(3).content, /Signal "deal\.won" runs on trigger kind "deal_closed_won"/);
  assert.match(res(4).content, /trigger\.signal_key is required/);
});

test('/v2 accepts hints: they reach the turn, and the body carries the settled trigger', async () => {
  const { b, client } = builder({ script: [reply([use('propose_job', MEETING_PROPOSAL('meeting.done'))])] });
  const impl = { ...b, turnInput, collectTurn };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { Object.assign(req, { workspaceId: 'ws', memberUserId: 'u1' }); next(); });
  app.use('/v2/revboxes', makeRevboxesV2Router({ getSb: () => ({}), builder: () => impl }));
  const server = http.createServer(app);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/v2/revboxes/${BOX}/jobs/builder`;
  const post = (body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const r = await post({ message: 'After every meeting', hints: { integrations: ['slack'], signal: 'meeting.done' } });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.state, 'proposed');
    assert.deepEqual(body.trigger, { signal: 'meeting.done', signals: ['meeting.done'], label: 'Meeting done' });
    assert.match(client.calls[0].messages[0].content[0].text, /Integrations the user attached: slack\..*\nTrigger the user picked: Meeting done/s);
    const bad = await post({ message: 'x', hints: { integrations: 'slack' } });
    assert.equal(bad.status, 400);
  } finally { await new Promise(r => server.close(r)); }
});

// ── Several signals on one job (GET-873) ──────────────────────────────────────

const DEAL_PROPOSAL = (trigger) => ({
  name: 'Closed deal write-up', summary: 'When a deal closes, write it up and post it to #cs-handoffs.',
  trigger: { kind: 'deal_closed_won', config: {}, label: 'When a deal closes', ...trigger },
  steps: MEETING_PROPOSAL('x').steps, display: MEETING_PROPOSAL('x').display,
});

test('"when a deal closes (won or lost)": set_trigger({ signals }) emits both, and the proposal carries signal_keys and config.also', async () => {
  const script = [
    reply([use('set_trigger', { signals: ['deal.won', 'deal.lost'] })]),
    // The model names only the first key: the committed pair still wins.
    reply([use('propose_job', DEAL_PROPOSAL({ signal_key: 'deal.won' }))]),
  ];
  const { b, client, eng } = builder({ script });
  const events = await turn(b, { message: 'When a deal closes, won or lost, post a write-up to #cs-handoffs' });
  const triggers = events.filter(e => e.type === 'trigger');
  assert.deepEqual(triggers.map(({ signal, signals, label }) => ({ signal, signals, label })), [
    { signal: 'deal.won', signals: ['deal.won', 'deal.lost'], label: 'When a deal is won or lost' },
    { signal: 'deal.won', signals: ['deal.won', 'deal.lost'], label: 'When a deal is won or lost' },
  ]);
  const res = JSON.parse(client.calls[1].messages.at(-1).content[0].content);
  assert.deepEqual(res.trigger, { kind: 'deal_closed_won', config: { also: [{ kind: 'deal_closed_lost', config: {} }] } });
  assert.deepEqual(res.signal_keys, ['deal.won', 'deal.lost']);
  const p = events.find(e => e.type === 'proposal').proposal;
  assert.equal(p.trigger.kind, 'deal_closed_won');
  assert.deepEqual(p.trigger.signal_keys, ['deal.won', 'deal.lost']);
  assert.deepEqual(p.trigger.config, { also: [{ kind: 'deal_closed_lost', config: {} }] });
  assert.equal(p.trigger.label, 'When a deal is won or lost');
  assert.deepEqual(eng.log.validations.at(-1).proposal.trigger.signal_keys, ['deal.won', 'deal.lost']);
  assert.deepEqual(collectTurn(events).trigger, { signal: 'deal.won', signals: ['deal.won', 'deal.lost'], label: 'When a deal is won or lost' });
  // The legacy single-signal set_trigger still works.
  const { b: b2 } = builder({ script: [reply([use('set_trigger', { signal: 'deal.won' })]), reply([{ type: 'text', text: 'ok' }])] });
  const ev2 = await turn(b2, { message: 'When we win a deal' });
  assert.deepEqual(ev2.find(e => e.type === 'trigger'), { type: 'trigger', signal: 'deal.won', signals: ['deal.won'], label: 'Deal won' });
});

test('a multi-signal proposal keeps the model\'s own config for an extra trigger; a schedule with signals and a wrong primary kind are refused', async () => {
  const script = [
    reply([use('set_trigger', { signals: ['schedule', 'deal.won'] })]),
    reply([use('propose_job', DEAL_PROPOSAL({ signal_key: 'deal.lost', signal_keys: ['deal.lost', 'deal.won'] }))]),
    reply([use('propose_job', DEAL_PROPOSAL({ signal_key: 'deal.won', signal_keys: ['deal.won', 'hubspot.field_changed'], config: { also: [{ kind: 'hubspot_field_changed', config: { object: 'deals', property: 'amount' } }] } }))]),
  ];
  const { b, client } = builder({ script });
  const events = await turn(b, { message: 'when a deal closes or its amount field changes' });
  assert.match(events.find(e => e.type === 'tool' && e.name === 'set_trigger' && e.state === 'error').summary, /schedule cannot be combined/);
  assert.match(client.calls[2].messages.at(-1).content[0].content, /run on trigger kind "deal_closed_lost"/);
  const p = events.find(e => e.type === 'proposal').proposal;
  assert.deepEqual(p.trigger.config, { also: [{ kind: 'hubspot_field_changed', config: { object: 'deals', property: 'amount' } }] });
});

test('a job on several signals uses every signal\'s tool: the recorders and HubSpot', () => {
  const t = { signal_key: 'meeting.done', signal_keys: ['meeting.done', 'hubspot.field_changed'], kind: 'call_ended', config: { also: [{ kind: 'hubspot_field_changed', config: {} }] } };
  assert.deepEqual(jobIntegrations({ trigger: t, steps: [{ type: 'slack' }] }, ['granola', 'fireflies', 'slack']), ['granola', 'fireflies', 'hubspot', 'slack']);
});

test('hints carry several signals (signals), the older single signal still parses, and the turn is told to use them all', async () => {
  assert.deepEqual(turnInput({ message: 'x', hints: { signals: ['deal.won', 'deal.lost', 'deal.won'] } }).hints, { integrations: [], signal: 'deal.won', signals: ['deal.won', 'deal.lost'] });
  for (const bad of [{ signals: 'deal.won' }, { signals: [5] }, { signals: Array(21).fill('deal.won') }]) {
    assert.throws(() => turnInput({ message: 'x', hints: bad }), e => e.status === 400 && e.code === 'invalid_hints');
  }
  const { b, client } = builder({ script: [reply([use('ask', { questions: [{ id: 'q', header: 'Time', question: 'What time should it run?', options: [{ label: '08:00' }, { label: '09:00' }] }, { id: 'c', header: 'Channel', question: 'Which channel?', options: [{ label: '#a' }, { label: '#b' }] }] })])] });
  const events = await turn(b, { message: 'Write up closed deals', hints: { integrations: [], signals: ['deal.won', 'deal.lost'] } });
  assert.match(client.calls[0].messages[0].content[0].text, /Triggers the user picked: Deal won, Deal lost \(signals "deal\.won", "deal\.lost"\)\. The job starts when any of them happens/);
  // Event signals hinted: the timing question is dropped.
  assert.deepEqual(events.find(e => e.type === 'ask').questions.map(q => q.id), ['c']);
});

// ── Approve switches the job on; Edit reopens the job's chat (GET-868 polish) ─────

test('approve hands core the switch-on check: credits, then the plan limit for a new job only; a failed check is a reason, not a refusal', async () => {
  const eng = engine();
  eng.sessions.set(SESSION, { id: SESSION, revbox_id: BOX, job_id: null, messages: [], proposal: REFERENCE_PROPOSAL, state: 'open' });
  eng.approveBuilderProposal = async (_sb, args) => {
    eng.log.approvals.push(args);
    const reason = await args.enableCheck({ isNew: true, routineId: null, trigger: { kind: 'clock' } });
    return { routine: { id: 'r1', enabled: !reason }, enabled: !reason, ...(reason ? { reason } : {}) };
  };
  let limit = 3;
  const limitCalls = [];
  const { b } = builder({ script: [], eng });
  const base = { sb: {}, workspaceId: 'ws', userId: 'u1', revboxId: BOX, sessionId: SESSION, limitHit: async (opts) => { limitCalls.push(opts ?? null); return limit; } };
  const off = await b.approve(base);
  assert.deepEqual([off.enabled, off.routine.enabled], [false, false]);
  assert.match(off.reason, /Your plan includes 3 automations/);
  const check = eng.log.approvals[0].enableCheck;
  assert.deepEqual(limitCalls, [{}]);
  // Review 6: an existing job that will be on is checked like the enable endpoint, without counting itself.
  assert.match(await check({ isNew: false, routineId: 'r9' }), /Your plan includes 3 automations/);
  assert.deepEqual(limitCalls.at(-1), { excludeId: 'r9' });
  limit = null;
  assert.equal(await check({ isNew: false, routineId: 'r9' }), null);
  assert.equal(await check({ isNew: true }), null);
  const on = await b.approve(base);
  assert.deepEqual([on.enabled, on.reason], [true, undefined]);
  // The credit gate throws; core turns that into the reason.
  const { b: broke, eng: eng2 } = builder({ script: [], gate: async () => { throw Object.assign(new Error('Credits are required.'), { status: 402 }); } });
  eng2.sessions.set(SESSION, { id: SESSION, revbox_id: BOX, job_id: null, messages: [], proposal: REFERENCE_PROPOSAL, state: 'open' });
  await broke.approve(base);
  await assert.rejects(eng2.log.approvals[0].enableCheck({ isNew: true }), /Credits are required/);
});

test('the route: Edit ({ job_id }, no message) answers JSON with the history; approve says whether the job is on', async () => {
  const JOB = '44444444-4444-4444-8444-444444444444';
  const eng = engine();
  const opened = [];
  eng.openBuilderSessionForJob = async (_sb, args) => {
    opened.push(args);
    return { session: { id: SESSION, job_id: args.jobId, proposal: { name: 'Daily summary' } }, source_session_id: 'old',
      history: [{ role: 'user', text: 'Report every morning' }, { kind: 'ask', questions: [{ id: 'q1' }], answers: [{ question: 'When?', answer: '08:00' }] }, { kind: 'proposal', proposal: { name: 'Daily summary' }, approved: true }] };
  };
  eng.approveBuilderProposal = async () => ({ routine: { id: JOB, enabled: false }, enabled: false, reason: 'Credits are required.' });
  const { b } = builder({ script: [], eng });
  const srv = await serve(makeRevboxBuilderRouter({ builder: b, getSb: () => ({}) }));
  try {
    const r = await fetch(`${srv.url}/api/revboxes/${BOX}/builder`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ job_id: JOB }) });
    assert.equal(r.status, 201);
    assert.match(r.headers.get('content-type'), /application\/json/);
    const body = await r.json();
    assert.deepEqual(Object.keys(body).sort(), ['history', 'job_id', 'proposal', 'session_id']);
    assert.deepEqual([body.session_id, body.job_id, body.proposal.name], [SESSION, JOB, 'Daily summary']);
    assert.deepEqual(body.history.map(i => i.kind ?? i.role), ['user', 'ask', 'proposal']);
    assert.deepEqual(opened[0], { workspaceId: 'ws', revboxId: BOX, userId: 'u1', jobId: JOB });
    const bad = await fetch(`${srv.url}/api/revboxes/${BOX}/builder`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ job_id: 'nope' }) });
    assert.equal(bad.status, 400);
    eng.sessions.set(SESSION, { id: SESSION, revbox_id: BOX, job_id: JOB, messages: [], proposal: REFERENCE_PROPOSAL, state: 'open' });
    const a = await fetch(`${srv.url}/api/revboxes/${BOX}/builder/${SESSION}/approve`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.deepEqual(await a.json(), { routine: { id: JOB, enabled: false }, enabled: false, reason: 'Credits are required.' });
    // Review 8: the mailbox-owner warnings ride along.
    const w = [{ kind: 'mailbox_owner', destination_id: 'd1', mailbox: 'dana@acme.example', owner: 'Dana', message: 'Gmail draft destination dana@acme.example belongs to Dana; drafts will fail while you own this job.' }];
    eng.approveBuilderProposal = async () => ({ routine: { id: JOB, enabled: true }, enabled: true, warnings: w });
    eng.sessions.set(SESSION, { id: SESSION, revbox_id: BOX, job_id: JOB, messages: [], proposal: REFERENCE_PROPOSAL, state: 'open' });
    const a2 = await fetch(`${srv.url}/api/revboxes/${BOX}/builder/${SESSION}/approve`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.deepEqual((await a2.json()).warnings, w);
  } finally { await srv.close(); }
});

test('review 8: approve hands core the owners of the box\'s Gmail destination mailboxes, by name', async () => {
  const eng = engine();
  eng.sessions.set(SESSION, { id: SESSION, revbox_id: BOX, job_id: null, messages: [], proposal: { ...REFERENCE_PROPOSAL, uses_box_delivery: true }, state: 'open' });
  const h = helpers();
  h.revboxBox = async () => ({ id: BOX, delivery: [{ id: 'd1', kind: 'gmail', target: 'conn-dana', to: 'vp@x.example' }, { id: 'd2', kind: 'slack', target: 'C0CS' }] });
  h.mailboxes = async () => [{ id: 'conn-dana', kind: 'gmail', email: 'dana@acme.example', owner_user_id: 'dana', mine: false }, { id: 'conn-u1', kind: 'gmail', email: 'u1@acme.example', owner_user_id: 'u1', mine: true }];
  const asked = [];
  h.userNames = async (_ctx, ids) => { asked.push(ids); return new Map([['dana', 'Dana']]); };
  const b = makeJobBuilder({ engine: eng, client: scriptedClient([]), helpers: h, gate: async () => {}, meter: async () => {}, model: { modelId: 'm', thinking: false }, costOf: () => 0, toCredits: () => 0 });
  await b.approve({ sb: {}, workspaceId: 'ws', userId: 'u1', revboxId: BOX, sessionId: SESSION });
  assert.deepEqual(eng.log.approvals[0].mailboxOwners, [{ id: 'conn-dana', email: 'dana@acme.example', user_id: 'dana', user_name: 'Dana' }]);
  assert.deepEqual(asked, [['dana']]);
  // No box delivery: nothing looked up.
  eng.sessions.set(SESSION, { id: SESSION, revbox_id: BOX, job_id: null, messages: [], proposal: REFERENCE_PROPOSAL, state: 'open' });
  await b.approve({ sb: {}, workspaceId: 'ws', userId: 'u1', revboxId: BOX, sessionId: SESSION });
  assert.equal(eng.log.approvals[1].mailboxOwners, undefined);
});


// ── Event triggers never ask for a time; the tools are inferred (product owner, GET-858) ──

const FOLLOW_UP = {
  name: 'Meeting follow-up',
  summary: 'After every meeting: draft the follow-up in Gmail and send me the summary in Slack.',
  trigger: { signal_key: 'meeting.done:granola', kind: 'call_ended', config: {}, label: 'Meeting done · Granola' },
  steps: [
    { id: 'summary', type: 'agent', config: { mode: 'write', model: 'opennous', prompt: 'Summarize the meeting and draft the follow-up.' } },
    { id: 'draft', type: 'gmail', config: { mode: 'draft', to: '{{meeting.attendees}}', subject: 'Following up', body: '{{steps.summary.output}}', send_from: { id: 'mbx-1', kind: 'gmail', email: 'me@acme.example' } } },
    { id: 'tell', type: 'slack', config: { action: 'dm', user_id: 'U1', text: '{{steps.summary.output}}', format: 'notification' } },
  ],
  display: [{ step_id: 'summary', tool: 'ai', title: 'Summarize the meeting' }, { step_id: 'draft', tool: 'gmail', title: 'Draft the follow-up' }, { step_id: 'tell', tool: 'slack', title: 'Send me the summary' }],
};
const TIME_Q = { id: 'when', header: 'Time', question: 'What time should it run each day?', options: [{ label: '08:00 (Recommended)' }, { label: '17:00' }] };
const CHANNEL_Q = { id: 'where', header: 'Where', question: 'Where should the summary go?', options: [{ label: 'A DM to you (Recommended)' }, { label: '#cs-handoffs' }] };
function meetingBuilder(script) {
  const h = helpers();
  h.connections = async () => [{ id: 'c1', slug: 'granola', label: 'Granola' }, { id: 'c2', slug: 'gmail', label: 'Gmail' }, { id: 'c3', slug: 'slack', label: 'Slack' }];
  h.mailboxes = async () => [{ id: 'mbx-1', kind: 'gmail', email: 'me@acme.example', mine: true }];
  const eng = engine();
  const b = makeJobBuilder({ engine: eng, client: scriptedClient(script), helpers: h, gate: async () => {}, meter: async () => {}, model: { modelId: 'm', thinking: false }, costOf: () => 0, toCredits: () => 0, today: '2026-10-14' });
  return { b, eng };
}

test('"after every meeting, draft a follow-up and report the summary to me in Slack", no hints: meeting.done, no time question, integrations, then the proposal', async () => {
  const { b, eng } = meetingBuilder([
    reply([use('workspace_connections', {})]),
    reply([use('set_trigger', { signal: 'meeting.done:granola' })]),
    reply([use('ask', { questions: [TIME_Q] })]),          // a time question on an event job: dropped, sent back
    reply([use('propose_job', FOLLOW_UP)]),
  ]);
  const events = await turn(b, { message: 'after every meeting, draft a follow-up and report the meeting summary to me in Slack' });
  const types = events.map(e => e.type);
  assert.equal(types.includes('ask'), false);
  assert.match(events.find(e => e.type === 'trigger').signal, /^meeting\.done/);
  const integ = events.find(e => e.type === 'integrations');
  assert.deepEqual([...integ.slugs].sort(), ['gmail', 'granola', 'slack']);
  assert.ok(types.indexOf('integrations') < types.indexOf('proposal'), 'integrations before the proposal');
  const p = events.find(e => e.type === 'proposal').proposal;
  assert.ok(p.steps.some(s => s.type === 'gmail' && s.config.mode === 'draft') && p.steps.some(s => s.type === 'slack'));
  assert.equal(p.trigger.kind, 'call_ended');
  assert.equal(p.trigger.config.frequency, undefined);
  // The model was told why its question went away.
  const back = eng.sessions.get(SESSION).messages.flatMap(m => (Array.isArray(m.content) ? m.content : [])).find(x => x.type === 'tool_result' && x.is_error && /runs as soon as the event happens/.test(String(x.content)));
  assert.ok(back, 'the dropped question is explained to the model');
  // collectTurn (/v2) carries the integrations.
  assert.deepEqual([...collectTurn(events).integrations].sort(), ['gmail', 'granola', 'slack']);
});

test('an ask on an event job keeps its other questions and drops the time one; a schedule job may still ask about time', async () => {
  const { b, eng } = meetingBuilder([reply([use('set_trigger', { signal: 'deal.won' })]), reply([use('ask', { questions: [TIME_Q, CHANNEL_Q] })])]);
  const events = await turn(b, { message: 'when we win a deal, tell CS' });
  assert.deepEqual(events.find(e => e.type === 'ask').questions.map(q => q.id), ['where']);
  // The transcript holds the questions really asked, so the answers line up.
  const asked = eng.sessions.get(SESSION).messages.at(-1).content.find(x => x.name === 'ask').input.questions;
  assert.deepEqual(asked.map(q => q.id), ['where']);
  // The composer's event hint counts too.
  const { b: hinted } = meetingBuilder([reply([use('ask', { questions: [CHANNEL_Q, { ...TIME_Q, id: 'freq', question: 'How often should this run?' }] })])]);
  const ev2 = await turn(hinted, { message: 'tell CS', hints: { integrations: [], signal: 'signal.churn_risk' } });
  assert.deepEqual(ev2.find(e => e.type === 'ask').questions.map(q => q.id), ['where']);
  // A schedule job: the time question stays.
  const { b: clock } = meetingBuilder([reply([use('set_trigger', { signal: 'schedule' })]), reply([use('ask', { questions: [TIME_Q] })])]);
  const ev3 = await turn(clock, { message: 'a daily report' });
  assert.deepEqual(ev3.find(e => e.type === 'ask').questions.map(q => q.id), ['when']);
});

test('the prompt: an event job never asks for a time, and the tools are inferred from the request', async () => {
  const { buildSystemPrompt } = await import('../src/lib/jobBuilder/prompt.mjs');
  const s = buildSystemPrompt({ today: '2026-10-14' });
  assert.match(s, /runs as soon as the event happens/);
  assert.match(s, /NEVER ask for a time/);
  assert.match(s, /draft a follow-up" is a Gmail draft/i);
  assert.match(s, /workspace_connections/);
});

test('jobIntegrations: step types plus the trigger provider', async () => {
  const { jobIntegrations } = await import('../src/lib/jobBuilder/loop.mjs');
  assert.deepEqual(jobIntegrations(FOLLOW_UP), ['granola', 'gmail', 'slack']);
  assert.deepEqual(jobIntegrations({ trigger: { signal_key: 'hubspot.field_changed', kind: 'hubspot_field_changed' }, steps: [{ type: 'agent' }, { type: 'webhook' }] }), ['hubspot']);
  assert.deepEqual(jobIntegrations({ trigger: { signal_key: 'meeting.done', kind: 'call_ended' }, steps: [{ type: 'gmail', config: { send_from: { kind: 'smtp' } } }] }, ['fireflies', 'slack']), ['fireflies', 'smtp']);
});
