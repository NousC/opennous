// Edit on a job no builder chat made (GET-884, on GET-873's openBuilderSessionForJob), end to end with
// the real engine (core) on an in-memory database and a scripted model: the chat opens on the job's
// brief (no "set up outside the builder" line), the model sees the job's current AI instructions and
// Slack layout, proposes a changed prompt and layout, and approving saves them on the same routine as
// a new version.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as core from '@nous/core';
import { makeJobBuilder } from '../src/lib/jobBuilder/index.mjs';

const { signalCatalog } = core;
const BOX = 'box-1';
const CUSTOM = '2-9000001';

// ── An in-memory Supabase, as core's tests use, plus the agent_routines version trigger ──────────
// The real bump is the BEFORE UPDATE trigger agent_routines_version_bump (2026_10_01_automation_versions.sql):
// a write that changes a snapshot column (steps, prompt, name, the schedule…) takes the next version.
const SNAPSHOT = ['name', 'prompt', 'trigger_kind', 'frequency', 'at_time', 'day_of_week', 'day_of_month', 'timezone', 'offset_minutes', 'entity_id', 'condition', 'action', 'artifact', 'destination', 'destination_target', 'tools', 'steps', 'trigger_config'];
const snap = (r) => JSON.stringify(SNAPSHOT.map(k => [k, r[k] ?? null]));
function database(seed = {}) {
  const tables = {
    workspace_members: [{ workspace_id: 'ws', user_id: 'owner', role: 'admin' }],
    revboxes: [{ id: BOX, workspace_id: 'ws', owner_id: 'owner', shared: true, name: 'Ops box', objective: 'Keep the team informed.', blocks: [], delivery: [] }],
    revbox_members: [], revbox_context: [], revbox_builder_sessions: [], revbox_datasets: [], agent_routines: [], documents: [],
    ...seed,
  };
  let seq = 0;
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
      if (this.insertValue) { const row = structuredClone({ id: `${this.table}-${++seq}`, ...this.insertValue }); tables[this.table].push(row); values = [row]; }
      if (this.updateValue) for (const row of values) {
        const before = snap(row);
        Object.assign(row, structuredClone(this.updateValue));
        if (this.table === 'agent_routines' && snap(row) !== before) row.version = (row.version ?? 0) + 1;
      }
      return { data: structuredClone(single ? values[0] ?? null : values), error: null };
    }
    maybeSingle() { return Promise.resolve(this.result(true)); }
    single() { return this.maybeSingle(); }
    then(ok, bad) { return Promise.resolve(this.result(false)).then(ok, bad); }
  }
  return { tables, from: t => new Query(t) };
}

// ── A scripted model ─────────────────────────────────────────────────────────────────────────────
let n = 0;
const use = (name, input) => ({ type: 'tool_use', id: `tu_${++n}`, name, input });
const reply = (content) => ({ id: `msg_${++n}`, model: 'claude-sonnet-5', content, stop_reason: content.some(b => b.type === 'tool_use') ? 'tool_use' : 'end_turn', usage: { input_tokens: 100, output_tokens: 10 } });
function scriptedClient(script) {
  const calls = [];
  return { calls, messages: { stream(params) {
    calls.push(structuredClone(params));
    const resp = script.shift();
    if (!resp) throw new Error('script ran out');
    return { async *[Symbol.asyncIterator]() {}, finalMessage: async () => resp };
  } } };
}
const helpers = () => ({
  connections: async () => [{ id: 'c1', slug: 'hubspot', label: 'HubSpot' }, { id: 'c2', slug: 'slack', label: 'Slack' }],
  revboxContext: async () => ({ box: { id: BOX, name: 'Ops box', objective: 'Keep the team informed.' }, context: [], jobs: [] }),
  slackTargets: async () => ({ connected: true, channels: [{ id: 'C0OPS', name: 'ops-daily', member: true }], people: [] }),
  mailboxes: async () => [], searchAccounts: async () => [], customSignals: async () => [],
  hubspotObjects: async () => ({ connected: true, objects: [{ id: CUSTOM, label: 'Account Daily Usage', custom: true }] }), hubspotFields: async () => [],
  signalCatalog: async () => signalCatalog({ custom: [] }),
});

