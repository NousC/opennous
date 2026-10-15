// A built-in job's chat (GET-902), driven by a scripted model: no network, no database. A built-in
// opens the same chat as a builder job, on a session with no job: the agent explains it, changes
// what can change (its email voice, its On/Off where that is allowed) with builtin_job, and builds a
// NEW custom job in the box for what the built-in cannot do. It never edits the built-in as a routine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { makeJobBuilder } from '../src/lib/jobBuilder/index.mjs';
import { signalCatalog, builtinSeedTranscript, builtinOfTranscript } from '@nous/core';
import { runBuiltinTool } from '../src/lib/jobBuilder/tools.mjs';
import { makeRevboxBuilderRouter } from '../src/routes/api/revboxBuilder.mjs';

const BOX = '11111111-1111-4111-8111-111111111111';
const SESSION = '22222222-2222-4222-8222-222222222222';

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
          async *[Symbol.asyncIterator]() { for (const b of resp.content) if (b.type === 'text') yield { type: 'content_block_delta', delta: { type: 'text_delta', text: b.text } }; },
          finalMessage: async () => resp,
        };
      },
    },
  };
}

const FOLLOW_UP = {
  key: 'sales_follow_up', name: 'Sales follow-up', enabled: true, switchable: true, can_switch: false,
  brief: { text: 'When a Granola meeting with a customer ends, I draft the follow-up email and propose the tasks and the CRM updates from what was said; you approve each one in Priorities.', starts: 'After each meeting', tools: ['granola'], lands: 'Priorities', details: ['Nothing is sent until you approve the card in Priorities.'] },
  email_voice: { id: 'voice-1', text: 'Warm and specific. Under 150 words.' }, box: { id: BOX, name: 'Meetings Follow-up' },
};

function helpers(info = FOLLOW_UP, log = {}) {
  return {
    connections: async () => [{ id: 'c1', slug: 'granola', label: 'Granola' }, { id: 'c2', slug: 'slack', label: 'Slack' }],
    revboxContext: async () => ({ box: { id: BOX, name: 'Meetings Follow-up' }, context: [], jobs: [] }),
    slackTargets: async () => ({ connected: true, channels: [{ id: 'C0SALES', name: 'sales', member: true }], people: [] }),
    mailboxes: async () => [],
    signalCatalog: async () => signalCatalog({ custom: [] }),
    builtinInfo: async (_ctx, key) => (key === info?.key ? structuredClone(info) : null),
    switchBuiltin: async (_ctx, key, enabled) => { (log.switched ??= []).push([key, enabled]); },
    setEmailVoice: async (_ctx, b, text) => { (log.voices ??= []).push([b.email_voice.id, text]); return { id: b.email_voice.id }; },
  };
}

function engine() {
  const sessions = new Map();
  const log = { approvals: [], routines: 0, opened: [] };
  return {
    log, sessions,
    createBuilderSession: async (_sb, { revboxId, jobId }) => { const s = { id: SESSION, revbox_id: revboxId, job_id: jobId, messages: [], proposal: null, state: 'open' }; sessions.set(s.id, s); return s; },
    getBuilderSession: async (_sb, { sessionId }) => structuredClone(sessions.get(sessionId) ?? null),
    saveBuilderSession: async (_sb, { sessionId, messages, proposal }) => { Object.assign(sessions.get(sessionId), structuredClone({ messages, proposal })); },
    approveBuilderProposal: async (_sb, args) => { log.approvals.push(args); return { routine: { id: 'r-new', name: args.proposal.name, enabled: true }, enabled: true }; },
    listRevboxRoutines: async () => { log.routines += 1; return []; },
    validateBuilderProposal: () => ({ ok: true, errors: [] }),
    openBuilderSessionForBuiltin: async (_sb, args) => {
      log.opened.push(args);
      const s = { id: SESSION, revbox_id: args.revboxId, job_id: null, messages: builtinSeedTranscript(args.key, args.card), proposal: null, state: 'open' };
      sessions.set(s.id, s);
      return { session: s, history: [{ kind: 'builtin', key: args.key }] };
    },
  };
}

