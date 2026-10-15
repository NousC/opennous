// A job's chat remembers (GET-889): opening a job's chat reopens the person's own conversation on it
// (one session, reused) instead of a new seeded session per click, the history shows every turn, a
// failed turn shows as failed, and the session-binding rules hold.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  approveBuilderProposal, openBuilderSessionForJob, createBuilderSession, getBuilderSession, saveBuilderSession,
  sanitizeBuilderTranscript, builderSessionHistory, unanswered, withNewerSetup, APPROVED_NOTE,
} from '../dist/db/revboxBuilder.mjs';

const dailyReport = () => ({
  name: 'Morning report',
  summary: 'Reads HubSpot every morning and posts to Slack.',
  trigger: { kind: 'clock', config: { frequency: 'daily', at: '08:00' }, timezone: 'America/Toronto', label: 'Every day at 08:00' },
  steps: [
    { id: 'read', type: 'hubspot', config: { action: 'read', object: 'deals', fields: ['amount'], window: 'yesterday' } },
    { id: 'write', type: 'agent', config: { mode: 'write', prompt: 'Summarise {{steps.read.output}}.' } },
    { id: 'post', type: 'slack', config: { action: 'channel', channel_id: 'C0OPS', text: '{{steps.write.output}}' } },
  ],
  display: [
    { step_id: 'read', tool: 'hubspot', title: 'Read deals' },
    { step_id: 'write', tool: 'ai', title: 'Write it' },
    { step_id: 'post', tool: 'slack', title: 'Post' },
  ],
  warnings: [], assumptions: [], estimated_credits_per_run: 2,
});
const lookups = { slackChannelIds: ['C0OPS'], mailboxIds: [] };

// An in-memory supabase-js: filters, a real order(), and a clock so "newest" is well defined.
function database(seed = {}) {
  const tables = {
    workspace_members: [{ workspace_id: 'ws', user_id: 'owner', role: 'admin' }, { workspace_id: 'ws', user_id: 'editor', role: 'member' }],
    revboxes: [{ id: 'box', workspace_id: 'ws', owner_id: 'owner', shared: false, name: 'Ops box', objective: 'Keep ops informed.', blocks: [], delivery: [] }],
    revbox_members: [{ workspace_id: 'ws', revbox_id: 'box', user_id: 'editor', role: 'editor' }],
    revbox_context: [], revbox_builder_sessions: [], revbox_datasets: [], agent_routines: [], documents: [],
    ...seed,
  };
  let seq = 0;
  let clock = Date.parse('2026-10-15T00:00:00Z');
  const tick = () => new Date(clock += 1000).toISOString();
  class Query {
    constructor(table) { this.table = table; this.filters = []; this.sort = null; }
    select() { return this; } limit() { return this; }
    order(k, { ascending = true } = {}) { this.sort = { k, ascending }; return this; }
    eq(k, v) { this.filters.push(r => r[k] === v); return this; }
    neq(k, v) { this.filters.push(r => r[k] !== v); return this; }
    in(k, vs) { this.filters.push(r => vs.includes(r[k])); return this; }
    insert(v) { this.insertValue = v; return this; }
    update(v) { this.updateValue = v; return this; }
    result(single) {
      let values = (tables[this.table] ??= []).filter(r => this.filters.every(f => f(r)));
      if (this.insertValue) {
        const t = tick();
        const row = structuredClone({ id: `${this.table}-${++seq}`, created_at: t, updated_at: t, ...this.insertValue });
        tables[this.table].push(row); values = [row];
      }
      if (this.updateValue) for (const row of values) Object.assign(row, structuredClone(this.updateValue), 'updated_at' in this.updateValue ? { updated_at: tick() } : {});
      if (this.sort) { const { k, ascending } = this.sort; values = [...values].sort((a, b) => String(a[k]).localeCompare(String(b[k])) * (ascending ? 1 : -1)); }
      return { data: structuredClone(single ? values[0] ?? null : values), error: null };
    }
    maybeSingle() { return Promise.resolve(this.result(true)); }
    single() { return this.maybeSingle(); }
    then(ok, bad) { return Promise.resolve(this.result(false)).then(ok, bad); }
  }
  return { tables, from: t => new Query(t) };
}
const W = { workspaceId: 'ws', revboxId: 'box' };
const sessions = (sb) => sb.tables.revbox_builder_sessions;
const kinds = (h) => h.map(i => i.kind ?? i.role);

