// writeLayerClaims — persists the layered score as icp.<layer> claims. Proves the
// two honest rules: a KNOWN layer is written as a claim; an UNKNOWN layer writes NO
// claim and invalidates any stale one (unknown ≠ 0). See predictions.ts.
//
// Run: pnpm --filter @nous/core build && node --test packages/core/test/writeLayerClaims.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeLayerClaims } from '../dist/icp/predictions.js';

const sig = (key, weight, rule, layer) => ({
  id: key, workspace_id: 'w', key, label: key, weight, rule,
  coverage: 0, added_in: null, active: true, layer, created_at: '', updated_at: '',
});
const CATALOG = [
  sig('revenue_owner', 10, { feature: 'is_revenue_owner', op: 'exists' }, 'fit'),
  sig('b2b_saas', 8, { feature: 'company_type', op: '==', value: 'b2b_saas' }, 'fit'),
  sig('friction', 12, { feature: 'signal.friction', op: 'scaled' }, 'pain'),
  sig('hiring', 8, { feature: 'signal.hiring', op: 'scaled' }, 'intent'),
];

// Minimal chainable fake of the Supabase client — records upserted rows and the
// property list of any invalidate (update) call.
function fakeSupabase() {
  const calls = { upserted: [], invalidated: [] };
  const chain = {
    eq() { return chain; },
    in(_k, v) { calls.invalidated.push(...v); return chain; },
    is() { return chain; },
    then(res) { return Promise.resolve({ error: null }).then(res); },
  };
  const api = {
    from() { return api; },
    upsert(rows) { calls.upserted.push(...rows); return Promise.resolve({ error: null }); },
    update() { return chain; },
  };
  return { supabase: api, calls };
}

const props = (rows) => rows.map(r => r.property).sort();

test('LinkedIn-only: writes icp.fit + icp.priority, invalidates the unknown layers', async () => {
  const { supabase, calls } = fakeSupabase();
  await writeLayerClaims(supabase, 'w', 'e1',
    { is_revenue_owner: true, company_type: 'b2b_saas' }, CATALOG, '2026-08-17T00:00:00Z');

  assert.deepEqual(props(calls.upserted), ['icp.fit', 'icp.priority', 'icp.priority_band']);
  // The fit claim carries the number, not an object.
  const fit = calls.upserted.find(r => r.property === 'icp.fit');
  assert.equal(typeof fit.value, 'number');
  assert.ok(fit.value > 50);
  // Unknown layers are invalidated, never written as 0.
  assert.deepEqual([...calls.invalidated].sort(), ['icp.ability', 'icp.intent', 'icp.pain']);
});

test('enriched: writes fit+pain+intent+priority, invalidates only ability', async () => {
  const { supabase, calls } = fakeSupabase();
  await writeLayerClaims(supabase, 'w', 'e2',
    { is_revenue_owner: true, company_type: 'b2b_saas', 'signal.friction': 8, 'signal.hiring': 9 },
    CATALOG, '2026-08-17T00:00:00Z');

  assert.deepEqual(props(calls.upserted),
    ['icp.fit', 'icp.intent', 'icp.pain', 'icp.priority', 'icp.priority_band']);
  assert.deepEqual(calls.invalidated, ['icp.ability']);
});

test('empty profile: nothing known → no claims upserted, all layers invalidated', async () => {
  const { supabase, calls } = fakeSupabase();
  await writeLayerClaims(supabase, 'w', 'e3', {}, CATALOG, '2026-08-17T00:00:00Z');
  assert.equal(calls.upserted.length, 0);
  assert.deepEqual([...calls.invalidated].sort(),
    ['icp.ability', 'icp.fit', 'icp.intent', 'icp.pain', 'icp.priority', 'icp.priority_band']);
});

// ── the history log + the asserted guard (forecasting layer 3 groundwork) ────
//
// A richer fake: serves existing icp.* claims to the pre-read, records observation
// inserts. This is what proves the two new behaviours: a CHANGED layer appends an
// append-only history observation (with the previous value riding along), an unchanged
// one appends nothing, and a human-asserted layer is never clobbered by rescoring.

