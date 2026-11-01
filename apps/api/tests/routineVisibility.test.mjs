// Personal and shared RevPlays (GET-1087): one rule, enforced on /api/automations, /v2/workflows and
// /v2/rev-plays. A member owns their personal plays; only an admin shares; shared is read-only below admin.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { startFakePostgrest, serveApp, callJson } from './fakePostgrest.mjs';
import { canEditRoutine, canSeeRoutine, createVisibility, visibilityChange, viewerOf } from '../src/lib/routineVisibility.mjs';

const WS = 'ws-1';
const id = (n) => `00000000-0000-4000-8000-00000000000${n}`;
const FLOW = { revbox_id: null, trigger_kind: 'deal_closed_won', steps: [{ id: 'a', type: 'webhook', config: { url: 'https://a.example' } }], version: 1, created_at: '2026-10-01' };
const play = (n, over) => ({ id: id(n), workspace_id: WS, name: `Play ${n}`, enabled: true, user_id: 'admin-1', ...FLOW, ...over });
const seed = (closed = true) => ({
  workspaces: [{ id: WS, team_id: 't1', open_account_visibility: !closed }],
  teams: [{ id: 't1', name: 'T' }],
  subscriptions: [{ team_id: 't1', plan_id: 'api', status: 'active' }],
  workspace_members: [], workflow_provider_connections: [], workflow_providers: [], crm_sync_configs: [], agent_routine_runs: [],
  agent_routines: [
    play(1, { name: 'Team play' }),                                              // no column value: an existing row is shared
    play(2, { name: 'Shared by a member once', user_id: 'member-1' }),           // existing, member-made: still shared
    play(3, { name: 'Mine', user_id: 'member-1', visibility: 'personal' }),
    play(4, { name: 'Theirs', user_id: 'member-2', visibility: 'personal' }),
    play(5, { name: "Admin's own", user_id: 'admin-1', visibility: 'personal' }),
  ],
});
const MEMBER = { memberUserId: 'member-1', viewerScope: 'member', internalUserId: 'member-1', noContent: false };
const ADMIN = { memberUserId: 'admin-1', viewerScope: 'admin', internalUserId: 'admin-1', noContent: false };
const WORKSPACE_KEY = { memberUserId: null, viewerScope: 'admin', noContent: true };
const TEMPLATE_BODY = { trigger: { type: 'deal_closed_won' }, steps: [{ type: 'webhook', url: 'https://a.example' }] };

let tables, pgrest, server, key;
before(async () => {
  tables = seed();
  pgrest = await startFakePostgrest(() => tables);
  const { revPlaysV2Router } = await import('../src/routes/v2/revPlays.mjs');
  const { workflowsV2Router } = await import('../src/routes/v2/workflows.mjs');
  const { automationsRouter } = await import('../src/routes/api/automations.mjs');
  const app = express();
  app.use(express.json());
  const who = (req, _res, next) => { Object.assign(req, { workspaceId: WS, ...key }); next(); };
  app.use('/v2/rev-plays', who, revPlaysV2Router);
  app.use('/v2/workflows', who, workflowsV2Router);
  app.use('/api/automations', who, automationsRouter);
  server = await serveApp(app);
});
after(async () => { await server?.close(); await pgrest?.close(); });
const call = (k, method, path, body) => { key = k; return callJson(server.url, method, path, body); };
const reset = (closed) => { tables = seed(closed); };
const names = (rows) => rows.map(r => r.name).sort();

test('the rule, pure', () => {
  const shared = { user_id: 'a' }, mine = { user_id: 'm', visibility: 'personal' };
  const member = { userId: 'm', admin: false }, admin = { userId: 'a', admin: true }, keyOnly = { userId: null, admin: true };
  assert.equal(canSeeRoutine(shared, member), true);
  assert.equal(canEditRoutine(shared, member), false);
  assert.equal(canEditRoutine(shared, admin), true);
  assert.equal(canSeeRoutine(mine, member), true);
  assert.equal(canEditRoutine(mine, member), true);
  assert.equal(canSeeRoutine(mine, admin), false, 'an admin does not see a member\'s personal play');
  assert.equal(canEditRoutine(mine, admin), false);
  assert.equal(canSeeRoutine(mine, keyOnly), false);
  assert.equal(canEditRoutine(shared, keyOnly), true, 'an admin workspace key still runs the shared ones');
  assert.deepEqual(createVisibility(undefined, member), { visibility: 'personal' });
  assert.deepEqual(createVisibility(undefined, keyOnly), { visibility: 'shared' });
  assert.equal(createVisibility('shared', member).fail.status, 403);
  assert.deepEqual(createVisibility('shared', admin), { visibility: 'shared' });
  assert.equal(createVisibility('team', admin).fail.status, 400);
  assert.equal(visibilityChange({ user_id: 'a', visibility: 'personal' }, 'shared', admin), null);
  assert.equal(visibilityChange(mine, 'shared', member).status, 403);
  assert.equal(viewerOf({ viewerScope: 'admin', noContent: true, memberUserId: 'no-content' }).userId, null);
});

