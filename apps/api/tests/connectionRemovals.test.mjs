// GET-901: every removal of an integration connection is on the audit trail, with who removed it,
// which path, and (for Slack) the team and bot ids; a removed Slack connection is told once.
import test from 'node:test';
import assert from 'node:assert/strict';
import { recordConnectionRemovals } from '../src/lib/audit.mjs';

test('one audit row per removed connection, Slack ids kept, tokens never', async () => {
  const rows = [], told = [], lines = [];
  const cloud = { slackHealth: { connectionRemoved: async (a) => { told.push(a); } } };
  recordConnectionRemovals({ fake: true }, [
    { id: 'c-slack', workspace_id: 'ws1', name: 'Slack', encrypted_credentials: { bot_token: 'enc:secret', slack_team_id: 'T0HARBOR', bot_user_id: 'U0BOT' }, workflow_providers: { name: 'slack' } },
    { id: 'c-hub', workspace_id: 'ws1', name: 'Harborline HubSpot', encrypted_credentials: { api_key: 'enc:x' }, workflow_providers: { name: 'hubspot' } },
  ], { actor: { user_id: 'u-7', email: 'dana@harborline.example', ip: '203.0.113.9' }, via: 'disconnect_route', cloud, audit: (r) => rows.push(r), log: (l) => lines.push(l) });
  await new Promise(r => setImmediate(r));
  assert.deepEqual(rows.map(r => [r.action, r.target_id, r.target_workspace_id, r.actor_user_id, r.metadata.provider, r.metadata.provider_type, r.metadata.via]), [
    ['integration.disconnect', 'c-slack', 'ws1', 'u-7', 'Slack', 'slack', 'disconnect_route'],
    ['integration.disconnect', 'c-hub', 'ws1', 'u-7', 'Harborline HubSpot', 'hubspot', 'disconnect_route'],
  ]);
  assert.deepEqual([rows[0].metadata.slack_team_id, rows[0].metadata.bot_user_id], ['T0HARBOR', 'U0BOT']);
  assert.equal(JSON.stringify(rows).includes('secret'), false);
  assert.equal(rows[0].ip, '203.0.113.9');
  assert.match(lines[0], /^\[connection-removed\] ws=ws1 provider=slack id=c-slack via=disconnect_route by=u-7$/);
  // Only the Slack one is told, with who and how.
  assert.deepEqual(told.map(t => [t.connectionId, t.workspaceId, t.provider, t.via, t.actor.user_id]), [['c-slack', 'ws1', 'slack', 'disconnect_route', 'u-7']]);
});

test('a system path has no actor; a bad row or a failing alert never throws', async () => {
  const rows = [];
  const cloud = { slackHealth: { connectionRemoved: async () => { throw new Error('alert down'); } } };
  recordConnectionRemovals(null, [null, { id: 'c1', workspace_id: 'ws2', provider: 'slack' }], { via: 'workspace_deleted', cloud, audit: (r) => rows.push(r), log: () => {} });
  await new Promise(r => setImmediate(r));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].actor_user_id, null);
  assert.equal(rows[0].metadata.via, 'workspace_deleted');
});
