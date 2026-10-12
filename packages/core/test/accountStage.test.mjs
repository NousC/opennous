// The account stage (GET-263): read as the furthest-along live person, written by moving people
// so it reads back as exactly what was chosen. Pure tests of the rule and the plan.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accountStage, planAccountStage } from '../dist/pipeline.js';

const apply = (people, moves) => people.map(p => ({ ...p, pipeline_stage: moves.find(m => m.id === p.id)?.to ?? p.pipeline_stage }));
const stageAfter = (people, target) => accountStage(apply(people, planAccountStage(people, target)).map(p => p.pipeline_stage));

test('accountStage: the furthest live person wins; one exit does not bury a live account', () => {
  assert.equal(accountStage(['identified', 'negotiation', 'churned']), 'negotiation');
  assert.equal(accountStage(['closed_lost', 'churned']), 'churned');
  assert.equal(accountStage(['proposal', 'aware']), 'negotiation');   // legacy names resolve
  assert.equal(accountStage([]), null);
});

test('accountStage: an unstaged person is a live lead, not an exit', () => {
  assert.equal(accountStage([null, 'closed_lost']), null);
});

test('planAccountStage: stepping back moves everyone further along, nobody else', () => {
  const people = [{ id: 'a', pipeline_stage: 'negotiation' }, { id: 'b', pipeline_stage: 'demo' }, { id: 'c', pipeline_stage: 'identified' }];
  const moves = planAccountStage(people, 'discovery');
  assert.deepEqual(moves.map(m => m.id).sort(), ['a', 'b']);
  assert.equal(stageAfter(people, 'discovery'), 'discovery');
});

test('planAccountStage: moving forward puts only the primary on the new stage', () => {
  const people = [{ id: 'primary', pipeline_stage: 'connected' }, { id: 'other', pipeline_stage: 'identified' }];
  const moves = planAccountStage(people, 'negotiation');
  assert.deepEqual(moves, [{ id: 'primary', from: 'connected', to: 'negotiation' }]);
  assert.equal(stageAfter(people, 'negotiation'), 'negotiation');
});

test('planAccountStage: already there is a no-op', () => {
  const people = [{ id: 'a', pipeline_stage: 'discovery' }, { id: 'b', pipeline_stage: 'identified' }];
  assert.deepEqual(planAccountStage(people, 'discovery'), []);
});

test('planAccountStage: closed lost exits every live person and leaves the exited alone', () => {
  const people = [{ id: 'a', pipeline_stage: 'demo' }, { id: 'b', pipeline_stage: 'churned' }, { id: 'c', pipeline_stage: null }];
  const moves = planAccountStage(people, 'closed_lost');
  assert.deepEqual(moves.map(m => m.id).sort(), ['a', 'c']);
  // The already-churned person keeps their more specific exit, so the account reads 'churned',
  // which the account page's Stage select shows as Closed Lost. Exited either way.
  assert.ok(['closed_lost', 'churned'].includes(stageAfter(people, 'closed_lost')));
});

test('planAccountStage: reopening a fully exited account moves the primary back onto the ladder', () => {
  const people = [{ id: 'a', pipeline_stage: 'closed_lost' }, { id: 'b', pipeline_stage: 'churned' }];
  const moves = planAccountStage(people, 'discovery');
  assert.deepEqual(moves, [{ id: 'a', from: 'closed_lost', to: 'discovery' }]);
  assert.equal(stageAfter(people, 'discovery'), 'discovery');
});

test('planAccountStage: a won account stepped back to negotiation steps its people back', () => {
  const people = [{ id: 'a', pipeline_stage: 'closed_won' }, { id: 'b', pipeline_stage: 'closed_won' }];
  assert.equal(stageAfter(people, 'negotiation'), 'negotiation');
});
