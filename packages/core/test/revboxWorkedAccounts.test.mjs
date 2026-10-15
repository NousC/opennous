// The accounts a RevBox works on (GET-891): its selected scope, plus the accounts its jobs worked on
// (run entities, deals as their company, table rows, and account names a HubSpot read or a report
// states, resolved by exact normalized name), only the ones the viewer may see.
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAccountName, accountNamesInText, resolveAccountNames } from '../src/db/accountNames.mjs';
import { revboxWorkedAccounts, revboxRunAccounts } from '../src/db/revboxes.mjs';

const NOW = Date.parse('2026-10-14T12:00:00Z');
const ago = (days) => new Date(NOW - days * 86_400_000).toISOString();

/** An in-memory stand-in for the supabase-js query builder: eq, in, gte, or(name.ilike.*a*b*), range. */
function database(tables) {
  const reads = [], writes = [], resolves = [];
  class Query {
    constructor(table) { this.table = table; this.filters = []; reads.push(table); }
    select(cols) { this.cols = cols; return this; } order() { return this; } limit() { return this; }
    update(patch) { this.patch = patch; writes.push({ table: this.table, patch }); return this; }
    range(a, b) { this.window = [a, b]; return this; }
    eq(k, v) { this.filters.push(r => r[k] === v); return this; }
    in(k, vs) { this.filters.push(r => vs.includes(r[k])); return this; }
    gte(k, v) { this.filters.push(r => String(r[k] ?? '') >= v); return this; }
    or(expr) {
      resolves.push(expr);
      const pats = expr.split(',').map(p => { const m = p.match(/^(\w+)\.ilike\.(.*)$/); return { col: m[1], re: new RegExp(`^${m[2].split('*').map(x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 'i') }; });
      this.filters.push(r => pats.some(p => p.re.test(String(r[p.col] ?? ''))));
      return this;
    }
    result(single) {
      let values = (tables[this.table] ?? []).filter(r => this.filters.every(f => f(r)));
      if (this.patch) { for (const r of values) Object.assign(r, structuredClone(this.patch)); return { data: null, error: null }; }
      if (this.window) values = values.slice(this.window[0], this.window[1] + 1);
      // A JSON path column (`alias:col->key`), as PostgREST selects it.
      const paths = [...String(this.cols ?? '').matchAll(/(\w+):(\w+)->(\w+)/g)];
      if (paths.length) values = values.map(r => Object.assign({ ...r }, ...paths.map(([, as, col, key]) => ({ [as]: r[col]?.[key] ?? null }))));
      return { data: structuredClone(single ? values[0] ?? null : values), error: null };
    }
    maybeSingle() { return Promise.resolve(this.result(true)); } single() { return this.maybeSingle(); }
    then(ok, ko) { return Promise.resolve(this.result(false)).then(ok, ko); }
  }
  return { tables, reads, writes, resolves, from: t => new Query(t) };
}

const acct = (id, name, extra = {}) => ({ workspace_id: 'ws', entity_id: id, kind: 'account', name, domain: null, company_id: null, icp_score: 50, last_activity_at: null, people_count: 1, ...extra });
const world = () => ({
  workspace_members: [{ workspace_id: 'ws', user_id: 'owner' }],
  revboxes: [{ id: 'box', workspace_id: 'ws', owner_id: 'owner', shared: false, name: 'Daily account report', revision: 1, scope: { mode: 'selected', account_ids: ['acct-sel', 'acct-a'], min_icp: 70 } }],
  revbox_members: [],
  agent_routines: [{ id: 'job', workspace_id: 'ws', revbox_id: 'box' }, { id: 'other-job', workspace_id: 'ws', revbox_id: 'other' }],
  agent_routine_runs: [
    // A run on an account, and one on a deal (its company counts).
    { id: 'r1', workspace_id: 'ws', routine_id: 'job', started_at: ago(1), entity_id: 'acct-a', document_id: null, step_log: [] },
    { id: 'r2', workspace_id: 'ws', routine_id: 'job', started_at: ago(2), entity_id: 'deal-1', document_id: null, step_log: [] },
    // A HubSpot read recorded since GET-891: the accounts it resolved are on its line.
    { id: 'r3', workspace_id: 'ws', routine_id: 'job', started_at: ago(1), entity_id: null, document_id: null,
      step_log: [{ step: 1, type: 'hubspot', status: 'ok', accounts: ['acct-read'], accounts_unmatched: 1 }, { step: 2, type: 'agent', status: 'ok', document_id: 'doc-new', accounts: [] }] },
    // From before GET-891: a report with a table of names and no links, read now.
    { id: 'r4', workspace_id: 'ws', routine_id: 'job', started_at: ago(3), entity_id: null, document_id: null,
      step_log: [{ step: 1, type: 'hubspot', status: 'ok' }, { step: 2, type: 'agent', status: 'ok', document_id: 'doc-old' }] },
    { id: 'old', workspace_id: 'ws', routine_id: 'job', started_at: ago(45), entity_id: 'acct-stale', document_id: null, step_log: [] },
    { id: 'else', workspace_id: 'ws', routine_id: 'other-job', started_at: ago(1), entity_id: 'acct-stale', document_id: null, step_log: [] },
  ],
  revbox_runs: [],
  documents: [
    { id: 'doc-new', workspace_id: 'ws', subject_entity_id: null, title: 'Daily report', body_md: '| Account | Scored |\n|---|---|\n| Not Resolved Again | 1 |' },
    { id: 'doc-old', workspace_id: 'ws', subject_entity_id: null, title: 'Daily report',
      body_md: 'Records, 2026-10-13: 4 with activity.\nName | Pulls | Sold\nHarborline Labs Inc. | 12 (+2) | 1\nfernpoint health, ltd | 3 | 0\nUnknown Company Group | 2 | 0\nTwin Name | 1 | 0\nRecord 77 (no name) | 1 | 0\nTotal | 19 | 1' },
  ],
  document_links: [],
  revbox_datasets: [{ id: 'ds', workspace_id: 'ws', revbox_id: 'box' }],
  revbox_dataset_rows: [
    { id: 'row1', workspace_id: 'ws', dataset_id: 'ds', entity_id: 'deal-2', created_at: ago(4) },
    { id: 'row2', workspace_id: 'ws', dataset_id: 'ds', entity_id: null, created_at: ago(4) },
    { id: 'row3', workspace_id: 'ws', dataset_id: 'ds', entity_id: 'acct-stale', created_at: ago(60) },
  ],
  entity_list_rows: [
    acct('acct-sel', 'Selected Co'), acct('acct-a', 'Northside Labs'), acct('acct-read', 'Lakeshore Health'),
    acct('acct-harbor', 'Harborline Labs'), acct('acct-fern', 'Fernpoint Health'), acct('acct-stale', 'Old Account'),
    acct('acct-deal', 'Deal Holder'), acct('acct-tab', 'Table Holder'), acct('acct-hidden', 'Hidden Co'),
    acct('twin-1', 'Twin Name'), acct('twin-2', 'Twin Name Inc'),
    { workspace_id: 'ws', entity_id: 'deal-1', kind: 'deal', name: 'Renewal', company_id: 'acct-deal' },
    { workspace_id: 'ws', entity_id: 'deal-2', kind: 'deal', name: 'Expansion', company_id: 'acct-tab' },
  ],
});

test('names normalize: case, punctuation and a trailing legal suffix set aside, nothing looser', () => {
  assert.equal(normalizeAccountName('Harborline Labs, Inc.'), 'harborline labs');
  assert.equal(normalizeAccountName("fernpoint HEALTH ltd"), 'fernpoint health');
  assert.equal(normalizeAccountName('Co'), 'co');                       // a name that is only a suffix stays
  assert.notEqual(normalizeAccountName('Harborline'), normalizeAccountName('Harborline Labs'));
});

test('a report states names in its tables, in bold and in its title lead; headers, totals and unnamed rows are not names', () => {
  const text = '## Summary\n**Lumen Freight** led the day.\n\n| Account | Scored |\n|---|---:|\n| Harborline Labs | 4 (+1) |\n| Total | 4 |\n\nName | Pulls\nFernpoint Health | 3\nRecord 9 (no name) | 1';
  assert.deepEqual(accountNamesInText(text, 'Cobalt Systems — closed lost').sort(), ['Cobalt Systems', 'Fernpoint Health', 'Harborline Labs', 'Lumen Freight']);
  assert.deepEqual(accountNamesInText('Plain prose naming Harborline Labs is not scanned.', 'Monthly report'), []);
});

test('names resolve by exact normalized match only: unmatched skipped and counted, a name two accounts carry is ambiguous', async () => {
  const sb = database(world());
  const r = await resolveAccountNames(sb, 'ws', ['HARBORLINE LABS', 'Fernpoint Health Ltd.', 'Harborline', 'Unknown Company Group', 'Twin Name']);
  assert.deepEqual(r.ids.sort(), ['acct-fern', 'acct-harbor']);
  assert.deepEqual(r.unmatched, ['Harborline', 'Unknown Company Group']);   // "Harborline" is not "Harborline Labs"
  assert.deepEqual(r.ambiguous, ['Twin Name']);
});

test('worked accounts: the selected scope and what the jobs worked on, deduped, deals as their company, last 30 days', async () => {
  const sb = database(world());
  const out = await revboxWorkedAccounts(sb, 'ws', 'owner', 'box', null, { now: NOW });
  const ids = out.accounts.map(a => a.id).sort();
  assert.deepEqual(ids, ['acct-a', 'acct-deal', 'acct-fern', 'acct-harbor', 'acct-read', 'acct-sel', 'acct-tab']);
  assert.deepEqual(out.breakdown, { selected: 2, worked_on: 6 });   // acct-a is both: counted once in the union
  assert.equal(out.accounts.find(a => a.id === 'acct-a').selected, true);
  assert.equal(out.accounts.find(a => a.id === 'acct-a').worked_on, true);
  assert.deepEqual(out.names, { matched: 2, unmatched: 1, ambiguous: 1 });   // from the old report, read now
  assert.equal(out.days, 30);
  // Not the 45-day-old run, not another box's job, not a 60-day-old table row, not the ambiguous twins.
  for (const id of ['acct-stale', 'twin-1', 'twin-2']) assert.ok(!ids.includes(id));
});

test('worked accounts are the viewer-visible ones only', async () => {
  const sb = database(world());
  const out = await revboxWorkedAccounts(sb, 'ws', 'owner', 'box', new Set(['acct-a', 'acct-harbor', 'acct-tab']), { now: NOW });
  assert.deepEqual(out.accounts.map(a => a.id).sort(), ['acct-a', 'acct-harbor', 'acct-tab']);
  assert.deepEqual(out.breakdown, { selected: 1, worked_on: 3 });
});

test('selectedOnly is the scope alone, and a selected scope never reads the whole catalog', async () => {
  const sb = database(world());
  const out = await revboxWorkedAccounts(sb, 'ws', 'owner', 'box', null, { now: NOW, selectedOnly: true });
  assert.deepEqual(out.accounts.map(a => a.id).sort(), ['acct-a', 'acct-sel']);
  assert.ok(!sb.reads.includes('agent_routine_runs'));
});

test('a recorded run is not re-read: its document is parsed only when its step logged no accounts', async () => {
  const w = world();
  w.agent_routine_runs = w.agent_routine_runs.filter(r => r.id === 'r3');
  const out = await revboxRunAccounts(database(w), 'ws', { revboxId: 'box', routineIds: ['job'], now: NOW });
  assert.deepEqual(out.accounts.map(a => a.id), ['acct-read']);
  assert.deepEqual(out.names, { matched: 0, unmatched: 0, ambiguous: 0 });   // doc-new was not parsed
});

test('at run time a box job\'s AI step logs the accounts its output names (resolved, unmatched counted)', async () => {
  const { runStepsForTest: runSteps } = await import('../dist/services/automationRun.mjs');
  const sb = database(world());
  const brief = { id: 'doc-run', title: 'Harborline Labs — closed won', sections: [{ label: 'Accounts', body: '| Account | Pulls |\n|---|---|\n| Fernpoint Health | 3 |\n| Nobody Known | 1 |' }] };
  const automation = { id: 'job', name: 'Daily account report', user_id: 'owner', revbox_id: 'box', trigger_kind: 'clock', steps: [{ id: 'summary', type: 'agent', config: { mode: 'write', prompt: 'Write it.' } }] };
  const r = await runSteps(automation, brief, { stage: 'scheduled', ctx: { supabase: sb, workspaceId: 'ws', runId: 'run-1' } });
  assert.equal(r.failed, undefined, r.message);
  const line = r.log.find(e => e.type === 'agent');
  assert.equal(line.document_id, 'doc-run');
  assert.deepEqual(line.accounts.sort(), ['acct-fern', 'acct-harbor']);
  assert.equal(line.accounts_unmatched, 1);
  // Outside a RevBox nothing is looked up or logged.
  const plain = await runSteps({ ...automation, revbox_id: null }, brief, { stage: 'scheduled', ctx: { supabase: database(world()), workspaceId: 'ws', runId: 'run-2' } });
  assert.equal(plain.log.find(e => e.type === 'agent').accounts, undefined);
});

// GET-896: a run's accounts are worked out once. The first read after a run has finished resolves
// its output's names and reads its documents, then keeps the result on the run (state.accounts_resolved);
// every later read takes it from there: no documents, no name lookups, the same accounts.
const finished = (w) => { for (const r of w.agent_routine_runs) r.status = 'ok'; return w; };
test('the second read of a box resolves no names and reads no documents, and returns the same accounts', async () => {
  const sb = database(finished(world()));
  const first = await revboxWorkedAccounts(sb, 'ws', 'owner', 'box', null, { now: NOW });
  assert.ok(sb.reads.includes('documents') && sb.resolves.length, 'the first read works the past runs out');
  assert.ok(sb.writes.some(w => w.table === 'agent_routine_runs' && w.patch.state?.accounts_resolved), 'and keeps the result on the run');
  sb.reads.length = 0; sb.resolves.length = 0; sb.writes.length = 0;
  const second = await revboxWorkedAccounts(sb, 'ws', 'owner', 'box', null, { now: NOW });
  assert.deepEqual(second.accounts, first.accounts);
  assert.deepEqual(second.breakdown, first.breakdown);
  assert.deepEqual(second.names, first.names);
  assert.equal(sb.resolves.length, 0, 'no name resolution');
  assert.ok(!sb.reads.includes('documents') && !sb.reads.includes('document_links'), `no document reads: ${sb.reads}`);
  assert.equal(sb.writes.length, 0, 'nothing rewritten');
  // Visibility is still per viewer, on the kept result.
  const narrow = await revboxWorkedAccounts(sb, 'ws', 'owner', 'box', new Set(['acct-a', 'acct-harbor', 'acct-tab']), { now: NOW });
  assert.deepEqual(narrow.accounts.map(a => a.id).sort(), ['acct-a', 'acct-harbor', 'acct-tab']);
});

test('a new run is picked up on the next read; a run still going is worked out live and not kept', async () => {
  const w = finished(world());
  const sb = database(w);
  await revboxWorkedAccounts(sb, 'ws', 'owner', 'box', null, { now: NOW });
  w.entity_list_rows.push(acct('acct-new', 'Bayview Labs'), acct('acct-live', 'Live Account'));
  w.documents.push({ id: 'doc-next', workspace_id: 'ws', subject_entity_id: null, title: 'Daily report', body_md: 'Name | Pulls\nBayview Labs | 2' },
    { id: 'doc-live', workspace_id: 'ws', subject_entity_id: null, title: 'Live Account — today', body_md: '' });
  w.agent_routine_runs.push(
    { id: 'r5', workspace_id: 'ws', routine_id: 'job', status: 'ok', started_at: ago(0.1), entity_id: null, document_id: null, step_log: [{ step: 1, type: 'agent', status: 'ok', document_id: 'doc-next' }] },
    { id: 'r6', workspace_id: 'ws', routine_id: 'job', status: 'awaiting_approval', started_at: ago(0.05), entity_id: null, document_id: 'doc-live', step_log: [] });
  sb.writes.length = 0;
  const out = await revboxWorkedAccounts(sb, 'ws', 'owner', 'box', null, { now: NOW });
  const ids = out.accounts.map(a => a.id);
  assert.ok(ids.includes('acct-new') && ids.includes('acct-live'), 'both new runs count');
  assert.deepEqual(sb.writes.map(x => x.patch.state?.accounts_resolved ? 'kept' : '?'), ['kept'], 'only the finished run is kept');
  assert.ok(w.agent_routine_runs.find(r => r.id === 'r5').state.accounts_resolved.entities.includes('acct-new'));
  assert.equal(w.agent_routine_runs.find(r => r.id === 'r6').state, undefined);
});

test('a caller who may not see the box gets the access error, and nothing is read from its documents or kept', async () => {
  const sb = database(finished(world()));
  await assert.rejects(revboxWorkedAccounts(sb, 'ws', 'stranger', 'box', null, { now: NOW }), e => e.status === 403);
  await new Promise(r => setTimeout(r, 20));
  assert.ok(!sb.reads.includes('documents'), `no document reads: ${sb.reads}`);
  assert.equal(sb.resolves.length, 0);
  assert.equal(sb.writes.length, 0);
});
