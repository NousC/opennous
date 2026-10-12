// Linear connection (GET-825): the authorize URL, state/CSRF, the code exchange (Linear mocked),
// tokens encrypted at rest, the default team, and the refresh that keeps a 24h token alive.
//
// Run: node --test apps/api/tests/linearProvider.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeDb } from '../../worker/tests/fakeDb.mjs';

// Before the crypto module loads: it reads the key at import.
process.env.ENCRYPTION_KEY = 'c'.repeat(64);
const ENV = {
  LINEAR_CLIENT_ID: 'lin-client', LINEAR_CLIENT_SECRET: 'shh',
  LINEAR_REDIRECT_URI: 'https://api.example.com/api/workflow-providers/linear/oauth/callback',
};

const L = await import('../src/providers/linear.mjs');
const { decrypt } = await import('../src/providers/crypto.mjs');

const WS = 'ws-1';
const ADMIN = 'u-admin';
const seed = () => ({ workflow_providers: [{ id: 'p-linear', name: 'linear' }], workflow_provider_connections: [] });

function fakeLinearHttp({ teams = [{ id: 't1', key: 'PRD', name: 'Product' }], tokenStatus = 200, gqlErrors = null } = {}) {
  const calls = [];
  const impl = async (url, init = {}) => {
    const body = init.body ? String(init.body) : '';
    calls.push({ url: String(url), body, auth: init.headers?.Authorization ?? init.headers?.authorization ?? null });
    if (String(url) === 'https://api.linear.app/oauth/token') {
      const p = new URLSearchParams(body);
      if (tokenStatus !== 200) return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: tokenStatus });
      const fresh = p.get('grant_type') === 'refresh_token';
      return new Response(JSON.stringify({
        access_token: fresh ? 'lin_access_2' : 'lin_access_1', refresh_token: fresh ? 'lin_refresh_2' : 'lin_refresh_1',
        expires_in: 86399, scope: 'read write issues:create comments:create', token_type: 'Bearer',
      }), { status: 200 });
    }
    if (String(url) === 'https://api.linear.app/graphql') {
      if (gqlErrors) return new Response(JSON.stringify({ errors: gqlErrors }), { status: 200 });
      return new Response(JSON.stringify({ data: {
        organization: { id: 'org-1', name: 'Harborline', urlKey: 'harborline' },
        teams: { nodes: teams },
      } }), { status: 200 });
    }
    return new Response('{}', { status: 404 });
  };
  return { impl, calls };
}

test('authorize URL installs as the app (actor=app) with the scopes we need, and carries a state', () => {
  const { state } = L.createLinearState({ workspaceId: WS, userId: ADMIN });
  const url = new URL(L.buildLinearAuthUrl({ state, env: ENV }));
  assert.equal(url.origin + url.pathname, 'https://linear.app/oauth/authorize');
  assert.equal(url.searchParams.get('client_id'), 'lin-client');
  assert.equal(url.searchParams.get('redirect_uri'), ENV.LINEAR_REDIRECT_URI);
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('actor'), 'app');
  assert.equal(url.searchParams.get('state'), state);
  const scopes = url.searchParams.get('scope').split(',');
  for (const s of ['read', 'write', 'issues:create']) assert.ok(scopes.includes(s), s);
  assert.ok(!scopes.includes('admin'));
});

test('a state works once and only for who minted it', () => {
  const { state } = L.createLinearState({ workspaceId: WS, userId: ADMIN });
  assert.deepEqual(L.consumeLinearState(state)?.workspaceId, WS);
  assert.equal(L.consumeLinearState(state), null);
  assert.equal(L.consumeLinearState('nope'), null);
});

