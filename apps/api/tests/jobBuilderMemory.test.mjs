// A job's chat remembers (GET-889), end to end with the real engine (core) on an in-memory database
// and a scripted model: opening a job's chat twice is one session; a turn the provider fails still
// keeps the user's message (shown on reopen, with Try again); a retry runs it again without adding it
// twice; two tabs never silently overwrite each other's turn.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as core from '@nous/core';
import { makeJobBuilder, turnInput } from '../src/lib/jobBuilder/index.mjs';

const { signalCatalog } = core;
const BOX = 'box-1';

function database(seed = {}) {
  const tables = {
    workspace_members: [{ workspace_id: 'ws', user_id: 'owner', role: 'admin' }],
    revboxes: [{ id: BOX, workspace_id: 'ws', owner_id: 'owner', shared: true, name: 'Ops box', objective: 'Keep the team informed.', blocks: [], delivery: [] }],
    revbox_members: [], revbox_context: [], revbox_builder_sessions: [], revbox_datasets: [], agent_routines: [], documents: [],
    ...seed,
  };
  let seq = 0;
  let clock = Date.parse('2026-10-15T00:00:00Z');
  const tick = () => new Date(clock += 1000).toISOString();
  class Query {
    constructor(table) { this.table = table; this.filters = []; }
    select() { return this; } order() { return this; } limit() { return this; }
    eq(k, v) { this.filters.push(r => r[k] === v); return this; }
    neq(k, v) { this.filters.push(r => r[k] !== v); return this; }
    in(k, vs) { this.filters.push(r => vs.includes(r[k])); return this; }
    insert(v) { this.insertValue = v; return this; }
    update(v) { this.updateValue = v; return this; }
    result(single) {
      let values = (tables[this.table] ??= []).filter(r => this.filters.every(f => f(r)));
      if (this.insertValue) { const t = tick(); const row = structuredClone({ id: `${this.table}-${++seq}`, created_at: t, updated_at: t, ...this.insertValue }); tables[this.table].push(row); values = [row]; }
      if (this.updateValue) for (const row of values) Object.assign(row, structuredClone(this.updateValue), 'updated_at' in this.updateValue ? { updated_at: tick() } : {});
      return { data: structuredClone(single ? values[0] ?? null : values), error: null };
    }
    maybeSingle() { return Promise.resolve(this.result(true)); }
    single() { return this.maybeSingle(); }
    then(ok, bad) { return Promise.resolve(this.result(false)).then(ok, bad); }
  }
  return { tables, from: t => new Query(t) };
}

let n = 0;
const reply = (content) => ({ id: `msg_${++n}`, model: 'claude-sonnet-5', content, stop_reason: 'end_turn', usage: { input_tokens: 100, output_tokens: 10 } });
/** A model that answers from the script; an Error in the script is a provider failure mid-stream. */
function scriptedClient(script) {
  const calls = [];
  return { calls, messages: { stream(params) {
    calls.push(structuredClone(params));
    const next = script.shift();
    if (!next) throw new Error('script ran out');
    return {
      async *[Symbol.asyncIterator]() { if (next instanceof Error) throw next; },
      finalMessage: async () => { if (next instanceof Error) throw next; return next; },
    };
  } } };
}
const helpers = () => ({
  connections: async () => [{ id: 'c1', slug: 'slack', label: 'Slack' }],
  revboxContext: async () => ({ box: { id: BOX, name: 'Ops box' }, context: [], jobs: [] }),
  slackTargets: async () => ({ connected: true, channels: [], people: [] }),
  mailboxes: async () => [], searchAccounts: async () => [], customSignals: async () => [],
  hubspotObjects: async () => ({ connected: false, objects: [] }), hubspotFields: async () => [],
  signalCatalog: async () => signalCatalog({ custom: [] }),
});
const handJob = () => ({ id: 'r-hand', workspace_id: 'ws', revbox_id: BOX, user_id: 'owner', name: 'Pipeline digest', enabled: true,
  trigger_kind: 'clock', trigger_config: { frequency: 'daily', at: '08:00' }, timezone: 'America/New_York', prompt: 'Summarise the pipeline.',
  steps: [{ id: 'write', type: 'agent', config: { mode: 'write', prompt: 'Summarise the pipeline.' } }] });

function setup(script, extra = {}) {
  const sb = database({ agent_routines: [handJob()] });
  const client = scriptedClient(script);
  const b = makeJobBuilder({ engine: core, client, helpers: helpers(), gate: async () => {}, meter: async () => {}, alert: () => {},
    model: { modelId: 'claude-sonnet-5', thinking: false }, costOf: () => 0, toCredits: () => 0, today: '2026-10-15', ...extra });
  const base = { sb, workspaceId: 'ws', userId: 'owner', revboxId: BOX };
  const say = async (sessionId, input) => {
    const opened = await b.openSession({ ...base, sessionId });
    const events = [];
    for await (const e of b.runTurn({ ...base, ...opened, message: null, answers: null, hints: null, ...input })) events.push(e);
    return events;
  };
  return { sb, b, base, client, say };
}
const kinds = (h) => h.map(i => i.kind ?? i.role);

