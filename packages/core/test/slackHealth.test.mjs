// GET-901: Slack trouble named. The classifier, the outcomes a run's step log records, and the one
// state a job card, the Delivery rail and Results show, derived from the connection now.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifySlackFailure, slackOutcomes, slackStatus, slackHealthView, runSlackStatus, jobUsesSlack,
  SLACK_RECONNECT_HREF, SLACK_INVITE_COMMAND,
} from '../dist/index.js';

const OK = { connected: true, working: true };
const GONE = { connected: false, working: false };
const BROKEN = { connected: true, working: false };

test('classifier: reason codes, raw Slack errors and the words older step logs kept', () => {
  assert.deepEqual(classifySlackFailure('slack_not_connected'), { kind: 'disconnected', connection: true, error: 'not_connected' });
  for (const e of ['invalid_auth', 'account_inactive', 'token_revoked', 'not_authed', 'missing_scope', 'slack_invalid_auth', 'app_uninstalled', 'tokens_revoked']) {
    const c = classifySlackFailure(e);
    assert.equal(c.kind, 'broken', e);
    assert.equal(c.connection, true, e);
  }
  assert.equal(classifySlackFailure('slack_not_in_channel').kind, 'not_in_channel');
  assert.equal(classifySlackFailure('channel_not_found').kind, 'channel_not_found');
  assert.equal(classifySlackFailure('slack_is_archived').kind, 'archived');
  assert.equal(classifySlackFailure('slack_channel_not_found').connection, false);
  // Words, from step logs written before the reason code was kept.
  assert.equal(classifySlackFailure("Slack isn't connected").kind, 'disconnected');
  assert.equal(classifySlackFailure("Slack can't find that channel").kind, 'channel_not_found');
  assert.equal(classifySlackFailure("Slack can't see that channel. If it's private, invite the Nous app: type /invite @Nous in the channel").kind, 'channel_not_found');
  assert.equal(classifySlackFailure("the Nous app isn't in that channel. In Slack, type /invite @Nous in it").kind, 'not_in_channel');
  assert.equal(classifySlackFailure('the Slack connection expired. Reconnect Slack in Sources').kind, 'broken');
  assert.equal(classifySlackFailure('that channel is archived').kind, 'archived');
  assert.equal(classifySlackFailure('slack_rate_limited').kind, 'other');
  assert.equal(classifySlackFailure(''), null);
  assert.equal(classifySlackFailure(null), null);
});

const post = { id: 'post', type: 'slack', config: { action: 'channel', channel_id: 'C0HARBOR1', channel: 'harborline-daily' } };
const deliver = { id: 'deliver', type: 'revbox_delivery', config: {} };
const box = { delivery: [{ id: 'd1', kind: 'slack', target: 'C0FERN001', channel: 'fernpoint-ops' }, { id: 'd2', kind: 'email', target: 'ops@harborline.example' }] };

test('outcomes: a Slack step line and a box delivery, the last word per place, held lines ignored', () => {
  const log = [
    { step: 1, id: 'read', type: 'hubspot', status: 'ok' },
    { step: 3, id: 'post', type: 'slack', status: 'failed', detail: "Slack can't see that channel", reason: 'slack_channel_not_found', target: 'C0HARBOR1' },
    { step: 4, id: 'deliver', type: 'revbox_delivery', status: 'failed', deliveries: [{ id: 'd1', kind: 'slack', target: 'C0FERN001', ok: false, error: 'slack_not_in_channel' }, { id: 'd2', kind: 'email', ok: true }] },
    { step: 5, id: 'held', type: 'slack', status: 'held', detail: 'Would post' },
  ];
  const out = slackOutcomes(log, { routineId: 'r1', steps: [post, deliver], box });
  assert.deepEqual(out.map(o => [o.key, o.ok, o.kind, o.channel]), [
    ['step:r1:post', false, 'channel_not_found', 'harborline-daily'],
    ['box:d1', false, 'not_in_channel', 'fernpoint-ops'],
  ]);
  // A step since pointed at another channel: its old line is not this step's outcome.
  const moved = slackOutcomes(log, { routineId: 'r1', steps: [{ ...post, config: { ...post.config, channel_id: 'C0OTHER01' } }], box });
  assert.equal(moved.some(o => o.key === 'step:r1:post'), false);
  // A destination since removed from the box is not an outcome either.
  assert.equal(slackOutcomes(log, { routineId: 'r1', steps: [post], box: { delivery: [] } }).some(o => o.key === 'box:d1'), false);
});