test('completing the connection exchanges the code and stores tokens encrypted, with org and teams', async () => {
  const db = fakeDb(seed());
  const http = fakeLinearHttp();
  const conn = await L.completeLinearConnection(db, { workspaceId: WS, userId: ADMIN, code: 'code-1', env: ENV, fetchImpl: http.impl });
  const row = db.tables.workflow_provider_connections[0];
  assert.equal(conn.id, row.id);
  assert.equal(row.workspace_id, WS);
  assert.equal(row.provider_id, 'p-linear');
  assert.equal(row.is_verified, true);
  const c = row.encrypted_credentials;
  assert.notEqual(c.access_token, 'lin_access_1');
  assert.equal(decrypt(c.access_token), 'lin_access_1');
  assert.equal(decrypt(c.refresh_token), 'lin_refresh_1');
  assert.ok(Date.parse(c.expires_at) > Date.now());
  assert.equal(c.organization.name, 'Harborline');
  assert.deepEqual(c.teams, [{ id: 't1', key: 'PRD', name: 'Product' }]);
  // One team: it is the default, nothing to pick.
  assert.equal(c.default_team_id, 't1');
  // The code exchange sent the secret and the same redirect URI.
  const tokenCall = http.calls.find((x) => x.url.endsWith('/oauth/token'));
  const p = new URLSearchParams(tokenCall.body);
  assert.equal(p.get('grant_type'), 'authorization_code');
  assert.equal(p.get('code'), 'code-1');
  assert.equal(p.get('redirect_uri'), ENV.LINEAR_REDIRECT_URI);
});

test('several teams: no default until an admin picks one; reconnecting keeps the pick', async () => {
  const db = fakeDb(seed());
  const teams = [{ id: 't1', key: 'PRD', name: 'Product' }, { id: 't2', key: 'ENG', name: 'Engineering' }];
  await L.completeLinearConnection(db, { workspaceId: WS, userId: ADMIN, code: 'c', env: ENV, fetchImpl: fakeLinearHttp({ teams }).impl });
  assert.equal(db.tables.workflow_provider_connections[0].encrypted_credentials.default_team_id, null);

  await L.setLinearDefaultTeam(db, { workspaceId: WS, teamId: 't2' });
  assert.equal(db.tables.workflow_provider_connections[0].encrypted_credentials.default_team_id, 't2');
  await assert.rejects(L.setLinearDefaultTeam(db, { workspaceId: WS, teamId: 't-unknown' }), (e) => e.code === 'unknown_team');

  await L.completeLinearConnection(db, { workspaceId: WS, userId: ADMIN, code: 'c2', env: ENV, fetchImpl: fakeLinearHttp({ teams }).impl });
  assert.equal(db.tables.workflow_provider_connections.length, 1, 'one Linear connection per workspace');
  assert.equal(db.tables.workflow_provider_connections[0].encrypted_credentials.default_team_id, 't2');
});

test('an expired token is refreshed before the call, and the new refresh token is stored', async () => {
  const db = fakeDb(seed());
  await L.completeLinearConnection(db, { workspaceId: WS, userId: ADMIN, code: 'c', env: ENV, fetchImpl: fakeLinearHttp().impl });
  db.tables.workflow_provider_connections[0].encrypted_credentials.expires_at = new Date(Date.now() - 1000).toISOString();

  const http = fakeLinearHttp();
  const client = await L.getLinearClient(db, WS, { env: ENV, fetchImpl: http.impl });
  await client.gql('query Viewer { viewer { id } }');
  const refresh = http.calls.find((x) => x.url.endsWith('/oauth/token'));
  assert.equal(new URLSearchParams(refresh.body).get('grant_type'), 'refresh_token');
  assert.equal(new URLSearchParams(refresh.body).get('refresh_token'), 'lin_refresh_1');
  const gqlCall = http.calls.find((x) => x.url.endsWith('/graphql'));
  assert.equal(gqlCall.auth, 'Bearer lin_access_2');
  const c = db.tables.workflow_provider_connections[0].encrypted_credentials;
  assert.equal(decrypt(c.refresh_token), 'lin_refresh_2');
  assert.equal(decrypt(c.access_token), 'lin_access_2');
});

test('no connection: a clear error, not a crash', async () => {
  await assert.rejects(L.getLinearClient(fakeDb(seed()), WS, { env: ENV }), (e) => e.code === 'linear_not_connected');
});

test('GraphQL errors surface as linear_graphql with Linear\'s message', async () => {
  const db = fakeDb(seed());
  await L.completeLinearConnection(db, { workspaceId: WS, userId: ADMIN, code: 'c', env: ENV, fetchImpl: fakeLinearHttp().impl });
  const client = await L.getLinearClient(db, WS, { env: ENV, fetchImpl: fakeLinearHttp({ gqlErrors: [{ message: 'Entity not found' }] }).impl });
  await assert.rejects(client.gql('query X { viewer { id } }'), (e) => e.code === 'linear_graphql' && /Entity not found/.test(e.message));
});
