// The Job Builder on every edition (GET-905): self-host builds RevBox jobs on the operator's own
// model keys, says what to fix in nous.env when a key is missing or rejected, and Settings →
// Instance setup lists the builder's model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { jobBuilderModel, JOB_BUILDER_DEFAULT_MODEL } from '../src/lib/model.mjs';
import { providerFailure, noProviderMessage } from '../src/lib/providerAlert.mjs';
import { aiSetup } from '../src/routes/api/instanceSetup.mjs';
import { defaultHelpers, registerSlackTargets } from '../src/lib/jobBuilder/tools.mjs';

test('the builder runs Claude Sonnet 5 unless JOB_BUILDER_MODEL names another Claude model', () => {
  assert.equal(jobBuilderModel({}).modelId, JOB_BUILDER_DEFAULT_MODEL);
  assert.equal(jobBuilderModel({ JOB_BUILDER_MODEL: 'claude-opus-4-8' }).modelId, 'claude-opus-4-8');
  // Not Claude (the loop speaks Anthropic's Messages format) or unknown: the default, not a dead builder.
  assert.equal(jobBuilderModel({ JOB_BUILDER_MODEL: 'glm-5.2' }).modelId, JOB_BUILDER_DEFAULT_MODEL);
  assert.equal(jobBuilderModel({ JOB_BUILDER_MODEL: 'no-such-model' }).modelId, JOB_BUILDER_DEFAULT_MODEL);
});

test('on self-host a rejected or empty key says what to fix in nous.env, and never claims we were alerted', () => {
  const quiet = () => false;
  const auth = providerFailure({ status: 401, error: { type: 'authentication_error' } }, { subject: 'The job builder', alert: quiet, selfHosted: true });
  assert.equal(auth.code, 'model_unavailable');
  assert.match(auth.message, /nous\.env/);
  assert.doesNotMatch(auth.message, /alerted/);
  const credit = providerFailure({ status: 402, error: { type: 'billing_error', message: 'credit balance is too low' } }, { alert: quiet, selfHosted: true });
  assert.match(credit.message, /out of credit/);
  // Cloud keeps its message: there it is our key, and ops is told.
  assert.match(providerFailure({ status: 401, error: { type: 'authentication_error' } }, { alert: quiet, selfHosted: false }).message, /alerted/);
  assert.match(noProviderMessage('The job builder', { selfHosted: true }), /OPENROUTER_API_KEY or ANTHROPIC_API_KEY in nous\.env/);
});

test('Instance setup lists the Job Builder: its model, and ready only with a Claude route', () => {
  const row = (env) => aiSetup(env).jobs.find(j => j.tier === 'job_builder');
  assert.deepEqual(
    { ...row({ OPENROUTER_API_KEY: 'sk-or-test' }), ready: row({ OPENROUTER_API_KEY: 'sk-or-test' }).ready },
    { tier: 'job_builder', label: 'Building RevBox jobs', model: 'claude-sonnet-5', route: 'anthropic', ready: true, fallback: null, fallbackReady: null },
  );
  assert.equal(row({ ANTHROPIC_API_KEY: 'sk-ant-test' }).ready, true);
  assert.equal(row({}).ready, false);
});

test('without Cloud there is no Slack: the builder sees none and proposes none; Cloud registers its lister', async () => {
  const h = defaultHelpers();
  assert.deepEqual(await h.slackTargets({ sb: null, workspaceId: 'ws' }), { connected: false, team: null, channels: [], people: [] });
  registerSlackTargets(async ({ workspaceId }) => ({ connected: true, team: null, channels: [{ id: 'C1', name: `cs-${workspaceId}` }], people: [] }));
  try {
    assert.equal((await h.slackTargets({ sb: null, workspaceId: 'ws' })).channels[0].name, 'cs-ws');
  } finally { registerSlackTargets(null); }
});
