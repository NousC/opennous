// A Network account (marked personal, or every one of its people is) is someone we know, not an
// account we sell to (GET-1017, GET-1019): the Accounts list leaves it out unless its filter asks
// for `network=show`, and the graph never draws it. Its people stay on the graph, with no employer.
//
// Run: cd apps/api && node --test tests/networkAccounts.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { networkExcludeIds } from '../src/routes/api/companies.mjs';
import { drawnAccounts, committeeAccounts, claimsByAccount } from '../src/routes/api/graph.mjs';
import { listRows } from '../src/lib/listRows.mjs';

const WS = 'ws-1';

// A Supabase stand-in over in-memory tables: the filters personalAccountIds uses.
function fakeDb(tables) {
  return {
    from(table) {
      const preds = [];
      const q = {
        select: () => q, order: () => q, range: () => q,
        eq: (k, v) => { preds.push(r => r[k] === v); return q; },
        in: (k, vs) => { preds.push(r => vs.includes(r[k])); return q; },
        is: (k, v) => { preds.push(r => (r[k] ?? null) === v); return q; },
        then: (resolve) => resolve({ data: (tables[table] ?? []).filter(r => preds.every(f => f(r))), error: null }),
      };
      return q;
    },
  };
}
const mark = (entity_id, value = true) => ({ workspace_id: WS, entity_id, property: 'is_personal', value, invalid_at: null });
const db = () => fakeDb({
  claims: [mark('co-friend'), mark('p-nell'), mark('p-old', null)],
  entity_list_rows: [
    { workspace_id: WS, entity_id: 'co-friend', kind: 'account', company_id: null, people_count: 1 },
    { workspace_id: WS, entity_id: 'co-solo', kind: 'account', company_id: null, people_count: 1 },
    { workspace_id: WS, entity_id: 'co-team', kind: 'account', company_id: null, people_count: 3 },
    { workspace_id: WS, entity_id: 'p-nell', kind: 'person', company_id: 'co-solo', people_count: null },
  ],
});

test('the Accounts list leaves Network accounts out by default', async () => {
  // Marked itself, and the account whose only person is marked. Not one with people still to sell to.
  assert.deepEqual((await networkExcludeIds(db(), WS, {})).sort(), ['co-friend', 'co-solo']);
});

test('the filter set to Shown brings them back, without asking who they are', async () => {
  let asked = false;
  assert.deepEqual(await networkExcludeIds(db(), WS, { network: 'show' }, async () => { asked = true; return new Set(['co-friend']); }), []);
  assert.equal(asked, false);
});

test('the excluded ids reach the list query as one `not in`', async () => {
  const calls = [];
  const q = new Proxy({}, {
    get: (_t, k) => k === 'then'
      ? (resolve) => resolve({ data: [], count: 0, error: null })
      : (...args) => { calls.push([k, ...args]); return q; },
  });
  // The ownership and inbound probes read a column; answering with an error means "not migrated".
  const sb = { from: () => q, rpc: async () => ({ data: null, error: { code: '42703' } }) };
  await listRows(sb, WS, 'account', { excludeIds: ['co-friend', 'co-solo'] }).catch(() => {});
  assert.ok(calls.some(c => c[0] === 'not' && c[1] === 'entity_id' && c[2] === 'in' && c[3] === '(co-friend,co-solo)'), 'not in (Network ids)');
});

test('the graph does not draw a Network account', () => {
  const companies = [{ id: 'co-friend' }, { id: 'co-team' }, { id: 'co-merged' }];
  const live = new Set(['co-friend', 'co-team']);
  assert.deepEqual(drawnAccounts(companies, live, new Set(['co-friend'])).map(c => c.id), ['co-team']);
});

test('the committee picker leaves Network accounts out, most labelled first', () => {
  const named = [
    { entity_id: 'co-friend', name: 'Friend Co', people_count: 2 },
    { entity_id: 'co-team', name: 'Team Co', people_count: 3 },
    { entity_id: 'co-two', name: 'Two Co', people_count: 1 },
  ];
  const byCompany = new Map([['co-friend', new Set(['a', 'b'])], ['co-team', new Set(['c'])], ['co-two', new Set(['d', 'e'])]]);
  assert.deepEqual(committeeAccounts(named, byCompany, new Set(['co-friend'])).map(a => a.id), ['co-two', 'co-team']);
});

test('what we learned is not grouped under a Network account; a person with no company still is theirs', () => {
  const fact = (id, entity_id) => ({ r: { id, entity_id, value: { content: `fact ${id} about them` } }, cat: 'pain' });
  const list = new Map([
    ['co-friend', { entity_id: 'co-friend', kind: 'account', name: 'Friend Co' }],
    ['co-team', { entity_id: 'co-team', kind: 'account', name: 'Team Co' }],
    ['p-nell', { entity_id: 'p-nell', kind: 'person', name: 'Nell Arden', company_id: 'co-friend' }],
    ['p-ivo', { entity_id: 'p-ivo', kind: 'person', name: 'Ivo Brandt', company_id: null }],
  ]);
  const out = claimsByAccount([fact('1', 'co-friend'), fact('2', 'p-nell'), fact('3', 'co-team'), fact('4', 'p-ivo')], list, new Set(['co-friend']));
  assert.deepEqual(out.accounts.map(a => a.id), ['co-team', 'p-ivo']);
  assert.deepEqual(out.claims.map(c => c.id), ['3', '4']);
});