test('status: connection first, then the channel; a reconnect clears a connection failure', () => {
  const invite = { ok: false, kind: 'channel_not_found', channel: 'harborline-daily' };
  assert.deepEqual(slackStatus({ connection: GONE, outcome: invite }), { kind: 'disconnected', text: 'Slack disconnected', fix: { label: 'Reconnect', href: SLACK_RECONNECT_HREF } });
  assert.equal(slackStatus({ connection: BROKEN }).kind, 'broken');
  assert.deepEqual(slackStatus({ connection: OK, outcome: invite }), { kind: 'invite', text: 'Invite @Nous to #harborline-daily', copy: SLACK_INVITE_COMMAND, channel: 'harborline-daily' });
  assert.equal(slackStatus({ connection: OK, outcome: { ok: false, kind: 'not_in_channel', channel: null } }).text, 'Invite @Nous to the channel');
  assert.equal(slackStatus({ connection: OK, outcome: { ok: false, kind: 'archived', channel: 'old' } }).text, 'Channel archived · #old');
  // Fixed since: the connection works now, so a disconnect on record is no longer a state.
  assert.equal(slackStatus({ connection: OK, outcome: { ok: false, kind: 'disconnected' } }), null);
  assert.equal(slackStatus({ connection: OK, outcome: { ok: true } }), null);
  // A DM that failed is not an invite.
  assert.equal(slackStatus({ connection: OK, outcome: { ok: false, kind: 'channel_not_found', dm: true } }), null);
});

test('card and rail: per job and per destination, newest run first, tests skipped', () => {
  const routines = [{ id: 'r1', steps: [post] }, { id: 'r2', steps: [deliver] }, { id: 'r3', steps: [{ id: 'x', type: 'webhook' }] }];
  const runs = [
    { routine_id: 'r1', state: { test: true }, step_log: [{ id: 'post', type: 'slack', status: 'ok', target: 'C0HARBOR1' }] },
    { routine_id: 'r1', step_log: [{ id: 'post', type: 'slack', status: 'failed', reason: 'slack_not_in_channel', target: 'C0HARBOR1' }] },
    { routine_id: 'r2', step_log: [{ id: 'deliver', type: 'revbox_delivery', deliveries: [{ id: 'd1', kind: 'slack', target: 'C0FERN001', ok: true }] }] },
    { routine_id: 'r2', step_log: [{ id: 'deliver', type: 'revbox_delivery', deliveries: [{ id: 'd1', kind: 'slack', target: 'C0FERN001', ok: false, error: 'slack_channel_not_found' }] }] },
  ];
  const v = slackHealthView({ connection: OK, routines, runs, box });
  assert.equal(v.connection, null);
  assert.equal(v.jobs.r1.text, 'Invite @Nous to #harborline-daily');
  assert.equal(v.jobs.r2, undefined, 'the newer run delivered, so the box destination is fine');
  assert.equal(v.jobs.r3, undefined);
  assert.equal(v.deliveries['step:r1:post'].kind, 'invite');
  assert.equal(v.deliveries['box:d1'], undefined);
  // Disconnected: every job that posts to Slack says so, the webhook job does not.
  const gone = slackHealthView({ connection: GONE, routines, runs, box });
  assert.equal(gone.connection.kind, 'disconnected');
  assert.equal(gone.jobs.r1.kind, 'disconnected');
  assert.equal(gone.jobs.r2.kind, 'disconnected');
  assert.equal(gone.jobs.r3, undefined);
  // A box with no Slack anywhere has no Slack state, connected or not.
  assert.equal(slackHealthView({ connection: GONE, routines: [routines[2]], runs: [], box: { delivery: [] } }).connection, null);
  assert.equal(jobUsesSlack([deliver], { delivery: [] }), false);
  assert.equal(jobUsesSlack([deliver], box), true);
});

