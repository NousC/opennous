// Product users show interest the way a reply does (GET-751): a signup, or a week of product use
// from the PostHog source, moves a person to 'interested', which is what lists them on People and
// their account on Accounts.
//
// Run: pnpm --filter @nous/core build && node --test packages/core/test/productUserStage.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { targetStageFor, STAGE_DRIVING_TYPES } from '../dist/db/pipelineStage.js';

test('a signup and a week of product use are interest', () => {
  assert.equal(targetStageFor('signed_up'), 'interested');
  assert.equal(targetStageFor('product_used'), 'interested');
  assert.ok(STAGE_DRIVING_TYPES.has('signed_up') && STAGE_DRIVING_TYPES.has('product_used'));
});

test('the rest of the ladder is unchanged', () => {
  assert.equal(targetStageFor('website_visit'), 'connected');
  assert.equal(targetStageFor('meeting_held'), 'discovery');
  assert.equal(targetStageFor('email_sent'), null);
});
