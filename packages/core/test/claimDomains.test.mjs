// Every category declares its domain, and no reader crosses one (GET-409).
//
// The split existed as a table in docs/claims.md; readers keyed on category names. That is how a
// customer's expansion ask, filed as buying_signal, advanced a prospect's pipeline stage for a
// fortnight. The domain is the rail: a reader for one domain cannot be joined by a category from
// another, and a taxonomy change that moved a category across the line fails a test here.
//
// Run: node --test packages/core/test/claimDomains.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CLAIM_CATEGORIES, CLAIM_DOMAINS, claimDomainOf, categoriesInDomain } from '../dist/db/claimCategories.js';
import { healthKindOf } from '../dist/services/accountHealthState.js';

test('every category has a declared domain from the closed set', () => {
  for (const c of CLAIM_CATEGORIES) assert.ok(CLAIM_DOMAINS.includes(c.domain), `${c.key} has domain ${c.domain}`);
});

test('the four domains hold exactly what they should', () => {
  assert.deepEqual([...categoriesInDomain('account')].sort(),
    ['authority', 'discovery', 'firmographic', 'preference', 'relationship', 'seasonality', 'staff_change', 'status_quo', 'tech_stack']);
  assert.deepEqual([...categoriesInDomain('deal')].sort(), ['blocker', 'budget', 'buying_signal', 'competitor', 'objection', 'requirement', 'timeline']);
  assert.deepEqual([...categoriesInDomain('customer')].sort(), ['adoption', 'expansion_signal', 'proficiency', 'risk_signal']);
  assert.deepEqual([...categoriesInDomain('product')].sort(), ['goal', 'pain', 'performance']);
  assert.deepEqual([...categoriesInDomain('general')], ['general']);
});

test('the hard rules the reviewer asked to preserve, as domains', () => {
  // Buying signal = movement toward the initial sale. Expansion = more, by an existing customer.
  assert.equal(claimDomainOf('buying_signal'), 'deal');
  assert.equal(claimDomainOf('expansion_signal'), 'customer');
  // Objection = a prospect's reason not to buy. Risk = the customer relationship deteriorating.
  assert.equal(claimDomainOf('objection'), 'deal');
  assert.equal(claimDomainOf('risk_signal'), 'customer');
  // Pain = a problem, implying neither purchase nor churn.
  assert.equal(claimDomainOf('pain'), 'product');
  // Unknown → general, never a guess.
  assert.equal(claimDomainOf('vibes'), 'general');
  assert.equal(claimDomainOf(null), 'general');
});

test('the stage worker reads a deal-domain category, and only that', () => {
  // stageDerivation asserts this at load; here it is asserted where a taxonomy edit runs tests.
  assert.equal(claimDomainOf('buying_signal'), 'deal');
});

test('the health reader takes customer-domain rows and the two borrowed legacy shapes, nothing else', () => {
  assert.equal(healthKindOf({ category: 'risk_signal', metadata: {} }), 'risk');
  assert.equal(healthKindOf({ category: 'pain', metadata: { signal_type: 'health_risk' } }), 'risk', 'pre-GET-401 shape, still read');
  assert.equal(healthKindOf({ category: 'buying_signal', metadata: { signal_type: 'health_expansion' } }), 'expansion', 'pre-GET-401 shape, still read');
  // A deal-domain claim that picked up a health tag by accident does not move standing.
  assert.equal(healthKindOf({ category: 'objection', metadata: { signal_type: 'health_risk' } }), null);
  assert.equal(healthKindOf({ category: 'competitor', metadata: { signal_type: 'health_expansion' } }), null);
  // Nor a product-domain one.
  assert.equal(healthKindOf({ category: 'goal', metadata: { signal_type: 'health_expansion' } }), null);
});
