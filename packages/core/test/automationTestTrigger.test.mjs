// Test on a deal trigger, and on a job's `also` triggers (GET-873 review): a won/lost job tests on
// the latest closed deal its owner can see, and a job on several triggers tests on the newest event
// of any of them.
//
// Run: pnpm --filter @nous/core build && node --test packages/core/test/automationTestTrigger.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { latestTestTrigger, testTriggers, startTestRun, registerStepHandler } from '../dist/services/automationRun.mjs';

const A1 = '00000000-0000-4000-8000-000000000001';
const A2 = '00000000-0000-4000-8000-000000000002';
const A3 = '00000000-0000-4000-8000-000000000003';

function database(seed = {}) {
  const tables = { agent_routines: [], agent_routine_runs: [], deal_outcomes: [], companies: [], observations: [], contacts: [], account_signals: [], ...seed };
  let seq = 0;
  class Query {
    constructor(table) { this.table = table; this.filters = []; this.sort = null; this.max = null; }
    select() { return this; }
    eq(k, v) { this.filters.push(r => r[k] === v); return this; }
    in(k, vs) { this.filters.push(r => vs.includes(r[k])); return this; }
    not(k, op, v) { this.filters.push(r => !(op === 'is' && v === null ? r[k] == null : r[k] === v)); return this; }
    gte(k, v) { this.filters.push(r => r[k] >= v); return this; }
    like() { return this; }
    order(k, o = {}) { this.sort ??= [k, o.ascending !== false]; return this; }
    limit(n) { this.max = n; return this; }
    range(a, b) { this.max = b - a + 1; return this; }
    insert(v) { this.insertValue = v; return this; }
    update(v) { this.updateValue = v; return this; }
    result(single) {
      const all = (tables[this.table] ??= []);
      if (this.insertValue) { const row = { id: `${this.table}-${++seq}`, ...structuredClone(this.insertValue) }; all.push(row); return { data: structuredClone(row), error: null }; }
      let values = all.filter(r => this.filters.every(f => f(r)));
      if (this.updateValue) for (const row of values) Object.assign(row, structuredClone(this.updateValue));
      if (this.sort) { const [k, asc] = this.sort; values = [...values].sort((a, b) => (asc ? 1 : -1) * (a[k] < b[k] ? -1 : a[k] > b[k] ? 1 : 0)); }
      if (this.max != null) values = values.slice(0, this.max);
      return { data: structuredClone(single ? values[0] ?? null : values), error: null };
    }
    maybeSingle() { return Promise.resolve(this.result(true)); }
    single() { return this.maybeSingle(); }
    then(ok, bad) { return Promise.resolve(this.result(false)).then(ok, bad); }
  }
  return { tables, from: t => new Query(t) };
}

const wonOrLost = { id: 'r-wl', workspace_id: 'ws', user_id: 'owner', name: 'Win/loss table', steps: [],
  trigger_kind: 'deal_closed_won', trigger_config: { signal_keys: ['deal.won', 'deal.lost'], also: [{ kind: 'deal_closed_lost', config: {} }] } };
const deals = () => ({
  companies: [{ id: A1, workspace_id: 'ws', name: 'Harborline' }, { id: A2, workspace_id: 'ws', name: 'Fernpoint' }, { id: A3, workspace_id: 'ws', name: 'Hidden Co' }],
  deal_outcomes: [
    { workspace_id: 'ws', entity_id: A1, deal_id: 'deal-1', outcome: 'won', closed_at: '2026-10-01T10:00:00Z' },
    { workspace_id: 'ws', entity_id: A2, deal_id: 'deal-2', outcome: 'lost', closed_at: '2026-10-08T10:00:00Z' },
    { workspace_id: 'ws', entity_id: A3, deal_id: 'deal-3', outcome: 'lost', closed_at: '2026-10-12T10:00:00Z' },
    { workspace_id: 'ws', entity_id: 'not-an-account', deal_id: 'deal-4', outcome: 'won', closed_at: '2026-10-13T10:00:00Z' },
  ],
});

test('a won-or-lost job tests on the latest closed deal its owner can see, lost included through `also`', async () => {
  registerStepHandler('visible_accounts', async ({ userId }) => (userId === 'owner' ? new Set([A1, A2]) : null));
  const sb = database(deals());
  const t = await latestTestTrigger(sb, 'ws', wonOrLost);
  assert.ok(t, 'a deal trigger');
  assert.equal(t.kind, 'deal_closed_lost');
  assert.equal(t.stage, 'closed_lost');
  assert.equal(t.entityId, A2);
  assert.equal(t.dealId, 'deal-2');
  assert.match(t.label, /Fernpoint/);
  // Won only: the latest win.
  const won = await latestTestTrigger(sb, 'ws', { ...wonOrLost, trigger_config: {} });
  assert.equal(won.entityId, A1);
  assert.equal(won.stage, 'closed_won');
  // The picker lists them, and a pick runs on that one.
  const list = await testTriggers(sb, 'ws', wonOrLost);
  assert.deepEqual(list.map(x => x.account?.name), ['Fernpoint', 'Harborline']);
  const picked = await latestTestTrigger(sb, 'ws', wonOrLost, list[1].id);
  assert.equal(picked.entityId, A1);
});

test('without the visibility handler no deal is assumed visible', async () => {
  registerStepHandler('visible_accounts', null);
  const sb = database(deals());
  assert.equal(await latestTestTrigger(sb, 'ws', wonOrLost), null);
});

test('a job on a call and on account signals (through `also`) tests on the newest of either', async () => {
  const sb = database({
    observations: [{ workspace_id: 'ws', kind: 'event', property: 'interaction.meeting_held', source: 'granola', entity_id: 'p1', observed_at: '2026-10-05T10:00:00Z', raw: { title: 'Pricing call' }, value: {} }],
    account_signals: [{ id: 'sig-1', workspace_id: 'ws', account_id: A1, team_readable: true, kind: 'churn_risk', content: 'Budget cut', occurred_at: '2026-10-09T10:00:00Z' }],
  });
  const routine = { id: 'r-cs', workspace_id: 'ws', user_id: 'owner', trigger_kind: 'call_ended', trigger_config: { tools: ['granola'], also: [{ kind: 'account_signal', config: { signals: ['churn_risk'] } }] }, steps: [] };
  const t = await latestTestTrigger(sb, 'ws', routine);
  assert.equal(t.kind, 'account_signal');
  assert.equal(t.signal.id, 'sig-1');
  sb.tables.observations[0].observed_at = '2026-10-11T10:00:00Z';
  assert.equal((await latestTestTrigger(sb, 'ws', routine)).kind, 'call_ended');
});

test('startTestRun starts a deal-triggered job instead of refusing it', async () => {
  registerStepHandler('visible_accounts', async () => null);
  const sb = database({ ...deals(), agent_routines: [wonOrLost] });
  const out = await startTestRun(sb, 'ws', 'r-wl', { holdSends: true });
  assert.equal(out.ok, true, out.message);
  // Everyone visible: the newest close is the lost deal (the row that is no account is skipped).
  assert.equal(out.trigger.kind, 'deal_closed_lost');
  assert.match(out.trigger.label, /Hidden Co.*closed lost/);
  const run = sb.tables.agent_routine_runs[0];
  assert.equal(run.state.held, true);
  for (let i = 0; i < 200 && run.status === 'running'; i++) await new Promise(res => setTimeout(res, 2));
});
