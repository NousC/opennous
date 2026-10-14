// Review finding 1 on the RevBox Job Builder (GET-868): a RevBox job is an agent_routines row with
// revbox_id, managed only through /api/revboxes (which checks box access). /api/automations and
// /v2/workflows must not list it, read it, run it, edit it or delete it: any workspace member could
// otherwise read its steps and prompt, run it (reading the box as its owner), or change it.
// Ordinary automations are unchanged.
//
// The routes run for real against a small in-memory PostgREST stand-in, through the real
// supabase-js client. Nothing here reaches a real database.
//
// Run: node --test apps/api/tests/automationsBoxJobs.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { startFakePostgrest, serveApp, callJson } from './fakePostgrest.mjs';

const WS = 'ws-1';
const BOX_JOB = '11111111-1111-4111-8111-111111111111';
const PLAIN = '22222222-2222-4222-8222-222222222222';
const OTHER_BOX_JOB = '33333333-3333-4333-8333-333333333333';
const RUN = '44444444-4444-4444-8444-444444444444';
const OWNER = 'owner-1';

let tables;
// Who is calling /api/automations and /v2/approvals (member-1 unless a test says otherwise).
let caller = 'member-1';
const BOX_RUN = '55555555-5555-4555-8555-555555555555';
const SHARED_BOX_RUN = '66666666-6666-4666-8666-666666666666';
const PLAIN_WAITING = '77777777-7777-4777-8777-777777777777';
const waiting = (id, routine) => ({ id, workspace_id: WS, routine_id: routine, status: 'awaiting_approval', started_at: '2026-10-12', step_index: 0, document_id: null, step_log: [],
  state: { preview: { step: 'Step 1 · Approval', type: 'approval', rows: [['Output', routine === BOX_JOB ? 'SECRET box output' : 'plain output']] }, bundle: [], resume: { steps: [{ id: 'ap', type: 'approval', config: {} }], ctx: {} } } });
const seed = () => ({
  workspaces: [{ id: WS, team_id: 't1', open_account_visibility: true }],
  teams: [{ id: 't1', name: 'T' }],
  subscriptions: [],
  agent_routines: [
    { id: BOX_JOB, workspace_id: WS, user_id: OWNER, revbox_id: 'box-1', name: 'Box job', prompt: 'SECRET box prompt', trigger_kind: 'clock', enabled: true, steps: [{ id: 'a', type: 'agent', config: { prompt: 'SECRET box prompt' } }], draft: { name: 'x' }, version: 1, created_at: '2026-10-01' },
    { id: OTHER_BOX_JOB, workspace_id: WS, user_id: 'member-1', revbox_id: 'box-2', name: 'Box job 2', prompt: 'p', trigger_kind: 'deal_closed_won', enabled: true, steps: [], version: 1, created_at: '2026-10-02' },
    { id: PLAIN, workspace_id: WS, user_id: 'member-1', revbox_id: null, name: 'Plain', prompt: 'hello', trigger_kind: 'deal_closed_won', enabled: true, steps: [], draft: null, version: 1, created_at: '2026-10-03' },
  ],
  agent_routine_runs: [
    { id: RUN, workspace_id: WS, routine_id: PLAIN, status: 'ok', started_at: '2026-10-10' },
    waiting(BOX_RUN, BOX_JOB), waiting(SHARED_BOX_RUN, OTHER_BOX_JOB), waiting(PLAIN_WAITING, PLAIN),
  ],
  // box-1 is private (OWNER's, with an editor and a viewer); box-2 is shared with the team.
  revboxes: [
    { id: 'box-1', workspace_id: WS, owner_id: OWNER, shared: false, name: 'Private box', delivery: [], blocks: [] },
    { id: 'box-2', workspace_id: WS, owner_id: 'someone', shared: true, name: 'Shared box', delivery: [], blocks: [] },
  ],
  revbox_members: [
    { workspace_id: WS, revbox_id: 'box-1', user_id: 'editor-1', role: 'editor' },
    { workspace_id: WS, revbox_id: 'box-1', user_id: 'viewer-1', role: 'viewer' },
  ],
  workspace_members: ['member-1', 'editor-1', 'viewer-1', OWNER, 'someone'].map((u) => ({ workspace_id: WS, user_id: u, role: 'member' })),
  revbox_context: [],
  automation_versions: [{ routine_id: BOX_JOB, workspace_id: WS, version: 1, snapshot: { name: 'Box job', prompt: 'SECRET box prompt' } }],
});

