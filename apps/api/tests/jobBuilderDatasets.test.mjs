// The Job Builder and RevBox datasets (GET-874 follow-up), driven by a scripted model: no network, no
// database. One chat in a "Closed won/lost analysis" box sets up three jobs: on a deal won or lost,
// analyse it against the ICP and add a row to a table; then a monthly and a quarterly report that read
// that table. The builder proposes the table with the first job, and after each approval the chat
// continues in a new session (approve's next_session_id) to propose the next job.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { signalCatalog, validateBuilderProposal } from '@nous/core';
import { makeJobBuilder, collectTurn, turnInput } from '../src/lib/jobBuilder/index.mjs';
import { normalizeProposal } from '../src/lib/jobBuilder/loop.mjs';
import { runTool, TOOL_DEFS, statusLabel, memo } from '../src/lib/jobBuilder/tools.mjs';
import { buildSystemPrompt } from '../src/lib/jobBuilder/prompt.mjs';
import { makeRevboxBuilderRouter, approveBody } from '../src/routes/api/revboxBuilder.mjs';
import { makeRevboxesV2Router } from '../src/routes/v2/revboxes.mjs';

const BOX = '11111111-1111-4111-8111-111111111111';
const S1 = '22222222-2222-4222-8222-222222222222';
const S2 = '33333333-3333-4333-8333-333333333333';
const S3 = '55555555-5555-4555-8555-555555555555';
const S0 = '66666666-6666-4666-8666-666666666666';

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

const COLUMNS = [
  { key: 'deal', label: 'Deal', type: 'text' },
  { key: 'outcome', label: 'Outcome', type: 'enum', options: ['won', 'lost'] },
  { key: 'icp_fit', label: 'ICP fit', type: 'enum', options: ['strong', 'partial', 'weak'] },
  { key: 'reason', label: 'Main reason', type: 'text' },
];

// The box's datasets as the tool and validation read them; approve adds to it.
function helpers(tables) {
  return {
    connections: async () => [{ id: 'c1', slug: 'hubspot', label: 'HubSpot' }],
    revboxContext: async () => ({ box: { id: BOX, name: 'Closed won/lost analysis', objective: 'Learn why deals close.' }, context: [{ title: 'ICP', body: 'Mid-market lenders.' }], jobs: [] }),
    revboxBox: async () => ({ id: BOX, name: 'Closed won/lost analysis', delivery: [] }),
    slackTargets: async () => ({ connected: false, channels: [], people: [] }),
    mailboxes: async () => [],
    signalCatalog: async () => signalCatalog({ custom: [] }),
    datasets: async () => tables.map(d => ({ ...d, row_count: d.row_count ?? 0 })),
  };
}

// The engine: sessions in memory, the REAL validation, approve as core does it for datasets.
function engine(tables) {
  const sessions = new Map();
  const ids = [S1, S2, S3];
  const log = { validations: [], approvals: [] };
  let routines = 0;
  return {
    log, sessions,
    createBuilderSession: async (_sb, { revboxId, jobId }) => { const s = { id: ids.shift(), revbox_id: revboxId, job_id: jobId, messages: [], proposal: null, state: 'open' }; sessions.set(s.id, s); return s; },
    getBuilderSession: async (_sb, { sessionId }) => structuredClone(sessions.get(sessionId) ?? null),
    saveBuilderSession: async (_sb, { sessionId, messages, proposal }) => { const s = sessions.get(sessionId); if (messages !== undefined) s.messages = structuredClone(messages); if (proposal !== undefined) s.proposal = structuredClone(proposal); },
    listRevboxRoutines: async () => [],
    validateBuilderProposal: (proposal, v) => { log.validations.push({ proposal, ids: v }); return validateBuilderProposal(proposal, v); },
    approveBuilderProposal: async (_sb, args) => {
      log.approvals.push(args);
      const s = sessions.get(args.sessionId);
      s.state = 'approved';
      const created = [];
      for (const d of args.proposal.datasets ?? []) if (!tables.some(t => t.key === d.key)) { tables.push({ key: d.key, name: d.name, columns: d.columns }); created.push(d.key); }
      const out = { routine: { id: `r${++routines}`, name: args.proposal.name }, enabled: true, datasets: (args.proposal.datasets ?? []).map(d => ({ key: d.key, name: d.name, created: created.includes(d.key) })) };
      if (args.proposal.next_jobs?.length) {
        const next = { id: ids.shift(), revbox_id: BOX, job_id: null, state: 'open', proposal: null,
          messages: [...s.messages, { role: 'user', content: s.messages.at(-1).content.filter(b => b.type === 'tool_use').map(b => ({ type: 'tool_result', tool_use_id: b.id, content: 'The user approved this proposal; it is now a live job.' })) }] };
        sessions.set(next.id, next);
        out.next_session_id = next.id; out.next_jobs = args.proposal.next_jobs;
      }
      return out;
    },
  };
}

