// The RevBox Accounts card's two links (GET-891): the Accounts page (?revbox=) and the Account
// graph (?revbox=) open on the same accounts the card counts: the box's selected scope plus what its
// jobs worked on, viewer-visible only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { revboxListPage } from '../src/routes/api/companies.mjs';
import { revboxCardAccounts, revboxCardGraph } from '../src/routes/api/revboxes.mjs';

const NOW = Date.now();
const ago = (days) => new Date(NOW - days * 86_400_000).toISOString();

function database(tables) {
  class Query {
    constructor(table) { this.table = table; this.filters = []; }
    select() { return this; } order() { return this; } limit() { return this; }
    range(a, b) { this.window = [a, b]; return this; }
    eq(k, v) { this.filters.push(r => r[k] === v); return this; }
    in(k, vs) { this.filters.push(r => vs.includes(r[k])); return this; }
    gte(k, v) { this.filters.push(r => String(r[k] ?? '') >= v); return this; }
    or(expr) {
      const pats = expr.split(',').map(p => { const m = p.match(/^(\w+)\.ilike\.(.*)$/); return { col: m[1], re: new RegExp(`^${m[2].split('*').map(x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 'i') }; });
      this.filters.push(r => pats.some(p => p.re.test(String(r[p.col] ?? ''))));
      return this;
    }
    result(single) {
      let values = (tables[this.table] ?? []).filter(r => this.filters.every(f => f(r)));
      if (this.window) values = values.slice(this.window[0], this.window[1] + 1);
      return { data: structuredClone(single ? values[0] ?? null : values), error: null };
    }
    maybeSingle() { return Promise.resolve(this.result(true)); } single() { return this.maybeSingle(); }
    then(ok, ko) { return Promise.resolve(this.result(false)).then(ok, ko); }
  }
  return { from: t => new Query(t) };
}
const acct = (id, name) => ({ workspace_id: 'ws', entity_id: id, kind: 'account', name, domain: `${id}.example`, company_id: null, icp_score: 60, last_activity_at: null, people_count: 1 });
const world = () => ({
  workspace_members: [{ workspace_id: 'ws', user_id: 'owner' }],
  revboxes: [{ id: 'box', workspace_id: 'ws', owner_id: 'owner', shared: false, name: 'Daily account report', revision: 1, scope: { mode: 'selected', account_ids: ['acct-sel'], min_icp: 70 } }],
  revbox_members: [],
  agent_routines: [{ id: 'job', workspace_id: 'ws', revbox_id: 'box' }],
  agent_routine_runs: [
    { id: 'r1', workspace_id: 'ws', routine_id: 'job', started_at: ago(1), entity_id: 'deal-1', document_id: null, step_log: [] },
    { id: 'r2', workspace_id: 'ws', routine_id: 'job', started_at: ago(1), entity_id: null, document_id: null, step_log: [{ type: 'hubspot', status: 'ok', accounts: ['acct-read'] }, { type: 'agent', status: 'ok', document_id: 'doc-1' }] },
  ],
  revbox_runs: [],
  documents: [{ id: 'doc-1', workspace_id: 'ws', subject_entity_id: null, title: 'Daily report', body_md: 'Name | Pulls\nHarborline Labs Inc | 4\nNo Such Account | 1' }],
  document_links: [],
  revbox_datasets: [],
  entity_list_rows: [
    acct('acct-sel', 'Selected Co'), acct('acct-read', 'Lakeshore Health'), acct('acct-harbor', 'Harborline Labs'), acct('acct-deal', 'Deal Holder'), acct('acct-other', 'Not Worked On'),
    { workspace_id: 'ws', entity_id: 'deal-1', kind: 'deal', name: 'Renewal', company_id: 'acct-deal', stage: 'open' },
    { workspace_id: 'ws', entity_id: 'person-1', kind: 'person', name: 'Pat', company_id: 'acct-harbor' },
  ],
});
const UNION = ['acct-deal', 'acct-harbor', 'acct-read', 'acct-sel'];

test('companies/list?revbox pages the union: selected plus worked on (a deal as its company, a named account)', async () => {
  const { box, page } = await revboxListPage(database(world()), 'ws', 'owner', 'box', null);
  assert.equal(box.name, 'Daily account report');
  assert.deepEqual([...page.ids].sort(), UNION);
  assert.equal(page.total, 4);
  const scope = await revboxListPage(database(world()), 'ws', 'owner', 'box', null, { selectedOnly: true });
  assert.deepEqual(scope.page.ids, ['acct-sel']);
});

test('the Account graph and the Accounts page open on exactly the accounts the card counts', async () => {
  const card = await revboxCardAccounts(database(world()), 'ws', 'owner', 'box', null);
  const { page } = await revboxListPage(database(world()), 'ws', 'owner', 'box', null);
  const graph = await revboxCardGraph(database(world()), 'ws', 'owner', 'box', null);
  const graphAccounts = graph.nodes.filter(n => n.type === 'account').map(n => n.id).sort();
  assert.deepEqual(card.accounts.map(a => a.id).sort(), UNION);
  assert.deepEqual([...page.ids].sort(), UNION);
  assert.deepEqual(graphAccounts, UNION);
  assert.deepEqual(card.breakdown, { selected: 1, worked_on: 3 });
  assert.ok(graph.nodes.some(n => n.id === 'person-1'), 'a worked-on account brings its people');
});

test('both links respect the viewer\'s visibility', async () => {
  const visible = new Set(['acct-sel', 'acct-harbor']);
  const { page } = await revboxListPage(database(world()), 'ws', 'owner', 'box', visible);
  const graph = await revboxCardGraph(database(world()), 'ws', 'owner', 'box', visible);
  assert.deepEqual([...page.ids].sort(), ['acct-harbor', 'acct-sel']);
  assert.deepEqual(graph.nodes.filter(n => n.type === 'account').map(n => n.id).sort(), ['acct-harbor', 'acct-sel']);
});
