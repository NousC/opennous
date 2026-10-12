// A merged or deleted entity's flattened row is removed once a refresh pass completes (GET-841).
// The refresh walks active entities only, so before this a merged account kept its row forever and
// showed up beside the account it was merged into.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pruneDeadListRows } from '../src/workers/listRowsRefresh.mjs';

/** A fake of the two tables the prune reads and the one delete it makes. */
function fakeDb({ rows, status }) {
  const deleted = [];
  const from = (table) => {
    const q = { table, filters: {}, ins: null, range: null, del: false };
    const api = {
      select() { return api; },
      delete() { q.del = true; return api; },
      eq(k, v) { q.filters[k] = v; return api; },
      in(k, v) { q.ins = [k, v]; return api; },
      order() { return api; },
      range(a, b) { q.range = [a, b]; return api; },
      then(resolve) {
        if (q.del) { deleted.push(...q.ins[1]); return resolve({ error: null }); }
        if (table === 'entity_list_rows') {
          const all = rows.filter(r => r.kind === q.filters.kind).map(r => ({ entity_id: r.id }));
          return resolve({ data: all.slice(q.range[0], q.range[1] + 1), error: null });
        }
        if (table === 'entities') return resolve({ data: q.ins[1].filter(id => status.has(id)).map(id => ({ id, status: status.get(id) })), error: null });
        return resolve({ data: [], error: null });
      },
    };
    return api;
  };
  return { db: { from }, deleted };
}

test('rows of merged or missing entities are deleted; active and parked ones stay', async () => {
  const { db, deleted } = fakeDb({
    rows: [{ id: 'a1', kind: 'account' }, { id: 'ghost', kind: 'account' }, { id: 'gone', kind: 'account' }, { id: 'nap', kind: 'account' }, { id: 'p1', kind: 'person' }],
    status: new Map([['a1', 'active'], ['ghost', 'merged'], ['nap', 'parked'], ['p1', 'active']]),
  });
  const n = await pruneDeadListRows(db, 'ws', 'account');
  assert.equal(n, 2);
  assert.deepEqual(deleted.sort(), ['ghost', 'gone'], 'merged and missing go; parked stays');
});

test('nothing to prune deletes nothing', async () => {
  const { db, deleted } = fakeDb({ rows: [{ id: 'a1', kind: 'account' }], status: new Map([['a1', 'active']]) });
  assert.equal(await pruneDeadListRows(db, 'ws', 'account'), 0);
  assert.deepEqual(deleted, []);
});