before(async () => {
  tables = seed();
  pgrest = await startFakePostgrest(() => tables);
  const { automationsRouter } = await import('../src/routes/api/automations.mjs');
  const { workflowsV2Router } = await import('../src/routes/v2/workflows.mjs');
  const { approvalsV2Router } = await import('../src/routes/v2/approvals.mjs');
  const app = express();
  app.use(express.json());
  app.use('/api/automations', (req, _res, next) => { Object.assign(req, { workspaceId: WS, internalUserId: caller }); next(); }, automationsRouter);
  app.use('/v2/approvals', (req, _res, next) => { Object.assign(req, { workspaceId: WS, memberUserId: caller, viewerScope: 'member' }); next(); }, approvalsV2Router);
  // An admin key on /v2 (sees every workflow), and a member key under /v2m.
  app.use('/v2/workflows', (req, _res, next) => { Object.assign(req, { workspaceId: WS, memberUserId: 'member-1', viewerScope: 'admin' }); next(); }, workflowsV2Router);
  app.use('/v2m/workflows', (req, _res, next) => { Object.assign(req, { workspaceId: WS, memberUserId: 'member-1', viewerScope: 'member' }); next(); }, workflowsV2Router);
  server = await serveApp(app);
  baseUrl = server.url;
});
after(async () => {
  await server?.close();
  await pgrest?.close();
});

let server; let baseUrl; let pgrest;
const call = (method, path, body) => callJson(baseUrl, method, path, body);
const boxRow = () => tables.agent_routines.find((r) => r.id === BOX_JOB);

test('/api/automations lists ordinary automations only; the ladder still counts box jobs', async () => {
  tables = seed();
  const r = await call('GET', '/api/automations');
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.body.automations.map((a) => a.id), [PLAIN]);
  assert.doesNotMatch(r.text, /SECRET box prompt/);
  assert.equal(r.body.used, 3);   // automationLimitHit counts every row, box jobs included
});

test('/api/automations refuses every /:id route on a box job with 404 and changes nothing', async () => {
  tables = seed();
  const before = JSON.stringify(boxRow());
  for (const [method, path, body] of [
    ['PATCH', `/api/automations/${BOX_JOB}`, { enabled: false }],
    ['PATCH', `/api/automations/${BOX_JOB}`, { draft: { name: 'mine now' } }],
    ['PATCH', `/api/automations/${BOX_JOB}`, { name: 'renamed', prompt: 'leak the box', artifact: null }],
    ['POST', `/api/automations/${BOX_JOB}/publish`, {}],
    ['GET', `/api/automations/${BOX_JOB}/versions`],
    ['POST', `/api/automations/${BOX_JOB}/versions/1/restore`, {}],
    ['GET', `/api/automations/${BOX_JOB}/test-triggers`],
    ['POST', `/api/automations/${BOX_JOB}/test-run`, {}],
    ['POST', `/api/automations/${BOX_JOB}/test`, {}],
    ['DELETE', `/api/automations/${BOX_JOB}`],
  ]) {
    const r = await call(method, path, body);
    assert.equal(r.status, 404, `${method} ${path}: ${r.status} ${r.text}`);
    assert.doesNotMatch(r.text, /SECRET box prompt/, `${method} ${path}`);
  }
  assert.equal(JSON.stringify(boxRow()), before);
});

test('/api/automations still edits and deletes an ordinary automation', async () => {
  tables = seed();
  const p = await call('PATCH', `/api/automations/${PLAIN}`, { enabled: false });
  assert.equal(p.status, 200, p.text);
  assert.equal(p.body.enabled, false);
  const v = await call('GET', `/api/automations/${PLAIN}/versions`);
  assert.equal(v.status, 200, v.text);
  const d = await call('DELETE', `/api/automations/${PLAIN}`);
  assert.equal(d.status, 200, d.text);
  assert.equal(tables.agent_routines.some((r) => r.id === PLAIN), false);
  assert.ok(boxRow());
});

test('/v2/workflows lists ordinary workflows only, for an admin key and a member key', async () => {
  tables = seed();
  const a = await call('GET', '/v2/workflows');
  assert.equal(a.status, 200, a.text);
  assert.deepEqual(a.body.workflows.map((w) => w.id), [PLAIN]);
  const m = await call('GET', '/v2m/workflows');
  assert.equal(m.status, 200, m.text);
  assert.deepEqual(m.body.workflows.map((w) => w.id), [PLAIN]);   // member-1 owns OTHER_BOX_JOB too
});