function builder(script, tables = []) {
  const client = scriptedClient(script);
  const metered = [];
  const eng = engine(tables);
  const b = makeJobBuilder({
    engine: eng, client, helpers: helpers(tables), gate: async () => {}, meter: async (m) => { metered.push(m); },
    model: { modelId: 'claude-sonnet-5', thinking: false }, costOf: () => 0.01, toCredits: (usd) => Math.ceil(usd / 0.02), today: '2026-10-14',
  });
  return { b, client, eng, metered, tables };
}

const base = { sb: {}, workspaceId: 'ws', userId: 'u1', revboxId: BOX };
async function turn(b, { sessionId = null, message, hints = null }) {
  const opened = await b.openSession({ ...base, sessionId });
  const events = [];
  for await (const e of b.runTurn({ ...base, ...opened, message, hints })) events.push(e);
  return events;
}

const ANALYSIS = {
  name: 'Closed deal analysis',
  summary: 'When a deal is won or lost: analyse it against the ICP and add a row to Win/loss deals.',
  trigger: { signal_key: 'deal.won', signal_keys: ['deal.won', 'deal.lost'], kind: 'deal_closed_won', config: { also: [{ kind: 'deal_closed_lost', config: {} }] }, label: 'When a deal is won or lost' },
  datasets: [{ key: 'win_loss_deals', name: 'Win/loss deals', description: 'One row per closed deal.', columns: COLUMNS }],
  steps: [
    { id: 'analyse', type: 'agent', config: { mode: 'write', model: 'opennous', prompt: 'Analyse this closed deal against our ICP: fit, main reason, what to repeat.' } },
    { id: 'row', type: 'dataset_append', config: { dataset_key: 'win_loss_deals', dedupe_from: 'deal' } },
  ],
  display: [{ step_id: 'analyse', tool: 'ai', title: 'Analyse the deal against the ICP' }, { step_id: 'row', tool: 'dataset_append', title: 'Add a row' }],
  next_jobs: ['Monthly win/loss report', 'Quarterly win/loss review'],
  estimated_credits_per_run: 2,
};
const REPORT = (name, frequency, window, next = []) => ({
  name, summary: `${name} from the closed deals table.`,
  trigger: { signal_key: 'schedule', kind: 'clock', config: { frequency, at: '08:00' }, timezone: 'UTC', label: `${frequency} at 08:00` },
  steps: [
    { id: 'rows', type: 'dataset_read', config: { dataset_key: 'win_loss_deals', window } },
    { id: 'report', type: 'agent', config: { mode: 'write', model: 'opennous', prompt: 'Write the win/loss report from {{steps.rows.output}}.' } },
  ],
  display: [{ step_id: 'rows', tool: 'dataset_read', title: 'Read the deals' }, { step_id: 'report', tool: 'ai', title: 'Write the report' }],
  uses_box_delivery: true,
  ...(next.length ? { next_jobs: next } : {}),
});

test('revbox_datasets lists the box\'s tables: key, name, columns and row count', async () => {
  const tables = [{ key: 'win_loss_deals', name: 'Win/loss deals', description: 'One row per closed deal.', columns: COLUMNS, row_count: 12, id: 'x', created_by: 'u9' }];
  const h = helpers(tables);
  const out = await runTool('revbox_datasets', {}, { helpers: h, ctx: base, cached: memo(h, base) });
  assert.deepEqual(out.result.datasets, [{ key: 'win_loss_deals', name: 'Win/loss deals', description: 'One row per closed deal.', columns: COLUMNS.map(c => ({ key: c.key, label: c.label, type: c.type, ...(c.options ? { options: c.options } : {}) })), row_count: 12 }]);
  assert.equal(out.summary, '1 table: Win/loss deals (12 rows)');
  const none = await runTool('revbox_datasets', {}, { helpers: helpers([]), ctx: base, cached: memo(helpers([]), base) });
  assert.equal(none.summary, 'No tables yet');
  assert.ok(TOOL_DEFS.some(t => t.name === 'revbox_datasets'));
  assert.equal(statusLabel('revbox_datasets'), 'Reading this box\'s tables…');
  // propose_job's schema carries the tables and the jobs still to set up.
  const props = TOOL_DEFS.find(t => t.name === 'propose_job').input_schema.properties;
  assert.ok(props.datasets && props.next_jobs);
});

