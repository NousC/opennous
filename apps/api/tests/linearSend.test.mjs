// "Send to Linear" over HTTP (GET-825): the one function both doors call — the app's button
// (/api/linear/topics/:key/send) and the API plan's /v2/insights/topics/:key/linear — and what it
// answers when Linear is not connected, no team is picked, or the topic does not exist.
//
// Run: node --test apps/api/tests/linearSend.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.ENCRYPTION_KEY = 'd'.repeat(64);
const { sendTopic } = await import('../src/lib/linearSend.mjs');

const ISSUE = { id: 'lin-1', identifier: 'PRD-12', url: 'https://linear.app/acme/issue/PRD-12' };
const deps = (over = {}) => {
  const seen = {};
  return {
    seen,
    getClient: async () => ({ gql: async () => ({}), defaultTeamId: 't1', teams: [{ id: 't1', key: 'PRD', name: 'Product' }] }),
    send: async (_db, opts) => { seen.opts = opts; return { created: true, issue: ISSUE, requests_added: 2, requests_skipped: null, accounts: 2 }; },
    appUrl: 'https://app.example.com',
    visibility: async () => ({ unrestricted: true }),
    ...over,
  };
};

test('sends to the default team and answers with the issue', async () => {
  const d = deps();
  const r = await sendTopic({ supabase: {}, workspaceId: 'ws', topicKey: 'feature|tag-qr', userId: 'u' }, d);
  assert.equal(r.status, 201);
  assert.equal(r.body.issue.identifier, 'PRD-12');
  assert.equal(d.seen.opts.teamId, 't1');
  assert.equal(d.seen.opts.appUrl, 'https://app.example.com');
});

test('a re-send that files no new issue answers 200', async () => {
  const d = deps({ send: async () => ({ created: false, issue: ISSUE, requests_added: 1, requests_skipped: null, accounts: 2 }) });
  const r = await sendTopic({ supabase: {}, workspaceId: 'ws', topicKey: 'feature|tag-qr' }, d);
  assert.equal(r.status, 200);
});

test('an explicit team wins over the default, but only a team of this Linear workspace', async () => {
  const teams = [{ id: 't1', key: 'PRD', name: 'Product' }, { id: 't2', key: 'ENG', name: 'Engineering' }];
  const d = deps({ getClient: async () => ({ gql: async () => ({}), defaultTeamId: 't1', teams }) });
  await sendTopic({ supabase: {}, workspaceId: 'ws', topicKey: 'feature|x', teamId: 't2' }, d);
  assert.equal(d.seen.opts.teamId, 't2');
  const bad = await sendTopic({ supabase: {}, workspaceId: 'ws', topicKey: 'feature|x', teamId: 't9' }, d);
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error, 'unknown_team');
});

test('several teams and none picked: 409 with the teams to choose from', async () => {
  const teams = [{ id: 't1', key: 'PRD', name: 'Product' }, { id: 't2', key: 'ENG', name: 'Engineering' }];
  const d = deps({ getClient: async () => ({ gql: async () => ({}), defaultTeamId: null, teams }) });
  const r = await sendTopic({ supabase: {}, workspaceId: 'ws', topicKey: 'feature|x' }, d);
  assert.equal(r.status, 409);
  assert.equal(r.body.error, 'linear_team_required');
  assert.deepEqual(r.body.teams, teams);
});

test('Linear not connected: 409 linear_not_connected', async () => {
  const d = deps({ getClient: async () => { throw Object.assign(new Error('x'), { code: 'linear_not_connected' }); } });
  const r = await sendTopic({ supabase: {}, workspaceId: 'ws', topicKey: 'feature|x' }, d);
  assert.equal(r.status, 409);
  assert.equal(r.body.error, 'linear_not_connected');
});

test('a bad key is 400, an empty topic 404, a Linear failure 502', async () => {
  assert.equal((await sendTopic({ supabase: {}, workspaceId: 'ws', topicKey: 'nobar' }, deps())).status, 400);
  const nf = deps({ send: async () => { throw Object.assign(new Error('x'), { code: 'topic_not_found' }); } });
  assert.equal((await sendTopic({ supabase: {}, workspaceId: 'ws', topicKey: 'feature|x' }, nf)).status, 404);
  const lf = deps({ send: async () => { throw Object.assign(new Error('Entity not found'), { code: 'linear_graphql' }); } });
  const r = await sendTopic({ supabase: {}, workspaceId: 'ws', topicKey: 'feature|x' }, lf);
  assert.equal(r.status, 502);
  assert.equal(r.body.error, 'linear_error');
});

test('a restricted member sends only the accounts they may see', async () => {
  const d = deps({ visibility: async (_db, _ws, viewer, { isAdmin }) => (isAdmin ? { unrestricted: true } : { unrestricted: false, ids: new Set(['co-1']) }) });
  await sendTopic({ supabase: {}, workspaceId: 'ws', topicKey: 'feature|x', viewerId: 'm', isAdmin: false }, d);
  assert.deepEqual([...d.seen.opts.visibleCompanyIds], ['co-1']);
  await sendTopic({ supabase: {}, workspaceId: 'ws', topicKey: 'feature|x', viewerId: 'a', isAdmin: true }, d);
  assert.equal(d.seen.opts.visibleCompanyIds, null);
});

test('a send already under way answers 409 send_in_progress', async () => {
  const d = deps({ send: async () => { throw Object.assign(new Error('x'), { code: 'send_in_progress' }); } });
  const r = await sendTopic({ supabase: {}, workspaceId: 'ws', topicKey: 'feature|x' }, d);
  assert.equal(r.status, 409);
  assert.equal(r.body.error, 'send_in_progress');
});
