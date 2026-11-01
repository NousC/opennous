// The setup block of /v2/workspace/whoami (GET-1087): what the /start skill reads in one call.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { startFakePostgrest, serveApp, callJson } from './fakePostgrest.mjs';
import { setupBlock, visibleConnections } from '../src/lib/whoamiSetup.mjs';

const WS = 'ws-1';
const provider = (id, name) => ({ id, name });
const tablesFor = () => ({
  workspaces: [{ id: WS, team_id: 't1', name: 'Harborline', onboarding_activated_at: null }],
  teams: [{ id: 't1', name: 'T' }],
  team_members: [{ team_id: 't1', user_id: 'founder-1', role: 'founder' }, { team_id: 't1', user_id: 'member-1', role: 'member' }],
  users: [{ id: 'founder-1', name: 'Ida', email: 'ida@harborline.example' }, { id: 'member-1', name: 'Tomas', email: 'tomas@harborline.example' }],
  subscriptions: [{ team_id: 't1', plan_id: 'api', status: 'trialing', trial_ends_at: '2099-01-01T00:00:00.000Z' }],
  workflow_providers: [provider('p1', 'gmail_oauth'), provider('p2', 'fireflies'), provider('p3', 'hubspot')],
  workflow_provider_connections: [
    { id: 'c1', workspace_id: WS, owner_user_id: 'founder-1', provider_id: 'p1', account_email: 'ida@harborline.example', encrypted_credentials: { api_key: 'enc-secret' }, provider: { name: 'gmail_oauth' } },
    { id: 'c2', workspace_id: WS, owner_user_id: 'member-1', provider_id: 'p2', encrypted_credentials: { api_key: 'enc-secret' }, provider: { name: 'fireflies' } },
    { id: 'c3', workspace_id: WS, owner_user_id: null, provider_id: 'p3', provider: { name: 'hubspot' } },
  ],
  crm_sync_configs: [{ workspace_id: WS, provider: 'hubspot' }],
  foundations: [], contact_enrichment_jobs: [], entities: [], contacts: [], observations: [],
  workspace_webhook_subscriptions: [{ id: 'h1', workspace_id: WS, url: 'https://hooks.example/secret-path' }],
  agent_routines: [{ id: 'r1', workspace_id: WS }, { id: 'r2', workspace_id: WS }],
  workspace_members: [{ workspace_id: WS, user_id: 'founder-1', role: 'owner' }, { workspace_id: WS, user_id: 'member-1', role: 'member' }],
});

let pgrest, server, key;
before(async () => {
  const tables = tablesFor();
  pgrest = await startFakePostgrest(() => tables);
  const { workspaceStatusV2Router } = await import('../src/routes/v2/workspaceStatus.mjs');
  const app = express();
  app.use(express.json());
  app.use('/v2/workspace', (req, _res, next) => { Object.assign(req, { workspaceId: WS, ...key }); next(); }, workspaceStatusV2Router);
  server = await serveApp(app);
});
after(async () => { await server?.close(); await pgrest?.close(); });
const whoami = async (k) => { key = k; return callJson(server.url, 'GET', '/v2/workspace/whoami'); };

test('an admin key sees the workspace, with the counts and the plan', async () => {
  const { status, body } = await whoami({ memberUserId: 'founder-1', viewerScope: 'admin', noContent: false });
  assert.equal(status, 200);
  const s = body.setup;
  assert.deepEqual(s.integrations, ['fireflies', 'gmail_oauth', 'hubspot']);
  assert.equal(s.email_connected, true);
  assert.equal(s.notetaker_connected, true);
  assert.equal(s.crm_connected, true);
  assert.equal(s.sync.state, 'none');
  assert.deepEqual(s.foundations, { done: [], missing: ['icp'] });
  assert.equal(s.has_icp, false, 'the block extends what whoami already said');
  assert.equal(s.webhooks, 1);
  assert.equal(s.rev_plays.used, 2);
  assert.equal(s.members, 2);
  assert.equal(s.plan.trial_ends_at, '2099-01-01T00:00:00.000Z');
});

test('a member key sees shared tools and its own, never a teammate\'s mailbox', async () => {
  const { body } = await whoami({ memberUserId: 'member-1', viewerScope: 'member', noContent: false });
  assert.deepEqual(body.setup.integrations, ['fireflies', 'hubspot']);
  assert.equal(body.setup.email_connected, false);
  assert.equal(body.setup.notetaker_connected, true);
});

test('nothing secret leaves in the block', async () => {
  const { body } = await whoami({ memberUserId: 'founder-1', viewerScope: 'admin', noContent: false });
  const text = JSON.stringify(body.setup);
  for (const leak of ['enc-secret', 'secret-path', 'encrypted_credentials', 'account_email', '@harborline', 'tomas']) assert.equal(text.includes(leak), false, leak);
});

test('pure pieces: a workspace key is not narrowed; a trial date shows only on a no-card trial', () => {
  const conns = [{ owner_user_id: 'a', provider: { name: 'gmail_oauth' } }];
  assert.equal(visibleConnections(conns, { scope: 'admin', memberUserId: null }).length, 1);
  assert.equal(visibleConnections(conns, { scope: 'member', memberUserId: 'b' }).length, 0);
  const paid = setupBlock({ plan: { id: 'api' }, subscription: { status: 'active', trial_ends_at: '2020-01-01', stripe_subscription_id: 's' }, creditsLeft: 7 }, { scope: 'admin' });
  assert.equal(paid.plan.trial_ends_at, null);
  assert.equal(paid.plan.credits_left, 7);
});
