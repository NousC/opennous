// The Accounts overview reads the account_overview RPC (GET-924). A database that predates it can
// answer through a fallback a deployment registers, used only when PostgREST says the function is
// missing (PGRST202); any other error still throws.
//
// Run: cd packages/core && node --test test/accountOverviewRpc.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accountOverview, registerAccountOverviewFallback } from '../src/db/accountOverview.mjs';

const row = { id: 'a1', deal_count: 2, won_deals: 1, lost_deals: 0, latest_signal: null };
// A client whose RPCs answer from `fns` (name -> rows); a missing name is PostgREST's PGRST202.
function fakeSb(fns) {
  const calls = [];
  return {
    calls,
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
  assert.deepEqual(await accountOverview(sb, 'ws', ['a1']), [row]);
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
    assert.deepEqual(await accountOverview(sb, 'ws', ['a1']), [row]);
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
