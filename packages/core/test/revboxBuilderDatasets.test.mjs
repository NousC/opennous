// The Job Builder and RevBox datasets (GET-874 follow-up): a proposal may carry the tables its jobs
// keep (`datasets`), its steps may add to a table (dataset_append) or read one (dataset_read), approve
// creates the proposed tables before the routine (an existing key is reused, never changed), and a
// proposal that names jobs still to set up (`next_jobs`) continues in a new session after approval,
// so one chat sets up the closed won/lost analysis and its monthly and quarterly reports.
//
// Run: pnpm --filter @nous/core build && node --test packages/core/test/revboxBuilderDatasets.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { validateBuilderProposal, approveBuilderProposal, createBuilderSession, saveBuilderSession, builderSessionHistory, sanitizeBuilderTranscript, openBuilderSessionForJob } from '../dist/db/revboxBuilder.mjs';
import { displayForStep } from '../dist/db/revboxJobProposal.mjs';

const COLUMNS = [
  { key: 'deal', label: 'Deal', type: 'text' },
  { key: 'outcome', label: 'Outcome', type: 'enum', options: ['won', 'lost'] },
  { key: 'icp_fit', label: 'ICP fit', type: 'enum', options: ['strong', 'partial', 'weak'] },
  { key: 'amount', label: 'Amount', type: 'number' },
  { key: 'reason', label: 'Main reason', type: 'text' },
];

// Job 1: on a deal won or lost, analyse it against the box's ICP context and add one row.
const analysis = () => ({
  name: 'Closed deal analysis',
  summary: 'When a deal is won or lost: analyse it against the ICP and add a row to Win/loss deals.',
  trigger: { signal_key: 'deal.won', signal_keys: ['deal.won', 'deal.lost'], kind: 'deal_closed_won', config: { also: [{ kind: 'deal_closed_lost', config: {} }] }, label: 'When a deal is won or lost' },
  datasets: [{ key: 'win_loss_deals', name: 'Win/loss deals', description: 'One row per closed deal.', columns: COLUMNS }],
  steps: [
    { id: 'analyse', type: 'agent', config: { mode: 'write', model: 'opennous', prompt: 'Analyse this closed deal against our ICP.' } },
    { id: 'row', type: 'dataset_append', config: { dataset_key: 'win_loss_deals', dedupe_from: 'deal' } },
  ],
  display: [
    { step_id: 'analyse', tool: 'ai', title: 'Analyse the deal against the ICP' },
    { step_id: 'row', tool: 'dataset_append', title: 'Add a row to Win/loss deals' },
  ],
  uses_box_delivery: false,
  next_jobs: ['Monthly win/loss report', 'Quarterly win/loss review'],
  estimated_credits_per_run: 2,
});

// Job 2: monthly, read last month's rows and write the report.
const monthly = (key = 'win_loss_deals') => ({
  name: 'Monthly win/loss report',
  summary: 'On the first of the month: read last month\'s closed deals and write the win/loss report.',
  trigger: { signal_key: 'schedule', kind: 'clock', config: { frequency: 'monthly', at: '08:00' }, timezone: 'UTC', label: 'On the first of the month at 08:00' },
  steps: [
    { id: 'rows', type: 'dataset_read', config: { dataset_key: key, window: 'last_month', limit: 200 } },
    { id: 'report', type: 'agent', config: { mode: 'write', model: 'opennous', prompt: 'Write the monthly win/loss report from {{steps.rows.output}}.' } },
  ],
  display: [
    { step_id: 'rows', tool: 'dataset_read', title: 'Read last month\'s deals' },
    { step_id: 'report', tool: 'ai', title: 'Write the report' },
  ],
  uses_box_delivery: true,
});

const existing = [{ key: 'win_loss_deals', name: 'Win/loss deals', columns: COLUMNS }];

test('a job that analyses each closed deal into a proposed table passes, and its facts name the table', () => {
  const r = validateBuilderProposal(analysis(), { datasets: [] });
  assert.deepEqual(r.errors, []);
  assert.equal(r.ok, true);
  assert.deepEqual(r.datasets.map(d => [d.key, d.exists]), [['win_loss_deals', false]]);
  const fact = r.facts.find(f => f.step_id === 'row');
  assert.equal(fact.type, 'dataset_append');
  assert.equal(fact.dataset_key, 'win_loss_deals');
  assert.equal(fact.dataset, 'Win/loss deals');
  assert.equal(fact.new_dataset, true);
  assert.equal(fact.dedupe_from, 'deal');
  assert.match(fact.target, /Add a row to the table "Win\/loss deals" \(win_loss_deals, new\)/);
  assert.equal(fact.external, false);
});

