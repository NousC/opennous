// GET-1068: an ICP prediction is graded only on what happened AFTER it was made.
// The old rule read the account's current stage, so an account that was already a
// customer when we scored it counted as a win. Pure tests of the disposition rule.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideDisposition, isLearnableDisposition } from '../dist/services/outcomes.js';

const base = { pipelineFrom: 'identified', pipelineTo: 'identified', events: [], decidedBefore: false, timeOut: false };
const decide = (o) => decideDisposition({ ...base, ...o });
const ev = (kind, at, source = 'deal') => ({ kind, at, source });

test('a customer at scoring time is already decided, whatever happens next', () => {
  assert.equal(decide({ pipelineFrom: 'closed_won', pipelineTo: 'closed_won' }), 'already_decided');
  assert.equal(decide({ pipelineFrom: 'client', pipelineTo: 'closed_won' }), 'already_decided');
  // A renewal after scoring is not a conversion.
  assert.equal(decide({ pipelineFrom: 'closed_won', pipelineTo: 'closed_won', events: [ev('won', '2026-10-01')] }), 'already_decided');
});

test('the stage alone never grades an account whose deal closed before scoring', () => {
  // The stage reads closed_won because of a deal that closed in 2024.
  assert.equal(decide({ pipelineTo: 'closed_won', decidedBefore: true }), 'already_decided');
  assert.equal(decide({ pipelineTo: 'closed_lost', decidedBefore: true, timeOut: true }), 'already_decided');
});

test('a deal that closes after scoring grades the prediction', () => {
  assert.equal(decide({ events: [ev('won', '2026-10-01')] }), 'won');
  assert.equal(decide({ events: [ev('lost', '2026-10-01')] }), 'lost');
  // Even with an older deal on the account, the new one decides.
  assert.equal(decide({ decidedBefore: true, pipelineTo: 'closed_won', events: [ev('lost', '2026-10-01')] }), 'lost');
});

test('the first decisive event wins, not won-first', () => {
  assert.equal(decide({ events: [ev('won', '2026-10-20'), ev('lost', '2026-10-02')] }), 'lost');
  assert.equal(decide({ events: [ev('lost', '2026-10-20', 'observation'), ev('won', '2026-10-02', 'observation')] }), 'won');
});

test('lost at scoring: only a later deal decides, else it is already decided once the window ends', () => {
  assert.equal(decide({ pipelineFrom: 'closed_lost', pipelineTo: 'closed_won' }), null);
  assert.equal(decide({ pipelineFrom: 'closed_lost', pipelineTo: 'closed_lost', timeOut: true }), 'already_decided');
  assert.equal(decide({ pipelineFrom: 'closed_lost', events: [ev('won', '2026-10-05')] }), 'won');
});

test('unchanged: stage wins with no history, qualified timeouts lose, cold timeouts are no opportunity', () => {
  assert.equal(decide({ pipelineTo: 'closed_won' }), 'won');
  assert.equal(decide({ pipelineFrom: 'interested', pipelineTo: 'interested', timeOut: true }), 'lost');
  assert.equal(decide({ timeOut: true }), 'no_opportunity');
  assert.equal(decide({ pipelineFrom: 'interested', pipelineTo: 'interested' }), null);
});

test('only won and lost are learned from', () => {
  assert.equal(isLearnableDisposition('won'), true);
  assert.equal(isLearnableDisposition('lost'), true);
  assert.equal(isLearnableDisposition('no_opportunity'), false);
  assert.equal(isLearnableDisposition('already_decided'), false);
});
