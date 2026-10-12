// HubSpot fields as variables (GET-567): only the properties the text names are read, live,
// for the run's deal and company; a missing connection leaves them blank instead of failing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hubspotPropsIn, hubspotTemplateVars, hubspotFieldList } from '../dist/services/hubspotVars.mjs';

function db(tables) {
  return {
    from(table) {
      const filters = [];
      const q = new Proxy({}, {
        get(_t, prop) {
          const rows = () => (tables[table] ?? []).filter(r => filters.every(([k, v]) => !(k in r) || r[k] === v));
          if (prop === 'then') return (resolve) => resolve({ data: rows(), error: null });
          if (prop === 'maybeSingle') return async () => ({ data: rows()[0] ?? null, error: null });
          if (prop === 'eq') return (k, v) => { filters.push([k, v]); return q; };
          return () => q;
        },
      });
      return q;
    },
  };
}

const tables = () => ({
  crm_sync_configs: [{ connection_id: 'c1' }],
  workflow_provider_connections: [{ id: 'c1', encrypted_credentials: { access_token: 'pat-test' } }],
  entity_identifiers: [{ entity_id: 'deal-1', kind: 'deal_hubspot', value: '9001' }],
  companies: [{ id: 'acc-1', hubspot_company_id: '777' }],
  crm_property_schemas: [
    { object_type: 'deals', properties: [
      { name: 'dealname', label: 'Deal Name', type: 'string' },
      { name: 'closedate', label: 'Close Date', type: 'datetime' },
      { name: 'onboarding_owner', label: 'Onboarding owner', type: 'string', custom: true },
    ] },
    { object_type: 'companies', properties: [{ name: 'industry', label: 'Industry', type: 'enumeration' }] },
  ],
});

test('hubspotPropsIn finds deal and company properties in any text', () => {
  const p = hubspotPropsIn(['Hi {{ hubspot.deal.dealname }}', 'From {{hubspot.company.industry}} and {{account.name}}']);
  assert.deepEqual([...p.deal], ['dealname']);
  assert.deepEqual([...p.company], ['industry']);
});

test('reads only the named properties, live, and prints dates as dates', async () => {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, body, auth: init.headers.Authorization });
    const props = url.includes('/deals/') ? { dealname: 'Corrigan — Enterprise', closedate: '2026-09-28T14:00:00Z', onboarding_owner: 'Odile' } : { industry: 'AUTOMOTIVE;RETAIL' };
    return new Response(JSON.stringify({ results: [{ id: body.inputs[0].id, properties: props }] }), { status: 200 });
  };
  try {
    const vars = await hubspotTemplateVars(db(tables()), 'w1', {
      dealId: 'deal-1', accountId: 'acc-1',
      texts: ['{{hubspot.deal.dealname}} closed {{hubspot.deal.closedate}}, onboarding: {{hubspot.deal.onboarding_owner}}', '{{hubspot.company.industry}}'],
    });
    assert.equal(vars['hubspot.deal.dealname'], 'Corrigan — Enterprise');
    assert.equal(vars['hubspot.deal.closedate'], 'September 28, 2026');
    assert.equal(vars['hubspot.deal.onboarding_owner'], 'Odile');
    assert.equal(vars['hubspot.company.industry'], 'AUTOMOTIVE, RETAIL');
    const deal = calls.find(c => c.url.includes('/deals/'));
    assert.deepEqual(deal.body.inputs, [{ id: '9001' }]);
    assert.deepEqual(deal.body.properties.sort(), ['closedate', 'dealname', 'onboarding_owner']);
    assert.equal(deal.auth, 'Bearer pat-test');
  } finally { globalThis.fetch = realFetch; }
});

test('no HubSpot connection: the variables are simply empty, nothing throws', async () => {
  const t = tables();
  t.crm_sync_configs = [];
  const vars = await hubspotTemplateVars(db(t), 'w1', { dealId: 'deal-1', texts: ['{{hubspot.deal.dealname}}'] });
  assert.deepEqual(vars, {});
});

test('a text with no hubspot variable makes no call at all', async () => {
  const realFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = async () => { called = true; return new Response('{}'); };
  try {
    assert.deepEqual(await hubspotTemplateVars(db(tables()), 'w1', { dealId: 'deal-1', texts: ['{{account.name}}'] }), {});
    assert.equal(called, false);
  } finally { globalThis.fetch = realFetch; }
});

test('the field list puts custom fields first', async () => {
  const list = await hubspotFieldList(db(tables()), 'w1');
  assert.equal(list.deal[0].name, 'onboarding_owner');
  assert.equal(list.company[0].name, 'industry');
});
