// Stages follow the deal (GET-1028): a deal nobody on their side answered in 60 days closes as
// went_quiet; a call's type moves the stage it implies.
//
// Run: cd apps/worker && node --test tests/wentQuiet.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSignOfLife, quietGroups } from '../src/workers/wentQuiet.mjs';
import { stageForCallType } from '@nous/core';

test('their reply or a meeting is a sign of life; our send and a newsletter are not', () => {
  assert.equal(isSignOfLife({ property: 'interaction.email_received', raw: {} }), true);
  assert.equal(isSignOfLife({ property: 'interaction.meeting_held', raw: null }), true);
  assert.equal(isSignOfLife({ property: 'interaction.email_received', raw: { bulk: true } }), false);
  assert.equal(isSignOfLife({ property: 'interaction.email_sent', raw: {} }), false);
  assert.equal(isSignOfLife({ property: 'interaction.slack_message', raw: { is_outbound: true } }), false);
});

test('a deal goes quiet only when every person on it has been silent past the cutoff', () => {
  const cutoff = '2026-08-25';
  const groups = new Map([
    ['ws:co-quiet', [{ id: 'a', stageSince: '2026-06-20' }, { id: 'b', stageSince: '2026-06-20' }]],
    ['ws:co-live', [{ id: 'c', stageSince: '2026-06-20' }, { id: 'd', stageSince: '2026-06-20' }]],
    ['ws:co-new', [{ id: 'e', stageSince: '2026-10-01' }]],
  ]);
  const last = new Map([['a', '2026-07-01'], ['d', '2026-10-20']]);
  assert.deepEqual(quietGroups(groups, last, cutoff).map(([k]) => k), ['ws:co-quiet']);
});

test("a call's type moves the stage it implies; other calls move nothing", () => {
  assert.equal(stageForCallType('demo'), 'demo');
  assert.equal(stageForCallType('proposal'), 'negotiation');
  assert.equal(stageForCallType('onboarding'), 'closed_won');
  assert.equal(stageForCallType('business_review'), 'closed_won');
  assert.equal(stageForCallType('discovery'), null);
  assert.equal(stageForCallType(null), null);
});
