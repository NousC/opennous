// Deal jobs run per deal (GET-881): an account's second won or lost deal runs too, one close runs a
// job once however many of its triggers it matches, the daily pass caps runs per job (with a
// workspace ceiling) instead of five for the whole workspace, jobs from before the change never
// re-run a deal their account-keyed run covered, and the AI step is told which deal it is about.
//
// Run: pnpm --filter @nous/core build && node --test packages/core/test/dealJobsPerDeal.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  runAutomationsForWorkspace, makeArtifactForTest, registerStepHandler, DEAL_PASS_LIMITS,
} from '../dist/services/automationRun.mjs';

// A Supabase stand-in: tables filtered by eq/in (a row without the column passes), every insert
// recorded; inserts into agent_routine_runs are readable afterwards (the dedupe lookup).
function fakeDb(tables) {
  const inserts = [];
  const reads = [];
  const from = (table) => {
    const filters = [];
    let op = null, payload = null;
    const rows = () => (tables[table] ?? []).filter(r => filters.every(([k, v, inList]) => !(k in r) || (inList ? v.includes(r[k]) : r[k] === v)));
    const q = new Proxy({}, {
      get(_t, prop) {
        if (prop === 'then') return (res) => { if (!op) reads.push({ table, filters: [...filters] }); return res({ data: op ? null : rows(), error: null }); };
        if (prop === 'maybeSingle' || prop === 'single') return async () => {
          if (op === 'insert') { inserts.push({ table, payload }); (tables[table] ??= []).push({ id: `run-${inserts.length}`, ...payload }); return { data: { id: `run-${inserts.length}` }, error: null }; }
          if (!op) reads.push({ table, filters: [...filters] });
          return { data: op ? null : rows()[0] ?? null, error: null };
        };
        if (prop === 'eq') return (k, v) => { filters.push([k, v]); return q; };
        if (prop === 'in') return (k, v) => { filters.push([k, v, true]); return q; };
        if (['insert', 'update', 'upsert'].includes(prop)) return (p) => { op = prop; payload = p; return q; };
        return () => q;
      },
    });
    return q;
  };
  return { from, inserts, reads };
}

const OLD = '2025-01-01T00:00:00Z';
const job = (id, trigger_kind, trigger_config = {}, extra = {}) => ({ id, workspace_id: 'w1', enabled: true, name: id, trigger_kind, trigger_config, steps: [], created_at: OLD, ...extra });
const WON_OR_LOST = { signal_keys: ['deal.won', 'deal.lost'], also: [{ kind: 'deal_closed_lost', config: {} }] };
const runKeys = (db) => db.inserts.filter(i => i.table === 'agent_routine_runs').map(i => i.payload.dedupe_key).sort();
const pass = (db, opts = {}) => runAutomationsForWorkspace(db, 'w1', '2026-10-01T00:00:00Z', opts);

test('two lost deals on one account both run, each under its own deal key', async () => {
  const db = fakeDb({
    agent_routines: [job('r1', 'deal_closed_won', WON_OR_LOST)],
    deal_outcomes: [
      { entity_id: 'a1', outcome: 'lost', closed_at: '2026-10-02T00:00:00Z', deal_id: 'd1' },
      { entity_id: 'a1', outcome: 'lost', closed_at: '2026-10-09T00:00:00Z', deal_id: 'd2' },
      { entity_id: 'a1', outcome: 'won', closed_at: '2026-10-10T00:00:00Z', deal_id: 'd3' },
    ],
    companies: [{ id: 'a1' }], observations: [], agent_routine_runs: [],
  });
  const out = await pass(db);
  assert.deepEqual(runKeys(db), ['r1:deal:d1:closed_lost', 'r1:deal:d2:closed_lost', 'r1:deal:d3:closed_won']);
  assert.equal(out.ran, 3);
  // The next pass finds every key taken and runs nothing.
  const before = db.inserts.length;
  await pass(db);
  assert.equal(db.inserts.filter(i => i.table === 'agent_routine_runs').length, db.inserts.slice(0, before).filter(i => i.table === 'agent_routine_runs').length);
});

