// The Job Builder always settles the trigger with the user (GET-892), driven by a scripted model.
// A request that names no start and picks no signal is asked (2-4 fitting starts plus "Something
// else"); "after every meeting" and a hinted signal are not; a proposal whose trigger the user never
// grounded is refused back to the model. The signal catalog offers only connected recorders.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeJobBuilder } from '../src/lib/jobBuilder/index.mjs';
import { triggerGrounding, signalMentioned } from '../src/lib/jobBuilder/loop.mjs';
import { runTool, memo } from '../src/lib/jobBuilder/tools.mjs';
import { buildSystemPrompt } from '../src/lib/jobBuilder/prompt.mjs';
import { signalCatalog } from '@nous/core';

const BOX = '11111111-1111-4111-8111-111111111111';
const SESSION = '22222222-2222-4222-8222-222222222222';

let n = 0;
const use = (name, input) => ({ type: 'tool_use', id: `tu_${++n}`, name, input });
const reply = (content, stop = content.some(b => b.type === 'tool_use') ? 'tool_use' : 'end_turn') =>
  ({ id: `msg_${++n}`, model: 'claude-sonnet-5', content, stop_reason: stop, usage: { input_tokens: 100, output_tokens: 10 } });

function scriptedClient(script) {
  const calls = [];
  return {
    calls,
    messages: {
      stream(params) {
        calls.push(structuredClone(params));
        const resp = script.shift();
        if (!resp) throw new Error('script ran out');
        return { async *[Symbol.asyncIterator]() {}, finalMessage: async () => resp };
      },
    },
  };
}

function helpers({ recorders = ['granola'] } = {}) {
  return {
    connections: async () => [...recorders, 'hubspot', 'slack'].map((slug, i) => ({ id: `c${i}`, slug, label: slug })),
    revboxContext: async () => ({ box: { id: BOX, name: 'Box' }, context: [], jobs: [] }),
    slackTargets: async () => ({ connected: true, channels: [{ id: 'C0CS', name: 'cs-handoffs', member: true }], people: [] }),
    mailboxes: async () => [],
    hubspotObjects: async () => ({ connected: true, objects: [] }),
    hubspotFields: async () => [],
    searchAccounts: async () => [],
    signalCatalog: async () => signalCatalog({ custom: [] }),
  };
}

function engine() {
  const sessions = new Map();
  const log = { validations: [] };
  return {
    log, sessions,
    createBuilderSession: async (_sb, { revboxId, jobId }) => { const s = { id: SESSION, revbox_id: revboxId, job_id: jobId, messages: [], proposal: null, state: 'open' }; sessions.set(s.id, s); return s; },
    getBuilderSession: async (_sb, { sessionId }) => structuredClone(sessions.get(sessionId) ?? null),
    saveBuilderSession: async (_sb, { sessionId, workspaceId: _w, ...patch }) => { Object.assign(sessions.get(sessionId), structuredClone(Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)))); },
    approveBuilderProposal: async () => ({ routine: { id: 'r1' } }),
    listRevboxRoutines: async () => [],
    validateBuilderProposal: (proposal, ids) => { log.validations.push({ proposal, ids }); return { ok: true, errors: [] }; },
  };
}

function builder(script, opts = {}) {
  const client = scriptedClient(script);
  const eng = engine();
  const b = makeJobBuilder({
    engine: eng, client, helpers: helpers(opts), gate: async () => {}, meter: async () => {},
    model: { modelId: 'claude-sonnet-5', thinking: false }, costOf: () => 0.01, toCredits: () => 1, today: '2026-10-15',
  });
  return { b, client, eng };
}

async function turn(b, args) {
  const base = { sb: {}, workspaceId: 'ws', userId: 'u1', revboxId: BOX };
  const opened = await b.openSession({ ...base, sessionId: args.sessionId ?? null });
  const events = [];
  for await (const e of b.runTurn({ ...base, ...opened, message: args.message ?? null, answers: args.answers ?? null, hints: args.hints ?? null })) events.push(e);
  return events;
}

const STEPS = [
  { id: 'write', type: 'agent', config: { mode: 'write', model: 'opennous', prompt: 'Summarize the open deals.' } },
  { id: 'post', type: 'slack', config: { action: 'channel', channel_id: 'C0CS', channel: 'cs-handoffs', text: '{{steps.write.output}}', format: 'digest' } },
];
const DISPLAY = [{ step_id: 'write', tool: 'opennous', title: 'Write it' }, { step_id: 'post', tool: 'slack', title: 'Post to #cs-handoffs' }];
const CLOCK = { signal_key: 'schedule', kind: 'clock', config: { frequency: 'daily', at: '08:00' }, timezone: 'America/New_York', label: 'Every day at 08:00' };
const proposal = (trigger) => ({ name: 'Deal digest', summary: 'Open deals to Slack.', trigger, steps: STEPS, display: DISPLAY });
const TRIGGER_ASK = { questions: [{ id: 'start', header: 'Trigger', question: 'What should start this job?', options: [
  { label: 'Every weekday morning (Recommended)' }, { label: 'When a deal is won' }, { label: 'When a Granola meeting ends' }, { label: 'Something else' },
] }] };