test('Results: a failed run says what its Slack post hit, against the connection now', () => {
  const run = { job_id: 'r1', error: "Step 3 · Slack: Slack can't see that channel", step_log: [{ id: 'post', type: 'slack', status: 'failed', reason: 'slack_channel_not_found', target: 'C0HARBOR1' }] };
  assert.equal(runSlackStatus({ connection: OK, run, steps: [post] }).text, 'Invite @Nous to #harborline-daily');
  // The run that hit a removed connection, with no reason code on its line (an older run).
  const old = { job_id: 'r1', error: "Step 3 · Slack: Slack isn't connected", step_log: [{ id: 'post', type: 'slack', status: 'failed', detail: "Slack isn't connected" }] };
  assert.equal(runSlackStatus({ connection: GONE, run: old, steps: [post] }).kind, 'disconnected');
  assert.equal(runSlackStatus({ connection: OK, run: old, steps: [post] }), null, 'reconnected since');
  // Only the error survived.
  assert.equal(runSlackStatus({ connection: GONE, run: { error: "Step 3 · Slack: Slack isn't connected", step_log: [] } }).kind, 'disconnected');
  // A box delivery to an archived channel, named from the box.
  const boxRun = { job_id: 'r2', step_log: [{ id: 'deliver', type: 'revbox_delivery', deliveries: [{ id: 'd1', kind: 'slack', target: 'C0FERN001', ok: false, error: 'slack_is_archived' }] }] };
  assert.equal(runSlackStatus({ connection: OK, run: boxRun, box }).text, 'Channel archived · #fernpoint-ops');
  // Not Slack.
  assert.equal(runSlackStatus({ connection: OK, run: { error: "Step 2 · HubSpot: HubSpot isn't connected", step_log: [] } }), null);
});

test('the engine keeps a Slack line\'s target and, on failure, its reason code', async () => {
  const { runStepsForTest: runSteps, registerStepHandler } = await import('../dist/services/automationRun.mjs');
  const db = { from() { const q = { select: () => q, eq: () => q, in: () => q, is: () => q, order: () => q, limit: () => q, update: () => q, insert: () => q, upsert: () => q,
    single: async () => ({ data: null, error: null }), maybeSingle: async () => ({ data: null, error: null }), then: (ok) => Promise.resolve({ data: [], error: null }).then(ok) }; return q; } };
  const ctx = { supabase: db, workspaceId: 'ws', entityId: null };
  const auto = (steps) => ({ id: 'r1', name: 'Harborline daily', user_id: 'u1', steps });
  registerStepHandler('slack', async () => ({ ok: false, reason: 'slack_not_connected' }));
  const failed = await runSteps(auto([post]), null, { stage: 'x', ctx });
  assert.deepEqual([failed.log.at(-1).reason, failed.log.at(-1).target], ['slack_not_connected', 'C0HARBOR1']);
  registerStepHandler('slack', async () => ({ ok: true }));
  const ok = await runSteps(auto([post]), null, { stage: 'x', ctx });
  assert.equal(ok.log.at(-1).target, 'C0HARBOR1');
  assert.equal(ok.log.at(-1).reason, undefined);
  assert.deepEqual(slackOutcomes(failed.log, { routineId: 'r1', steps: [post] }).map(o => o.kind), ['disconnected']);
});