test('a close matching won, lost and stage-move triggers runs a job once', async () => {
  const db = fakeDb({
    agent_routines: [
      job('r_all', 'deal_closed_won', { also: [{ kind: 'deal_closed_lost', config: {} }, { kind: 'deal_stage_changed', config: {} }] }),
      // A stage-move job with no outcome trigger still runs on the move, keyed by account as before.
      job('r_stage', 'deal_stage_changed'),
    ],
    deal_outcomes: [{ entity_id: 'a1', outcome: 'won', closed_at: '2026-10-10T00:00:00Z', deal_id: 'd1' }],
    // The same close, seen as a stage move on the account.
    observations: [
      { entity_id: 'a1', kind: 'state', property: 'pipeline_stage', value: 'proposal', observed_at: '2026-09-01T00:00:00Z' },
      { entity_id: 'a1', kind: 'state', property: 'pipeline_stage', value: 'closed_won', observed_at: '2026-10-10T00:00:00Z' },
    ],
    companies: [{ id: 'a1' }], contacts: [], agent_routine_runs: [],
  });
  await pass(db);
  assert.deepEqual(runKeys(db), ['r_all:deal:d1:closed_won', 'r_stage:a1:closed_won']);
});

test('more than five deals in a pass for one job all run, up to the per-job cap', async () => {
  const n = 9;
  const deals = Array.from({ length: n }, (_, i) => ({ entity_id: `a${i % 3}`, outcome: i % 2 ? 'won' : 'lost', closed_at: `2026-10-0${i + 1}T00:00:00Z`, deal_id: `d${i}` }));
  const db = fakeDb({
    agent_routines: [job('r1', 'deal_closed_won', WON_OR_LOST)],
    deal_outcomes: deals, companies: [{ id: 'a0' }, { id: 'a1' }, { id: 'a2' }], observations: [], agent_routine_runs: [],
  });
  const out = await pass(db);
  assert.equal(out.ran, n);
  assert.equal(runKeys(db).length, n);
});

test('a big backlog stops at the per-job cap, and several jobs stop at the workspace ceiling', async () => {
  const { perJob, perWorkspace } = DEAL_PASS_LIMITS;
  assert.ok(perJob > 5 && perWorkspace >= perJob, 'the limits are above the old five and the ceiling covers one job');
  const many = Array.from({ length: perWorkspace + 10 }, (_, i) => ({ entity_id: 'a1', outcome: 'won', closed_at: new Date(Date.parse('2026-01-01T00:00:00Z') + i * 3_600_000).toISOString(), deal_id: `d${i}` }));
  const one = fakeDb({ agent_routines: [job('r1', 'deal_closed_won')], deal_outcomes: many, companies: [{ id: 'a1' }], observations: [], agent_routine_runs: [] });
  await pass(one);
  assert.equal(runKeys(one).length, perJob);
  // Oldest first, so the backlog drains in the order things happened.
  assert.ok(runKeys(one).includes('r1:deal:d0:closed_won'));

  const jobs = Array.from({ length: Math.ceil(perWorkspace / perJob) + 1 }, (_, i) => job(`r${i}`, 'deal_closed_won'));
  const all = fakeDb({ agent_routines: jobs, deal_outcomes: many, companies: [{ id: 'a1' }], observations: [], agent_routine_runs: [] });
  await pass(all);
  assert.equal(runKeys(all).length, perWorkspace);
  for (const j of jobs) assert.ok(runKeys(all).filter(k => k.startsWith(`${j.id}:`)).length <= perJob);
});

test('a job made before per-deal keys never re-runs the deal its account-keyed run covered', async () => {
  const db = fakeDb({
    agent_routines: [job('r1', 'deal_closed_won', WON_OR_LOST)],
    deal_outcomes: [
      // Covered by the old run on 2026-10-05 (closed before it started): not run again.
      { entity_id: 'a1', outcome: 'lost', closed_at: '2026-10-02T00:00:00Z', deal_id: 'd1' },
      // A second loss on the same account after that run: new, runs under its deal key.
      { entity_id: 'a1', outcome: 'lost', closed_at: '2026-10-09T00:00:00Z', deal_id: 'd2' },
      // An account with no old run: runs.
      { entity_id: 'a2', outcome: 'lost', closed_at: '2026-10-03T00:00:00Z', deal_id: 'd3' },
      // The old run was for losses on a1; a win on a1 is a different key and runs.
      { entity_id: 'a1', outcome: 'won', closed_at: '2026-10-04T00:00:00Z', deal_id: 'd4' },
    ],
    companies: [{ id: 'a1' }, { id: 'a2' }], observations: [],
    agent_routine_runs: [{ id: 'old-1', routine_id: 'r1', dedupe_key: 'r1:a1:closed_lost', started_at: '2026-10-05T07:00:00Z', status: 'ok' }],
  });
  await pass(db);
  assert.deepEqual(runKeys(db), ['r1:deal:d2:closed_lost', 'r1:deal:d3:closed_lost', 'r1:deal:d4:closed_won']);
});

