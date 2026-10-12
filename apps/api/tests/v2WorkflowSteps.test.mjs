// What an agent builds over /v2/workflows opens ready in the editor (GET-748): "Account summary"
// is the OpenNous action, an email is a Gmail draft, and an empty body is what the AI step wrote.
//
// Run: node --test apps/api/tests/v2WorkflowSteps.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSteps, jobOf } from '../src/routes/v2/workflows.mjs';
import { flowColumns } from '../src/routes/api/automations.mjs';

test('action names in any form are the OpenNous action', () => {
  for (const v of ['Account summary', 'account-summary', 'ACCOUNT_SUMMARY', 'account_summary']) assert.equal(jobOf(v), 'account_summary');
  assert.equal(jobOf('Draft follow-up'), 'follow_up');
  assert.equal(jobOf('pre-meeting brief'), 'premeeting_brief');
  assert.equal(jobOf('handoff'), 'deal_handoff');
  assert.equal(jobOf('write me a poem'), null);
});

test('the closed-won flow an agent sent becomes the editor\'s: OpenNous action, then a Gmail draft with the summary', () => {
  const steps = normalizeSteps([
    { id: 'step_1', type: 'agent', config: { artifact: 'account_summary' } },
    { id: 'step_2', type: 'email', config: { to: 'theo@x.co', subject: 'Closed-won account summary' } },
  ]);
  assert.deepEqual(steps[0].config, { mode: 'pick', job: 'account_summary', extra: '', model: 'opennous', artifact: 'account_summary' });
  assert.equal(steps[1].type, 'gmail');
  assert.deepEqual(steps[1].config, { mode: 'draft', to: 'theo@x.co', cc: '', subject: 'Closed-won account summary', body: '{{steps.step_1.output}}' });
});

test('an own prompt is a written step; instructions ride on an action; an SMTP email stays email', () => {
  const steps = normalizeSteps([
    { id: 'a', type: 'agent', config: { prompt: 'Find budget talk' } },
    { id: 'b', type: 'agent', config: { action: 'call summary', instructions: 'In German' } },
    { id: 'c', type: 'email', config: { send_from: { id: 'smtp-1' }, to: 'x@y.co' } },
    { id: 'd', type: 'slack', config: { channel: '#wins' } },
  ]);
  assert.equal(steps[0].config.mode, 'write');
  assert.equal(steps[1].config.job, 'call_summary');
  assert.equal(steps[1].config.extra, 'In German');
  assert.equal(steps[2].type, 'email');
  assert.equal(steps[2].config.body, '{{steps.b.output}}');
  assert.equal(steps[3].config.text, '{{steps.b.output}}');
});

test('the app\'s own checker accepts what the API builds', () => {
  const steps = normalizeSteps([
    { id: 'step_1', type: 'agent', config: { action: 'Account summary' } },
    { id: 'step_2', type: 'email', config: { to: 'theo@x.co' } },
  ]);
  const plan = { id: 'api', artifacts: null };
  const built = flowColumns({ when: 'deal_closed_won', trigger_config: { tools: ['hubspot'] }, steps, artifact: 'account_summary', prompt: null }, plan);
  assert.equal(built.fail, undefined, JSON.stringify(built.fail));
});