for (const [surface, list, items, path] of [
  ['/v2/rev-plays', '/v2/rev-plays', 'rev_plays', '/v2/rev-plays'],
  ['/v2/workflows', '/v2/workflows', 'workflows', '/v2/workflows'],
  ['/api/automations', '/api/automations', 'automations', '/api/automations'],
]) {
  test(`${surface}: a member lists shared plus their own, an admin never sees a member's`, async () => {
    reset();
    assert.deepEqual(names((await call(MEMBER, 'GET', list)).body[items]), ['Mine', 'Shared by a member once', 'Team play']);
    assert.deepEqual(names((await call(ADMIN, 'GET', list)).body[items]), ["Admin's own", 'Shared by a member once', 'Team play']);
  });

  test(`${surface}: read-only means read-only, and hidden means 404`, async () => {
    reset();
    const write = surface === '/v2/rev-plays' ? { enabled: false } : surface === '/api/automations' ? { enabled: false } : { enabled: false };
    assert.equal((await call(MEMBER, 'PATCH', `${path}/${id(1)}`, write)).status, 403);
    assert.equal((await call(MEMBER, 'DELETE', `${path}/${id(1)}`)).status, 403);
    assert.equal(tables.agent_routines.find(r => r.id === id(1)).enabled, true);
    assert.equal((await call(MEMBER, 'PATCH', `${path}/${id(2)}`, write)).status, 403, 'an old row is shared, whoever made it');
    assert.equal((await call(MEMBER, 'PATCH', `${path}/${id(4)}`, write)).status, 404);
    assert.equal((await call(ADMIN, 'PATCH', `${path}/${id(3)}`, write)).status, 404, 'admins cannot edit a member\'s own');
    assert.equal((await call(ADMIN, 'DELETE', `${path}/${id(3)}`)).status, 404);
    assert.equal((await call(MEMBER, 'PATCH', `${path}/${id(3)}`, write)).status, 200);
    assert.equal((await call(MEMBER, 'DELETE', `${path}/${id(3)}`)).status, 200);
    assert.equal((await call(ADMIN, 'PATCH', `${path}/${id(1)}`, write)).status, 200);
  });
}

test('a member on a closed workspace creates a personal play', async () => {
  reset(true);
  const made = await call(MEMBER, 'POST', '/v2/rev-plays', TEMPLATE_BODY);
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.equal(made.body.rev_play.visibility, 'personal');
  assert.equal(tables.agent_routines.at(-1).user_id, 'member-1');
});

test('only an admin shares, on every door', async () => {
  reset();
  for (const [path, body] of [['/v2/rev-plays', { ...TEMPLATE_BODY, visibility: 'shared' }], ['/v2/workflows', { ...TEMPLATE_BODY, visibility: 'shared' }]]) {
    const refused = await call(MEMBER, 'POST', path, body);
    assert.equal(refused.status, 403, path);
    assert.equal(refused.body.error, 'admin_required');
    assert.equal((await call(ADMIN, 'POST', path, body)).status, 201, path);
  }
  assert.equal((await call(MEMBER, 'PATCH', `/v2/rev-plays/${id(3)}`, { visibility: 'shared' })).status, 403, 'not even their own');
  const shared = await call(ADMIN, 'PATCH', `/v2/rev-plays/${id(5)}`, { visibility: 'shared' });
  assert.equal(shared.status, 200, JSON.stringify(shared.body));
  assert.equal(tables.agent_routines.find(r => r.id === id(5)).visibility, 'shared');
});

test('the limit: five shared for the team, and five personal for each person', async () => {
  reset();
  tables.agent_routines = [1, 2, 3, 4, 5].map(n => play(n, { name: `S${n}` }));
  assert.equal((await call(ADMIN, 'POST', '/v2/rev-plays', { ...TEMPLATE_BODY, visibility: 'shared' })).status, 402);
  assert.equal((await call(MEMBER, 'POST', '/v2/rev-plays', TEMPLATE_BODY)).status, 201, 'a full team list does not stop a personal one');
  tables.agent_routines.push(...[6, 7, 8, 9].map(n => play(n, { id: `p${n}`, user_id: 'member-1', visibility: 'personal' })));
  assert.equal((await call(MEMBER, 'POST', '/v2/rev-plays', TEMPLATE_BODY)).status, 402);
  const listed = (await call(MEMBER, 'GET', '/v2/rev-plays')).body;
  assert.equal(listed.used, 5, 'yours');
  assert.equal(listed.used_shared, 5);
  assert.equal((await call(ADMIN, 'POST', '/v2/rev-plays', TEMPLATE_BODY)).status, 201, 'someone else\'s pool is their own');
});

test('a key with no person cannot make a personal play, and never sees one', async () => {
  reset();
  assert.deepEqual(names((await call(WORKSPACE_KEY, 'GET', '/v2/workflows')).body.workflows), ['Shared by a member once', 'Team play']);
  assert.equal((await call(WORKSPACE_KEY, 'GET', `/v2/workflows/${id(3)}`)).status, 404);
});
