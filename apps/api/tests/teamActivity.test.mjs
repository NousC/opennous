// Settings > Team (GET-1120): each person's agents and last activity, from the request log.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { agentOf, summarize, loadTeamActivity, topTools, touched } = await import('../src/lib/teamActivity.mjs');
const { makeTeamActivityHandler, makeTeamMemberHandler } = await import('../src/routes/api/apiActivity.mjs');

const NOW = Date.parse('2026-11-10T12:00:00Z');
const ago = (d) => new Date(NOW - d * 86_400_000).toISOString();

test('an agent is named by its client, without the version', () => {
  assert.equal(agentOf('claude-code/2.1.0'), 'claude-code');
  assert.equal(agentOf('cursor'), 'cursor');
  assert.equal(agentOf(null), '');
});

test('a person: newest activity, calls this week, agents newest first', () => {
  const out = summarize([
    { at: ago(1), client: 'claude-code/2.1.0' }, { at: ago(3), client: 'claude-code/2.0.0' },
    { at: ago(0.5), client: 'grok/1' }, { at: ago(20), client: 'cursor/1' }, { at: ago(2), client: null },
  ], NOW);
  assert.equal(out.last_active_at, ago(0.5));
  assert.equal(out.calls_7d, 4);
  assert.deepEqual(out.agents.map(a => a.name), ['grok', 'claude-code', 'cursor']);
  assert.equal(out.agents[1].last_at, ago(1));
});

test('nothing logged reads as nothing', () => {
  assert.deepEqual(summarize([], NOW), { last_active_at: null, calls_7d: 0, agents: [] });
});

function db(tables) {
  const calls = [];
  const q = (t) => {
    const f = [];
    const b = { select: () => b, order: () => b, limit: () => b,
      eq: (k, v) => { f.push(r => r[k] === v); return b; },
      gte: (k, v) => { f.push(r => r[k] >= v); return b; },
      not: (k) => { f.push(r => r[k] != null); return b; },
      then: (ok, no) => { calls.push(t); return Promise.resolve({ data: tables[t].filter(r => f.every(x => x(r))), error: null }).then(ok, no); } };
    return b;
  };
  return { from: q, calls };
}

test('two keys count for one person, a workspace key and other workspaces for no one', async () => {
  const sb = db({
    api_keys: [{ id: 'k1', workspace_id: 'w', owner_user_id: 'u1' }, { id: 'k2', workspace_id: 'w', owner_user_id: 'u1' },
      { id: 'k3', workspace_id: 'w', owner_user_id: null }, { id: 'k4', workspace_id: 'w', owner_user_id: 'quiet' }, { id: 'k5', workspace_id: 'other', owner_user_id: 'u9' }],
    api_request_log: [{ workspace_id: 'w', api_key_id: 'k1', at: ago(1), client: 'claude-code/2' }, { workspace_id: 'w', api_key_id: 'k2', at: ago(2), client: 'grok/1' },
      { workspace_id: 'w', api_key_id: 'k3', at: ago(1), client: 'n8n' }, { workspace_id: 'w', api_key_id: 'k1', at: ago(60), client: 'old/1' }],
  });
  const { members } = await loadTeamActivity(sb, { workspaceId: 'w', now: NOW });
  assert.deepEqual(Object.keys(members), ['u1']);
  assert.equal(members.u1.calls_7d, 2);
  assert.deepEqual(members.u1.agents.map(a => a.name), ['claude-code', 'grok']);
});

test('the route is for admins', async () => {
  const handler = makeTeamActivityHandler({ getClient: () => { throw new Error('must not read'); } });
  const send = async (req) => { let status = 200, body; await handler(req, { status(s) { status = s; return this; }, json(b) { body = b; return this; } }); return { status, body }; };
  assert.equal((await send({ workspaceId: 'w', viewerScope: 'member', workspaceRole: 'member' })).status, 403);
  assert.equal((await send({})).status, 400);
});

test('what agents do most, and what they worked on, once each', () => {
  const rows = [{ route: 'a' }, { route: 'b' }, { route: 'b' }, { route: null }];
  assert.deepEqual(topTools(rows), [{ route: 'b', calls: 2 }, { route: 'a', calls: 1 }]);
  const calls = [{ at: '3', about: { id: 'x', name: 'Acme', type: 'company' } }, { at: '2', about: { id: 'x', name: 'Acme', type: 'company' } }, { at: '1', about: null }];
  assert.deepEqual(touched(calls), [{ id: 'x', name: 'Acme', type: 'company', at: '3' }]);
});

test('one person in depth is for admins', async () => {
  const handler = makeTeamMemberHandler({ getClient: () => { throw new Error('must not read'); } });
  let status = 200;
  await handler({ workspaceId: 'w', viewerScope: 'member', workspaceRole: 'member', params: { userId: 'u' } }, { status(s) { status = s; return this; }, json() { return this; } });
  assert.equal(status, 403);
});
