// Phase 4.3 — the findPaths wrapper over traverse_graph. The recursive CTE itself is
// validated against real data; here we lock the wrapper contract with a stubbed RPC:
// depth clamps to 1..5, empty edgeTypes become null (any verb), and raw rows map to GraphPath.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findPaths } from '../dist/db/graph.js';

function stubRpc(rows, captured) {
  return {
    rpc: async (name, params) => {
      captured.name = name;
      captured.params = params;
      return { data: rows, error: null };
    },
  };
}

test('clamps maxDepth into 1..5 and defaults to 3', async () => {
  for (const [input, expected] of [[undefined, 3], [0, 1], [-4, 1], [2, 2], [99, 5], [5, 5]]) {
    const cap = {};
    await findPaths(stubRpc([], cap), 'ws', 'start', input === undefined ? {} : { maxDepth: input });
    assert.equal(cap.params.p_max_depth, expected, `maxDepth ${input} -> ${expected}`);
  }
});

test('empty or missing edgeTypes become null (any verb); a list passes through', async () => {
  const c1 = {}; await findPaths(stubRpc([], c1), 'ws', 's', {});
  assert.equal(c1.params.p_edge_types, null);
  const c2 = {}; await findPaths(stubRpc([], c2), 'ws', 's', { edgeTypes: [] });
  assert.equal(c2.params.p_edge_types, null);
  const c3 = {}; await findPaths(stubRpc([], c3), 'ws', 's', { edgeTypes: ['KNOWS', 'WORKS_WITH'] });
  assert.deepEqual(c3.params.p_edge_types, ['KNOWS', 'WORKS_WITH']);
});

test('maps raw CTE rows to GraphPath', async () => {
  const rows = [
    { depth: 2, end_entity: 'c', end_label: 'quillfield.example', path_entities: ['a', 'b', 'c'], path_relationships: ['KNOWS', 'MENTIONED_AT'] },
  ];
  const out = await findPaths(stubRpc(rows, {}), 'ws', 'a', { maxDepth: 3 });
  assert.equal(out.length, 1);
  assert.deepEqual(out[0], {
    depth: 2, endEntity: 'c', endLabel: 'quillfield.example',
    pathEntities: ['a', 'b', 'c'], pathRelationships: ['KNOWS', 'MENTIONED_AT'],
  });
  assert.equal(out[0].pathRelationships.length, out[0].depth); // one verb per hop
});

test('passes workspace + start through and surfaces RPC errors', async () => {
  const cap = {};
  await findPaths(stubRpc([], cap), 'ws1', 'start1', {});
  assert.equal(cap.params.p_workspace_id, 'ws1');
  assert.equal(cap.params.p_start_entity, 'start1');
  const bad = { rpc: async () => ({ data: null, error: { message: 'boom' } }) };
  await assert.rejects(() => findPaths(bad, 'ws', 's', {}), /traverse_graph failed: boom/);
});
