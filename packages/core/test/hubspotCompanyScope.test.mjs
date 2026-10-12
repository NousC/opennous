// Which HubSpot companies the sync reads when a workspace scopes it (crm_sync_configs.company_scope).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hubspotCompanyScopeGroups } from '../dist/integrations/crm/index.js';

// A portal shaped like Harborline's, as its property schema reads (picklist values invented).
const schema = [
  { name: 'account_status', options: ['Client', 'Cancelled', 'Prospect', 'Partner'] },
  { name: 'name' },
];

test('the default reads every company: no filter at all', () => {
  assert.equal(hubspotCompanyScopeGroups('all', schema), null);
  assert.equal(hubspotCompanyScopeGroups(undefined, schema), null);
  assert.equal(hubspotCompanyScopeGroups(null, schema), null);
});

test('customers_and_deals: any deal, OR a customer lifecycle, OR the portal status says customer or churned', () => {
  const groups = hubspotCompanyScopeGroups('customers_and_deals', schema);
  assert.deepEqual(groups, [
    [{ propertyName: 'num_associated_deals', operator: 'GT', value: 0 }],
    [{ propertyName: 'lifecyclestage', operator: 'EQ', value: 'customer' }],
    [{ propertyName: 'account_status', operator: 'IN', values: ['Client', 'Cancelled'] }],
  ]);
});

test('a prospect or non-ICP status is never a reason to read the company', () => {
  const values = hubspotCompanyScopeGroups('customers_and_deals', schema).flat().flatMap(f => f.values ?? []);
  assert.ok(!values.includes('Prospect'));
  assert.ok(!values.includes('Partner'));
});

test('a portal that spells it differently is matched by meaning, and one without the field still scopes', () => {
  const other = hubspotCompanyScopeGroups('customers_and_deals', [{ name: 'subscription_status', options: ['Active', 'Churned', 'Trial'] }]);
  assert.deepEqual(other.at(-1), [{ propertyName: 'subscription_status', operator: 'IN', values: ['Active', 'Churned'] }]);
  const bare = hubspotCompanyScopeGroups('customers_and_deals', []);
  assert.equal(bare.length, 2, 'deals + lifecycle only');
});

test('never more than five groups, which is all HubSpot search accepts', () => {
  const wide = [
    { name: 'account_status', options: ['Client'] },
    { name: 'subscription_status', options: ['Active'] },
  ];
  assert.ok(hubspotCompanyScopeGroups('customers_and_deals', wide).length <= 5);
});
