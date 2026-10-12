// One run per account per conversation (GET-834): a call that raised five signals drafted five
// emails to the same person. The pure halves.
//
// Run: node --test packages/core/test/signalRunGroups.test.mjs   (after `tsc`)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupSignalsForRuns, signalMoment, signalRunKey } from '../dist/services/automationRun.mjs';

const ACC = 'acc-harborline';
const OTHER = 'acc-fernpoint';
const AT = '2026-10-07T15:02:11.000Z';
const sig = (id, kind, extra = {}) => ({ id, kind, account_id: ACC, occurred_at: AT, source_ref: null, content: `${kind} text`, ...extra });

test('five signals from one call make one group, led by the one that most needs an answer', () => {
  const groups = groupSignalsForRuns([
    sig('s1', 'next_step'), sig('s2', 'buying_signal'), sig('s3', 'objection_raised'),
    sig('s4', 'budget_discussed'), sig('s5', 'competitor_mentioned'),
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].lead.id, 's3');
  assert.deepEqual(groups[0].lead.also.map((s) => s.id), ['s2', 's5', 's1', 's4']);
});

test('different accounts and different conversations stay apart', () => {
  const groups = groupSignalsForRuns([
    sig('a', 'buying_signal'),
    sig('b', 'buying_signal', { account_id: OTHER }),
    sig('c', 'objection_raised', { occurred_at: '2026-10-09T09:00:00.000Z' }),
    sig('d', 'objection_raised', { account_id: null }),
  ]);
  assert.equal(groups.length, 3);
});

test('the conversation is where it was said, else the minute it was said', () => {
  assert.equal(signalMoment({ source_ref: ' https://notes.example/m/1 ', occurred_at: AT }), 'ref:https://notes.example/m/1');
  assert.equal(signalMoment({ occurred_at: '2026-10-07T15:02:59.999Z' }), signalMoment({ occurred_at: AT }));
  // Two signals from the same call, stamped at different times: one call, because the link matches.
  const g = groupSignalsForRuns([sig('x', 'buying_signal', { source_ref: 'r1' }), sig('y', 'next_step', { source_ref: 'r1', occurred_at: '2026-10-07T15:40:00.000Z' })]);
  assert.equal(g.length, 1);
});

test('a lone signal leads its own run with nothing riding along', () => {
  const [g] = groupSignalsForRuns([sig('only', 'buying_signal')]);
  assert.equal(g.lead.id, 'only');
  assert.equal(g.lead.also, undefined);
});

test('the run key names routine, account and conversation', () => {
  assert.equal(signalRunKey('r1', ACC, 'ref:x'), `r1:signal-moment:${ACC}:ref:x`);
});
