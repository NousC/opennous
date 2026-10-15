// GET-873: a RevBox job's Test holds every external send (runSteps' holdSends), and Edit on a job no
// builder chat made opens on its current setup as an approved card.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openBuilderSessionForJob, approveBuilderProposal, validateBuilderProposal, APPROVED_NOTE } from '../dist/db/revboxBuilder.mjs';
import { proposalFromRoutine, signalKeyForRoutine } from '../dist/db/revboxJobProposal.mjs';
import { signalCatalog, customSignalEntry } from '../dist/services/signalCatalog.mjs';
import { runStepsForTest as runSteps, registerStepHandler } from '../dist/services/automationRun.mjs';

function database(seed = {}) {
  const tables = {
    workspace_members: [{ workspace_id: 'ws', user_id: 'owner', role: 'admin' }, { workspace_id: 'ws', user_id: 'viewer', role: 'member' }],
    revboxes: [{ id: 'box', workspace_id: 'ws', owner_id: 'owner', shared: true, name: 'Ops box', objective: 'Keep the team informed.', blocks: [], delivery: [] }],
    revbox_members: [], revbox_context: [], revbox_builder_sessions: [], agent_routines: [], documents: [],
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
      if (this.updateValue) for (const row of values) Object.assign(row, structuredClone(this.updateValue));
      return { data: structuredClone(single ? values[0] ?? null : values), error: null };
    }
    maybeSingle() { return Promise.resolve(this.result(true)); }
    single() { return this.maybeSingle(); }
    then(ok, bad) { return Promise.resolve(this.result(false)).then(ok, bad); }
  }
  return { tables, from: t => new Query(t) };
}

const doc = { id: 'd1', title: 'Daily usage', headline: null, sections: [{ label: 'Summary', body: 'Dealer A pulled 12 (+3).' }] };
const handRoutine = () => ({
  id: 'r-hand', workspace_id: 'ws', revbox_id: 'box', user_id: 'owner', name: 'Usage daily', enabled: false,
  trigger_kind: 'clock', trigger_config: { frequency: 'daily', at: '08:00' }, timezone: 'America/Toronto',
  steps: [
    { id: 'summary', type: 'agent', config: { mode: 'write', model: 'opennous', prompt: 'Write the summary.' } },
    { id: 'post', type: 'slack', config: { action: 'channel', channel_id: 'C0OPS', channel: 'ops-daily', text: '{{steps.summary.output}}', format: 'report' } },
    { id: 'mail', type: 'gmail', config: { to: 'lead@example.com', subject: 'Usage', body: '{{steps.summary.output}}', send_from: { id: 'mbx-1', email: 'me@example.com' } } },
    { id: 'hook', type: 'webhook', config: { url: 'https://hooks.example.com/x?token=1' } },
    { id: 'note', type: 'hubspot', config: { action: 'note', body: 'x' } },
    { id: 'box_delivery', type: 'revbox_delivery', config: { format: 'digest' } },
  ],
});

// ── Test: held sends ──────────────────────────────────────────────────────────

