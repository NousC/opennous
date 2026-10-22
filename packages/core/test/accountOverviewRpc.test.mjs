// The Accounts overview reads the account_overview RPC (GET-924). A database that predates it can
// answer through a fallback a deployment registers, used only when PostgREST says the function is
// missing (PGRST202); any other error still throws.
//
// Run: cd packages/core && node --test test/accountOverviewRpc.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accountOverview, personalAccountIds, registerAccountOverviewFallback } from '../src/db/accountOverview.mjs';

const row = { id: 'a1', deal_count: 2, won_deals: 1, lost_deals: 0, latest_signal: null };
const out = { ...row, is_personal: false };
// A client whose RPCs answer from `fns` (name -> rows); a missing name is PostgREST's PGRST202.
// Table reads answer from `tables`, narrowed by eq / in (the personal read, GET-1016).
function fakeSb(fns, tables = {}) {
  const calls = [];
  return {
    calls,
    from(table) {
      const preds = [];
      const q = {
        select: () => q, is: () => q,
        eq: (k, v) => { preds.push(r => r[k] === v); return q; },
        in: (k, vs) => { preds.push(r => vs.includes(r[k])); return q; },
        then: (resolve) => resolve({ data: (tables[table] ?? []).filter(r => preds.every(f => f(r))), error: null }),
      };
      return q;
    },
    rpc(name, args) {
      calls.push([name, args]);
      if (fns[name] instanceof Error) return Promise.resolve({ data: null, error: fns[name] });
      if (!(name in fns)) return Promise.resolve({ data: null, error: { code: 'PGRST202', message: `Could not find the function public.${name}` } });
      return Promise.resolve({ data: fns[name], error: null });
    },
  };
}

test('reads account_overview with the workspace and the account ids', async () => {
  registerAccountOverviewFallback(null);
  const sb = fakeSb({ account_overview: [row] });
  assert.deepEqual(await accountOverview(sb, 'ws', ['a1']), [out]);
  assert.deepEqual(sb.calls, [['account_overview', { p_workspace_id: 'ws', p_ids: ['a1'] }]]);
});

test('no ids, no call', async () => {
  const sb = fakeSb({});
  assert.deepEqual(await accountOverview(sb, 'ws', []), []);
  assert.equal(sb.calls.length, 0);
});

test('a missing account_overview uses the registered fallback, with the same arguments', async () => {
  registerAccountOverviewFallback('older_overview');
  try {
    const sb = fakeSb({ older_overview: [row] });
    assert.deepEqual(await accountOverview(sb, 'ws', ['a1']), [out]);
    assert.deepEqual(sb.calls.map(c => c[0]), ['account_overview', 'older_overview']);
    assert.deepEqual(sb.calls[1][1], { p_workspace_id: 'ws', p_ids: ['a1'] });
  } finally { registerAccountOverviewFallback(null); }
});

test('without a fallback, a missing account_overview throws', async () => {
  await assert.rejects(accountOverview(fakeSb({}), 'ws', ['a1']), e => e.code === 'PGRST202');
});

test('any other error throws, fallback or not', async () => {
  registerAccountOverviewFallback('older_overview');
  try {
    const sb = fakeSb({ account_overview: Object.assign(new Error('statement timeout'), { code: '57014' }), older_overview: [row] });
    await assert.rejects(accountOverview(sb, 'ws', ['a1']), /statement timeout/);
    assert.deepEqual(sb.calls.map(c => c[0]), ['account_overview']);
  } finally { registerAccountOverviewFallback(null); }
});

// A personal account (GET-1016) is someone we know, not a deal: it says so and has no latest signal.
const signal = { kind: 'budget_discussed', entity_id: 'p1', claim_property: 'note.x' };
const person = (entity_id, company_id) => ({ entity_id, company_id, kind: 'person', workspace_id: 'ws' });
const account = (entity_id, people_count) => ({ entity_id, people_count, kind: 'account', workspace_id: 'ws' });
const mark = (entity_id) => ({ entity_id, property: 'is_personal', value: true, workspace_id: 'ws' });

test('an account marked personal has no latest signal and says it is personal', async () => {
  registerAccountOverviewFallback(null);
  const sb = fakeSb({ account_overview: [{ ...row, latest_signal: signal }] }, { claims: [mark('a1')], entity_list_rows: [account('a1', 0)] });
  const [a] = await accountOverview(sb, 'ws', ['a1']);
  assert.equal(a.is_personal, true);
  assert.equal(a.latest_signal, null);
});

test('an account whose people are all personal is personal; one with a deal contact left is not', async () => {
  registerAccountOverviewFallback(null);
  const rows = [{ ...row, id: 'a1' }, { ...row, id: 'a2' }, { ...row, id: 'a3' }];
  const sb = fakeSb({ account_overview: rows }, {
    entity_list_rows: [person('p1', 'a1'), person('p2', 'a1'), person('p3', 'a2'), person('p4', 'a2'), account('a1', 2), account('a2', 2), account('a3', 0)],
    claims: [mark('p1'), mark('p2'), mark('p3')],
  });
  const got = await accountOverview(sb, 'ws', ['a1', 'a2', 'a3']);
  assert.deepEqual(got.map(a => [a.id, a.is_personal]), [['a1', true], ['a2', false], ['a3', false]]);
});

test('the whole workspace: marked accounts and accounts whose people are all marked', async () => {
  const sb = fakeSb({}, {
    entity_list_rows: [account('a1', 0), account('a2', 1), account('a3', 2), person('p1', 'a2'), person('p2', 'a3'), person('p3', 'a3')],
    claims: [mark('a1'), mark('p1'), mark('p2')],
  });
  assert.deepEqual([...await personalAccountIds(sb, 'ws')].sort(), ['a1', 'a2']);
});
