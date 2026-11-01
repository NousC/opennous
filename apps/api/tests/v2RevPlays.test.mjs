// /v2/rev-plays (GET-1087): RevPlays for agents. The routes run for real against the in-memory
// PostgREST stand-in; nothing reaches a real database.
//
// Run: node --test apps/api/tests/v2RevPlays.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { revPlayTemplateById } from '@nous/core';
import { startFakePostgrest, serveApp, callJson } from './fakePostgrest.mjs';
import { customRefusal, flowFromTemplate, parseTo, revPlayLimitBody, templateView, connectionWarnings } from '../src/routes/v2/revPlays.mjs';

const WS = 'ws-1';
const row = (i, over = {}) => ({ id: `00000000-0000-4000-8000-00000000000${i}`, workspace_id: WS, user_id: 'other', revbox_id: null, name: `Play ${i}`, trigger_kind: 'deal_closed_won', enabled: true, steps: [], version: 1, created_at: `2026-10-0${i}`, ...over });
const seed = (planId = 'api', rows = [], open = true) => ({
  workspaces: [{ id: WS, team_id: 't1', open_account_visibility: open }],
  teams: [{ id: 't1', name: 'T' }],
  subscriptions: [{ team_id: 't1', plan_id: planId, status: 'active' }],
  agent_routines: rows, agent_routine_runs: [],
  workspace_members: [], workflow_provider_connections: [], workflow_providers: [], crm_sync_configs: [],
});

let tables, pgrest, server;
let key;   // who is calling
const MEMBER = { memberUserId: 'member-1', viewerScope: 'member', internalUserId: 'member-1', noContent: false };
const ADMIN = { memberUserId: 'admin-1', viewerScope: 'admin', noContent: false };
const WORKSPACE_KEY = { memberUserId: null, viewerScope: 'admin', noContent: true };

before(async () => {
  tables = seed();
  pgrest = await startFakePostgrest(() => tables);
  const { revPlaysV2Router } = await import('../src/routes/v2/revPlays.mjs');
  const app = express();
  app.use(express.json());
  app.use('/v2/rev-plays', (req, _res, next) => { Object.assign(req, { workspaceId: WS, ...key }); next(); }, revPlaysV2Router);
  server = await serveApp(app);
});
after(async () => { await server?.close(); await pgrest?.close(); });
const call = (method, path, body) => callJson(server.url, method, `/v2/rev-plays${path}`, body);
const given = (t, k = MEMBER) => { tables = t; key = k; };

test('templates say what this plan can create, and what covers the rest', async () => {
  given(seed());
  const { body, status } = await call('GET', '/templates');
  assert.equal(status, 200);
  const by = Object.fromEntries(body.templates.map(t => [t.id, t]));
  assert.equal(by.account_handoff.available, true);
  assert.equal(by.account_handoff.needs_to, true);
  // The API plan runs no defaults, so one with a live trigger is its to have.
  assert.equal(by.sales_follow_up.available, true);
  assert.deepEqual(by.sales_follow_up.needs, ['notetaker', 'gmail']);
  // A trigger nothing fires is refused with the webhook that does cover it.
  assert.equal(by.stale_deal.available, false);
  assert.equal(by.stale_deal.webhook_event, 'deal.stalled');
  const custom = templateView(revPlayTemplateById('sales_follow_up'), { apiTier: false });
  assert.equal(custom.available, false);
  assert.match(custom.why_not, /already runs/);
});

test('a member key creates from a template as that member', async () => {
  given(seed());
  const { status, body } = await call('POST', '/', { template: 'account_handoff', to: 'Ida@harborline.example, sam@harborline.example' });
  assert.equal(status, 201, JSON.stringify(body));
  const saved = tables.agent_routines[0];
  assert.equal(saved.user_id, 'member-1');
  assert.equal(saved.name, 'Account handoff');
  assert.equal(saved.trigger_kind, 'deal_closed_won');
  assert.equal(saved.enabled, true);
  const email = saved.steps.find(s => s.type === 'email');
  assert.equal(email.config.to, 'ida@harborline.example');
  assert.equal(email.config.cc, 'sam@harborline.example');
  assert.equal(body.rev_play.steps.length, 2);
});

