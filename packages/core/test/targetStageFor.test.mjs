// The activity → stage mapping, extracted so the LIVE path (advancePipelineStage) and the
// HISTORICAL path (reconstructLadder) cannot disagree about what the funnel is.
//
// These assertions are the contract between them. If the live rules change, a
// reconstructed ladder built on the old rules would train the forecast on a funnel the
// product no longer runs — so the mapping has exactly one definition and this pins it.
//
// Run: pnpm --filter @nous/core build && node --test packages/core/test/targetStageFor.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { targetStageFor } from '../dist/db/pipelineStage.js';

test('plain activity types map to their rung', () => {
  assert.equal(targetStageFor('meeting_held'), 'discovery');
  assert.equal(targetStageFor('meeting_scheduled'), 'meeting_booked');
  assert.equal(targetStageFor('proposal_sent'), 'negotiation');
  assert.equal(targetStageFor('linkedin_connected'), 'connected');
  assert.equal(targetStageFor('deal_won'), 'closed_won');
  assert.equal(targetStageFor('payment_received'), 'closed_won');
  assert.equal(targetStageFor('deal_lost'), 'closed_lost');
});

test('an unknown type maps to nothing', () => {
  assert.equal(targetStageFor('email_sent'), null);
  assert.equal(targetStageFor('whatever'), null);
});

test('an opt-out reply disqualifies regardless of the underlying type', () => {
  for (const sig of ['unsubscribe', 'do_not_contact']) {
    assert.equal(targetStageFor('email_received', { replySignal: sig }), 'disqualified');
    assert.equal(targetStageFor('linkedin_message', { replySignal: sig }), 'disqualified');
  }
});

test('a bounce or auto-reply maps to nothing — not a downgrade, not a rung', () => {
  for (const sig of ['bounce', 'auto_reply']) {
    assert.equal(targetStageFor('email_received', { replySignal: sig }), null);
  }
});

test('a positive reply promotes to interested', () => {
  assert.equal(targetStageFor('email_received', { replySignal: 'positive' }), 'interested');
  assert.equal(targetStageFor('slack_message', { replySignal: 'positive' }), 'interested');
});

test('LinkedIn direction rules: inbound counts, outbound never does', () => {
  assert.equal(targetStageFor('linkedin_message', { isOutbound: false }), 'connected');
  assert.equal(targetStageFor('linkedin_message', { isOutbound: false, replySignal: 'positive' }), 'interested');
  assert.equal(targetStageFor('linkedin_message', { isOutbound: true }), null);
  // Direction unknown is treated as not-inbound — the conservative read, matching the
  // live engine: we never invent engagement we cannot attribute to the buyer.
  assert.equal(targetStageFor('linkedin_message', {}), null);
});

test('an opt-out on LinkedIn still disqualifies, outbound or not', () => {
  assert.equal(targetStageFor('linkedin_message', { isOutbound: true, replySignal: 'unsubscribe' }), 'disqualified');
});