test('a report job reads a table that exists or that this proposal creates; an unknown key is refused', () => {
  const ok = validateBuilderProposal(monthly(), { datasets: existing });
  assert.deepEqual(ok.errors, []);
  const read = ok.facts.find(f => f.step_id === 'rows');
  assert.equal(read.dataset, 'Win/loss deals');
  assert.equal(read.window, 'last_month');
  assert.equal(read.new_dataset, false);
  assert.match(read.target, /Read the table "Win\/loss deals" \(win_loss_deals\): last month/);
  const unknown = validateBuilderProposal(monthly('nope'), { datasets: existing });
  assert.equal(unknown.ok, false);
  assert.match(unknown.errors.join(' '), /no table "nope"/);
  // With the box's tables unknown (shape only), any well-formed key passes; a malformed one never does.
  assert.equal(validateBuilderProposal(monthly('anything_else'), {}).ok, true);
  assert.match(validateBuilderProposal(monthly('Bad Key'), {}).errors.join(' '), /dataset_key/);
  // {{steps.rows.output}}: a Read table step writes output like a HubSpot read.
  assert.doesNotMatch(ok.errors.join(' '), /writes no output/);
});

test('an AI step comes before an Add to table step and after a Read table step', () => {
  const noWriter = analysis(); noWriter.steps.reverse();
  assert.match(validateBuilderProposal(noWriter, { datasets: [] }).errors.join(' '), /Step "row": .*AI step before it/);
  const noReader = monthly(); noReader.steps.reverse(); noReader.steps[0].config.prompt = 'Write the report.';
  assert.match(validateBuilderProposal(noReader, { datasets: existing }).errors.join(' '), /Step "rows": .*AI step after it/);
});

test('a Read table window, a limit and dedupe_from are checked', () => {
  const w = monthly(); w.steps[0].config.window = 'last_year';
  assert.match(validateBuilderProposal(w, { datasets: existing }).errors.join(' '), /window/);
  const l = monthly(); l.steps[0].config.limit = 5000;
  assert.match(validateBuilderProposal(l, { datasets: existing }).errors.join(' '), /limit/);
  const d = analysis(); d.steps[1].config.dedupe_from = 'contact';
  assert.match(validateBuilderProposal(d, { datasets: [] }).errors.join(' '), /dedupe_from/);
  const missing = analysis(); delete missing.steps[1].config.dataset_key;
  assert.match(validateBuilderProposal(missing, { datasets: [] }).errors.join(' '), /dataset_key/);
});

test('proposed tables are checked: columns, keys, and no two with one key', () => {
  const cols = analysis(); cols.datasets[0].columns = [];
  assert.match(validateBuilderProposal(cols, { datasets: [] }).errors.join(' '), /at least one column/);
  const twice = analysis(); twice.datasets.push({ ...twice.datasets[0] });
  assert.match(validateBuilderProposal(twice, { datasets: [] }).errors.join(' '), /twice/);
  const badKey = analysis(); badKey.datasets[0].key = '9 lives';
  assert.match(validateBuilderProposal(badKey, { datasets: [] }).errors.join(' '), /key/);
  // No key: the name slugged is the key the steps use.
  const slug = analysis(); delete slug.datasets[0].key;
  assert.equal(validateBuilderProposal(slug, { datasets: [] }).ok, true);
  // Proposing a table the box already has reuses it (never changes it).
  const reuse = validateBuilderProposal(analysis(), { datasets: existing });
  assert.equal(reuse.ok, true);
  assert.equal(reuse.datasets[0].exists, true);
  assert.equal(reuse.facts.find(f => f.step_id === 'row').new_dataset, false);
  const nextJobs = analysis(); nextJobs.next_jobs = ['x'.repeat(200)];
  assert.match(validateBuilderProposal(nextJobs, { datasets: [] }).errors.join(' '), /next_jobs/);
});

test('a dataset step\'s display line cannot claim another tool', () => {
  const p = analysis(); p.display[1].tool = 'slack';
  assert.match(validateBuilderProposal(p, { datasets: [] }).errors.join(' '), /says tool "slack", but step "row" is a dataset_append step/);
});

test('Edit of a job made outside the builder names dataset steps from their type', () => {
  assert.equal(displayForStep({ id: 'row', type: 'dataset_append', config: { dataset_key: 'win_loss_deals' } }).title, 'Add a row to the table win_loss_deals');
  assert.equal(displayForStep({ id: 'rows', type: 'dataset_read', config: { dataset_key: 'win_loss_deals', window: 'last_quarter' } }).title, 'Read the table win_loss_deals');
  assert.equal(displayForStep({ id: 'rows', type: 'dataset_read', config: { dataset_key: 'k' } }).tool, 'dataset_read');
});

