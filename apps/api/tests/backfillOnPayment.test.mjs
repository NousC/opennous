// A payment starts the backfill (GET-682): the first payment starts every waiting backfill and
// makes one where none ever ran; a renewal starts only what was parked for it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AWAITING, startBackfillsOnPayment } from '../src/lib/backfillStart.mjs';

const get = (row, col) => {
  if (!col.includes('->>')) return row[col];
  const [a, b] = col.split('->>');
  return row[a]?.[b] ?? null;
};
function fakeSupabase(tables) {
  return {
    from(name) {
      const rows = tables[name] ?? (tables[name] = []);
      const filters = []; let patch = null; let head = false;
      const match = () => rows.filter(r => filters.every(f => f(r)));
      const q = {
        select(_c, opts) { head = !!opts?.head; return q; },
        update(p) { patch = p; return q; },
        eq(c, v) { filters.push(r => get(r, c) === v); return q; },
        is(c, v) { filters.push(r => (get(r, c) ?? null) === v); return q; },
        not(c, _op, v) { filters.push(r => (get(r, c) ?? null) !== v); return q; },
        order() { return q; }, limit() { return q; },
        async maybeSingle() { const r = match(); if (patch) r.forEach(x => Object.assign(x, patch)); return { data: r[0] ?? null }; },
        then(res) { const r = match(); if (patch) r.forEach(x => Object.assign(x, patch)); return Promise.resolve(head ? { count: r.length } : { data: r }).then(res); },
      };
      return q;
    },
  };
}
const job = (id, extra = {}) => ({ job_id: id, workspace_id: 'w1', status: AWAITING, paused_reason: 'awaiting_confirmation', window_days: 90, created_at: '2026-10-01', state: {}, ...extra });
const noEnqueue = async () => null;

test('the first payment starts every waiting backfill, flagged or not, founder and member', async () => {
  const db = { workspaces: [{ id: 'w1', team_id: 't1' }], contact_enrichment_jobs: [job('a'), job('b', { state: { owner_user_id: 'm1' } })] };
  await startBackfillsOnPayment(fakeSupabase(db), 't1', { firstPayment: true, enqueue: noEnqueue });
  assert.deepEqual(db.contact_enrichment_jobs.map(j => j.status), ['pending', 'pending']);
});

test('a renewal starts only what was parked for the payment', async () => {
  const db = { workspaces: [{ id: 'w1', team_id: 't1' }], contact_enrichment_jobs: [job('a')] };
  await startBackfillsOnPayment(fakeSupabase(db), 't1', { firstPayment: false, enqueue: noEnqueue });
  assert.equal(db.contact_enrichment_jobs[0].status, AWAITING);
  db.contact_enrichment_jobs[0].state = { start_on_payment: { short: false } };
  await startBackfillsOnPayment(fakeSupabase(db), 't1', { firstPayment: false, enqueue: noEnqueue });
  assert.equal(db.contact_enrichment_jobs[0].status, 'pending');
});

test('the first payment makes the backfill where none ever ran', async () => {
  const db = { workspaces: [{ id: 'w1', team_id: 't1' }], contact_enrichment_jobs: [] };
  const made = [];
  const enqueue = async (_sb, ws, { ownerUserId }) => { made.push(ownerUserId); db.contact_enrichment_jobs.push(job('new')); };
  await startBackfillsOnPayment(fakeSupabase(db), 't1', { firstPayment: true, enqueue });
  assert.deepEqual(made, [null]);
  assert.equal(db.contact_enrichment_jobs[0].status, 'pending');
});

test('…but not where a backfill already ran', async () => {
  const db = { workspaces: [{ id: 'w1', team_id: 't1' }], contact_enrichment_jobs: [job('old', { status: 'done', state: { started_at: '2026-09-01' } })] };
  const made = [];
  await startBackfillsOnPayment(fakeSupabase(db), 't1', { firstPayment: true, enqueue: async (_s, _w, o) => { made.push(o.ownerUserId); } });
  assert.deepEqual(made, []);
});

test('over the backfill credits it reads the last 30 days; over the ceiling it waits for us', async () => {
  const db = { workspaces: [{ id: 'w1', team_id: 't1' }], contact_enrichment_jobs: [job('a', { paused_reason: 'over_allowance' })] };
  await startBackfillsOnPayment(fakeSupabase(db), 't1', { firstPayment: true, enqueue: noEnqueue });
  assert.equal(db.contact_enrichment_jobs[0].status, 'pending');
  assert.equal(db.contact_enrichment_jobs[0].window_days, 30);
  const big = { workspaces: [{ id: 'w1', team_id: 't1' }], contact_enrichment_jobs: [job('b', { paused_reason: 'over_ceiling' })] };
  await startBackfillsOnPayment(fakeSupabase(big), 't1', { firstPayment: true, enqueue: noEnqueue });
  assert.equal(big.contact_enrichment_jobs[0].status, AWAITING);
});