test('normalizeProposal keeps the proposed tables and the jobs still to set up, capped', () => {
  const p = normalizeProposal({ ...ANALYSIS, next_jobs: ['A', '', 'B', 'C', 'D', 'E', 'F'], datasets: [...Array(8)].map((_, i) => ({ key: `t${i}`, name: `T${i}`, columns: COLUMNS })) });
  assert.deepEqual(p.next_jobs, ['A', 'B', 'C', 'D', 'E']);
  assert.equal(p.datasets.length, 5);
  assert.equal('datasets' in normalizeProposal({ ...ANALYSIS, datasets: undefined }), false);
  assert.equal('next_jobs' in normalizeProposal({ ...ANALYSIS, next_jobs: [] }), false);
});

test('the prompt: a table for "keep a log of closed deals", report jobs chained with dataset_read', () => {
  const s = buildSystemPrompt({ today: '2026-10-14' });
  assert.match(s, /revbox_datasets/);
  assert.match(s, /dataset_append/);
  assert.match(s, /dataset_read/);
  assert.match(s, /next_jobs/);
  assert.match(s, /keep a log/i);
  assert.match(s, /never ask for a time/i);
});

test('one chat: the analysis job with its table, then the monthly and the quarterly report, each approved in turn', async () => {
  const script = [
    // Turn 1: look at the box and its tables, settle the two signals, propose job 1 with its table.
    reply([{ type: 'text', text: 'Reading the box.' }, use('revbox_context', {}), use('revbox_datasets', {})]),
    reply([use('set_trigger', { signals: ['deal.won', 'deal.lost'] })]),
    reply([use('propose_job', ANALYSIS)]),
    // Turn 2 (continued session): the monthly report on the table just created.
    reply([use('revbox_datasets', {})]),
    reply([use('propose_job', REPORT('Monthly win/loss report', 'monthly', 'last_month', ['Quarterly win/loss review']))]),
    // Turn 3: the quarterly review.
    reply([use('propose_job', REPORT('Quarterly win/loss review', 'quarterly', 'last_quarter'))]),
  ];
  const { b, client, eng, metered, tables } = builder(script);

  const t1 = await turn(b, { message: 'Analyse every closed deal against our ICP into a table, then a monthly and a quarterly win/loss report.' });
  const tool = t1.find(e => e.type === 'tool' && e.name === 'revbox_datasets' && e.state === 'done');
  assert.equal(tool.summary, 'No tables yet');
  // Event job: no ask about time happened, and the proposal is on both signals.
  assert.equal(t1.some(e => e.type === 'ask'), false);
  const p1 = t1.find(e => e.type === 'proposal').proposal;
  assert.deepEqual(p1.trigger.signal_keys, ['deal.won', 'deal.lost']);
  assert.deepEqual(p1.datasets.map(d => d.key), ['win_loss_deals']);
  assert.deepEqual(p1.next_jobs, ['Monthly win/loss report', 'Quarterly win/loss review']);
  const f1 = p1.facts.find(f => f.step_id === 'row');
  assert.equal(f1.new_dataset, true);
  assert.equal(f1.dataset, 'Win/loss deals');
  // Validation knew the box had no tables yet.
  assert.deepEqual(eng.log.validations[0].ids.datasets, []);

  const a1 = await b.approve({ ...base, sessionId: S1 });
  assert.equal(a1.next_session_id, S2);
  assert.deepEqual(tables.map(t => t.key), ['win_loss_deals']);

  // The chat continues in the new session: the next turn's transcript carries the approval.
  const t2 = await turn(b, { sessionId: S2, message: 'Approved. Now set up the next job: Monthly win/loss report.' });
  const sent = client.calls[3].messages;
  assert.match(JSON.stringify(sent), /The user approved this proposal/);
  assert.match(sent.at(-1).content.at(-1).text, /Monthly win\/loss report/);
  assert.equal(t2.find(e => e.type === 'tool' && e.name === 'revbox_datasets' && e.state === 'done').summary, '1 table: Win/loss deals (0 rows)');
  const p2 = t2.find(e => e.type === 'proposal').proposal;
  assert.equal(p2.trigger.kind, 'clock');
  assert.equal(p2.facts.find(f => f.step_id === 'rows').new_dataset, false);
  assert.deepEqual(eng.log.validations.at(-1).ids.datasets.map(d => d.key), ['win_loss_deals']);
  const a2 = await b.approve({ ...base, sessionId: S2 });
  assert.equal(a2.next_session_id, S3);

  const t3 = await turn(b, { sessionId: S3, message: 'Approved. Now set up the next job: Quarterly win/loss review.' });
  assert.equal(t3.find(e => e.type === 'proposal').proposal.steps[0].config.window, 'last_quarter');
  const a3 = await b.approve({ ...base, sessionId: S3 });
  assert.equal(a3.next_session_id, undefined);
  assert.deepEqual(eng.log.approvals.map(a => a.proposal.name), ['Closed deal analysis', 'Monthly win/loss report', 'Quarterly win/loss review']);
  // Every model call of every turn was metered, once.
  assert.equal(metered.length, 6);
  assert.equal(new Set(metered.map(m => m.requestId)).size, 6);
});

