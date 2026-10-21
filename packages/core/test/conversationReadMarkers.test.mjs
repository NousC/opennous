import { test } from 'node:test';
import assert from 'node:assert/strict';
import { conversationReadMarkers } from '../dist/index.js';

test('read receipts are connector/workspace scoped, deduplicated and batched', async () => {
  const queries = [];
  const db = { from(table) {
    const ops = [['from', table]]; queries.push(ops);
    const q = { then: resolve => Promise.resolve({ data: [{ observed_at: '2026-10-01', value: {} }], error: null }).then(resolve) };
    for (const op of ['select', 'eq', 'in']) q[op] = (...args) => { ops.push([op, ...args]); return q; };
    return q;
  } };
  const refs = Array.from({ length: 101 }, (_, i) => `source://slack/T1/C1/${i}/v1`);
  const result = await conversationReadMarkers(db, 'workspace', 'slack', [...refs, refs[0]]);
  assert.equal(result.length, 2); assert.equal(queries.length, 2);
  for (const ops of queries) {
    assert(ops.some(o => o[0] === 'eq' && o[1] === 'workspace_id' && o[2] === 'workspace'));
    assert(ops.some(o => o[0] === 'eq' && o[1] === 'source' && o[2] === 'slack'));
    assert(ops.some(o => o[0] === 'eq' && o[1] === 'property' && o[2] === 'noema.read'));
  }
  assert.equal(queries[0].find(o => o[0] === 'in')[2].length, 100);
  assert.equal(queries[1].find(o => o[0] === 'in')[2].length, 1);
});