test('no trigger named and none picked: the turn is told to settle it, a silent default is refused, and the ask offers trigger options', async () => {
  // The model first tries the old habit (a daily schedule nobody asked for), then asks.
  const first = use('propose_job', proposal(CLOCK));
  const { b, client, eng } = builder([reply([use('set_trigger', { signal: 'schedule' }), first]), reply([use('ask', TRIGGER_ASK)])]);
  const events = await turn(b, { message: 'Send a digest of our open deals to #cs-handoffs.', hints: { integrations: [], signals: [] } });
  // The composer context no longer says "most likely a schedule"; it says to settle the start.
  const userText = client.calls[0].messages[0].content.find(x => x.type === 'text').text;
  assert.doesNotMatch(userText, /most likely/i);
  assert.match(userText, /settle/i);
  // The silent schedule came back as an error telling the model to ask.
  const fed = client.calls[1].messages.at(-1).content.find(x => x.tool_use_id === first.id);
  assert.equal(fed.is_error, true);
  assert.match(fed.content, /ask/i);
  assert.match(fed.content, /Something else/);
  assert.equal(events.some(e => e.type === 'proposal'), false);
  assert.equal(eng.log.validations.length, 0);
  // The ask reaches the user with its trigger options.
  const asked = events.find(e => e.type === 'ask');
  assert.deepEqual(asked.questions[0].options.map(o => o.label), TRIGGER_ASK.questions[0].options.map(o => o.label));
});

test('an answer to the trigger question grounds the trigger: set_trigger and propose go through', async () => {
  const script = [reply([use('ask', TRIGGER_ASK)])];
  const { b } = builder(script);
  await turn(b, { message: 'Send a digest of our open deals to #cs-handoffs.' });
  script.push(reply([use('set_trigger', { signal: 'schedule' }), use('propose_job', proposal(CLOCK))]));
  const events = await turn(b, { sessionId: SESSION, answers: [{ id: 'start', selected: ['Every weekday morning (Recommended)'] }] });
  assert.ok(events.some(e => e.type === 'proposal'));
});

test('"after every meeting": no trigger question, the proposal goes through', async () => {
  const meeting = { signal_key: 'meeting.done', kind: 'call_ended', config: {}, label: 'Meeting done' };
  const { b, client } = builder([reply([use('set_trigger', { signal: 'meeting.done' }), use('propose_job', proposal(meeting))])]);
  const events = await turn(b, { message: 'After every meeting, post a summary to #cs-handoffs.' });
  assert.equal(events.some(e => e.type === 'ask'), false);
  assert.equal(events.find(e => e.type === 'proposal').proposal.trigger.kind, 'call_ended');
  assert.equal(client.calls.length, 1);
});

test('a hinted signal skips the question: the proposal on it goes through without set_trigger', async () => {
  const won = { signal_key: 'deal.won', kind: 'deal_closed_won', config: {}, label: 'Deal won' };
  const { b } = builder([reply([use('propose_job', proposal(won))])]);
  const events = await turn(b, { message: 'Post the handoff to #cs-handoffs.', hints: { integrations: [], signals: ['deal.won'] } });
  assert.equal(events.find(e => e.type === 'proposal').proposal.trigger.signal_key, 'deal.won');
});

test('a proposal on a trigger the user never grounded is refused, even after set_trigger', async () => {
  const won = { signal_key: 'deal.won', kind: 'deal_closed_won', config: {}, label: 'Deal won' };
  const first = use('propose_job', proposal(won));
  const { b, client } = builder([reply([use('set_trigger', { signal: 'deal.won' }), first]), reply([{ type: 'text', text: 'I will ask.' }])]);
  const events = await turn(b, { message: 'Post a digest of open deals to #cs-handoffs.' });
  assert.equal(events.some(e => e.type === 'proposal'), false);
  const fed = client.calls[1].messages.at(-1).content.find(x => x.tool_use_id === first.id);
  assert.equal(fed.is_error, true);
  assert.match(fed.content, /What should start this job\?/);
  const err = events.find(e => e.type === 'tool' && e.name === 'propose_job' && e.state === 'error');
  assert.match(err.summary, /start/i);
});

