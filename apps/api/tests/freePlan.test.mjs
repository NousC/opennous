// The Free plan (GET-682): reads from today on a hard 500, one automation, no backfill until paid.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PLANS, normalizePlanId, planName, automationLimit, planTier, planIsLive, planMayBackfill, getPlanFromSubscription } from '../src/lib/plans.mjs';

const free = { plan_id: 'free', status: 'active' };

test('free is its own plan, on the self-serve surface', () => {
  assert.equal(normalizePlanId('free'), 'free');
  assert.equal(planName('free'), 'Free');
  assert.equal(planTier('free'), 'api');
  assert.equal(PLANS.free.aiCreditsPerMonth, 500);
  assert.equal(PLANS.free.hardCreditCap, true);
  assert.equal(getPlanFromSubscription(free).id, 'free');
});

test('one automation on Free, five on self-serve', () => {
  assert.equal(automationLimit('free'), 1);
  assert.equal(automationLimit('api'), 5);
});

test('Free reads but may not backfill; paying or a comp may', () => {
  assert.equal(planIsLive(free), true);
  assert.equal(planMayBackfill(free), false);
  assert.equal(planMayBackfill({ plan_id: 'api', status: 'active', stripe_subscription_id: 'sub_1' }), true);
  assert.equal(planMayBackfill({ plan_id: 'free', status: 'active', is_comp: true }), true);
  assert.equal(planMayBackfill({ plan_id: 'api', status: 'unpaid' }), false);
});