test('opening a job\'s chat twice is one session; a reply in it shows on the next open', async () => {
  const { sb, b, base, say } = setup([reply([{ type: 'text', text: 'Which Slack channel?' }])]);
  const one = await b.openForJob({ ...base, jobId: 'r-hand' });
  await say(one.session.id, { message: 'Post it to Slack as well' });
  const two = await b.openForJob({ ...base, jobId: 'r-hand' });
  assert.equal(two.session.id, one.session.id);
  assert.equal(sb.tables.revbox_builder_sessions.length, 1);
  assert.deepEqual(kinds(two.history), ['proposal', 'user', 'assistant']);
  assert.deepEqual(two.history.slice(1).map(i => i.text), ['Post it to Slack as well', 'Which Slack channel?']);
});

test('a provider failure keeps the user\'s message; reopen shows it as failed; retry answers it without adding it twice', async () => {
  const overloaded = Object.assign(new Error('Overloaded'), { status: 529 });
  const { b, base, client, say } = setup([overloaded, reply([{ type: 'text', text: 'Done: it now runs weekly.' }])]);
  const one = await b.openForJob({ ...base, jobId: 'r-hand' });
  const events = await say(one.session.id, { message: 'Make it weekly' });
  assert.ok(events.some(e => e.type === 'error'), JSON.stringify(events));
  const reopened = await b.openForJob({ ...base, jobId: 'r-hand' });
  assert.equal(reopened.session.id, one.session.id);
  assert.deepEqual(kinds(reopened.history), ['proposal', 'user', 'failed']);
  assert.equal(reopened.history[1].text, 'Make it weekly');

  // Try again: the saved turn runs again; the model sees the message once.
  const again = await say(one.session.id, { retry: true });
  assert.ok(!again.some(e => e.type === 'error'), JSON.stringify(again));
  const sent = JSON.stringify(client.calls.at(-1).messages);
  assert.equal(sent.split('Make it weekly').length - 1, 1);
  const after = await b.openForJob({ ...base, jobId: 'r-hand' });
  assert.deepEqual(kinds(after.history), ['proposal', 'user', 'assistant']);
  // Nothing left to retry now.
  const none = await say(one.session.id, { retry: true });
  assert.equal(none.find(e => e.type === 'error')?.code, 'nothing_to_retry');
});

test('the same words sent again after a failed turn are not added twice', async () => {
  const { b, base, client, say } = setup([new Error('socket hang up'), reply([{ type: 'text', text: 'ok' }])]);
  const one = await b.openForJob({ ...base, jobId: 'r-hand' });
  await say(one.session.id, { message: 'Make it weekly' });
  await say(one.session.id, { message: 'Make it weekly' });
  assert.equal(JSON.stringify(client.calls.at(-1).messages).split('Make it weekly').length - 1, 1);
});

test('a credit gate refusal keeps the message too', async () => {
  const gate = async () => { throw Object.assign(new Error('You have used your credits.'), { status: 402 }); };
  const { b, base, say } = setup([], { gate });
  const one = await b.openForJob({ ...base, jobId: 'r-hand' });
  const events = await say(one.session.id, { message: 'Make it weekly' });
  assert.equal(events.find(e => e.type === 'error').code, 'insufficient_credits');
  const reopened = await b.openForJob({ ...base, jobId: 'r-hand' });
  assert.deepEqual(kinds(reopened.history), ['proposal', 'user', 'failed']);
});

test('two tabs: the second turn to finish does not overwrite the first; it says the chat changed', async () => {
  const { sb, b, base } = setup([reply([{ type: 'text', text: 'From tab one' }]), reply([{ type: 'text', text: 'From tab two' }])]);
  const one = await b.openForJob({ ...base, jobId: 'r-hand' });
  // Both tabs read the session before either turn saves.
  const tab1 = await b.openSession({ ...base, sessionId: one.session.id });
  const tab2 = await b.openSession({ ...base, sessionId: one.session.id });
  const run = async (opened, message) => { const out = []; for await (const e of b.runTurn({ ...base, ...opened, message, answers: null, hints: null })) out.push(e); return out; };
  const first = await run(tab1, 'tab one says');
  const second = await run(tab2, 'tab two says');
  assert.ok(!first.some(e => e.type === 'error'));
  assert.equal(second.find(e => e.type === 'error')?.code, 'session_conflict');
  const stored = JSON.stringify(sb.tables.revbox_builder_sessions[0].messages);
  assert.ok(stored.includes('tab one says') && !stored.includes('tab two says'));
});

test('turnInput: { retry: true } alone is a retry; with a message it is refused', () => {
  assert.deepEqual(turnInput({ retry: true }), { message: null, answers: null, hints: null, retry: true });
  assert.throws(() => turnInput({ retry: true, message: 'x' }), e => e.status === 400);
  assert.equal(turnInput({ message: 'hi' }).retry, false);
});
