// Account health on a customer's own page (GET-692): the Customers page's classifier, run on one
// account, plus the one reason it lacked — the person who chose us leaving.
//
// Run: node --test apps/api/tests/accountHealthPage.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyCustomers, loadSaidReasons } from '../src/lib/csHealth.mjs';
import { buildAccountHealth } from '../src/lib/csReport.mjs';

const DAY = 86_400_000;
const ago = (d) => new Date(Date.now() - d * DAY).toISOString();
const acct = (id, over = {}) => ({ companyId: id, name: id, wonDeals: 1, openDeals: 0, daysQuiet: 10, reasons: [], products: [], ...over });
const left = { tier: 2, kind: 'champion_left', text: 'Their champion left', detail: 'Orrin left last month', at: ago(5) };

// A PostgREST stand-in: every chained filter is accepted, and each table answers with its rows.
function fakeSupabase(tables) {
  return {
    from(table) {
      const rows = () => tables[table] ?? [];
      const q = {
        select: () => q, eq: () => q, in: () => q, is: () => q, like: () => q, not: () => q,
        gte: () => q, lte: () => q, gt: () => q, order: () => q, limit: () => q,
        range: async () => ({ data: rows(), error: null }),
        maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
        then: (ok, bad) => Promise.resolve({ data: rows(), count: rows().length, error: null }).then(ok, bad),
      };
      return q;
    },
  };
}

test('a champion leaving is a tier-2 risk: shown alone, at risk with a second reason', () => {
  const health = new Map([['a', { status: 'client', mrr: 300, active_users_30d: 5 }], ['b', { status: 'client', mrr: 300, active_users_30d: 5, units_90d: 10, units_prev_90d: 100 }]]);
  const { atRisk, active } = classifyCustomers([acct('a', { reasons: [left] }), acct('b', { reasons: [left] })], health, { hasHealth: true });
  const a = active.find(r => r.companyId === 'a');
  assert.equal(a.riskReasons[0].kind, 'champion_left');
  assert.equal(a.riskReasons[0].tier, 2);
  assert.deepEqual(atRisk.map(r => r.companyId), ['b']);
});

test('one account classified alone still sees its group siblings', () => {
  const health = new Map([['a', { status: 'client', mrr: 300, active_users_30d: 5, group: 'Calloway Group' }]]);
  // Read off the row, not the expansion list: a group sibling is context (tier 3) and does not put
  // an account on the list by itself since 2026-10-01. What this guards is that it is still found.
  const { active } = classifyCustomers([acct('a')], health, { hasHealth: true, groupBuyers: new Map([['Calloway Group', 4]]) });
  assert.ok(active[0]?.expansionReasons.some(r => r.kind === 'group'));
});

test('a departure becomes a reason only when the person held a buying role', async () => {
  const supabase = fakeSupabase({
    relationships: [{ from_entity_id: 'p1', to_entity_id: 'co' }, { from_entity_id: 'p2', to_entity_id: 'co' }],
    claims: [
      { entity_id: 'p1', property: 'note.a', value: { source: 'signal_extraction', category: 'authority', metadata: { role: 'champion' }, content: 'Orrin pushes for us' } },
      { entity_id: 'p1', property: 'note.b', value: { source: 'signal_extraction', category: 'staff_change', metadata: { change: 'left' }, content: 'Orrin left last month' }, computed_at: ago(3) },
      { entity_id: 'p2', property: 'note.c', value: { source: 'signal_extraction', category: 'staff_change', metadata: { change: 'left' }, content: 'An intern left' }, computed_at: ago(3) },
    ],
  });
  const reasons = (await loadSaidReasons('ws', supabase, ['co'])).get('co');
  const gone = reasons.filter(r => r.kind === 'champion_left');
  assert.equal(gone.length, 1);
  assert.equal(gone[0].text, 'Their champion left');
  assert.equal(gone[0].detail, 'Orrin left last month');
});

test('the page answers null for a prospect and a state for a customer', async () => {
  const prospect = await buildAccountHealth(fakeSupabase({ entity_list_rows: [{ entity_id: 'co', name: 'Acme', won_deals: 0, cs: { status: 'lead' } }] }), 'ws', 'co');
  assert.equal(prospect.state, null);
  const paying = await buildAccountHealth(fakeSupabase({ entity_list_rows: [{ entity_id: 'co', name: 'Acme', won_deals: 1, cs: { status: 'client', mrr: 400, active_users_30d: 0, total_users: 8 } }] }), 'ws', 'co');
  assert.equal(paying.state, 'at_risk');
  assert.equal(paying.riskReasons[0].kind, 'no_usage');
  const gone = await buildAccountHealth(fakeSupabase({ entity_list_rows: [{ entity_id: 'co', name: 'Acme', won_deals: 1, cs: { status: 'cancelled' } }] }), 'ws', 'co');
  assert.equal(gone.state, 'churned');
});