function builder({ script, info = FOLLOW_UP, eng = engine() } = {}) {
  const client = scriptedClient(script);
  const log = {};
  const b = makeJobBuilder({
    engine: eng, client, helpers: helpers(info, log), gate: async () => {}, meter: async () => {},
    model: { modelId: 'claude-sonnet-5', thinking: false }, costOf: () => 0.01, toCredits: () => 1, today: '2026-10-15',
  });
  return { b, client, eng, log };
}
const base = { sb: {}, workspaceId: 'ws', userId: 'u1', revboxId: BOX };
async function turn(b, sessionId, message) {
  const opened = await b.openSession({ ...base, sessionId });
  const events = [];
  for await (const e of b.runTurn({ ...base, ...opened, message })) events.push(e);
  return events;
}

async function serve(router) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { Object.assign(req, { workspaceId: 'ws', internalUserId: 'u1' }); next(); });
  app.use('/api/revboxes', router);
  const server = http.createServer(app);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(r => server.close(r)) };
}

test('the route: { builtin } opens the built-in\'s chat as JSON, its card first, on a session with no job', async () => {
  const { b, eng } = builder({ script: [] });
  const srv = await serve(makeRevboxBuilderRouter({ builder: b, getSb: () => ({}) }));
  try {
    const post = (body) => fetch(`${srv.url}/api/revboxes/${BOX}/builder`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const r = await post({ builtin: 'sales_follow_up' });
    assert.equal(r.status, 201);
    assert.deepEqual(await r.json(), { session_id: SESSION, builtin: 'sales_follow_up', history: [{ kind: 'builtin', key: 'sales_follow_up' }] });
    // The card the session is seeded with is the server's brief, never free text.
    assert.equal(eng.log.opened[0].card.text, FOLLOW_UP.brief.text);
    assert.equal(eng.sessions.get(SESSION).job_id, null);
    assert.equal(builtinOfTranscript(eng.sessions.get(SESSION).messages), 'sales_follow_up');
    // A built-in the box does not list, a malformed key, or a job and a built-in at once are refused.
    assert.equal((await post({ builtin: 'stale_deal' })).status, 404);
    assert.equal((await post({ builtin: 'DROP TABLE' })).status, 400);
    assert.equal((await post({ builtin: 'sales_follow_up', job_id: '44444444-4444-4444-8444-444444444444', message: 'hi' })).status, 400);
  } finally { await srv.close(); }
});

test('a built-in chat: the agent knows the built-in, reads it, and rewrites its email voice when asked', async () => {
  const newVoice = 'Concise and formal. At most 80 words. Signed with your name.';
  const script = [
    reply([use('builtin_job', { action: 'status' })]),
    reply([use('builtin_job', { action: 'set_email_voice', text: newVoice })]),
    reply([{ type: 'text', text: 'Done: new follow-up emails are shorter and more formal.' }]),
  ];
  const { b, client, eng, log } = builder({ script });
  await b.openForBuiltin({ ...base, key: 'sales_follow_up' });
  const events = await turn(b, SESSION, 'Make the emails more concise and more formal.');

  const first = client.calls[0];
  assert.ok(first.tools.some(t => t.name === 'builtin_job'), 'the builtin_job tool is offered');
  assert.ok(first.tools.some(t => t.name === 'propose_job'), 'and the normal builder tools, for a custom job');
  const system = first.system[0].text;
  assert.match(system, /This chat is about a built-in job in this RevBox, not a workflow: "Sales follow-up"/);
  assert.match(system, /NEVER call propose_job to change it/);
  assert.match(system, /offer to set up a custom job in this box/);
  assert.ok(system.includes(FOLLOW_UP.brief.text));
  // Its card is the agent's first message.
  assert.equal(first.messages[1].role, 'assistant');
  assert.ok(first.messages[1].content[0].text.startsWith('Sales follow-up. When a Granola meeting'));
  // status, then the voice saved through the helper, and the page is told to refresh.
  const statusResult = JSON.parse(client.calls[1].messages.at(-1).content[0].content);
  assert.equal(statusResult.email_voice, FOLLOW_UP.email_voice.text);
  assert.deepEqual(log.voices, [['voice-1', newVoice]]);
  assert.ok(events.some(e => e.type === 'builtin' && e.key === 'sales_follow_up' && e.email_voice === true));
  assert.ok(events.some(e => e.type === 'tool' && e.name === 'builtin_job' && e.state === 'done' && e.summary === 'Email voice updated'));
  // Never treated as a routine: no routine read, no job on the session, no proposal.
  assert.equal(eng.log.routines, 0);
  assert.equal(eng.sessions.get(SESSION).job_id, null);
  assert.equal(eng.sessions.get(SESSION).proposal, null);
});

test('something the built-in cannot do: the agent proposes a NEW job in the box; approving it creates a job and leaves the built-in alone', async () => {
  const PROPOSAL = {
    name: 'Meeting summary to Slack', summary: 'After each Granola meeting, post the summary to #sales.',
    trigger: { signal_key: 'meeting.done:granola', kind: 'call_ended', config: { provider: 'granola' }, label: 'Meeting done · Granola' },
    steps: [{ id: 'sum', type: 'agent', config: { mode: 'write', model: 'opennous', prompt: 'Summarize the meeting.' } }, { id: 'post', type: 'slack', config: { action: 'channel', channel_id: 'C0SALES', channel: 'sales', text: '{{steps.sum.output}}', format: 'notification' } }],
    display: [{ step_id: 'sum', tool: 'opennous', title: 'Summarize' }, { step_id: 'post', tool: 'slack', title: 'Post to #sales' }],
  };
  const script = [
    reply([{ type: 'text', text: 'The follow-up only drafts emails for Priorities; it cannot post to Slack. I can set up a custom job in this box that does.' }]),
    reply([use('set_trigger', { signal: 'meeting.done:granola' })]),
    reply([use('propose_job', PROPOSAL)]),
  ];
  const { b, eng } = builder({ script });
  await b.openForBuiltin({ ...base, key: 'sales_follow_up' });
  await turn(b, SESSION, 'Can it also post the meeting summary to Slack?');
  const events = await turn(b, SESSION, 'Yes, after every Granola meeting, to #sales.');
  assert.ok(events.some(e => e.type === 'proposal' && e.proposal.name === 'Meeting summary to Slack'));
  await b.approve({ ...base, sessionId: SESSION });
  assert.equal(eng.log.approvals.length, 1);
  assert.equal(eng.sessions.get(SESSION).job_id, null, 'approve on a built-in chat can only create a new job');
  assert.equal(eng.log.approvals[0].proposal.name, 'Meeting summary to Slack');
});

test('switching: a detector cannot be switched here, the follow-up only by a workspace admin', async () => {
  const log = {};
  const h = helpers(FOLLOW_UP, log);
  const detector = { ...FOLLOW_UP, key: 'stale_deal', name: 'Stale deal detection', switchable: false, can_switch: false };
  const no = await runBuiltinTool({ action: 'switch', enabled: false }, { helpers: h, ctx: {}, builtin: detector });
  assert.match(no.result.reason, /switched on or off by OpenNous/);
  const member = await runBuiltinTool({ action: 'switch', enabled: false }, { helpers: h, ctx: {}, builtin: { ...FOLLOW_UP } });
  assert.match(member.result.reason, /owner or admin/);
  assert.equal(log.switched, undefined);
  const admin = await runBuiltinTool({ action: 'switch', enabled: false }, { helpers: h, ctx: {}, builtin: { ...FOLLOW_UP, can_switch: true } });
  assert.equal(admin.result.ok, true);
  assert.deepEqual(admin.changed, { key: 'sales_follow_up', enabled: false });
  assert.deepEqual(log.switched, [['sales_follow_up', false]]);
  await assert.rejects(runBuiltinTool({ action: 'set_email_voice', text: '' }, { helpers: h, ctx: {}, builtin: { ...FOLLOW_UP } }), /full new voice/);
  await assert.rejects(runBuiltinTool({ action: 'status' }, { helpers: h, ctx: {}, builtin: null }), /not about a built-in/);
});

test('a chat that is not about a built-in has no builtin_job tool and no built-in section', async () => {
  const { b, client } = builder({ script: [reply([{ type: 'text', text: 'What should this job do?' }])] });
  await turn(b, null, 'Help me set up a job');
  assert.ok(!client.calls[0].tools.some(t => t.name === 'builtin_job'));
  assert.doesNotMatch(client.calls[0].system[0].text, /built-in job in this RevBox/);
});
