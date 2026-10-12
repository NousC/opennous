// What the AI step reads (GET-568): parts switched off are not in the material, the account
// can be pinned, and the preview reads only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { automationContextPreview, CONTEXT_PARTS } from '../dist/services/automationRun.mjs';

function db(tables, writes = []) {
  return {
    from(table) {
      const filters = [];
      const q = new Proxy({}, {
        get(_t, prop) {
          const rows = () => (tables[table] ?? []).filter(r => filters.every(([k, v]) => !(k in r) || r[k] === v));
          if (prop === 'then') return (resolve) => resolve({ data: rows(), error: null });
          if (prop === 'maybeSingle' || prop === 'single') return async () => ({ data: rows()[0] ?? null, error: null });
          if (prop === 'eq') return (k, v) => { filters.push([k, v]); return q; };
          if (prop === 'insert' || prop === 'upsert' || prop === 'update') return (...a) => { writes.push({ table, prop, a }); return q; };
          return () => q;
        },
      });
      return q;
    },
  };
}

const tables = () => ({
  deal_outcomes: [{ entity_id: 'acc-1', deal_id: 'd1', closed_at: '2026-09-30T00:00:00Z', outcome: 'won' }],
  entity_list_rows: [{ entity_id: 'acc-1', name: 'Northcape Motors' }],
  companies: [{ id: 'acc-1', name: 'Northcape Motors', domain: 'northcape-motors.example' }],
  workspaces: [{ name: 'Harborline', icp_text: '## What we sell\nDealer software' }],
});

test('every part is in the material by default, and the account always is', async () => {
  const out = await automationContextPreview(db(tables()), 'w1', { when: 'deal_closed_won', steps: [{ id: 'agent', type: 'agent', config: {} }] });
  assert.equal(out.sample.entity_id, 'acc-1');
  assert.ok(out.material.account && out.material.today);
  for (const keys of Object.values(CONTEXT_PARTS)) for (const k of keys) assert.ok(k in out.material, `${k} present`);
});

test('a part switched off is not handed to the model', async () => {
  const steps = [{ id: 'agent', type: 'agent', config: { context: { activity: false, seller: false } } }];
  const out = await automationContextPreview(db(tables()), 'w1', { when: 'deal_closed_won', steps });
  assert.ok(!('recent_activity' in out.material));
  assert.ok(!('seller' in out.material));
  assert.ok('people' in out.material && 'intel' in out.material);
  assert.ok(out.material.account, 'the account is never switched off');
});

test('a pinned account is read instead of the trigger account, and nothing is written', async () => {
  const writes = [];
  const t = tables();
  t.companies.push({ id: 'acc-9', name: 'Pinned Co', domain: 'pinned.example' });
  const steps = [{ id: 'agent', type: 'agent', config: { account_id: 'acc-9', account_name: 'Pinned Co' } }];
  const out = await automationContextPreview(db(t, writes), 'w1', { when: 'deal_closed_won', steps });
  assert.equal(out.account_id, 'acc-9');
  assert.equal(writes.length, 0);
});
