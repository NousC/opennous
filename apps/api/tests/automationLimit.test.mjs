// Automation limits (GET-528): self-serve keeps five, Custom is unlimited.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { automationLimit } from '../src/lib/plans.mjs';

test('self-serve has five automations, Custom has no limit', () => {
  assert.equal(automationLimit('api'), 5);
  for (const legacy of ['starter', 'pro', 'scale']) assert.equal(automationLimit(legacy), 5, legacy);
  assert.equal(automationLimit('custom'), null);
});