// ── Approve ─────────────────────────────────────────────────────────────────────
function database(seed = {}) {
  const tables = {
    workspace_members: [{ workspace_id: 'ws', user_id: 'owner', role: 'admin' }],
    revboxes: [{ id: 'box', workspace_id: 'ws', owner_id: 'owner', shared: true, name: 'Closed won/lost analysis', objective: 'Learn why deals close.', blocks: [], delivery: [] }],
    revbox_members: [], revbox_context: [], revbox_builder_sessions: [], agent_routines: [], documents: [], revbox_datasets: [], revbox_dataset_rows: [],
    ...seed,
  };
  let seq = 0;
  const order = [];
  class Query {
    constructor(table) { this.table = table; this.filters = []; }
    select() { return this; } order() { return this; } limit() { return this; } gte() { return this; } lt() { return this; } or() { return this; }
    eq(k, v) { this.filters.push(r => r[k] === v); return this; }
    neq(k, v) { this.filters.push(r => r[k] !== v); return this; }
    in(k, vs) { this.filters.push(r => vs.includes(r[k])); return this; }
    insert(v) { this.insertValue = v; return this; }
    update(v) { this.updateValue = v; return this; }
    result(single) {
      let values = (tables[this.table] ??= []).filter(r => this.filters.every(f => f(r)));
      if (this.insertValue) { const row = structuredClone({ id: `${this.table}-${++seq}`, ...this.insertValue }); tables[this.table].push(row); values = [row]; order.push(this.table); }
      if (this.updateValue) for (const row of values) Object.assign(row, structuredClone(this.updateValue));
      return { data: structuredClone(single ? values[0] ?? null : values), error: null };
    }
    maybeSingle() { return Promise.resolve(this.result(true)); }
    single() { return this.maybeSingle(); }
    then(ok, bad) { return Promise.resolve(this.result(false)).then(ok, bad); }
  }
  return { tables, order, from: t => new Query(t) };
}

const transcript = (proposal) => [
  { role: 'user', content: [{ type: 'text', text: 'Analyse every closed deal into a table, then monthly and quarterly reports.' }] },
  { role: 'assistant', content: [{ type: 'text', text: 'Here is the first job.' }, { type: 'tool_use', id: 'toolu_p1', name: 'propose_job', input: proposal }] },
];

test('approve creates the proposed table before the routine, then continues in a new session for the next job', async () => {
  const sb = database();
  const s = await createBuilderSession(sb, { workspaceId: 'ws', revboxId: 'box', userId: 'owner' });
  await saveBuilderSession(sb, { workspaceId: 'ws', sessionId: s.id, messages: transcript(analysis()), proposal: analysis() });
  const out = await approveBuilderProposal(sb, { workspaceId: 'ws', revboxId: 'box', userId: 'owner', sessionId: s.id });

  assert.equal(sb.tables.revbox_datasets.length, 1);
  const ds = sb.tables.revbox_datasets[0];
  assert.equal(ds.key, 'win_loss_deals');
  assert.equal(ds.revbox_id, 'box');
  assert.deepEqual(ds.columns.map(c => c.key), COLUMNS.map(c => c.key));
  assert.ok(sb.order.indexOf('revbox_datasets') < sb.order.indexOf('agent_routines'), 'the table exists before the routine that writes to it');
  assert.deepEqual(out.datasets, [{ key: 'win_loss_deals', name: 'Win/loss deals', created: true }]);
  assert.deepEqual(out.routine.steps.map(s => s.type), ['agent', 'dataset_append']);
  assert.equal(out.routine.trigger_kind, 'deal_closed_won');
  // The proposal's own fields are not routine columns.
  assert.equal('datasets' in out.routine, false);
  assert.equal('next_jobs' in out.routine, false);

  // The chat continues: a new open session for the same person, on no job yet, seeded with this chat.
  assert.ok(out.next_session_id);
  assert.deepEqual(out.next_jobs, ['Monthly win/loss report', 'Quarterly win/loss review']);
  const next = sb.tables.revbox_builder_sessions.find(x => x.id === out.next_session_id);
  assert.equal(next.state, 'open');
  assert.equal(next.job_id, null);
  assert.equal(next.user_id, 'owner');
  assert.equal(next.proposal, null);
  const last = next.messages.at(-1);
  assert.equal(last.role, 'user');
  const note = last.content.find(b => b.type === 'tool_result' && b.tool_use_id === 'toolu_p1').content;
  assert.match(note, /^The user approved this proposal/);
  assert.match(note, /win_loss_deals/);
  assert.match(note, /Monthly win\/loss report/);
  assert.match(note, /NEW job/);
  // The approved session is the first job's.
  const first = sb.tables.revbox_builder_sessions.find(x => x.id === s.id);
  assert.equal(first.state, 'approved');
  assert.equal(first.job_id, out.routine.id);
  // Its history shows the first job approved, and a sanitized copy keeps that note.
  const h = builderSessionHistory(next.messages, {});
  assert.equal(h.find(i => i.kind === 'proposal').approved, true);
  const clean = sanitizeBuilderTranscript(next.messages, { keepText: true });
  assert.match(clean.at(-1).content.find(b => b.type === 'tool_result').content, /^The user approved this proposal/);
});

