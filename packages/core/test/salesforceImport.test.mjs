// Salesforce on the shared CRM import (GET-853): the token carries the org's host, SOQL pages
// follow nextRecordsUrl, opportunities carry Salesforce's own won/lost flags, and a refresh token
// is traded for a fresh access token before every run.
//
// Run: pnpm --filter @nous/core build && node --test packages/core/test/salesforceImport.test.mjs

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { salesforce, salesforceToken, salesforceAccess, salesforceDomain, fetchPipelineStages } from '../dist/integrations/crm/index.js';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });
const respond = (body, status = 200) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) });

test('a website becomes a bare domain', () => {
  assert.equal(salesforceDomain('https://www.Acme.com/en'), 'acme.com');
  assert.equal(salesforceDomain('acme.io'), 'acme.io');
  assert.equal(salesforceDomain(''), null);
  assert.equal(salesforceDomain('n/a'), null);
});

test('accounts page through nextRecordsUrl on the org host, newest-modified last', async () => {
  const urls = [];
  globalThis.fetch = async (url, init) => {
    urls.push(String(url));
    assert.equal(init.headers.Authorization, 'Bearer tok');
    return urls.length === 1
      ? respond({ done: false, nextRecordsUrl: '/services/data/v59.0/query/01g-200', records: [
          { Id: '001A', Name: 'Acme', Website: 'www.acme.com', Industry: 'Software', BillingCity: 'Berlin', BillingCountry: 'DE', Owner: { Name: 'Ana', Email: 'ana@x.com' }, LastModifiedDate: '2026-10-01T00:00:00.000+0000' },
        ] })
      : respond({ done: true, records: [] });
  };
  const token = salesforceToken('https://acme.my.salesforce.com/', 'tok');
  const p1 = await salesforce.fetchCompanies(token, { since: '2026-09-01T00:00:00Z' });
  assert.match(urls[0], /^https:\/\/acme\.my\.salesforce\.com\/services\/data\/v59\.0\/query\?q=/);
  const soql = decodeURIComponent(urls[0].split('q=')[1]);
  assert.match(soql, /FROM Account WHERE LastModifiedDate > 2026-09-01T00:00:00.000Z ORDER BY LastModifiedDate ASC/);
  assert.deepEqual(p1.records[0], { id: '001A', name: 'Acme', domain: 'acme.com', industry: 'Software', city: 'Berlin', country: 'DE', owner_name: 'Ana', owner_email: 'ana@x.com', updated_at: '2026-10-01T00:00:00.000+0000' });
  assert.equal(p1.cursor, '/services/data/v59.0/query/01g-200');
  const p2 = await salesforce.fetchCompanies(token, { cursor: p1.cursor });
  assert.equal(urls[1], 'https://acme.my.salesforce.com/services/data/v59.0/query/01g-200');
  assert.equal(p2.cursor, null);
});

test('opportunities: won, lost and open from IsClosed/IsWon, with account and contact roles', async () => {
  globalThis.fetch = async () => respond({ done: true, records: [
    { Id: '006W', Name: 'Big', Amount: 50000, StageName: 'Closed Won', IsClosed: true, IsWon: true, CloseDate: '2026-09-30', CreatedDate: '2026-06-01T00:00:00.000+0000', AccountId: '001A', Account: { Name: 'Acme' }, OpportunityContactRoles: { records: [{ ContactId: '003X' }] }, LastModifiedDate: 'x' },
    { Id: '006L', Name: 'Gone', Amount: null, StageName: 'Dead', IsClosed: true, IsWon: false, AccountId: null, LastModifiedDate: 'y' },
    { Id: '006O', Name: 'Live', Amount: '1200', StageName: 'Negotiation', IsClosed: false, IsWon: false, OpportunityContactRoles: null, LastModifiedDate: 'z' },
  ] });
  const { records } = await salesforce.fetchDeals(salesforceToken('https://o.my.salesforce.com', 't'));
  assert.deepEqual(records.map(d => d.status), ['won', 'lost', 'open']);
  assert.equal(records[0].value, 50000);
  assert.equal(records[0].company_external_id, '001A');
  assert.deepEqual(records[0].contact_ids, ['003X']);
  assert.equal(records[1].value, null);
  assert.equal(records[2].value, 1200);
  assert.deepEqual(records[2].contact_ids, []);
});

test('stages come in order with Salesforce\'s own won/lost flags', async () => {
  globalThis.fetch = async () => respond({ done: true, records: [
    { ApiName: 'Prospecting', MasterLabel: 'Prospecting', SortOrder: 1, IsClosed: false, IsWon: false },
    { ApiName: 'Closed Won', MasterLabel: 'Closed Won', SortOrder: 2, IsClosed: true, IsWon: true },
    { ApiName: 'Closed Lost', MasterLabel: 'Closed Lost', SortOrder: 3, IsClosed: true, IsWon: false },
  ] });
  const [p] = await fetchPipelineStages('salesforce', salesforceToken('https://o.my.salesforce.com', 't'));
  assert.deepEqual(p.stages.map(s => [s.label, !!s.isWon, !!s.isLost]), [['Prospecting', false, false], ['Closed Won', true, false], ['Closed Lost', false, true]]);
});

test('the refresh token is traded for a fresh access token; without app credentials the stored one is used', async () => {
  let body;
  globalThis.fetch = async (url, init) => { body = String(init.body); assert.equal(url, 'https://test.salesforce.com/services/oauth2/token'); return respond({ access_token: 'fresh', instance_url: 'https://o2.my.salesforce.com' }); };
  const env = { SALESFORCE_CLIENT_ID: 'cid', SALESFORCE_CLIENT_SECRET: 'sec', SALESFORCE_LOGIN_URL: 'https://test.salesforce.com/' };
  const t = await salesforceAccess({ access_token: 'old', refresh_token: 'r', instance_url: 'https://o.my.salesforce.com' }, env);
  assert.match(body, /grant_type=refresh_token/);
  assert.deepEqual(JSON.parse(t), { i: 'https://o2.my.salesforce.com', t: 'fresh' });
  assert.deepEqual(JSON.parse(await salesforceAccess({ access_token: 'old', instance_url: 'https://o.my.salesforce.com' }, {})), { i: 'https://o.my.salesforce.com', t: 'old' });
  assert.equal(await salesforceAccess({ access_token: 'old' }, {}), null);
  globalThis.fetch = async () => respond({ error: 'invalid_grant', error_description: 'expired access/refresh token' }, 400);
  await assert.rejects(salesforceAccess({ refresh_token: 'r', instance_url: 'https://o' }, env), /expired access\/refresh token/);
});
