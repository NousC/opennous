// Company enrichment (GET-669): on the workspace's own Apollo or Prospeo only, never a platform key;
// the 90-day reuse; Apollo first, Prospeo when Apollo has nothing; facts land as observations with
// the provider that said them; a workspace scoring with its own model is not re-scored by Nous.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enrichCompanyEntity, valuesFromApollo, valuesFromProspeo } from '../src/services/companyEnrich.mjs';

function fakeSupabase(tables = {}) {
  return {
    from(name) {
      const f = [];
      const b = {
        select() { return b; },
        eq(c, v) { f.push(r => r[c] === v); return b; },
        in(c, vs) { f.push(r => vs.includes(r[c])); return b; },
        order() { return b; }, limit() { return b; },
        then(res, rej) { return Promise.resolve({ data: (tables[name] ?? []).filter(r => f.every(fn => fn(r))), error: null }).then(res, rej); },
      };
      return b;
    },
  };
}

const DOMAIN = { workspace_id: 'ws', entity_id: 'co1', kind: 'domain', status: 'active', value: 'Acme.com' };
const recorder = () => {
  const calls = { observations: [], recomputed: [] };
  return {
    calls,
    deps: {
      recordObservations: async (_sb, rows) => { calls.observations.push(...rows); return rows.length; },
      recomputeClaim: async (_sb, _ws, _id, p) => { calls.recomputed.push(p); },
      getIcpScorer: async () => 'external',   // keep the rescore out of these tests
    },
  };
};

test('Apollo organization → the values we keep', () => {
  const v = valuesFromApollo({
    industry: 'Marketing & Advertising', estimated_num_employees: 14, keywords: ['outbound', 'revops', 'outbound'],
    short_description: 'GTM systems agency.', city: 'Austin', country: 'United States',
    current_technologies: [{ name: 'HubSpot' }, { name: 'Clay' }],
  });
  assert.deepEqual(v, {
    keywords: ['outbound', 'revops'], description: 'GTM systems agency.', industry: 'Marketing & Advertising',
    employee_count: 14, location: 'Austin, United States', tech_stack: ['HubSpot', 'Clay'],
  });
  assert.equal(valuesFromApollo({}), null);
  assert.equal(valuesFromProspeo(null), null);
});

test('no connected provider: refused, nothing looked up, no platform key', async () => {
  let looked = false;
  const out = await enrichCompanyEntity(fakeSupabase({ entity_identifiers: [DOMAIN] }), 'ws', 'co1', {
    keys: { apollo: null, prospeo: null }, deps: { fetchOrg: async () => { looked = true; return {}; } },
  });
  assert.equal(out.status, 'no_enrichment_provider');
  assert.equal(looked, false);
});

test('no domain: nothing to look it up by', async () => {
  const out = await enrichCompanyEntity(fakeSupabase({}), 'ws', 'co1', { keys: { apollo: 'k' } });
  assert.equal(out.status, 'no_domain');
});

test('enriched in the last 90 days: reused, nothing spent; force buys it again', async () => {
  const recent = { workspace_id: 'ws', entity_id: 'co1', method: 'enrichment', source: 'apollo', observed_at: new Date(Date.now() - 5 * 86_400_000).toISOString() };
  const sb = fakeSupabase({ entity_identifiers: [DOMAIN], observations: [recent] });
  let looked = 0;
  const fetchOrg = async () => { looked++; return { org: { industry: 'Software' } }; };
  const { deps } = recorder();
  const cached = await enrichCompanyEntity(sb, 'ws', 'co1', { keys: { apollo: 'k' }, deps: { ...deps, fetchOrg } });
  assert.equal(cached.status, 'cached');
  assert.equal(cached.provider, 'apollo');
  assert.equal(looked, 0);
  const forced = await enrichCompanyEntity(sb, 'ws', 'co1', { force: true, keys: { apollo: 'k' }, deps: { ...deps, fetchOrg } });
  assert.equal(forced.status, 'enriched');
  assert.equal(looked, 1);
});

test('Apollo answers: observations tagged apollo, claims recomputed, domain lowercased for the lookup', async () => {
  const { calls, deps } = recorder();
  let askedFor;
  const out = await enrichCompanyEntity(fakeSupabase({ entity_identifiers: [DOMAIN] }), 'ws', 'co1', {
    keys: { apollo: 'k' },
    deps: { ...deps, fetchOrg: async (d) => { askedFor = d; return { org: { industry: 'Software', estimated_num_employees: 40, short_description: 'CRM tools.' } }; } },
  });
  assert.equal(askedFor, 'acme.com');
  assert.equal(out.status, 'enriched');
  assert.equal(out.provider, 'apollo');
  assert.deepEqual(out.fields_added.sort(), ['description', 'employee_count', 'industry']);
  assert.ok(calls.observations.every(o => o.source === 'apollo' && o.method === 'enrichment' && o.entityId === 'co1' && o.kind === 'state'));
  assert.deepEqual(calls.recomputed.sort(), ['description', 'employee_count', 'industry']);
});

test('Apollo has nothing: Prospeo on the workspace key', async () => {
  const { calls, deps } = recorder();
  let prospeoKey;
  const fetchImpl = async (_url, init) => {
    prospeoKey = init.headers['X-KEY'];
    return { json: async () => ({ company: { industry: 'Staffing', employee_count: 9, location: { country: 'Germany' } } }) };
  };
  const out = await enrichCompanyEntity(fakeSupabase({ entity_identifiers: [DOMAIN] }), 'ws', 'co1', {
    keys: { apollo: 'a', prospeo: 'their_prospeo' }, fetchImpl,
    deps: { ...deps, fetchOrg: async () => ({ org: null }) },
  });
  assert.equal(prospeoKey, 'their_prospeo');
  assert.equal(out.provider, 'prospeo');
  assert.ok(calls.observations.every(o => o.source === 'prospeo'));
});

test('nobody knows the company: no match, nothing written', async () => {
  const { calls, deps } = recorder();
  const out = await enrichCompanyEntity(fakeSupabase({ entity_identifiers: [DOMAIN] }), 'ws', 'co1', {
    keys: { apollo: 'a' }, deps: { ...deps, fetchOrg: async () => ({ org: null }) },
  });
  assert.equal(out.status, 'no_match');
  assert.equal(calls.observations.length, 0);
});