test('/v2/workflows refuses every /:id route on a box job with 404 and changes nothing', async () => {
  tables = seed();
  const before = JSON.stringify(boxRow());
  for (const prefix of ['/v2/workflows', '/v2m/workflows']) {
    for (const id of [BOX_JOB, OTHER_BOX_JOB]) {
      for (const [method, suffix, body] of [
        ['GET', ''], ['GET', '/versions'], ['GET', '/runs'],
        ['PATCH', '', { enabled: false }], ['POST', '/duplicate', {}], ['POST', '/run', {}], ['DELETE', ''],
      ]) {
        const r = await call(method, `${prefix}/${id}${suffix}`, body);
        assert.equal(r.status, 404, `${method} ${prefix}/${id}${suffix}: ${r.status} ${r.text}`);
        assert.equal(r.body?.error, 'workflow_not_found');
      }
    }
  }
  assert.equal(JSON.stringify(boxRow()), before);
  assert.equal(tables.agent_routines.length, 3);   // no duplicate was made
});

test('/v2/workflows still reads, edits and deletes an ordinary workflow', async () => {
  tables = seed();
  const g = await call('GET', `/v2/workflows/${PLAIN}`);
  assert.equal(g.status, 200, g.text);
  assert.equal(g.body.workflow.id, PLAIN);
  const p = await call('PATCH', `/v2m/workflows/${PLAIN}`, { enabled: false });
  assert.equal(p.status, 200, p.text);
  const d = await call('DELETE', `/v2/workflows/${PLAIN}`);
  assert.equal(d.status, 200, d.text);
  assert.deepEqual(d.body, { deleted: true, id: PLAIN });
});

// ── Box-job runs and approvals (lead follow-up on finding 1) ─────────────────────

const runIds = (body) => body.runs.map((r) => r.id).sort();
const approvalIds = (body) => body.approvals.map((a) => a.run_id).sort();

test('an outsider sees no run of a private box job, in History, Approvals or by id, and cannot act on one', async () => {
  tables = seed(); caller = 'member-1';
  try {
    const h = await call('GET', '/api/automations/runs');
    assert.equal(h.status, 200, h.text);
    assert.deepEqual(runIds(h.body), [RUN, SHARED_BOX_RUN, PLAIN_WAITING].sort());   // box-2 is shared: a viewer
    assert.equal(h.body.stats.runs, 3);                                             // the stats leave it out too
    const a = await call('GET', '/api/automations/approvals');
    assert.equal(a.status, 200, a.text);
    assert.deepEqual(approvalIds(a.body), [SHARED_BOX_RUN, PLAIN_WAITING].sort());
    assert.doesNotMatch(a.text, /SECRET box output/);
    const v2 = await call('GET', '/v2/approvals');
    assert.deepEqual(approvalIds(v2.body), [SHARED_BOX_RUN, PLAIN_WAITING].sort());
    for (const [method, path] of [
      ['GET', `/api/automations/runs/${BOX_RUN}`],
      ['POST', `/api/automations/runs/${BOX_RUN}/send-email`],
      ['POST', `/api/automations/approvals/${BOX_RUN}/choices`],
      ['POST', `/api/automations/approvals/${BOX_RUN}/approve`],
      ['POST', `/api/automations/approvals/${BOX_RUN}/reject`],
      ['POST', `/v2/approvals/${BOX_RUN}/approve`],
      ['POST', `/v2/approvals/${BOX_RUN}/reject`],
    ]) {
      const r = await call(method, path, method === 'POST' ? {} : undefined);
      assert.equal(r.status, 404, `${method} ${path}: ${r.status} ${r.text}`);
      assert.doesNotMatch(r.text, /SECRET box output/);
    }
    assert.equal(tables.agent_routine_runs.find((r) => r.id === BOX_RUN).status, 'awaiting_approval');
  } finally { caller = 'member-1'; }
});

test('a box viewer sees the run but cannot approve, reject or send from it', async () => {
  tables = seed(); caller = 'viewer-1';
  try {
    const h = await call('GET', '/api/automations/runs');
    assert.ok(runIds(h.body).includes(BOX_RUN));
    const a = await call('GET', '/api/automations/approvals');
    assert.ok(approvalIds(a.body).includes(BOX_RUN));
    const one = await call('GET', `/api/automations/runs/${BOX_RUN}`);
    assert.equal(one.status, 200, one.text);
    for (const path of [`/api/automations/approvals/${BOX_RUN}/approve`, `/api/automations/approvals/${BOX_RUN}/reject`,
      `/api/automations/approvals/${BOX_RUN}/choices`, `/api/automations/runs/${BOX_RUN}/send-email`, `/v2/approvals/${BOX_RUN}/approve`]) {
      const r = await call('POST', path, {});
      assert.equal(r.status, 403, `${path}: ${r.status} ${r.text}`);
      assert.equal(r.body.error, 'box_edit_required');
    }
    // A shared box gives every member a viewer's rights: seen, not decided.
    caller = 'member-1';
    assert.equal((await call('POST', `/api/automations/approvals/${SHARED_BOX_RUN}/approve`, {})).status, 403);
    assert.equal(tables.agent_routine_runs.find((r) => r.id === BOX_RUN).status, 'awaiting_approval');
  } finally { caller = 'member-1'; }
});

