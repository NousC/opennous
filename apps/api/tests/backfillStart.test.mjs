// Pay before the backfill reads (GET-549): the yes is remembered on the waiting job, and the
// subscription going live starts it — once, however many times the webhook fires.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AWAITING, startAwaitingBackfill, rememberStartOnPayment, startBackfillsOnPayment,
} from '../src/lib/backfillStart.mjs';

// The slice of the Supabase builder these functions use: select/eq/is/order/limit,
// maybeSingle, update. Rows live in plain arrays so a test can read them back.
function fakeSupabase(tables) {
  return {
    from(name) {
      const rows = tables[name] ?? (tables[name] = []);
      const filters = [];
      let patch = null;
      let order = null;
      const match = () => {
        let r = rows.filter(row => filters.every(f => f(row)));
        if (order) r = [...r].sort((a, b) => (a[order.col] < b[order.col] ? 1 : -1) * (order.ascending ? -1 : 1));
        return r;
      };
      const q = {
        select() { return q; },
        update(p) { patch = p; return q; },
        eq(col, v) { filters.push(row => row[col] === v); return q; },
        is(col, v) { filters.push(row => (row[col] ?? null) === v); return q; },
        order(col, { ascending = true } = {}) { order = { col, ascending }; return q; },
        limit() { return q; },
        async maybeSingle() {
          const r = match();
          if (patch) { for (const row of r) Object.assign(row, patch); }
          return { data: r[0] ?? null };
        },
        then(resolve) {
          const r = match();
          if (patch) { for (const row of r) Object.assign(row, patch); }
          return Promise.resolve({ data: r }).then(resolve);
        },
      };
      return q;
    },
  };
}

const waitingJob = (extra = {}) => ({
  job_id: 'j1', workspace_id: 'w1', status: AWAITING, paused_reason: 'awaiting_confirmation',
  window_days: 90, created_at: '2026-10-01T00:00:00Z', state: { estimate: { credits: 54 } }, ...extra,
});

test('the yes before paying is remembered and the job keeps waiting', async () => {
  const db = { contact_enrichment_jobs: [waitingJob()] };
  const sb = fakeSupabase(db);
  assert.equal(await rememberStartOnPayment(sb, 'w1'), true);
  const job = db.contact_enrichment_jobs[0];
  assert.equal(job.status, AWAITING);
  assert.ok(job.state.start_on_payment);
  assert.equal(job.state.estimate.credits, 54, 'the estimate survives');
});

test('paying starts the remembered backfill, once', async () => {
  const db = {
    workspaces: [{ id: 'w1', team_id: 't1', onboarding_completed_at: null }],
    contact_enrichment_jobs: [waitingJob({ state: { start_on_payment: { short: false } } })],
  };
  const sb = fakeSupabase(db);
  await startBackfillsOnPayment(sb, 't1');
  const job = db.contact_enrichment_jobs[0];
  assert.equal(job.status, 'pending');
  assert.ok(job.state.started_at);
  assert.equal(job.state.start_on_payment, undefined, 'the flag is spent');
  assert.ok(db.workspaces[0].onboarding_completed_at);
  // The webhook fires again (created, then updated): nothing new happens.
  const startedAt = job.state.started_at;
  await startBackfillsOnPayment(sb, 't1');
  assert.equal(job.state.started_at, startedAt);
});

test('paying does not start a backfill nobody said yes to', async () => {
  const db = { workspaces: [{ id: 'w1', team_id: 't1' }], contact_enrichment_jobs: [waitingJob()] };
  await startBackfillsOnPayment(fakeSupabase(db), 't1');
  assert.equal(db.contact_enrichment_jobs[0].status, AWAITING);
});

test('a remembered 30-day yes starts the 30-day window', async () => {
  const db = {
    workspaces: [{ id: 'w1', team_id: 't1' }],
    contact_enrichment_jobs: [waitingJob({ paused_reason: 'over_allowance', state: { start_on_payment: { short: true } } })],
  };
  await startBackfillsOnPayment(fakeSupabase(db), 't1');
  assert.equal(db.contact_enrichment_jobs[0].status, 'pending');
  assert.equal(db.contact_enrichment_jobs[0].window_days, 30);
});

test('over the ceiling never starts from a button or a payment', async () => {
  const db = { contact_enrichment_jobs: [waitingJob({ paused_reason: 'over_ceiling' })] };
  const r = await startAwaitingBackfill(fakeSupabase(db), 'w1');
  assert.equal(r.ok, false);
  assert.equal(r.error, 'needs_support');
  assert.equal(db.contact_enrichment_jobs[0].status, AWAITING);
});