test('a follow-up on the API plan saves its words, and drafts without an approval nobody can see', async () => {
  given(seed());
  const { status, body } = await call('POST', '/', { template: 'sales_follow_up' });
  assert.equal(status, 201, JSON.stringify(body));
  const saved = tables.agent_routines[0];
  assert.deepEqual(saved.steps.map(s => s.type), ['agent', 'gmail']);
  assert.match(saved.prompt, /Draft the follow-up email/);
  assert.match(body.warnings.join(' '), /notetaker/);
  assert.match(body.warnings.join(' '), /Gmail/);
});

test('an emailed template needs a real recipient', async () => {
  given(seed());
  for (const to of [undefined, '', 'not an address']) {
    const r = await call('POST', '/', { template: 'weekly_insights', to });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'to_required');
  }
  assert.equal(tables.agent_routines.length, 0);
});

test('custom: the same shape as a workflow, refused when it could never deliver', async () => {
  given(seed());
  const ok = await call('POST', '/', { name: 'Won to my stack', trigger: { type: 'deal_closed_won' }, steps: [{ type: 'agent', action: 'deal_handoff' }, { type: 'webhook', url: 'https://hooks.harborline.example/won' }] });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal(tables.agent_routines[0].user_id, 'member-1');
  assert.match(tables.agent_routines[0].prompt, /handoff/);
  const notLive = await call('POST', '/', { trigger: { type: 'deal_stalled' }, steps: [{ type: 'agent', prompt: 'x' }] });
  assert.equal(notLive.status, 409);
  assert.equal(notLive.body.webhook_event, 'deal.stalled');
  const slack = await call('POST', '/', { trigger: { type: 'deal_closed_won' }, steps: [{ type: 'agent', prompt: 'x' }, { type: 'slack', channel: '#wins' }] });
  assert.equal(slack.status, 402);
  assert.equal(slack.body.error, 'slack_not_in_plan');
  const nowhere = await call('POST', '/', { trigger: { type: 'clock', frequency: 'daily' }, steps: [{ type: 'agent', prompt: 'x' }] });
  assert.equal(nowhere.body.error, 'needs_delivery');
  const meeting = await call('POST', '/', { trigger: { type: 'before_meeting' }, steps: [{ type: 'agent', prompt: 'x' }, { type: 'webhook', url: 'https://a.example' }] });
  assert.equal(meeting.body.error, 'trigger_not_available');
  assert.equal(tables.agent_routines.length, 1);
});

test('template or custom, not both; unknown fields and templates are named', async () => {
  given(seed());
  assert.equal((await call('POST', '/', { template: 'expansion', trigger: { type: 'clock' } })).body.error, 'template_or_custom');
  assert.equal((await call('POST', '/', {})).body.error, 'template_or_custom');
  assert.equal((await call('POST', '/', { colour: 'red' })).body.error, 'unknown_field');
  assert.equal((await call('POST', '/', { template: 'nope' })).status, 404);
});

test('the limit is the plan\'s, counts RevPlays that are off, and says so', async () => {
  const five = [1, 2, 3, 4, 5].map(i => row(i, { enabled: false, user_id: 'member-1', visibility: 'personal' }));
  given(seed('api', five));
  const r = await call('POST', '/', { template: 'sales_follow_up', enabled: false });
  assert.equal(r.status, 402);
  assert.equal(r.body.error, 'automation_limit_reached');
  assert.equal(r.body.limit, 5);
  assert.match(r.body.message, /includes 5 personal RevPlays, on or off, and all are in use/);
  assert.equal(tables.agent_routines.length, 5);

  given(seed('free', [row(1, { user_id: 'member-1', visibility: 'personal' })]));
  const free = await call('POST', '/', { template: 'sales_follow_up' });
  assert.equal(free.status, 402);
  assert.match(free.body.message, /includes 1 personal RevPlay, on or off, and it is in use/);

  given(seed('free'));
  assert.equal((await call('POST', '/', { template: 'sales_follow_up' })).status, 201);
});