test('a held test runs nothing outward and records what each step would do', async () => {
  const sb = database();
  sb.tables.revboxes[0].delivery = [{ id: 'd-s', kind: 'slack', target: 'C0BOX', channel: 'box-out' }, { id: 'd-e', kind: 'email', to: 'cs@example.com', target: 'cs@example.com' }];
  const sent = [];
  for (const h of ['slack', 'gmail_draft', 'gmail_send', 'smtp_send', 'safe_fetch']) registerStepHandler(h, async (...a) => { sent.push([h, a]); return { ok: true, status: 'created' }; });
  const routine = { ...handRoutine(), steps: handRoutine().steps.filter(s => s.type !== 'agent') };
  const r = await runSteps(routine, doc, { stage: 'scheduled', ctx: { supabase: sb, workspaceId: 'ws', runId: 'run-t', holdSends: true } });
  assert.equal(sent.length, 0);
  assert.equal(r.failed, undefined);
  assert.equal(r.paused, undefined);
  const held = r.log.filter(l => l.status === 'held');
  assert.deepEqual(held.map(l => l.type), ['slack', 'gmail', 'webhook', 'hubspot', 'revbox_delivery']);
  assert.equal(held[0].detail, 'Would post to #ops-daily');
  assert.equal(held[1].detail, 'Would draft to lead@example.com');
  assert.equal(held[2].detail, 'Would send to the webhook at hooks.example.com');
  assert.equal(held[3].detail, 'Would add a note in HubSpot');
  assert.match(held[4].detail, /^Would deliver to .*#box-out.*cs@example\.com/);
  assert.ok(held.every(l => l.held === true && Array.isArray(l.preview)));
  assert.ok(held[0].preview.some(x => x.label === 'Message' && /Dealer A pulled 12/.test(x.value)));
});

test('a held test never pauses for approval, and an ordinary run still does', async () => {
  const sb = database();
  const routine = { id: 'r2', revbox_id: 'box', user_id: 'owner', name: 'Gated', steps: [
    { id: 'ok', type: 'approval', config: {} },
    { id: 'post', type: 'slack', config: { action: 'channel', channel_id: 'C0OPS', channel: 'ops-daily' } },
  ] };
  let posted = 0;
  registerStepHandler('slack', async () => { posted++; return { ok: true }; });
  const held = await runSteps(routine, doc, { stage: 'scheduled', ctx: { supabase: sb, workspaceId: 'ws', holdSends: true } });
  assert.equal(held.paused, undefined);
  assert.equal(posted, 0);
  assert.equal(held.log.at(-1).detail, 'Would post to #ops-daily');
  const real = await runSteps(routine, doc, { stage: 'scheduled', ctx: { supabase: sb, workspaceId: 'ws' } });
  assert.equal(real.paused, true);
  assert.equal(posted, 0);
});

test('HubSpot reads still run in a held test', async () => {
  const sb = database();
  const routine = { id: 'r3', revbox_id: 'box', user_id: 'owner', name: 'Read', steps: [
    { id: 'post', type: 'slack', config: { action: 'dm', user_id: 'U1', user_name: 'Sam' } },
  ] };
  const r = await runSteps(routine, doc, { stage: 'scheduled', ctx: { supabase: sb, workspaceId: 'ws', holdSends: true } });
  assert.equal(r.log[0].detail, 'Would message Sam in Slack');
});

// ── Edit on a job no chat made ───────────────────────────────────────────────

test('a routine maps back to its signal key through the catalog', () => {
  const cat = signalCatalog({ custom: [{ id: 'def1', key: 'renewal_risk', name: 'Renewal risk', active: true }] });
  assert.equal(signalKeyForRoutine({ trigger_kind: 'clock' }, cat), 'schedule');
  assert.equal(signalKeyForRoutine({ trigger_kind: 'call_ended', trigger_config: { provider: 'granola', tools: ['granola'] } }, cat), 'meeting.done:granola');
  assert.equal(signalKeyForRoutine({ trigger_kind: 'call_ended', trigger_config: {} }, cat), 'meeting.done');
  assert.equal(signalKeyForRoutine({ trigger_kind: 'deal_closed_won' }, cat), 'deal.won');
  assert.equal(signalKeyForRoutine({ trigger_kind: 'account_signal', trigger_config: { signals: ['churn_risk'] } }, cat), 'signal.churn_risk');
  assert.equal(signalKeyForRoutine({ trigger_kind: 'account_signal', trigger_config: { signals: ['custom_def1'] } }, cat), 'custom.renewal_risk');
  assert.equal(signalKeyForRoutine({ trigger_kind: 'before_meeting' }, cat), null);
  assert.equal(customSignalEntry({ id: 'def1', key: 'renewal_risk', name: 'R' }).trigger.config.signals[0], 'custom_def1');
});

test('the routine as a proposal validates, with box delivery folded back in', () => {
  const p = proposalFromRoutine(handRoutine());
  assert.equal(p.name, 'Usage daily');
  assert.deepEqual(p.trigger, { signal_key: 'schedule', kind: 'clock', config: { frequency: 'daily', at: '08:00' }, timezone: 'America/Toronto', label: 'Every day at 08:00 (Toronto)' });
  assert.deepEqual(p.steps.map(s => s.id), ['summary', 'post', 'mail', 'hook', 'note']);
  assert.equal(p.uses_box_delivery, true);
  assert.equal(p.box_delivery_format, 'digest');
  assert.deepEqual(p.display.map(d => [d.step_id, d.tool, d.title]), [
    ['summary', 'ai', 'Write from the agent\'s instructions'], ['post', 'slack', 'Post to #ops-daily'], ['mail', 'gmail', 'Email lead@example.com'],
    ['hook', 'webhook', 'Send to hooks.example.com'], ['note', 'hubspot', 'Add a note in HubSpot'],
  ]);
  const v = validateBuilderProposal(p, { slackChannelIds: ['C0OPS'], mailboxIds: ['mbx-1'] });
  assert.deepEqual(v.errors, []);
});

test('Edit on a hand-made job opens on its setup as an approved card, and approving updates the same routine', async () => {
  const sb = database({ agent_routines: [handRoutine()] });
  const opened = await openBuilderSessionForJob(sb, { workspaceId: 'ws', revboxId: 'box', userId: 'owner', jobId: 'r-hand' });
  assert.equal(opened.source_session_id, null);
  // GET-884: no line about where the job was set up; the chat opens on its brief alone.
  assert.equal(opened.history.length, 1);
  assert.equal(opened.history[0].kind, 'proposal');
  assert.equal(opened.history[0].approved, true);
  assert.equal(opened.history[0].proposal.name, 'Usage daily');
  assert.equal(opened.history[0].proposal.facts.find(f => f.step_id === 'post').channel, 'ops-daily');
  assert.equal(opened.history[0].proposal.brief.text, 'Every morning I write the report, post it to #ops-daily, email it to lead@example.com, send it to hooks.example.com, save it as a note in HubSpot and send it to this box\'s destinations.');
  assert.equal(opened.history[0].proposal.brief.starts, 'Every day 08:00 (Toronto)');
  const row = sb.tables.revbox_builder_sessions.find(r => r.id === opened.session.id);
  // A valid transcript to continue: user, assistant (text + propose_job), user (the approved answer).
  assert.deepEqual(row.messages.map(m => m.role), ['user', 'assistant', 'user']);
  assert.equal(row.messages[1].content.length, 1);
  assert.equal(row.messages[1].content[0].name, 'propose_job');
  assert.equal(row.messages[1].content[0].input.facts, undefined);
  assert.equal(row.messages[1].content[0].input.brief, undefined);
  assert.deepEqual(row.messages[2].content, [{ type: 'tool_result', tool_use_id: 'toolu_current_job', content: APPROVED_NOTE }]);
  // Approving it as it is updates the same routine (no second job), keeping it off as it was.
  const out = await approveBuilderProposal(sb, { workspaceId: 'ws', revboxId: 'box', userId: 'owner', sessionId: opened.session.id, slackChannelIds: ['C0OPS'], mailboxIds: ['mbx-1'] });
  assert.equal(out.routine.id, 'r-hand');
  assert.equal(sb.tables.agent_routines.length, 1);
  assert.equal(out.enabled, false);
  assert.deepEqual(out.routine.steps.map(s => s.type), ['agent', 'slack', 'gmail', 'webhook', 'hubspot', 'revbox_delivery']);
  // A viewer cannot open it.
  await assert.rejects(openBuilderSessionForJob(sb, { workspaceId: 'ws', revboxId: 'box', userId: 'viewer', jobId: 'r-hand' }), e => e.status === 403);
});