test('a box editor sees the run and approves it from Priorities; the owner rejects one over /v2', async () => {
  tables = seed(); caller = 'editor-1';
  try {
    const a = await call('GET', '/api/automations/approvals');
    assert.ok(approvalIds(a.body).includes(BOX_RUN));
    const ok = await call('POST', `/api/automations/approvals/${BOX_RUN}/approve`, {});
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.body.ok, true);
    assert.notEqual(tables.agent_routine_runs.find((r) => r.id === BOX_RUN).status, 'awaiting_approval');
    tables = seed(); caller = OWNER;
    const rej = await call('POST', `/v2/approvals/${BOX_RUN}/reject`, {});
    assert.equal(rej.status, 200, rej.text);
    assert.equal(tables.agent_routine_runs.find((r) => r.id === BOX_RUN).status, 'rejected');
  } finally { caller = 'member-1'; }
});

test('ordinary runs and approvals are unchanged for any member', async () => {
  tables = seed(); caller = 'viewer-1';
  try {
    const one = await call('GET', `/api/automations/runs/${RUN}`);
    assert.equal(one.status, 200, one.text);
    const rej = await call('POST', `/api/automations/approvals/${PLAIN_WAITING}/reject`, {});
    assert.equal(rej.status, 200, rej.text);
    assert.equal(tables.agent_routine_runs.find((r) => r.id === PLAIN_WAITING).status, 'rejected');
    const missing = await call('GET', '/api/automations/runs/88888888-8888-4888-8888-888888888888');
    assert.equal(missing.status, 404);
  } finally { caller = 'member-1'; }
});

// ── Usage (lead follow-up): GET /api/automations/credits ─────────────────────────

test('credits: box jobs the caller cannot see are one "Private RevBox jobs" line, and the total is unchanged', async () => {
  const now = new Date().toISOString();
  const usage = (runId, usd) => ({ workspace_id: WS, request_id: `automation-run:${runId}:step:1`, cost_usd: usd, occurred_at: now });
  const withUsage = () => {
    const t = seed();
    const OTHER_PRIVATE_RUN = '99999999-9999-4999-8999-999999999999';
    t.agent_routines.push({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', workspace_id: WS, user_id: OWNER, revbox_id: 'box-1', name: 'Second private job', steps: [], created_at: '2026-10-04' });
    t.agent_routine_runs.push({ id: OTHER_PRIVATE_RUN, workspace_id: WS, routine_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', status: 'ok', started_at: '2026-10-11' });
    // $0.012 → 3 credits, $0.02 → 4, $0.005 → 1, $0.03 → 6 (one credit per $0.005, rounded up per automation).
    t.llm_usage = [usage(BOX_RUN, 0.012), usage(OTHER_PRIVATE_RUN, 0.02), usage(SHARED_BOX_RUN, 0.005), usage(RUN, 0.03)];
    return t;
  };
  const total = (body) => body.automations.reduce((n, a) => n + a.credits, 0);

  tables = withUsage(); caller = 'member-1';
  try {
    const out = await call('GET', '/api/automations/credits');
    assert.equal(out.status, 200, out.text);
    assert.doesNotMatch(out.text, /Box job"|Second private job/);
    const priv = out.body.automations.filter((a) => a.name === 'Private RevBox jobs');
    assert.equal(priv.length, 1);
    assert.deepEqual({ ...priv[0] }, { routine_id: null, name: 'Private RevBox jobs', runs: null, credits: 7, private: true });
    assert.ok(out.body.automations.some((a) => a.routine_id === PLAIN && a.credits === 6));
    assert.ok(out.body.automations.some((a) => a.routine_id === OTHER_BOX_JOB && a.name === 'Box job 2'));   // shared: seen
    assert.equal(total(out.body), 3 + 4 + 1 + 6);

    // A box member sees the jobs by name, and the same total.
    caller = 'viewer-1';
    const mine = await call('GET', '/api/automations/credits');
    assert.equal(mine.body.automations.some((a) => a.name === 'Private RevBox jobs'), false);
    assert.ok(mine.body.automations.some((a) => a.routine_id === BOX_JOB && a.credits === 3));
    assert.equal(total(mine.body), total(out.body));
  } finally { caller = 'member-1'; }
});
