// The server half of `nous backfill` (GET-1085): one person's job, one person's calls.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { startOwnBackfill, ownBackfillRefusal, ownJob, answerOwnCall, OWN_MODELS } from '../src/lib/ownBackfill.mjs';

function fake(tables) {
  return { from(name) {
    const rows = tables[name] ?? (tables[name] = []);
    const fs = []; let patch = null;
    const m = () => rows.filter(r => fs.every(f => f(r)));
    const q = {
      select: () => q, not: () => q, limit: () => q,
      eq(k, v) { fs.push(k === 'state->own_model->>owner_user_id' ? r => r.state?.own_model?.owner_user_id === v : r => r[k] === v); return q; },
      in(k, vs) { fs.push(r => vs.includes(r[k])); return q; },
      update(p) { patch = p; return q; },
      async insert(row) { rows.push(row); return { error: null }; },
      async maybeSingle() { const r = m(); if (patch) r.forEach(x => Object.assign(x, patch)); return { data: r[0] ?? null }; },
      then(res) { const r = m(); if (patch) r.forEach(x => Object.assign(x, patch)); return res({ data: r }); },
    };
    return q;
  } };
}

test("a new job covers the person's own connections only, and never enters the hosted queue", async () => {
  const t = { contacts: [{ id: 'c', email: 'A@EXAMPLE.COM', workspace_id: 'w' }], contact_enrichment_jobs: [] };
  const r = await startOwnBackfill(fake(t), 'w', 'u', { days: 30 });
  const job = t.contact_enrichment_jobs[0];
  assert.equal(r.resumed, false);
  assert.equal(job.status, 'own_model_pending');
  assert.equal(job.state.own_model.owner_user_id, 'u');
  assert.equal(job.state.owner_user_id, 'u');
  assert.equal(job.contacts[0].email, 'a@example.com');
  // state.started_at would open a backfill credit window: these reads are no credits at all.
  assert.equal(job.state.started_at, undefined);
  assert.ok(job.state.own_model.started_at);
});

test('coming back frees what the last run held, so nobody waits out a lease', async () => {
  const t = {
    contact_enrichment_jobs: [{ job_id: 'j', workspace_id: 'w', status: 'own_model_running', state: { own_model: { owner_user_id: 'u' } } }],
    own_model_calls: [{ id: 'c', job_id: 'j', status: 'leased', leased_until: 'later' }],
  };
  assert.equal((await startOwnBackfill(fake(t), 'w', 'u')).resumed, true);
  assert.equal(t.own_model_calls[0].status, 'pending');
  assert.equal(t.own_model_calls[0].leased_until, null);
});

test('trial and paid plans run; lapsed and Free do not', () => {
  const now = Date.parse('2026-11-10');
  const paid = { plan_id: 'api', status: 'active' };
  assert.equal(ownBackfillRefusal(paid, now), null);
  assert.equal(ownBackfillRefusal({ plan_id: 'custom', status: 'active' }, now), null);
  assert.equal(ownBackfillRefusal({ plan_id: 'free', status: 'active', is_comp: true }, now), null);
  assert.equal(ownBackfillRefusal({ plan_id: 'api', status: 'trialing', trial_ends_at: '2026-11-14' }, now), null);
  assert.equal(ownBackfillRefusal({ plan_id: 'api', status: 'trialing', trial_ends_at: '2026-11-09' }, now), 'trial_ended');
  assert.equal(ownBackfillRefusal({ plan_id: 'api', status: 'trialing', trial_ends_at: 'not a date' }, now), 'trial_ended');
  // Stripe's own trial: Stripe ends it, by flipping the status.
  assert.equal(ownBackfillRefusal({ plan_id: 'api', status: 'trialing', trial_ends_at: '2026-11-09', stripe_subscription_id: 'sub_1' }, now), null);
  assert.equal(ownBackfillRefusal({ plan_id: 'api', status: 'canceled' }, now), 'canceled');
  assert.equal(ownBackfillRefusal({ plan_id: 'api', status: 'past_due', past_due_since: '2026-10-01' }, now), 'payment_failed');
  assert.ok(ownBackfillRefusal({ plan_id: 'free', status: 'active' }, now));
  assert.ok(ownBackfillRefusal(null, now));
});

test('running it again picks up the paused job', async () => {
  const t = { contact_enrichment_jobs: [{ job_id: 'j', workspace_id: 'w', status: 'paused_own_model', state: { own_model: { owner_user_id: 'u' } } }] };
  const r = await startOwnBackfill(fake(t), 'w', 'u');
  assert.deepEqual(r, { job_id: 'j', resumed: true });
  assert.equal(t.contact_enrichment_jobs[0].status, 'own_model_pending');
  assert.equal(t.contact_enrichment_jobs.length, 1);
});

test("one person can't see another's job or answer their call", async () => {
  const t = {
    contact_enrichment_jobs: [{ job_id: 'j', workspace_id: 'w', status: 'own_model_running', state: { own_model: { owner_user_id: 'u' } } }],
    own_model_calls: [{ id: 'c', workspace_id: 'w', owner_user_id: 'u', status: 'leased' }],
  };
  assert.equal(await ownJob(fake(t), 'w', 'other', 'j'), null);
  assert.equal(await answerOwnCall(fake(t), 'w', 'other', 'c', { answer: 'x' }), false);
  assert.equal(t.own_model_calls[0].status, 'leased');
  assert.equal(await answerOwnCall(fake(t), 'w', 'u', 'c', { answer: 'x', model: 'm' }), true);
  assert.equal(t.own_model_calls[0].status, 'done');
  assert.equal(await answerOwnCall(fake(t), 'w', 'u', 'c', { answer: 'late' }), false);
  assert.equal(t.own_model_calls[0].answer, 'x');
});

test('a call with no answer fails rather than reading as empty', async () => {
  const t = { own_model_calls: [{ id: 'c', workspace_id: 'w', owner_user_id: 'u', status: 'leased' }] };
  await answerOwnCall(fake(t), 'w', 'u', 'c', {});
  assert.equal(t.own_model_calls[0].status, 'failed');
});

test('the models are the ones the evals picked', () => {
  assert.deepEqual(OWN_MODELS.claude, { model: 'claude-haiku-5-5', effort: 'low' });
  assert.deepEqual(OWN_MODELS.codex, { model: 'gpt-6.1-sol', effort: 'low' });
});

test('the migration keeps the queue away from clients', () => {
  const sql = readFileSync(new URL('../../../supabase/migrations/2026_10_30_own_model_calls.sql', import.meta.url), 'utf8');
  assert.match(sql, /ENABLE ROW LEVEL SECURITY/);
});
