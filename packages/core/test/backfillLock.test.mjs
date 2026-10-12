// One writer at a time (GET-412). Run: node --test packages/core/test/backfillLock.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { acquireBackfillLock, withBackfillLock, lockIsLive, LockHeldError, WORKSPACE_WIDE_JOB } from '../dist/services/backfillLock.js';

/** A fake backfill_locks table with just enough PostgREST surface. */
function fakeDb(rows = []) {
  const state = { rows: [...rows], writes: [] };
  const q = (table) => {
    const f = [];
    const chain = {
      select: () => chain, eq: (k, v) => { f.push(r => r[k] === v); return chain; },
      in: (k, vs) => { f.push(r => vs.includes(r[k])); return chain; },
      neq: (k, v) => { f.push(r => r[k] !== v); return chain; },
      then: (res) => res({ data: state.rows.filter(r => f.every(p => p(r))), error: null }),
      upsert: async (row) => { state.rows = state.rows.filter(r => !(r.workspace_id === row.workspace_id && r.job === row.job)); state.rows.push(row); state.writes.push(['upsert', row]); return { error: null }; },
      delete: () => ({ eq: (k, v) => { f.push(r => r[k] === v); const d = { eq: (k2, v2) => { f.push(r => r[k2] === v2); return d; }, then: (res) => { state.rows = state.rows.filter(r => !f.every(p => p(r))); state.writes.push(['delete']); res({ error: null }); } }; return d; } }),
      update: (patch) => ({ eq: (k, v) => { f.push(r => r[k] === v); const u = { eq: (k2, v2) => { f.push(r => r[k2] === v2); return u; }, then: (res) => { for (const r of state.rows) if (f.every(p => p(r))) Object.assign(r, patch); res({ error: null }); } }; return u; } }),
    };
    return chain;
  };
  return { from: q, state };
}
const W = 'ws-1';
const later = (min) => new Date(Date.now() + min * 60_000).toISOString();

test('a second run of the same job refuses to start and names the holder', async () => {
  const db = fakeDb([{ workspace_id: W, job: 'closeRecords', holder: 'box:1 closeRecords', acquired_at: new Date().toISOString(), expires_at: later(60), note: null }]);
  await assert.rejects(acquireBackfillLock(db, W, 'closeRecords', { holder: 'box:2 closeRecords' }), (e) => e instanceof LockHeldError && /box:1 closeRecords/.test(e.message));
});

test('a different job runs alongside — unless the workspace-wide lock is held', async () => {
  const db = fakeDb([{ workspace_id: W, job: 'closeRecords', holder: 'box:1', acquired_at: new Date().toISOString(), expires_at: later(60), note: null }]);
  const l = await acquireBackfillLock(db, W, 'gradeRiskSeverity', { holder: 'box:2' });
  assert.equal(l.noop, false);
  await l.release();
  const wide = fakeDb([{ workspace_id: W, job: WORKSPACE_WIDE_JOB, holder: 'box:9 fellowBackfill', acquired_at: new Date().toISOString(), expires_at: later(60), note: 'Fellow re-read' }]);
  await assert.rejects(acquireBackfillLock(wide, W, 'gradeRiskSeverity', { holder: 'box:2' }), /the workspace is locked by box:9 fellowBackfill/);
});

test('taking the workspace-wide lock needs every job to be free', async () => {
  const db = fakeDb([{ workspace_id: W, job: 'closeRecords', holder: 'box:1', acquired_at: new Date().toISOString(), expires_at: later(60), note: null }]);
  await assert.rejects(acquireBackfillLock(db, W, WORKSPACE_WIDE_JOB, { holder: 'box:2 settle' }), LockHeldError);
});

test('a stale lease is taken over with a warning, never blocks forever', async () => {
  const db = fakeDb([{ workspace_id: W, job: 'closeRecords', holder: 'box:1 (died)', acquired_at: new Date(0).toISOString(), expires_at: later(-5), note: null }]);
  const warnings = [];
  const l = await acquireBackfillLock(db, W, 'closeRecords', { holder: 'box:2', warn: (m) => warnings.push(m) });
  assert.equal(l.noop, false);
  assert.match(warnings[0], /taking over a stale closeRecords lock held by box:1/);
  assert.equal(db.state.rows[0].holder, 'box:2');
});

test('withBackfillLock releases on success and on failure', async () => {
  const db = fakeDb();
  await withBackfillLock(db, W, 'j', { holder: 'me' }, async () => 1);
  assert.equal(db.state.rows.length, 0);
  await assert.rejects(withBackfillLock(db, W, 'j', { holder: 'me' }, async () => { throw new Error('boom'); }), /boom/);
  assert.equal(db.state.rows.length, 0, 'released even when the run threw');
});

test('a missing table means no lock, and says so, rather than blocking a fresh install', async () => {
  const db = { from: () => ({ select: () => ({ eq: () => ({ in: () => Promise.resolve({ data: null, error: { code: '42P01', message: 'relation "backfill_locks" does not exist' } }) }) }) }) };
  const warnings = [];
  const l = await acquireBackfillLock(db, W, 'j', { holder: 'me', warn: (m) => warnings.push(m) });
  assert.equal(l.noop, true);
  assert.match(warnings[0], /migration not applied/);
});

test('lockIsLive is the one definition of live', () => {
  assert.equal(lockIsLive({ expires_at: later(1) }), true);
  assert.equal(lockIsLive({ expires_at: later(-1) }), false);
  assert.equal(lockIsLive(null), false);
  assert.equal(lockIsLive({ expires_at: 'not a date' }), false);
});