function fakeSupabaseWithState(existingClaims) {
  const calls = { upserted: [], invalidated: [], observations: [] };
  const api = {
    from(table) {
      if (table === 'observations') {
        return {
          insert(rows) { calls.observations.push(...rows); return Promise.resolve({ error: null }); },
        };
      }
      const chain = {
        select() { return chain; },
        eq() { return chain; },
        in(_k, v) {
          // The invalidate path calls .update().eq().eq().in(props) — record those;
          // the read path calls .select()...in(props) — serve the fixture.
          if (chain._mode === 'update') { calls.invalidated.push(...v); return chain; }
          return chain;
        },
        is() { return chain; },
        then(res) {
          return Promise.resolve(
            chain._mode === 'update' ? { error: null } : { data: existingClaims, error: null },
          ).then(res);
        },
      };
      return {
        select() { return chain; },
        upsert(rows) { calls.upserted.push(...rows); return Promise.resolve({ error: null }); },
        update() { chain._mode = 'update'; return chain; },
      };
    },
  };
  return { supabase: api, calls };
}

test('a changed layer writes ONE history observation carrying the previous value', async () => {
  const { supabase, calls } = fakeSupabaseWithState([
    { property: 'icp.fit', value: 40, epistemic_class: 'inferred' },
  ]);
  await writeLayerClaims(supabase, 'w', 'e1',
    { is_revenue_owner: true, company_type: 'b2b_saas' }, CATALOG, '2026-08-31T00:00:00Z');

  const fitHistory = calls.observations.filter(o => o.property === 'icp.fit');
  assert.equal(fitHistory.length, 1, 'expected exactly one icp.fit history row');
  // 'event', never 'state': a state row on the claim's own property would be picked up by
  // claim derivation and overwrite the numeric claim with this object. See predictions.ts.
  assert.equal(fitHistory[0].kind, 'event');
  assert.equal(fitHistory[0].value.from, 40, 'previous value must ride along');
  assert.ok(typeof fitHistory[0].value.value === 'number' && fitHistory[0].value.value !== 40);
  assert.equal(fitHistory[0].observed_at, '2026-08-31T00:00:00Z');
});

test('an unchanged layer writes NO history row — sweeps must not spam the log', async () => {
  // First run against empty state to learn what score this fixture produces...
  const probe = fakeSupabaseWithState([]);
  await writeLayerClaims(probe.supabase, 'w', 'p',
    { is_revenue_owner: true, company_type: 'b2b_saas' }, CATALOG, '2026-08-31T00:00:00Z');
  const scored = Object.fromEntries(probe.calls.upserted.map(r => [r.property, r.value]));

  // ...then re-run with that exact state already in place: nothing changed, nothing logged.
  const { supabase, calls } = fakeSupabaseWithState(
    Object.entries(scored).map(([property, value]) => ({ property, value, epistemic_class: 'inferred' })),
  );
  await writeLayerClaims(supabase, 'w', 'e2',
    { is_revenue_owner: true, company_type: 'b2b_saas' }, CATALOG, '2026-08-31T01:00:00Z');
  assert.equal(calls.observations.length, 0,
    `unchanged rescore logged history: ${JSON.stringify(calls.observations)}`);
});

test('a human-asserted layer is never clobbered by rescoring', async () => {
  // Someone hand-set icp.fit to 95 (epistemic_class 'asserted'). The scorer disagrees —
  // and must lose: no upsert, no invalidation, no history row for that layer.
  const { supabase, calls } = fakeSupabaseWithState([
    { property: 'icp.fit', value: 95, epistemic_class: 'asserted' },
  ]);
  await writeLayerClaims(supabase, 'w', 'e3',
    { is_revenue_owner: true, company_type: 'b2b_saas' }, CATALOG, '2026-08-31T00:00:00Z');

  assert.ok(!calls.upserted.some(r => r.property === 'icp.fit'), 'asserted icp.fit was overwritten');
  assert.ok(!calls.invalidated.includes('icp.fit'), 'asserted icp.fit was invalidated');
  assert.ok(!calls.observations.some(o => o.property === 'icp.fit'), 'asserted icp.fit logged history');
  // The other layers still behave normally.
  assert.ok(calls.upserted.some(r => r.property === 'icp.priority'), 'priority should still write');
});

test('priority_band never enters the history log — it derives from priority', async () => {
  const { supabase, calls } = fakeSupabaseWithState([]);
  await writeLayerClaims(supabase, 'w', 'e4',
    { is_revenue_owner: true, company_type: 'b2b_saas' }, CATALOG, '2026-08-31T00:00:00Z');
  assert.ok(!calls.observations.some(o => o.property === 'icp.priority_band'));
  assert.ok(calls.observations.some(o => o.property === 'icp.priority'), 'priority itself should log');
});