/** A builder chat that made the job: words, an ask answered, a proposal. */
function madeTranscript() {
  return [
    { role: 'user', content: [{ type: 'text', text: "[Context from the composer, not the user's words]\nIntegrations the user attached: hubspot.\n\nA deals report every morning in Slack" }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Which time suits?' }, { type: 'tool_use', id: 'a1', name: 'ask', input: { questions: [{ id: 'time', header: 'Time', question: 'When?', multi: false, options: [{ label: '08:00' }] }] } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a1', content: 'The user answered:\n\nWhen?\n-> 08:00' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Here it is.' }, { type: 'tool_use', id: 'p1', name: 'propose_job', input: dailyReport() }] },
  ];
}
/** What the loop saves after one more turn: the user's words and the agent's reply. */
function afterTurn(messages, said, reply) {
  const out = structuredClone(messages);
  const last = out.at(-1);
  const words = { type: 'text', text: said };
  if (last?.role === 'user') last.content = [...last.content, words]; else out.push({ role: 'user', content: [words] });
  if (reply) out.push({ role: 'assistant', content: [{ type: 'text', text: reply }] });
  return out;
}
async function builtJob(sb, userId = 'owner') {
  const s = await createBuilderSession(sb, { ...W, userId });
  await saveBuilderSession(sb, { ...W, sessionId: s.id, userId, messages: madeTranscript(), proposal: dailyReport() });
  const { routine } = await approveBuilderProposal(sb, { ...W, userId, sessionId: s.id, ...lookups });
  return { first: s, routine };
}
const handJob = () => ({ id: 'r-hand', workspace_id: 'ws', revbox_id: 'box', user_id: 'owner', name: 'Pipeline digest', enabled: true,
  trigger_kind: 'clock', trigger_config: { frequency: 'daily', at: '08:00' }, timezone: 'America/Toronto', prompt: 'Summarise the pipeline.',
  steps: [{ id: 'write', type: 'agent', config: { mode: 'write', prompt: 'Summarise the pipeline.' } }] });

test('reopening a job made in the builder returns the same session and the whole conversation', async () => {
  const sb = database();
  const { first, routine } = await builtJob(sb);
  const opened = await openBuilderSessionForJob(sb, { ...W, userId: 'owner', jobId: routine.id });
  assert.notEqual(opened.session.id, first.id);   // the approved chat is closed: it goes on in a new one
  assert.deepEqual(kinds(opened.history), ['user', 'assistant', 'ask', 'assistant', 'proposal']);

  // A turn in it, then the chat is closed and opened again: the same session, every turn shown.
  const row = sessions(sb).find(r => r.id === opened.session.id);
  await saveBuilderSession(sb, { ...W, sessionId: row.id, userId: 'owner', messages: afterTurn(row.messages, 'Also post the top deal', 'Sure, which channel?'), proposal: row.proposal });
  const count = sessions(sb).length;
  const again = await openBuilderSessionForJob(sb, { ...W, userId: 'owner', jobId: routine.id });
  assert.equal(again.session.id, opened.session.id);
  assert.equal(sessions(sb).length, count, 'no new session');
  assert.deepEqual(kinds(again.history), ['user', 'assistant', 'ask', 'assistant', 'proposal', 'user', 'assistant']);
  assert.equal(again.history[0].text, 'A deals report every morning in Slack');
  assert.deepEqual(again.history[2].answers, [{ question: 'When?', answer: '08:00' }]);
  assert.equal(again.history[4].approved, true);
  assert.deepEqual(again.history.slice(-2).map(i => i.text), ['Also post the top deal', 'Sure, which channel?']);
  // The plumbing stays hidden.
  const raw = JSON.stringify(again.history);
  for (const hidden of ['[Context from the composer', 'tool_result', APPROVED_NOTE]) assert.ok(!raw.includes(hidden), hidden);
  // A third open: still that one.
  assert.equal((await openBuilderSessionForJob(sb, { ...W, userId: 'owner', jobId: routine.id })).session.id, opened.session.id);
});

test('a job made outside the builder reuses its seeded session on the second open', async () => {
  const sb = database({ agent_routines: [handJob()] });
  const one = await openBuilderSessionForJob(sb, { ...W, userId: 'owner', jobId: 'r-hand' });
  assert.deepEqual(kinds(one.history), ['proposal']);
  assert.equal(sessions(sb).length, 1);
  const two = await openBuilderSessionForJob(sb, { ...W, userId: 'owner', jobId: 'r-hand' });
  assert.equal(two.session.id, one.session.id);
  assert.equal(sessions(sb).length, 1, 'no new session');
  assert.deepEqual(kinds(two.history), ['proposal']);

  // They ask for a change and the agent replies (the 4-message shape stored in production): reopening shows it.
  const row = sessions(sb)[0];
  const said = "[Context from the composer, not the user's words]\nIntegrations the user attached: slack.\n\nPost it to Slack as well";
  await saveBuilderSession(sb, { ...W, sessionId: row.id, userId: 'owner', messages: afterTurn(row.messages, said, 'Which Slack channel?'), proposal: row.proposal });
  assert.equal(sessions(sb)[0].messages.length, 4);
  const three = await openBuilderSessionForJob(sb, { ...W, userId: 'owner', jobId: 'r-hand' });
  assert.equal(three.session.id, one.session.id);
  assert.deepEqual(kinds(three.history), ['proposal', 'user', 'assistant']);
  assert.deepEqual(three.history.slice(1).map(i => i.text), ['Post it to Slack as well', 'Which Slack channel?']);
});

test('a failed turn: the user message is kept and the chat says it got no answer', async () => {
  const sb = database({ agent_routines: [handJob()] });
  const one = await openBuilderSessionForJob(sb, { ...W, userId: 'owner', jobId: 'r-hand' });
  const row = sessions(sb)[0];
  // The loop saves the transcript with the user's words and no reply when the provider fails.
  await saveBuilderSession(sb, { ...W, sessionId: row.id, userId: 'owner', messages: afterTurn(row.messages, 'Make it weekly'), proposal: row.proposal });
  const again = await openBuilderSessionForJob(sb, { ...W, userId: 'owner', jobId: 'r-hand' });
  assert.equal(again.session.id, one.session.id);
  assert.deepEqual(kinds(again.history), ['proposal', 'user', 'failed']);
  assert.equal(again.history[1].text, 'Make it weekly');
  // A seeded chat or an answered turn is not a failure.
  assert.equal(unanswered(one.session.messages), false);
  assert.equal(unanswered(afterTurn(one.session.messages, 'x', 'y')), false);
  assert.equal(unanswered([...madeTranscript().slice(0, 2), { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a1', content: '{"rows":1}' }] }]), true);
});

test('session binding: each person has their own chat on the job; another person\'s session is refused', async () => {
  const sb = database();
  const { routine } = await builtJob(sb);
  const mine = await openBuilderSessionForJob(sb, { ...W, userId: 'owner', jobId: routine.id });
  const theirs = await openBuilderSessionForJob(sb, { ...W, userId: 'editor', jobId: routine.id });
  assert.notEqual(theirs.session.id, mine.session.id);
  assert.equal(sessions(sb).find(r => r.id === theirs.session.id).user_id, 'editor');
  // The editor sees the approved setup, never the owner's words.
  assert.deepEqual(kinds(theirs.history), ['assistant', 'proposal']);
  assert.ok(!JSON.stringify(theirs.history).includes('deals report every morning'));
  // The editor's second open is their own session again.
  assert.equal((await openBuilderSessionForJob(sb, { ...W, userId: 'editor', jobId: routine.id })).session.id, theirs.session.id);
  // Neither can read or write the other's session.
  assert.equal(await getBuilderSession(sb, { ...W, userId: 'editor', sessionId: mine.session.id }), null);
  assert.equal(await saveBuilderSession(sb, { ...W, sessionId: mine.session.id, userId: 'editor', messages: [] }), false);
  assert.ok(sessions(sb).find(r => r.id === mine.session.id).messages.length > 0);
  // A viewer of nothing cannot open it at all.
  await assert.rejects(openBuilderSessionForJob(sb, { ...W, userId: 'stranger', jobId: routine.id }), e => [403, 404].includes(e.status));
});

test('someone else approved the job since: your chat goes on from the live job', async () => {
  // The editor administers the workspace, so may change the owner's job.
  const sb = database({ workspace_members: [{ workspace_id: 'ws', user_id: 'owner', role: 'admin' }, { workspace_id: 'ws', user_id: 'editor', role: 'admin' }] });
  const { routine } = await builtJob(sb);
  const mine = await openBuilderSessionForJob(sb, { ...W, userId: 'owner', jobId: routine.id });
  // The editor changes the job and approves it.
  const theirs = await openBuilderSessionForJob(sb, { ...W, userId: 'editor', jobId: routine.id });
  await approveBuilderProposal(sb, { ...W, userId: 'editor', sessionId: theirs.session.id, name: 'Morning report v2', ...lookups });
  const back = await openBuilderSessionForJob(sb, { ...W, userId: 'owner', jobId: routine.id });
  assert.equal(back.session.id, mine.session.id);
  assert.equal(back.history.at(-1).kind, 'proposal');
  assert.equal(back.history.at(-1).proposal.name, 'Morning report v2');
  assert.equal(back.history.at(-1).approved, true);
  assert.ok(back.history.some(i => i.role === 'assistant' && /changed this job since/.test(i.text)));
  // Only once: the next open changes nothing.
  const n = sessions(sb).find(r => r.id === mine.session.id).messages.length;
  await openBuilderSessionForJob(sb, { ...W, userId: 'owner', jobId: routine.id });
  assert.equal(sessions(sb).find(r => r.id === mine.session.id).messages.length, n);
  // The transcript stays valid: every tool_use answered in the next message.
  const msgs = sessions(sb).find(r => r.id === mine.session.id).messages;
  msgs.forEach((m, i) => { if (i) assert.notEqual(m.role, msgs[i - 1].role); });
  assert.deepEqual(withNewerSetup([], dailyReport()).map(m => m.role), ['user', 'assistant', 'user']);
});

test('an empty open session on the job is filled instead of another one created', async () => {
  const sb = database({ agent_routines: [handJob()] });
  const blank = await createBuilderSession(sb, { ...W, userId: 'owner', jobId: 'r-hand' });
  const opened = await openBuilderSessionForJob(sb, { ...W, userId: 'owner', jobId: 'r-hand' });
  assert.equal(opened.session.id, blank.id);
  assert.equal(sessions(sb).length, 1);
});

test('two tabs: a save based on an older read does not replace the newer transcript', async () => {
  const sb = database({ agent_routines: [handJob()] });
  await openBuilderSessionForJob(sb, { ...W, userId: 'owner', jobId: 'r-hand' });
  const read = structuredClone(sessions(sb)[0]);
  assert.equal(await saveBuilderSession(sb, { ...W, sessionId: read.id, userId: 'owner', messages: afterTurn(read.messages, 'tab one', 'ok'), expectUpdatedAt: read.updated_at }), true);
  assert.equal(await saveBuilderSession(sb, { ...W, sessionId: read.id, userId: 'owner', messages: afterTurn(read.messages, 'tab two', 'ok'), expectUpdatedAt: read.updated_at }), false);
  assert.ok(JSON.stringify(sessions(sb)[0].messages).includes('tab one'));
});

test('the same person\'s answers to an ask are carried into the next session; tool results are not', () => {
  const t = madeTranscript();
  t.splice(1, 0, { role: 'assistant', content: [{ type: 'tool_use', id: 't0', name: 'hubspot_find', input: {} }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't0', content: 'PRIVATE ROW' }] });
  const same = JSON.stringify(sanitizeBuilderTranscript(t, { keepText: true }));
  assert.ok(same.includes('-> 08:00') && !same.includes('PRIVATE ROW'));
  assert.ok(!JSON.stringify(sanitizeBuilderTranscript(t, { keepText: false, approved: dailyReport() })).includes('-> 08:00'));
  assert.deepEqual(builderSessionHistory(t).find(i => i.kind === 'ask').answers, [{ question: 'When?', answer: '08:00' }]);
});