test('the next job reads the table the first one created; an existing key is reused and never changed', async () => {
  const sb = database();
  const s1 = await createBuilderSession(sb, { workspaceId: 'ws', revboxId: 'box', userId: 'owner' });
  const first = await approveBuilderProposal(sb, { workspaceId: 'ws', revboxId: 'box', userId: 'owner', sessionId: s1.id, proposal: analysis() });
  // The monthly report, proposed in the continued session.
  await saveBuilderSession(sb, { workspaceId: 'ws', sessionId: first.next_session_id, userId: 'owner', proposal: { ...monthly(), next_jobs: ['Quarterly win/loss review'] } });
  const second = await approveBuilderProposal(sb, { workspaceId: 'ws', revboxId: 'box', userId: 'owner', sessionId: first.next_session_id });
  assert.deepEqual(second.routine.steps.map(s => s.type), ['dataset_read', 'agent', 'revbox_delivery']);
  assert.equal(second.routine.trigger_kind, 'clock');
  assert.ok(second.next_session_id);

  // The quarterly review proposes the same table again, with other columns: reused as it is.
  const quarterly = { ...monthly(), name: 'Quarterly win/loss review', trigger: { ...monthly().trigger, config: { frequency: 'quarterly', at: '08:00' } },
    datasets: [{ key: 'win_loss_deals', name: 'Renamed', columns: [{ key: 'other', label: 'Other' }] }] };
  quarterly.steps[0].config.window = 'last_quarter';
  await saveBuilderSession(sb, { workspaceId: 'ws', sessionId: second.next_session_id, userId: 'owner', proposal: quarterly });
  const third = await approveBuilderProposal(sb, { workspaceId: 'ws', revboxId: 'box', userId: 'owner', sessionId: second.next_session_id });
  assert.deepEqual(third.datasets, [{ key: 'win_loss_deals', name: 'Win/loss deals', created: false }]);
  assert.equal(sb.tables.revbox_datasets.length, 1);
  assert.equal(sb.tables.revbox_datasets[0].name, 'Win/loss deals');
  assert.deepEqual(sb.tables.revbox_datasets[0].columns.map(c => c.key), COLUMNS.map(c => c.key));
  // No more jobs to set up: the chat ends with this approval.
  assert.equal(third.next_session_id, undefined);
  assert.equal(sb.tables.agent_routines.length, 3);
  assert.equal(sb.tables.revbox_builder_sessions.length, 3);
});

test('approve refuses a step on a table the box does not have and nothing proposes', async () => {
  const sb = database();
  const s = await createBuilderSession(sb, { workspaceId: 'ws', revboxId: 'box', userId: 'owner' });
  await assert.rejects(approveBuilderProposal(sb, { workspaceId: 'ws', revboxId: 'box', userId: 'owner', sessionId: s.id, proposal: monthly('missing_table') }), e => e.status === 400 && /missing_table/.test(e.message));
  assert.equal(sb.tables.agent_routines.length, 0);
  assert.equal(sb.tables.revbox_builder_sessions[0].state, 'open');
});

test('Edit on a chained job opens its own chat, the earlier job shown approved', async () => {
  const sb = database();
  const s1 = await createBuilderSession(sb, { workspaceId: 'ws', revboxId: 'box', userId: 'owner' });
  await saveBuilderSession(sb, { workspaceId: 'ws', sessionId: s1.id, messages: transcript(analysis()), proposal: analysis() });
  const first = await approveBuilderProposal(sb, { workspaceId: 'ws', revboxId: 'box', userId: 'owner', sessionId: s1.id });
  const next = sb.tables.revbox_builder_sessions.find(x => x.id === first.next_session_id);
  const m = monthly();
  const messages = [...next.messages];
  messages.at(-1).content.push({ type: 'text', text: 'Approved. Now set up the next job: Monthly win/loss report.' });
  messages.push({ role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_p2', name: 'propose_job', input: m }] });
  await saveBuilderSession(sb, { workspaceId: 'ws', sessionId: next.id, userId: 'owner', messages, proposal: m });
  const second = await approveBuilderProposal(sb, { workspaceId: 'ws', revboxId: 'box', userId: 'owner', sessionId: next.id });
  const edit = await openBuilderSessionForJob(sb, { workspaceId: 'ws', revboxId: 'box', userId: 'owner', jobId: second.routine.id });
  const cards = edit.history.filter(i => i.kind === 'proposal');
  assert.deepEqual(cards.map(c => [c.proposal.name, c.approved]), [['Closed deal analysis', true], ['Monthly win/loss report', true]]);
});