test('a deal that closed before the job existed is still skipped', async () => {
  const db = fakeDb({
    agent_routines: [job('r1', 'deal_closed_won', WON_OR_LOST, { created_at: '2026-10-05T00:00:00Z' })],
    deal_outcomes: [
      { entity_id: 'a1', outcome: 'lost', closed_at: '2026-10-02T00:00:00Z', deal_id: 'd1' },
      { entity_id: 'a1', outcome: 'lost', closed_at: '2026-10-09T00:00:00Z', deal_id: 'd2' },
    ],
    companies: [{ id: 'a1' }], observations: [], agent_routine_runs: [],
  });
  await pass(db);
  assert.deepEqual(runKeys(db), ['r1:deal:d2:closed_lost']);
});

test('the credit gate stops the pass before a run starts', async () => {
  registerStepHandler('credit_gate', async () => ({ allowed: false, reason: 'over_credit_limit' }));
  try {
    const db = fakeDb({
      agent_routines: [job('r1', 'deal_closed_won')],
      deal_outcomes: [{ entity_id: 'a1', outcome: 'won', closed_at: '2026-10-10T00:00:00Z', deal_id: 'd1' }],
      companies: [{ id: 'a1' }], observations: [], agent_routine_runs: [],
    });
    const out = await pass(db);
    assert.deepEqual(runKeys(db), []);
    assert.equal(out.ran, 0);
  } finally {
    registerStepHandler('credit_gate', undefined);
  }
});

test('the AI step is told which deal: its name, amount, stage, pipeline, close date and stage history', async () => {
  const db = fakeDb({
    companies: [{ id: 'a1', name: 'Account One', domain: 'one.test' }],
    deal_outcomes: [
      { entity_id: 'a1', deal_id: 'd1', outcome: 'lost', value_usd: 1000, opened_at: '2026-08-01T00:00:00Z', closed_at: '2026-09-01T00:00:00Z' },
      { entity_id: 'a1', deal_id: 'd2', outcome: 'lost', value_usd: 5000, opened_at: '2026-09-01T00:00:00Z', closed_at: '2026-10-09T00:00:00Z' },
    ],
    claims: [
      { entity_id: 'd1', property: 'name', value: { value: 'Pilot' } },
      { entity_id: 'd2', property: 'name', value: { value: 'Group rollout' } },
      { entity_id: 'd2', property: 'stage', value: { value: 'Closed Lost' } },
      { entity_id: 'd2', property: 'pipeline', value: 'Sales' },
      { entity_id: 'd2', property: 'value', value: 5000 },
      { entity_id: 'd2', property: 'currency', value: 'USD' },
      { entity_id: 'd2', property: 'close_date', value: '2026-10-09' },
    ],
    observations: [
      { entity_id: 'd2', kind: 'state', property: 'stage', value: 'Discovery', observed_at: '2026-09-02T00:00:00Z' },
      { entity_id: 'd2', kind: 'state', property: 'stage', value: 'Discovery', observed_at: '2026-09-05T00:00:00Z' },
      { entity_id: 'd2', kind: 'state', property: 'stage', value: 'Proposal', observed_at: '2026-09-20T00:00:00Z' },
      { entity_id: 'd2', kind: 'state', property: 'stage', value: 'Closed Lost', observed_at: '2026-10-09T00:00:00Z' },
    ],
  });
  const { material } = await makeArtifactForTest(db, 'w1', { entityId: 'a1', dealId: 'd2', stage: 'closed_lost', prompt: null, materialOnly: true });
  assert.equal(material.deal.name, 'Group rollout');
  assert.equal(material.deal.stage, 'Closed Lost');
  assert.equal(material.deal.pipeline, 'Sales');
  assert.equal(material.deal.closed, '2026-10-09');
  assert.equal(material.deal.value_usd, 5000);
  assert.deepEqual(material.deal.stage_history, [
    { stage: 'Discovery', on: '2026-09-02' }, { stage: 'Proposal', on: '2026-09-20' }, { stage: 'Closed Lost', on: '2026-10-09' },
  ]);
  // The other deal is background, named too.
  assert.deepEqual(material.other_deals_on_record.map(d => d.name), ['Pilot']);
});

test('the daily pass hands the AI step the deal that fired it', async () => {
  const db = fakeDb({
    agent_routines: [job('r1', 'deal_closed_won', WON_OR_LOST)],
    deal_outcomes: [{ entity_id: 'a1', outcome: 'lost', closed_at: '2026-10-09T00:00:00Z', deal_id: 'd2' }],
    companies: [{ id: 'a1' }], observations: [], agent_routine_runs: [], claims: [],
  });
  await pass(db);
  assert.ok(db.reads.some(r => r.table === 'claims' && r.filters.some(([k, v]) => k === 'entity_id' && v === 'd2')), 'the deal\'s own record is read for the write-up');
});