test('a step on a table that neither exists nor is proposed goes back to the model, which proposes the table', async () => {
  const bad = { ...REPORT('Monthly win/loss report', 'monthly', 'last_month') };
  const fixed = { ...bad, datasets: [{ key: 'win_loss_deals', name: 'Win/loss deals', columns: COLUMNS }] };
  fixed.steps = [{ id: 'analyse', type: 'agent', config: { mode: 'write', prompt: 'x' } }, { id: 'row', type: 'dataset_append', config: { dataset_key: 'win_loss_deals' } }, ...bad.steps];
  fixed.display = [{ step_id: 'analyse', tool: 'ai', title: 'Analyse' }, { step_id: 'row', tool: 'dataset_append', title: 'Add' }, ...bad.display];
  const { b, client } = builder([reply([use('propose_job', bad)]), reply([use('propose_job', fixed)])]);
  const events = await turn(b, { message: 'Monthly report from the deals table' });
  const err = client.calls[1].messages.at(-1).content[0];
  assert.equal(err.is_error, true);
  assert.match(err.content, /no table "win_loss_deals"/);
  assert.ok(events.some(e => e.type === 'proposal'));
});

test('approve passes the chain and the tables through, on the app route and /v2', async () => {
  assert.deepEqual(approveBody({ routine: { id: 'r1' }, enabled: true, next_session_id: S2, next_jobs: ['Monthly'], datasets: [{ key: 'k', name: 'K', created: true }] }),
    { routine: { id: 'r1' }, enabled: true, next_session_id: S2, next_jobs: ['Monthly'], datasets: [{ key: 'k', name: 'K', created: true }] });
  assert.equal('next_session_id' in approveBody({ routine: { id: 'r1' } }), false);

  const { b, eng } = builder([]);
  eng.sessions.set(S0, { id: S0, revbox_id: BOX, job_id: null, state: 'open', proposal: ANALYSIS, messages: [{ role: 'user', content: 'x' }, { role: 'assistant', content: [{ type: 'tool_use', id: 'p', name: 'propose_job', input: ANALYSIS }] }] });
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { Object.assign(req, { workspaceId: 'ws', internalUserId: 'u1', memberUserId: 'u1' }); next(); });
  app.use('/api/revboxes', makeRevboxBuilderRouter({ builder: b, getSb: () => ({}) }));
  app.use('/v2/revboxes', makeRevboxesV2Router({ getSb: () => ({}), builder: () => ({ ...b, turnInput, collectTurn }) }));
  const server = http.createServer(app);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const r = await fetch(`${url}/api/revboxes/${BOX}/builder/${S0}/approve`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const body = await r.json();
    assert.ok(body.next_session_id);
    assert.deepEqual(body.next_jobs, ANALYSIS.next_jobs);
    assert.deepEqual(body.datasets, [{ key: 'win_loss_deals', name: 'Win/loss deals', created: true }]);
    eng.sessions.get(S0).state = 'open';
    const v2 = await fetch(`${url}/v2/revboxes/${BOX}/jobs/builder/${S0}/approve`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const vb = await v2.json();
    assert.ok(vb.next_session_id && vb.next_session_id !== body.next_session_id);
    assert.deepEqual(vb.datasets, [{ key: 'win_loss_deals', name: 'Win/loss deals', created: false }]);
  } finally { await new Promise(r => server.close(r)); }
});
