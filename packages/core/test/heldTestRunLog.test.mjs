// GET-879: a held Test of a clock job (Run now through startTestRun) keeps every held send in its
// step log, even when the step-by-step progress writes land after the run's final write.
//
// Run: pnpm --filter @nous/core build && node --test packages/core/test/heldTestRunLog.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestRun, registerStepHandler } from '../dist/services/automationRun.mjs';

/** In-memory Supabase. `slowLog[n]`: how late the n-th progress write (an update of step_log alone)
 *  lands, as a network write issued earlier can commit after one issued later. */
function database(seed = {}, { slowLog = [] } = {}) {
  let logWrites = 0;
  const tables = { agent_routines: [], agent_routine_runs: [], documents: [], workspace_members: [], revboxes: [], revbox_members: [], revbox_context: [], ...seed };
  let seq = 0;
  class Query {
    constructor(table) { this.table = table; this.filters = []; }
    select() { return this; } order() { return this; } limit() { return this; } range() { return this; }
    like() { return this; } gte() { return this; } not() { return this; } is() { return this; }
    eq(k, v) { this.filters.push(r => r[k] === v); return this; }
    neq(k, v) { this.filters.push(r => r[k] !== v); return this; }
    in(k, vs) { this.filters.push(r => vs.includes(r[k])); return this; }
    insert(v) { this.insertValue = v; return this; }
    upsert(v) { this.insertValue = v; return this; }
    update(v) { this.updateValue = v; return this; }
    result(single) {
      const all = (tables[this.table] ??= []);
      if (this.insertValue) { const row = { id: `${this.table}-${++seq}`, ...structuredClone(this.insertValue) }; all.push(row); return { data: structuredClone(row), error: null }; }
      let values = all.filter(r => this.filters.every(f => f(r)));
      if (this.updateValue) for (const row of values) Object.assign(row, structuredClone(this.updateValue));
      return { data: structuredClone(single ? values[0] ?? null : values), error: null };
    }
    run(single) {
      const progress = this.updateValue && this.table === 'agent_routine_runs' && Object.keys(this.updateValue).join() === 'step_log';
      const late = progress ? slowLog[logWrites++] ?? 0 : 0;
      return late ? new Promise(res => setTimeout(() => res(this.result(single)), late)) : Promise.resolve(this.result(single));
    }
    maybeSingle() { return this.run(true); }
    single() { return this.maybeSingle(); }
    then(ok, bad) { return this.run(false).then(ok, bad); }
  }
  return { tables, from: t => new Query(t), rpc: async () => ({ data: null, error: null }) };
}

const box = () => ({
  workspace_members: [{ workspace_id: 'ws', user_id: 'owner', role: 'admin' }],
  revboxes: [{ id: 'box', workspace_id: 'ws', owner_id: 'owner', shared: true, name: 'Ops box', objective: 'Keep the team informed.', blocks: [],
    delivery: [{ id: 'd-s', kind: 'slack', target: 'C0BOX', channel: 'box-out' }] }],
});
const dailyReport = (steps) => ({
  id: 'r-daily', workspace_id: 'ws', revbox_id: 'box', user_id: 'owner', name: 'Daily report', enabled: true,
  trigger_kind: 'clock', trigger_config: { frequency: 'daily', at: '08:00' }, timezone: 'UTC', steps,
});
const settle = async (run) => { for (let i = 0; i < 500 && run.status === 'running'; i++) await new Promise(r => setTimeout(r, 5)); await new Promise(r => setTimeout(r, 120)); };
/** What Results lists for a held test (the API's heldActions over the run's step log). */
const heldOf = (run) => (run.step_log ?? []).filter(e => e?.status === 'held').map(e => ({ step: e.name, text: e.detail }));

test('a held Test of a clock job logs the held Slack post after the AI step, and Results can list it', async () => {
  const sent = [];
  for (const h of ['slack', 'gmail_draft', 'gmail_send', 'smtp_send', 'safe_fetch']) registerStepHandler(h, async (...a) => { sent.push(h); return { ok: true, status: 'created' }; });
  try {
    const sb = database({ ...box(), agent_routines: [dailyReport([
      { id: 'summary', type: 'agent', config: { mode: 'write', prompt: 'Write the daily report.' } },
      { id: 'post', type: 'slack', config: { action: 'channel', channel_id: 'C0OPS', channel: 'ops-daily', format: 'report' } },
    // The AI step's progress write is the slow one: it lands after the Slack line and the final write.
    ])] }, { slowLog: [60] });
    const out = await startTestRun(sb, 'ws', 'r-daily', { holdSends: true });
    assert.equal(out.ok, true, out.message);
    const run = sb.tables.agent_routine_runs[0];
    await settle(run);
    assert.equal(run.status, 'ok');
    assert.equal(run.state?.held, true);
    assert.equal(run.state?.test, true);
    assert.deepEqual(run.step_log.map(l => [l.type, l.status]), [['agent', 'ok'], ['slack', 'held']]);
    assert.deepEqual(heldOf(run), [{ step: 'Slack', text: 'Would post to #ops-daily' }]);
    assert.equal(sent.length, 0);
  } finally {
    for (const h of ['slack', 'gmail_draft', 'gmail_send', 'smtp_send', 'safe_fetch']) registerStepHandler(h, null);
  }
});

test('every held send type on the clock path lands in the step log, in order', async () => {
  const sent = [];
  for (const h of ['slack', 'gmail_draft', 'gmail_send', 'smtp_send', 'safe_fetch']) registerStepHandler(h, async () => { sent.push(h); return { ok: true, status: 'created' }; });
  try {
    const sb = database({ ...box(), agent_routines: [dailyReport([
      { id: 'summary', type: 'agent', config: { mode: 'write', prompt: 'Write the daily report.' } },
      { id: 'post', type: 'slack', config: { action: 'channel', channel_id: 'C0OPS', channel: 'ops-daily', format: 'report' } },
      { id: 'mail', type: 'gmail', config: { to: 'lead@example.com', subject: 'Daily', body: '{{steps.summary.output}}', send_from: { id: 'mbx-1', email: 'me@example.com' } } },
      { id: 'hook', type: 'webhook', config: { url: 'https://hooks.example.com/x' } },
      { id: 'out', type: 'revbox_delivery', config: { format: 'digest' } },
    ])] }, { slowLog: [70, 50, 30, 10] });
    const out = await startTestRun(sb, 'ws', 'r-daily', { holdSends: true });
    assert.equal(out.ok, true, out.message);
    const run = sb.tables.agent_routine_runs[0];
    await settle(run);
    assert.equal(run.status, 'ok');
    assert.deepEqual(heldOf(run).map(h => h.text), [
      'Would post to #ops-daily', 'Would draft to lead@example.com', 'Would send to the webhook at hooks.example.com', 'Would deliver to Slack: #box-out',
    ]);
    assert.equal(sent.length, 0);
  } finally {
    for (const h of ['slack', 'gmail_draft', 'gmail_send', 'smtp_send', 'safe_fetch']) registerStepHandler(h, null);
  }
});