test('triggerGrounding: hints, the user\'s words, an answered trigger question, the job being edited, the last proposal', () => {
  const catalog = signalCatalog({ custom: [{ id: 'd1', key: 'security_review', name: 'Security review needed', rule: 'x', active: true }] });
  const userMsg = (text) => ({ role: 'user', content: [{ type: 'text', text }] });
  const none = triggerGrounding({ keys: ['schedule'], kind: 'clock', messages: [userMsg('Post open deals to Slack')], catalog });
  assert.equal(none.ok, false);
  assert.equal(triggerGrounding({ keys: ['schedule'], kind: 'clock', messages: [userMsg('Post open deals to Slack every Monday')], catalog }).by, 'words');
  const hinted = "[Context from the composer, not the user's words]\nTrigger the user picked: Deal won (signal \"deal.won\"). Use it.\n\nPost it";
  assert.equal(triggerGrounding({ keys: ['deal.won'], kind: 'deal_closed_won', messages: [userMsg(hinted)], catalog }).by, 'hint');
  // The hint's own words are not the user's: "Deal won" in the preamble does not ground deal.lost.
  assert.equal(triggerGrounding({ keys: ['deal.lost'], kind: 'deal_closed_lost', messages: [userMsg(hinted)], catalog }).ok, false);
  const ask = { role: 'assistant', content: [{ type: 'tool_use', id: 'a1', name: 'ask', input: TRIGGER_ASK }] };
  const answered = { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a1', content: 'The user answered:\n\nWhat should start this job?\n-> Other: when a ticket is escalated' }] };
  assert.equal(triggerGrounding({ keys: ['custom.security_review'], kind: 'account_signal', messages: [userMsg('Post it'), ask, answered], catalog }).by, 'answer');
  // A question about something else answered does not ground the trigger.
  const channelAsk = { role: 'assistant', content: [{ type: 'tool_use', id: 'a2', name: 'ask', input: { questions: [{ id: 'c', header: 'Channel', question: 'Which channel?', options: [{ label: '#a' }, { label: '#b' }] }] } }] };
  const channelAnswer = { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a2', content: 'The user answered:\n\nWhich channel?\n-> #a' }] };
  assert.equal(triggerGrounding({ keys: ['schedule'], kind: 'clock', messages: [userMsg('Post it'), channelAsk, channelAnswer], catalog }).ok, false);
  assert.equal(triggerGrounding({ keys: ['schedule'], kind: 'clock', messages: [userMsg('Change the channel')], catalog, job: { trigger: { kind: 'clock' } } }).by, 'job');
  assert.equal(triggerGrounding({ keys: ['deal.won'], kind: 'deal_closed_won', messages: [userMsg('Use a shorter summary')], catalog, priorProposal: { trigger: { signal_key: 'deal.won', kind: 'deal_closed_won' } } }).by, 'proposal');
});

test('signalMentioned reads the usual ways people name a start', () => {
  const catalog = signalCatalog({ custom: [] });
  const yes = [['meeting.done:granola', 'after every call'], ['deal.won', 'when we win a deal'], ['deal.lost', 'when a deal closes'], ['schedule', 'each weekday morning'], ['schedule', 'a weekly report'], ['signal.churn_risk', 'when churn risk shows up'], ['deal.stage_changed', 'when a deal moves stage']];
  for (const [key, words] of yes) assert.ok(signalMentioned(key, words, catalog), `${key} in "${words}"`);
  const no = [['schedule', 'post open deals to slack'], ['meeting.done', 'when we win a deal'], ['deal.won', 'summarize the pipeline']];
  for (const [key, words] of no) assert.ok(!signalMentioned(key, words, catalog), `${key} not in "${words}"`);
});

test('the prompt says to ask (2-4 starts plus Something else) or name the pick in one sentence, never a silent default', () => {
  const p = buildSystemPrompt({ today: '2026-10-15' });
  assert.match(p, /Something else/);
  assert.match(p, /never (silently )?default/i);
  assert.doesNotMatch(p, /No trigger picked most likely means a schedule/);
});

test('signal_catalog offers only connected recorders; none connected says to connect one', async () => {
  const run = async (recorders) => {
    const h = helpers({ recorders });
    const ctx = { sb: {}, workspaceId: 'ws' };
    return runTool('signal_catalog', {}, { helpers: h, ctx, cached: memo(h, ctx) });
  };
  const one = await run(['granola']);
  assert.deepEqual(one.result.signals.find(s => s.key === 'meeting.done').providers, ['granola', 'any']);
  const two = await run(['fireflies', 'fathom']);
  assert.deepEqual(two.result.signals.find(s => s.key === 'meeting.done').providers, ['fireflies', 'fathom', 'any']);
  const none = await run([]);
  const meeting = none.result.signals.find(s => s.key === 'meeting.done');
  assert.ok(!meeting.providers?.length);
  assert.match(none.result.note, /no meeting recorder is connected/i);
});

test('set_trigger refuses a recorder that is not connected', async () => {
  const first = use('set_trigger', { signal: 'meeting.done:fathom' });
  const { b, client } = builder([reply([first]), reply([{ type: 'text', text: 'ok' }])], { recorders: ['granola'] });
  await turn(b, { message: 'After every Fathom call, post a summary.' });
  const fed = client.calls[1].messages.at(-1).content.find(x => x.tool_use_id === first.id);
  assert.equal(fed.is_error, true);
  assert.match(fed.content, /not connected/i);
  assert.match(fed.content, /granola/i);
});
