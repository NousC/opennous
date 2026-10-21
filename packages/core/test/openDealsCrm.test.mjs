// The open book listens to the CRM (GET-835).
//
// An account used to count as an open deal whenever its rebuilt ladder didn't end on a
// terminal hop. So an existing customer with a won deal and a call every month read as
// "in discovery" for a year. Now: if the CRM holds deals for an account, it's open only
// when one of them is open. No CRM deal at all keeps the old implied behaviour.
//
// Run: pnpm --filter @nous/core build && node --test packages/core/test/openDealsCrm.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreOpenDeals, runDealOutlook } from '../dist/services/forecastRun.js';
import { loadCrmDealStatesByAccount } from '../dist/services/crmAgent.js';

// A tiny in-memory stand-in for the supabase query builder: just the calls these reads make.
function fakeSupabase(tables) {
  return {
    from(name) {
      const filters = [];
      let lo = 0, hi = Infinity, single = false;
      const q = {
        select() { return q; },
        eq(col, v) { filters.push(r => r[col] === v); return q; },
        in(col, vs) { const s = new Set(vs); filters.push(r => s.has(r[col])); return q; },
        is(col, v) { filters.push(r => (r[col] ?? null) === v); return q; },
        like(col, pat) {
          const re = new RegExp('^' + pat.split('%').map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
          filters.push(r => re.test(String(r[col] ?? ''))); return q;
        },
        or(expr) {
          const alts = expr.split(',').map(part => {
            const [path, , val] = part.split('.');
            const [col, key] = path.split('->>');
            return r => String(key ? r[col]?.[key] : r[col]) === val;
          });
          filters.push(r => alts.some(f => f(r))); return q;
        },
        order() { return q; },
        limit(n) { hi = n - 1; return q; },
        range(a, b) { lo = a; hi = b; return q; },
        maybeSingle() { single = true; return q; },
        then(resolve, reject) {
          const rows = (tables[name] ?? []).filter(r => filters.every(f => f(r))).slice(lo, hi + 1);
          return Promise.resolve({ data: single ? rows[0] ?? null : rows, error: null }).then(resolve, reject);
        },
      };
      return q;
    },
  };
}

const WS = 'ws-1';
const DAY = 86_400_000;
const NOW = Date.parse('2026-10-01T00:00:00Z');
const ago = (d) => new Date(NOW - d * DAY).toISOString();

// One person per company, each with a meeting a year ago and one last week: on activity
// alone every one of them sits "in discovery".
function world({ withCrm }) {
  const companies = ['co-won', 'co-open', 'co-none', 'co-closed-both', 'co-lost'];
  const people = companies.map(c => ({ id: `p-${c}`, company_id: c, workspace_id: WS }));
  people.push({ id: 'p-solo', company_id: null, workspace_id: WS, first_name: 'Sam', last_name: 'Solo' });
  const observations = people.flatMap((p, i) => [
    { id: `o${i}a`, workspace_id: WS, entity_id: p.id, property: 'interaction.meeting_held', observed_at: ago(300), raw: null },
    { id: `o${i}b`, workspace_id: WS, entity_id: p.id, property: 'interaction.meeting_held', observed_at: ago(7), raw: null },
  ]);
  const entities = [], claims = [], relationships = [];
  if (withCrm) {
    const deal = (id, company, status, stage) => {
      entities.push({ id, workspace_id: WS, type: 'deal' });
      relationships.push({ workspace_id: WS, from_entity_id: id, to_entity_id: company, type: 'belongs_to', valid_to: null });
      if (status) claims.push({ workspace_id: WS, entity_id: id, property: 'status', value: { value: status }, invalid_at: null });
      if (stage) claims.push({ workspace_id: WS, entity_id: id, property: 'stage', value: stage, invalid_at: null });
    };
    deal('d-won', 'co-won', 'won', 'Closed Won');
    deal('d-open', 'co-open', null, 'Discovery');
    deal('d-open-old', 'co-open', 'lost', null);
    deal('d-won2', 'co-closed-both', null, 'Closed Won');
    deal('d-lost2', 'co-closed-both', 'lost', 'Closed Lost');
    deal('d-lost3', 'co-lost', null, 'Closed Lost');
  }
  return fakeSupabase({
    observations,
    contacts: people,
    companies: companies.map(id => ({ id, name: id, domain: null, workspace_id: WS })),
    entities, claims, relationships,
  });
}

test('a won customer with ongoing calls is not an open deal; an open CRM deal and no CRM deal still are', async () => {
  const { deals } = await scoreOpenDeals(world({ withCrm: true }), WS, { now: NOW });
  const ids = deals.map(d => d.entityId).sort();
  assert.deepEqual(ids, ['co-none', 'co-open', 'p-solo']);
});

test('the scoring still learns from closed customers: they stay in the assembly', async () => {
  const { asm } = await scoreOpenDeals(world({ withCrm: true }), WS, { now: NOW });
  assert.ok(asm.accounts.has('co-won'));
  assert.ok(asm.accounts.has('co-closed-both'));
});

test('a workspace with no CRM deals keeps the implied deals exactly as before', async () => {
  const { deals } = await scoreOpenDeals(world({ withCrm: false }), WS, { now: NOW });
  assert.deepEqual(deals.map(d => d.entityId).sort(), ['co-closed-both', 'co-lost', 'co-none', 'co-open', 'co-won', 'p-solo']);
});

test('the reader reduces every CRM deal to the outcomes its account holds', async () => {
  const states = await loadCrmDealStatesByAccount(world({ withCrm: true }), WS);
  assert.deepEqual([...states.get('co-won')], ['won']);
  assert.deepEqual([...states.get('co-open')].sort(), ['lost', 'open']);
  assert.deepEqual([...states.get('co-closed-both')].sort(), ['lost', 'won']);
  assert.equal(states.has('co-none'), false);
});

test("the outlook reads the CRM's verdict for a dropped account, not the ladder's discovery", async () => {
  const out = await runDealOutlook(world({ withCrm: true }), WS, { now: NOW });
  assert.equal(out.stageByAccount.get('co-won'), 'closed_won');
  assert.equal(out.stageByAccount.get('co-closed-both'), 'closed_won');
  assert.equal(out.stageByAccount.get('co-lost'), 'closed_lost');
  assert.equal(out.stageByAccount.get('co-open'), 'discovery');
  assert.deepEqual(out.deals.map(d => d.entityId).sort(), ['co-none', 'co-open', 'p-solo']);
});
