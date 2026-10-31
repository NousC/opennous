// Closed workspace on the team reads (GET-1066): the graph is cut down to a member's book, and on a
// closed workspace a member can't create or test a webhook (a webhook is sent every account's
// events). get_context and the events feed are covered in publicApiReads.test.mjs and core's
// eventLog.test.mjs.
//
// Run: cd apps/api && node --test tests/closedWorkspaceReads.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { restrictNetwork } from '../src/routes/api/graph.mjs';
import { refuseTeamFeedToMember, requestBook } from '../src/lib/visibility.mjs';

const net = {
  nodes: [
    { i: 'p-mine', t: 0 }, { i: 'p-theirs', t: 0 },
    { i: 'c-mine', t: 1 }, { i: 'c-theirs', t: 1 },
    { i: 'cl0', t: 3, sz: 2 }, { i: 'cl1', t: 3, sz: 1 },
  ],
  edges: [
    { s: 'p-mine', t: 'c-mine', k: 0 }, { s: 'p-theirs', t: 'c-theirs', k: 0 },
    { s: 'p-mine', t: 'p-theirs', k: 3 },
    { s: 'c-mine', t: 'cl0', k: 2 }, { s: 'c-theirs', t: 'cl0', k: 2 }, { s: 'c-theirs', t: 'cl1', k: 2 },
  ],
  patterns: {
    single: ['c-mine', 'c-theirs'], budget: ['c-theirs'],
    clusters: [{ label: 'Pain A', ids: ['c-mine', 'c-theirs'], node: 'cl0', cat: 'pain' }, { label: 'Pain B', ids: ['c-theirs'], node: 'cl1', cat: 'pain' }],
  },
  meta: { people: 2, companies: 2, clusters: 2, ts: 1 },
};

test('restrictNetwork keeps only the book, the edges between what is kept, and the clusters still holding an account', () => {
  const out = restrictNetwork(net, new Set(['p-mine', 'c-mine']));
  assert.deepEqual(out.nodes.map(n => n.i), ['p-mine', 'c-mine', 'cl0']);
  assert.equal(out.nodes.find(n => n.i === 'cl0').sz, 1, 'the cluster counts only what the member sees');
  assert.deepEqual(out.edges, [{ s: 'p-mine', t: 'c-mine', k: 0 }, { s: 'c-mine', t: 'cl0', k: 2 }]);
  assert.deepEqual(out.patterns.single, ['c-mine']);
  assert.deepEqual(out.patterns.budget, []);
  assert.deepEqual(out.patterns.clusters.map(c => [c.node, c.ids]), [['cl0', ['c-mine']]]);
  assert.deepEqual({ ...out.meta, ts: 1 }, { people: 1, companies: 1, clusters: 1, ts: 1 });
});

test('an empty book draws nothing', () => {
  const out = restrictNetwork(net, new Set());
  assert.deepEqual(out.nodes, []);
  assert.deepEqual(out.edges, []);
});

// A workspace row is all getVisibilityScope / viewerVisibleAccountSet read before the book itself.
function workspaceDb(open) {
  return {
    from() {
      const b = {
        select() { return b; }, eq() { return b; },
        maybeSingle: async () => ({ data: { open_account_visibility: open }, error: null }),
      };
      return b;
    },
  };
}
function res() {
  return { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
}
const memberReq = { viewerScope: 'member', memberUserId: 'u1' };
const adminReq = { viewerScope: 'admin', memberUserId: 'u2' };

test('a webhook on a closed workspace takes an admin; a member is refused with 403', async () => {
  const r = res();
  assert.equal(await refuseTeamFeedToMember(workspaceDb(false), 'ws', memberReq, r), true);
  assert.equal(r.statusCode, 403);
  assert.equal(r.body.error, 'admin_key_required');
  assert.equal(await refuseTeamFeedToMember(workspaceDb(false), 'ws', adminReq, res()), false);
});

test('on an open workspace anyone may still create a webhook, and nobody has a book', async () => {
  assert.equal(await refuseTeamFeedToMember(workspaceDb(true), 'ws', memberReq, res()), false);
  assert.equal(await requestBook(workspaceDb(true), 'ws', memberReq), null);
  assert.equal(await requestBook(workspaceDb(false), 'ws', adminReq), null, 'an admin reads the whole workspace');
});
