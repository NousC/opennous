// Reading a customer's own account-health fields out of their CRM.
//
// Run: pnpm --filter @nous/core build && node --test packages/core/test/crmAccountHealth.test.mjs
//
// The risk this guards is not "does the map have the right keys" — it is that a portal WITHOUT
// these custom properties starts writing junk against every one of its companies, or that
// a portal WITH them silently stops being read because a shape changed. Both are quiet failures
// on a page a customer-success team is supposed to trust.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  accountHealthProperties, readAccountHealth, accountHealthFacts,
  registerAccountHealthMap, DEFAULT_HUBSPOT_HEALTH_MAP,
} from '../dist/integrations/crm/accountHealth.js';

// The public default map, pinned: a Cloud checkout loads its hosted map at import (tested in
// test/cloud/accountHealthMap.test.mjs), and this file must read the same in both builds.
registerAccountHealthMap('hubspot', DEFAULT_HUBSPOT_HEALTH_MAP);

test('the read asks for every property the map can use, and nothing twice', () => {
  const props = accountHealthProperties('hubspot');
  assert.ok(props.includes('account_status'));
  assert.ok(props.includes('mrr'));
  assert.ok(props.includes('upgrade_products'));
  assert.equal(props.length, new Set(props).size, 'duplicate property in the read list');
});

test('a provider we have no map for asks for nothing rather than guessing', () => {
  assert.deepEqual(accountHealthProperties('salesforce'), []);
  assert.deepEqual(readAccountHealth('salesforce', { account_status: 'Client' }), {});
});

test('a prospect yields nothing, so the sync does not write junk against every company', () => {
  // What a non-customer company actually looks like on the wire: the properties are requested,
  // the portal returns them empty. Most of a typical portal's companies are this.
  const empty = readAccountHealth('hubspot', {
    name: 'Some Company', account_status: '', mrr: '', customer_tier: null,
    active_users_30d: '', upgrade_products: '',
  });
  assert.deepEqual(empty, {});
  assert.deepEqual(accountHealthFacts(empty), []);
});

test('a portal that has none of these properties is not an error', () => {
  assert.deepEqual(readAccountHealth('hubspot', { name: 'Acme', domain: 'acme.example' }), {});
});

test('a customer row maps onto the canonical vocabulary with its types intact', () => {
  const h = readAccountHealth('hubspot', {
    account_status: 'Client',
    customer_success_owner: '90000017',
    customer_tier: 'Tier B',
    mrr: '175',
    active_products: 'Lumen Finance;Lumen Check',
    health_score: '47',
    active_users_30d: '0',
    total_users: '9',
    usage_30d: '14',
    last_active_date: '2026-05-10T15:30:00Z',
    upgrade_products: 'Lumen Insights;Lumen Sync Pro',
    upgrade_stage: 'In Conversation',
    upgrade_value: '249',
    customer_goals: 'Shorten time to contract;Cut paperwork errors',
  });
  assert.equal(h['cs.status'], 'client');
  assert.equal(h['cs.owner_external_id'], '90000017');
  // Numbers stay numbers. The CS page does arithmetic on MRR and compares usage across quarters;
  // a string '0' is truthy and would turn "nobody logged in" into "healthy".
  assert.strictEqual(h['cs.mrr'], 175);
  assert.strictEqual(h['cs.active_users_30d'], 0);
  assert.strictEqual(h['cs.usage_30d'], 14);
  assert.strictEqual(h['cs.health_score'], 47);
  assert.strictEqual(h['cs.upgrade_value'], 249);
  // Semicolon lists become arrays.
  assert.deepEqual(h['cs.products'], ['Lumen Finance', 'Lumen Check']);
  assert.deepEqual(h['cs.goals'], ['Shorten time to contract', 'Cut paperwork errors']);
  assert.equal(h['cs.last_used_at'], '2026-05-10T15:30:00.000Z');
});

test('status is normalised, because the page reasons over it', () => {
  const of = (v) => readAccountHealth('hubspot', { account_status: v, mrr: '10' })['cs.status'];
  assert.equal(of('Client'), 'client');
  assert.equal(of('Cancelled'), 'cancelled');
  assert.equal(of('Prospect'), 'prospect');
  // An unrecognised picklist value is NOT silently treated as a live customer. A portal can have an
  // 'Archived' and a 'Partner'; calling either of them a client would put them on the page.
  assert.equal(of('Archived'), 'other');
  assert.equal(of('Partner'), 'other');
});

test('the first named property wins, so a fallback never overrides the real field', () => {
  // `account_status` is the maintained field (nearly always filled); `subscription_status` is the older one
  // (often empty) and they disagree. The fallback must only apply where the first is absent.
  const both = readAccountHealth('hubspot', { account_status: 'Cancelled', subscription_status: 'Client' });
  assert.equal(both['cs.status'], 'cancelled');
  const only = readAccountHealth('hubspot', { subscription_status: 'Client' });
  assert.equal(only['cs.status'], 'client');
});

test('facts come out as the pairs the observation writer takes, nulls already dropped', () => {
  const facts = accountHealthFacts(readAccountHealth('hubspot', { account_status: 'Client', mrr: '99' }));
  assert.ok(facts.every(([k, v]) => k.startsWith('cs.') && v != null));
  assert.deepEqual(facts.find(([k]) => k === 'cs.mrr'), ['cs.mrr', 99]);
});

test('a status of prospect is not evidence of being a customer', () => {
  // `account_status` is filled on leads too, so treating any status as evidence gave a health bag
  // to every prospect in the book. Most accounts carrying one are prospects, and the CS page would
  // read all of them to use a sliver.
  assert.deepEqual(readAccountHealth('hubspot', { account_status: 'Prospect' }), {});
  assert.deepEqual(readAccountHealth('hubspot', { account_status: 'Archived' }), {});
  // A prospect who nonetheless carries real commercial facts still counts. Somebody is paying.
  const paying = readAccountHealth('hubspot', { account_status: 'Prospect', mrr: '250' });
  assert.equal(paying['cs.mrr'], 250);
});

test('client and cancelled both earn a bag, because the churn count needs them', () => {
  assert.equal(readAccountHealth('hubspot', { account_status: 'Client' })['cs.status'], 'client');
  assert.equal(readAccountHealth('hubspot', { account_status: 'Cancelled' })['cs.status'], 'cancelled');
});
