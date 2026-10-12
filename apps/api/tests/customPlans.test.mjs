// Custom plans (GET-761): the per-client quotes are the Workspace layer's. With nothing
// registered (a self-hosted install) every Custom team reads as "Quoted" — null.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { customPlanFor, registerCustomPlans, CUSTOM_BASICS } from '../src/lib/customPlans.mjs';

test('nothing registered: no quote on file for any team', () => {
  assert.equal(customPlanFor('team-1'), null);
});

test('a registered row fills in the basics and the label', () => {
  registerCustomPlans({ 'team-1': { priceUsd: 100, credits: 2_000, custom: ['A custom integration'] } });
  assert.deepEqual(customPlanFor('team-1'), {
    priceUsd: 100, credits: 2_000, basics: CUSTOM_BASICS, custom: ['A custom integration'], customLabel: 'Custom integrations',
  });
  assert.equal(customPlanFor('team-2'), null);
  registerCustomPlans({});
});