test('a key with no person is refused; a closed workspace takes a member\'s personal play', async () => {
  given(seed(), WORKSPACE_KEY);
  for (const [m, p, b] of [['GET', '/'], ['POST', '/', { template: 'sales_follow_up' }], ['PATCH', `/${row(1).id}`, { enabled: false }], ['POST', `/${row(1).id}/test`, {}]]) {
    const r = await call(m, p, b);
    assert.equal(r.status, 400, `${m} ${p}`);
    assert.equal(r.body.error, 'member_required');
  }
  given(seed('api', [], false));
  assert.equal((await call('POST', '/', { template: 'sales_follow_up' })).status, 201);
  given(seed('api', [], false), ADMIN);
  assert.equal((await call('POST', '/', { template: 'sales_follow_up' })).status, 201);
});

test('a member lists and switches their own; a teammate\'s is not there; a shared one is read-only', async () => {
  const mine = row(1, { user_id: 'member-1', visibility: 'personal' }), theirs = row(2, { visibility: 'personal' }), team = row(3);
  given(seed('api', [mine, theirs, team]));
  const list = await call('GET', '/');
  assert.deepEqual(list.body.rev_plays.map(p => p.id), [mine.id, team.id]);
  assert.equal(list.body.limit, 5);
  assert.equal(list.body.used, 1);
  assert.equal(list.body.used_shared, 1);
  assert.equal(list.body.plan, 'Self-serve');
  assert.equal(list.body.rev_plays[1].can_edit, false);
  assert.equal((await call('PATCH', `/${theirs.id}`, { enabled: false })).status, 404);
  assert.equal((await call('PATCH', `/${team.id}`, { enabled: false })).status, 403);
  const off = await call('PATCH', `/${mine.id}`, { enabled: false });
  assert.equal(off.status, 200, JSON.stringify(off.body));
  assert.equal(off.body.rev_play.enabled, false);
  assert.equal((await call('PATCH', `/${mine.id}`, { name: 'x' })).status, 400);
  key = ADMIN;
  assert.deepEqual((await call('GET', '/')).body.rev_plays.map(p => p.id), [team.id]);
});

test('delete frees the slot; someone else\'s is not there to delete', async () => {
  const mine = row(1, { user_id: MEMBER.memberUserId, enabled: false, visibility: 'personal' });
  const rest = [2, 3, 4, 5].map(i => row(i, { user_id: MEMBER.memberUserId, visibility: 'personal' }));
  const hidden = row(6, { user_id: 'other', visibility: 'personal' });
  given(seed('api', [mine, ...rest, hidden]));
  assert.equal((await call('DELETE', `/${hidden.id}`)).status, 404);
  const gone = await call('DELETE', `/${mine.id}`);
  assert.equal(gone.status, 200);
  assert.deepEqual(gone.body, { deleted: true, id: mine.id });
  assert.equal(tables.agent_routines.some(r => r.id === mine.id), false);
  assert.equal(tables.agent_routines.length, 5);
  given(seed('api', tables.agent_routines), WORKSPACE_KEY);
  assert.equal((await call('DELETE', `/${rest[0].id}`)).status, 400, 'a key with no person');
});

test('a test on a play with nothing to run on says so', async () => {
  const mine = row(1, { user_id: 'member-1', visibility: 'personal', trigger_kind: 'call_ended', steps: [{ id: 'a', type: 'agent', config: { prompt: 'x' } }] });
  given(seed('api', [mine]));
  const r = await call('POST', `/${mine.id}/test`, {});
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.equal(r.body.error, 'no_trigger');
});

test('pure pieces', () => {
  assert.deepEqual(parseTo('a@b.example; c@d.example'), { to: 'a@b.example', cc: 'c@d.example' });
  assert.equal(parseTo('a@b.example, nope'), null);
  // On Workspace an Approval before a HubSpot write stays; only a bare draft loses it, and only on the API plan.
  const crm = flowFromTemplate(revPlayTemplateById('crm_sync_back'), { apiTier: true }).flow;
  assert.ok(crm.steps.some(s => s.type === 'approval'));
  assert.equal(revPlayLimitBody('api', 0).message, 'RevPlays need an active plan.');
  assert.equal(customRefusal({ when: 'clock', steps: [{ type: 'agent' }, { type: 'gmail' }] }, { slack: false }), null);
  assert.deepEqual(connectionWarnings({ when: 'deal_closed_won', steps: [{ type: 'hubspot' }] }, ['hubspot']), []);
});