const OLD_PROMPT = 'Write the daily usage report from {{steps.read.output}}: totals first, then the five biggest movers.';
const NEW_PROMPT = 'Write a three-line usage update from {{steps.read.output}}: the total, the biggest mover up, the biggest mover down.';
const handRoutine = () => ({
  id: 'r-hand', workspace_id: 'ws', revbox_id: BOX, user_id: 'owner', name: 'Product Usage daily report', enabled: true, version: 1,
  trigger_kind: 'clock', trigger_config: { frequency: 'daily', at: '08:00' }, timezone: 'America/New_York', prompt: OLD_PROMPT,
  steps: [
    { id: 'read', type: 'hubspot', config: { action: 'read', object: CUSTOM, object_label: 'Account Daily Usage', fields: ['pulls'], group_by: 'company_name', date_property: 'date', window: 'yesterday', compare: true } },
    { id: 'summary', type: 'agent', config: { mode: 'write', model: 'opennous', prompt: OLD_PROMPT } },
    { id: 'post', type: 'slack', config: { action: 'channel', channel_id: 'C0OPS', channel: 'ops-daily', text: '{{steps.summary.output}}', format: 'report' } },
  ],
});

test('Edit on a job set up outside the builder: the model sees its prompt and layout, changes both, approve saves a new version', async () => {
  const sb = database({ agent_routines: [handRoutine()] });
  const base = { sb, workspaceId: 'ws', userId: 'owner', revboxId: BOX };

  // The model reads the job as it is (its own approved propose_job call), then proposes the change.
  const changed = (input) => {
    const steps = structuredClone(input.steps);
    steps.find(s => s.id === 'summary').config.prompt = NEW_PROMPT;
    steps.find(s => s.id === 'post').config.format = 'digest';
    return { ...input, steps, display: input.display.map(d => d.step_id === 'post' ? { ...d, detail: 'Digest layout' } : d) };
  };
  const script = [];
  const client = scriptedClient(script);
  const b = makeJobBuilder({ engine: core, client, helpers: helpers(), gate: async () => {}, meter: async () => {}, model: { modelId: 'claude-sonnet-5', thinking: false }, costOf: () => 0, toCredits: () => 0, today: '2026-10-15' });

  const opened = await b.openForJob({ ...base, jobId: 'r-hand' });
  // The chat opens on the brief alone: no line about where the job was set up.
  assert.equal(opened.history.length, 1);
  assert.equal(opened.history[0].kind, 'proposal');
  assert.equal(opened.history[0].proposal.brief.text, 'Every morning I read yesterday\'s Account Daily Usage in HubSpot, write the product usage report and post it to #ops-daily.');
  assert.ok(!JSON.stringify(opened).includes('outside the builder. Here'));

  const seededCall = opened.session.messages[1].content.find(x => x.type === 'tool_use' && x.name === 'propose_job');
  script.push(reply([use('propose_job', changed(seededCall.input))]));
  const { session } = await b.openSession({ ...base, sessionId: opened.session.id });
  const events = [];
  for await (const e of b.runTurn({ ...base, session, isNew: false, message: 'Make it a three-line update and use the digest layout.', answers: null, hints: null })) events.push(e);

  // What the model was given: the job's current AI instructions and Slack layout.
  const sent = JSON.stringify(client.calls[0].messages);
  assert.ok(sent.includes(JSON.stringify(OLD_PROMPT).slice(1, -1)), 'the current prompt is in the transcript');
  assert.match(sent, /"format":"report"/);
  const proposal = events.find(e => e.type === 'proposal')?.proposal;
  assert.ok(proposal, `a proposal: ${JSON.stringify(events.filter(e => e.type === 'error' || e.state === 'error'))}`);
  assert.equal(proposal.brief.text, 'Every morning I read yesterday\'s Account Daily Usage in HubSpot, write the product usage report and post it to #ops-daily.');

  const out = await b.approve({ ...base, sessionId: opened.session.id });
  assert.equal(out.routine.id, 'r-hand');
  assert.equal(sb.tables.agent_routines.length, 1);
  const saved = sb.tables.agent_routines[0];
  assert.equal(saved.steps.find(s => s.id === 'summary').config.prompt, NEW_PROMPT);
  assert.equal(saved.steps.find(s => s.id === 'post').config.format, 'digest');
  assert.equal(saved.prompt, NEW_PROMPT);   // the legacy column the event runners read
  assert.equal(saved.version, 2);
  assert.equal(saved.enabled, true);
  const stored = sb.tables.revbox_builder_sessions.find(r => r.id === opened.session.id);
  assert.equal(stored.state, 'approved');
  assert.equal(stored.proposal.brief.text, 'Every morning I read yesterday\'s Account Daily Usage in HubSpot, write the product usage report and post it to #ops-daily.');
});
