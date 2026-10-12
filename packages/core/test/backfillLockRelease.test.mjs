// A worker stopped mid-job (a deploy) must hand its locks back, or the workspace's next run is
// locked out for the rest of the lease.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withBackfillLock, releaseHeldLocks } from '../dist/services/backfillLock.js';

function fakeDb() {
  const rows = [];
  const q = (table) => {
    const f = { op: 'select', filters: {} };
    const api = {
      select() { return api; },
      eq(k, v) { f.filters[k] = v; return api; },
      in(k, v) { f.filters[k] = v; return api; },
      neq() { return api; },
      delete() { f.op = 'delete'; return api; },
      upsert(row) { rows.push(row); return Promise.resolve({ error: null }); },
      then(res) {
        if (f.op === 'delete') {
          for (let i = rows.length - 1; i >= 0; i--) if (rows[i].holder === f.filters.holder && rows[i].job === f.filters.job) rows.splice(i, 1);
          return Promise.resolve({ error: null }).then(res);
        }
        return Promise.resolve({ data: rows.filter(r => r.workspace_id === f.filters.workspace_id), error: null }).then(res);
      },
    };
    return api;
  };
  return { rows, from: q };
}

test('a lock held mid-job is released by releaseHeldLocks, and only once', async () => {
  const db = fakeDb();
  let unblock;
  const running = withBackfillLock(db, 'ws1', 'insightBoard', { holder: 'h1' }, () => new Promise((r) => { unblock = r; }));
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(db.rows.length, 1, 'the job holds its lock while running');
  assert.equal(await releaseHeldLocks(), 1, 'a shutdown releases it');
  assert.equal(db.rows.length, 0, 'and the row is gone');
  unblock('done');
  assert.equal(await running, 'done');
  assert.equal(await releaseHeldLocks(), 0, 'nothing is held after the job ends');
});
