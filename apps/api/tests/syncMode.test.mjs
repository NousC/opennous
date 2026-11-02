// Which onboarding a workspace gets, and the sync's status (GET-1087).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { workspaceSyncMode } from '../src/lib/backfillStart.mjs';
import { countHistoryToRead, distinctMeetingCount, enqueueWorkspaceHistoryBackfill, enqueueWorkspaceSync, SYNC_WINDOW_DAYS } from '../src/lib/historyBackfill.mjs';
import { syncStateOf } from '../src/lib/syncStatus.mjs';

function fake(tables) {
  const inserted = [];
  return {
    inserted,
    from(name) {
      const filters = [];
      const q = {
        select() { return q; }, eq(c, v) { filters.push(r => r[c] === v); return q; },
        in(c, v) { filters.push(r => v.includes(r[c])); return q; }, is() { return q; },
        or() { return q; }, order() { return q; }, limit() { return q; },
        insert(row) { inserted.push(row); return Promise.resolve({ error: null }); },
        async maybeSingle() { return { data: (tables[name] ?? []).find(r => filters.every(f => f(r))) ?? null }; },
        then(res) { return Promise.resolve({ data: (tables[name] ?? []).filter(r => filters.every(f => f(r))) }).then(res); },
      };
      return q;
    },
  };
}
const ws = { workspaces: [{ id: 'w', team_id: 't' }] };
const sub = (plan_id) => ({ subscriptions: [{ team_id: 't', plan_id, plan_name: plan_id, status: 'active' }] });

test('a new API-tier workspace syncs; custom keeps the confirmed backfill', async () => {
  assert.equal(await workspaceSyncMode(fake({ ...ws, ...sub('api') }), 'w', { selfHosted: false }), true);
  assert.equal(await workspaceSyncMode(fake({ ...ws }), 'w', { selfHosted: false }), true, 'no subscription is the API tier');
  assert.equal(await workspaceSyncMode(fake({ ...ws, ...sub('custom') }), 'w', { selfHosted: false }), false);
});

test('a workspace that ran a backfill stays as it is; one on a sync stays on it', async () => {
  const ran = { contact_enrichment_jobs: [{ workspace_id: 'w', started_at: '2026-10-01' }] };
  assert.equal(await workspaceSyncMode(fake({ ...ws, ...sub('api'), ...ran }), 'w', { selfHosted: false }), false);
  const both = { contact_enrichment_jobs: [{ workspace_id: 'w', sync_only: 'true' }, { workspace_id: 'w', started_at: '2026-10-01' }] };
  assert.equal(await workspaceSyncMode(fake({ ...ws, ...sub('api'), ...both }), 'w', { selfHosted: false }), true);
});

test('self-host never syncs', async () => {
  assert.equal(await workspaceSyncMode(fake({ ...ws, ...sub('api') }), 'w', { selfHosted: true }), false);
});

const connected = (name) => ({
  workflow_providers: [{ id: 'p', name }],
  workflow_provider_connections: [{ id: 'c', workspace_id: 'w', provider_id: 'p', owner_user_id: 'u' }],
});

test('email on an empty graph starts the sync at once: pending, twelve months, no estimate', async () => {
  const db = fake({ ...connected('gmail_oauth'), contacts: [], contact_enrichment_jobs: [] });
  assert.ok(await enqueueWorkspaceSync(db, 'w', { reason: 'connect:gmail_oauth' }));
  const job = db.inserted[0];
  assert.equal(job.status, 'pending');
  assert.equal(job.window_days, SYNC_WINDOW_DAYS);
  assert.equal(job.state.sync_only, true);
  assert.equal(job.state.estimate, undefined);
  assert.equal(job.state.started_at, undefined, 'started_at opens the backfill credits window; a sync spends none');
});

test('a CRM alone waits, and a payment starts nothing', async () => {
  const none = fake({ workflow_providers: [], workflow_provider_connections: [], contacts: [] });
  assert.equal(await enqueueWorkspaceSync(none, 'w', { reason: 'connect:hubspot' }), null);
  const db = fake({ ...connected('fireflies'), contacts: [] });
  assert.equal(await enqueueWorkspaceSync(db, 'w', { reason: 'payment' }), null);
  assert.equal(db.inserted.length, 0);
});

test('a member syncs only on a connection of their own', async () => {
  const db = fake({ ...connected('granola'), contacts: [], contact_enrichment_jobs: [] });
  assert.equal(await enqueueWorkspaceSync(db, 'w', { ownerUserId: 'other' }), null);
  assert.ok(await enqueueWorkspaceSync(db, 'w', { ownerUserId: 'u' }));
  assert.equal(db.inserted[0].state.owner_user_id, 'u');
});

test('a lapsed trial starts no sync; a Free row and a live trial do', async () => {
  const past = new Date(Date.now() - 86400_000).toISOString();
  const row = (s) => ({ subscriptions: [{ team_id: 't', ...s }] });
  const base = { ...ws, ...connected('gmail_oauth'), contacts: [], contact_enrichment_jobs: [] };
  const lapsed = fake({ ...base, ...row({ plan_id: 'api', status: 'trialing', trial_ends_at: past }) });
  assert.equal(await enqueueWorkspaceSync(lapsed, 'w'), null);
  assert.ok(await enqueueWorkspaceSync(fake({ ...base, ...row({ plan_id: 'free', status: 'active' }) }), 'w'));
  assert.ok(await enqueueWorkspaceSync(fake({ ...base, ...row({ plan_id: 'api', status: 'trialing', trial_ends_at: new Date(Date.now() + 86400_000).toISOString() }) }), 'w'));
});

