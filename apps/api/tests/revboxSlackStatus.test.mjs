// GET-901: the RevBox page's Slack state, derived on the server: the job cards and the Delivery rail
// from the connection now plus each place's latest outcome, and a failed run's own Slack trouble.
import test from 'node:test';
import assert from 'node:assert/strict';
import { boxSlackHealth, withSlackStatus, boxDeliveryStatuses, withRunSlackStatus } from '../src/routes/api/revboxes.mjs';

const post = { id: 'post', type: 'slack', config: { channel_id: 'C0HARBOR1', channel: 'harborline-daily' } };
const deliver = { id: 'deliver', type: 'revbox_delivery', config: {} };
const box = { id: 'b1', delivery: [{ id: 'd1', kind: 'slack', target: 'C0FERN001', channel: 'fernpoint-ops' }] };
const routines = [{ id: 'r1', steps: [post] }, { id: 'r2', steps: [deliver] }];

function fakeSb(runs, reads) {
  return { from: (t) => { reads.push(t); const q = { select: () => q, eq: () => q, in: () => q, order: () => q, limit: () => Promise.resolve({ data: runs, error: null }) }; return q; } };
}

test('cards and rail: one connection read and one runs read, statuses keyed for the UI', async () => {
  const reads = [];
  const runs = [
    { routine_id: 'r1', step_log: [{ id: 'post', type: 'slack', status: 'failed', reason: 'slack_channel_not_found', target: 'C0HARBOR1' }] },
    { routine_id: 'r2', step_log: [{ id: 'deliver', type: 'revbox_delivery', deliveries: [{ id: 'd1', kind: 'slack', target: 'C0FERN001', ok: false, error: 'slack_is_archived' }] }] },
  ];
  const slack = await boxSlackHealth(fakeSb(runs, reads), 'ws', routines, box, { connectionState: async () => ({ connected: true, working: true }) });
  assert.deepEqual(reads, ['agent_routine_runs']);
  assert.equal(slack.jobs.r1.text, 'Invite @Nous to #harborline-daily');
  assert.equal(slack.jobs.r1.copy, '/invite @Nous');
  assert.equal(slack.jobs.r2.text, 'Channel archived · #fernpoint-ops');
  assert.deepEqual(Object.keys(boxDeliveryStatuses(slack)), ['d1']);
  const rows = withSlackStatus([{ job_id: 'r1', step_id: 'post', kind: 'slack', label: '#harborline-daily' }, { job_id: 'r1', kind: 'email', label: 'Email' }], slack);
  assert.equal(rows[0].slack_status.kind, 'invite');
  assert.equal(rows[1].slack_status, undefined);
  // Disconnected: every Slack job and row says so.
  const gone = await boxSlackHealth(fakeSb(runs, []), 'ws', routines, box, { connectionState: async () => ({ connected: false, working: false }) });
  assert.equal(gone.connection.text, 'Slack disconnected');
  assert.equal(gone.connection.fix.href, '/company-sources?connect=slack');
  assert.equal(withSlackStatus([{ job_id: 'r1', step_id: 'post', kind: 'slack' }], gone)[0].slack_status.kind, 'disconnected');
});

test('nothing posts to Slack: no reads at all; an unreadable connection shows nothing', async () => {
  const reads = [];
  let asked = 0;
  assert.equal(await boxSlackHealth(fakeSb([], reads), 'ws', [{ id: 'r3', steps: [{ id: 'w', type: 'webhook' }] }], { delivery: [] }, { connectionState: async () => { asked++; return null; } }), null);
  assert.deepEqual([reads.length, asked], [0, 0]);
  assert.equal(await boxSlackHealth(fakeSb([], []), 'ws', routines, box, { connectionState: async () => null }), null);
  assert.equal(withSlackStatus([{ kind: 'slack' }], null)[0].slack_status, undefined);
});

test('Results: a failed run that hit Slack gains failure.slack; others are untouched', async () => {
  const runs = [
    { id: 'a', job_id: 'r1', error: "Step 2 · Slack: Slack isn't connected", failure: { text: "Slack isn't connected", fix: { label: 'Connect Slack', href: '/integrations' } },
      step_log: [{ id: 'post', type: 'slack', status: 'failed', reason: 'slack_not_connected', target: 'C0HARBOR1' }] },
    { id: 'b', job_id: 'r1', error: 'Step 1 · HubSpot: x', failure: { text: 'x', fix: null }, step_log: [{ type: 'hubspot', status: 'failed' }] },
    { id: 'c', job_id: 'r1', failure: null, step_log: [] },
  ];
  const req = { workspaceId: 'ws', internalUserId: 'u', params: { id: 'b1' } };
  await withRunSlackStatus({}, req, routines, runs, { connectionState: async () => ({ connected: false, working: false }), box });
  assert.equal(runs[0].failure.slack.kind, 'disconnected');
  assert.equal(runs[0].failure.text, "Slack isn't connected");
  assert.equal(runs[1].failure.slack, undefined);
  // Reconnected since: the run's failure stays in words, with no Slack state on top.
  const again = [{ ...runs[0], failure: { text: 'x', fix: null } }];
  await withRunSlackStatus({}, req, routines, again, { connectionState: async () => ({ connected: true, working: true }), box });
  assert.equal(again[0].failure.slack, undefined);
});