test('the state reads from the jobs', () => {
  assert.equal(syncStateOf([]), 'none');
  assert.equal(syncStateOf([{ status: 'pending' }, { status: 'done' }]), 'running');
  assert.equal(syncStateOf([{ status: 'done' }]), 'done');
  assert.equal(syncStateOf([{ status: 'failed' }]), 'failed');
  assert.equal(syncStateOf([{ status: 'paused_trial_ended' }]), 'stopped');
});

test('a paid read is written as a read in sync mode, not rerouted to a sync', async () => {
  const db = fake({ ...ws, ...sub('api'), ...connected('gmail_oauth'), contacts: [], contact_enrichment_jobs: [{ workspace_id: 'w', sync_only: 'true', status: 'done' }] });
  const paid = { session_id: 'cs_1', credits: 4000, allowance: 4400, days: 365 };
  assert.ok(await enqueueWorkspaceHistoryBackfill(db, 'w', { windowDays: 365, reason: 'paid', paid }));
  const job = db.inserted[0];
  assert.equal(job.status, 'paused_awaiting_confirmation', 'the webhook starts it next');
  assert.equal(job.window_days, 365);
  assert.deepEqual(job.state.paid_backfill, { session_id: 'cs_1', credits: 4000, days: 365 });
  assert.equal(job.state.sync_only, undefined);
});

test('a paid read alone keeps a workspace in sync mode, so subscribing later reads nothing', async () => {
  const paidOnly = { contact_enrichment_jobs: [{ workspace_id: 'w', started_at: '2026-11-01', paid: '{"days":90}' }] };
  assert.equal(await workspaceSyncMode(fake({ ...ws, ...sub('api'), ...paidOnly }), 'w', { selfHosted: false }), true);
});

test('after a sync the estimate is what it filed; before one it asks the source', async () => {
  const counted = (n) => ({
    from(name) {
      const q = {
        select() { return q; }, eq() { return q; }, in() { return q; }, gte() { return q; }, limit() { return q; }, order() { return q; }, range() { return q; },
        then(res) {
          if (name === 'contact_enrichment_jobs') return Promise.resolve({ data: n == null ? [] : [{ job_id: 'j' }] }).then(res);
          // Each meeting has two attendees, so two rows.
          return Promise.resolve({ count: n ?? 0, data: Array.from({ length: (n ?? 0) * 2 }, (_, i) => ({ id: i, source_ref: `source://fireflies/m${i >> 1}` })) }).then(res);
        },
      };
      return q;
    },
  });
  const atSource = async () => ({ counts: { email_thread: 0, meeting: 0, call: 0 }, meetingCredits: 0, sources: {} });
  const filed = await countHistoryToRead(counted(10), 'w', [], { days: 90, atSource });
  assert.ok(filed.counts.email_thread > 0);
  assert.equal(filed.counts.meeting, 10, 'one read per call, not one per attendee');
  assert.deepEqual(Object.keys(filed.sources), ['graph']);
  assert.deepEqual((await countHistoryToRead(counted(null), 'w', [], { days: 90, atSource })).sources, {}, 'no sync yet');
  assert.deepEqual((await countHistoryToRead(counted(10), 'w', [], { days: 730, atSource })).sources, {}, 'past what a sync covers');
  assert.deepEqual((await countHistoryToRead(counted(0), 'w', [], { days: 90, atSource })).sources, {}, 'a sync that filed nothing proves nothing');
});

test('the size plan-fit recommends is a size /subscribe sells', async () => {
  const { recommendedSize, sizeForPurchase } = await import('../src/lib/plans.mjs');
  process.env.STRIPE_CREDITS_1000_PRICE_ID = 'price_a'; process.env.STRIPE_CREDITS_4000_PRICE_ID = 'price_b'; process.env.STRIPE_CREDITS_10000_PRICE_ID = 'price_c';
  try {
    assert.equal(sizeForPurchase(recommendedSize(3000)).priceEnv, 'STRIPE_CREDITS_4000_PRICE_ID');
    assert.equal(sizeForPurchase(recommendedSize(100)).priceEnv, 'STRIPE_CREDITS_1000_PRICE_ID');
    assert.equal(sizeForPurchase(3333), null, 'a size not on sale is refused, never swapped');
  } finally {
    delete process.env.STRIPE_CREDITS_1000_PRICE_ID; delete process.env.STRIPE_CREDITS_4000_PRICE_ID; delete process.env.STRIPE_CREDITS_10000_PRICE_ID;
  }
});

test('a meeting counts once, by its source or by the id inside external_id', () => {
  const c = '7fb17432-fdb9-4247-92a8-04679494e910', d = 'f086fd64-a425-4768-8721-7ec1d2d8e907';
  assert.equal(distinctMeetingCount([{ id: 1, external_id: `ff_a_${c}` }, { id: 2, external_id: `ff_a_${d}` }, { id: 3, external_id: `ff_b_${c}` }]), 2);
  assert.equal(distinctMeetingCount([{ id: 1, source_ref: 'x' }, { id: 2, source_ref: 'x' }]), 1);
  assert.equal(distinctMeetingCount([{ id: 1, source_ref: `source://fireflies/ff_a_${c}`, external_id: `ff_a_${c}` }, { id: 2, source_ref: `source://fireflies/ff_a_${d}`, external_id: `ff_a_${d}` }]), 1, 'source_ref is per attendee too');
});
