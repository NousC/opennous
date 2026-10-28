// API-plan notifications (GET-635): thresholds, de-duplication, the member toggle, plan gating.
//
// Run: node --test apps/api/tests/apiNotifications.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  wantsAlert, alertRecipients, consecutiveFailures, webhookAlertDue, webhookCooldownClear,
  creditsLowDue, dayBucket, sweepApiNotifications,
  WEBHOOK_FAILURE_THRESHOLD, CREDITS_LOW_PCT,
} from '../src/lib/apiNotifications.mjs';

const NOW = Date.parse('2026-10-03T12:00:00Z');
const H = 3600_000;
const D = 24 * H;
const iso = (ms) => new Date(ms).toISOString();

// ── Thresholds ──────────────────────────────────────────────────────────────

test('webhook: three failures in a row trigger, two do not, a success resets the count', () => {
  const f = { ok: false }; const s = { ok: true };
  assert.equal(WEBHOOK_FAILURE_THRESHOLD, 3);
  assert.equal(consecutiveFailures([f, f, f]), 3);
  assert.equal(consecutiveFailures([f, f, s, f]), 2);
  assert.equal(consecutiveFailures([s, f, f, f]), 0);
  assert.equal(webhookAlertDue({ attempts: [f, f, f] }), true);
  assert.equal(webhookAlertDue({ attempts: [f, f] }), false);
  assert.equal(webhookAlertDue({ attempts: [f, f, s] }), false);
  assert.equal(webhookAlertDue({ attempts: [] }), false);
});

test('webhook: a dead-lettered event triggers on its own', () => {
  assert.equal(webhookAlertDue({ attempts: [{ ok: false }], deadLettered: true }), true);
});

test('credits: from 80% of a real allowance until it is over; unlimited never warns', () => {
  assert.equal(CREDITS_LOW_PCT, 80);
  assert.equal(creditsLowDue({ included: 2000, used: 1600, percentUsed: 80 }), true);
  assert.equal(creditsLowDue({ included: 2000, used: 1580, percentUsed: 79 }), false);
  assert.equal(creditsLowDue({ included: 2000, used: 1980, percentUsed: 99 }), true);
  assert.equal(creditsLowDue({ included: 2000, used: 2000, percentUsed: 100 }), false);
  assert.equal(creditsLowDue({ included: 0, used: 0, percentUsed: 0 }), false);
  assert.equal(creditsLowDue({ included: 2000, percentUsed: 90, unlimited: true }), false);
});

// ── The toggle ──────────────────────────────────────────────────────────────

test('toggle: unset is on for owners and admins (credits: everyone); a stored value always wins', () => {
  assert.equal(wantsAlert(null, 'credits_low', 'owner'), true);
  assert.equal(wantsAlert(null, 'credits_low', 'admin'), true);
  assert.equal(wantsAlert(null, 'credits_low', 'member'), true);
  assert.equal(wantsAlert(null, 'webhook_failures', 'owner'), true);
  assert.equal(wantsAlert(null, 'webhook_failures', 'member'), false);
  assert.equal(wantsAlert({ daily_digest: true }, 'credits_low', 'admin'), true);
  assert.equal(wantsAlert({ credits_low: { email: false, app: false } }, 'credits_low', 'owner'), false);
  assert.equal(wantsAlert({ credits_low: { email: true, app: true } }, 'credits_low', 'member'), true);
  assert.equal(wantsAlert({ credits_low: { email: false, app: true } }, 'credits_low', 'member'), true);
});

test('recipients: switched-off members are skipped, emails are unique', () => {
  const to = alertRecipients([
    { role: 'owner', email: 'a@x.co', notification_prefs: null },
    { role: 'admin', email: 'b@x.co', notification_prefs: { webhook_failures: { email: false, app: false } } },
    { role: 'member', email: 'c@x.co', notification_prefs: null },
    { role: 'member', email: 'd@x.co', notification_prefs: { webhook_failures: { email: true, app: true } } },
    { role: 'owner', email: 'a@x.co', notification_prefs: null },
    { role: 'owner', email: null, notification_prefs: null },
  ], 'webhook_failures');
  assert.deepEqual(to, ['a@x.co', 'd@x.co']);
});

// ── De-duplication ──────────────────────────────────────────────────────────

test('webhook cooldown: none within 24h, and only again after a new failure', () => {
  assert.equal(webhookCooldownClear({ lastAlertAt: null, lastFailureAt: iso(NOW), now: NOW }), true);
  assert.equal(webhookCooldownClear({ lastAlertAt: iso(NOW - 23 * H), lastFailureAt: iso(NOW), now: NOW }), false);
  assert.equal(webhookCooldownClear({ lastAlertAt: iso(NOW - 25 * H), lastFailureAt: iso(NOW - H), now: NOW }), true);
  assert.equal(webhookCooldownClear({ lastAlertAt: iso(NOW - 25 * H), lastFailureAt: iso(NOW - 26 * H), now: NOW }), false);
  assert.equal(dayBucket(NOW), '2026-10-03T00:00:00.000Z');
});

/** A fake of supabaseDb: two teams, one per plan, with a reservation table that rejects repeats. */
function fakeDb({ apiTeamPlan = 'api', attempts = null, credits = null } = {}) {
  const live = { status: 'active', stripe_subscription_id: 'sub_1' };
  const subs = {
    tApi: { team_id: 'tApi', plan_id: apiTeamPlan, ...live },
    tCustom: { team_id: 'tCustom', plan_id: 'custom', ...live },
  };
  const workspaces = new Map([
    ['wApi', { id: 'wApi', team_id: 'tApi', name: 'Acme' }],
    ['wCustom', { id: 'wCustom', team_id: 'tCustom', name: 'Big Co' }],
  ]);
  const members = {
    wApi: [
      { workspace_id: 'wApi', role: 'owner', email: 'owner@acme.co', notification_prefs: null },
      { workspace_id: 'wApi', role: 'member', email: 'rep@acme.co', notification_prefs: null },
    ],
    wCustom: [{ workspace_id: 'wCustom', role: 'owner', email: 'owner@big.co', notification_prefs: null }],
  };
  const fail = { ok: false, status_code: 500, error: 'boom', created_at: iso(NOW - H) };
  const log = [];
  const db = {
    log, memberRows: members, failureAt: iso(NOW - H),
    calls: { recentAttempts: [], lastDeadLetter: [] },
    deadAt: null,
    async workspacesByTeams(teamIds) { return new Map([...workspaces].filter(([, w]) => teamIds.includes(w.team_id))); },
    async activeSubscriptions(wsIds) {
      return [
        { id: 's1', workspace_id: 'wApi', name: 'CRM sync', url: 'https://a.co/hook', active: true },
        { id: 's2', workspace_id: 'wCustom', name: 'Other', url: 'https://b.co/hook', active: true },
      ].filter((s) => wsIds.includes(s.workspace_id));
    },
    async recentAttempts(id, n) {
      db.calls.recentAttempts.push([id, n]);
      return attempts ?? [0, 1, 2].map(() => ({ ...fail, created_at: db.failureAt }));
    },
    async lastDeadLetter(id) { db.calls.lastDeadLetter.push(id); return db.deadAt; },
    async teamWorkspaces(teamId) { return [...workspaces.values()].filter((w) => w.team_id === teamId); },
    async allSubscriptions() { return Object.values(subs).map((sub) => ({ team_id: sub.team_id, sub })); },
    async members(ids) { return ids.flatMap((id) => members[id] ?? []); },
    async lastAlert(teamId, kind) {
      const rows = log.filter((r) => r.team_id === teamId && r.kind === kind);
      return rows.length ? rows[rows.length - 1].sent_at : null;
    },
    async reserve(teamId, kind, periodStart) {
      if (log.some((r) => r.team_id === teamId && r.kind === kind && r.period_start === periodStart)) return false;
      log.push({ team_id: teamId, kind, period_start: periodStart, sent_at: iso(NOW) });
      return true;
    },
    async credits() {
      return credits ?? { used: 1700, included: 2000, percentUsed: 85, unlimited: false, periodStart: '2026-09-20T00:00:00.000Z' };
    },
  };
  return db;
}

test('sweep: API-plan workspace only; webhook alerts the owner, credits every member', async () => {
  const db = fakeDb();
  const queued = await sweepApiNotifications(db, { now: NOW });
  assert.deepEqual(queued.map((q) => q.kind).sort(), ['credits_low', 'webhook_failures']);
  assert.deepEqual(queued.find((q) => q.kind === 'webhook_failures').to, ['owner@acme.co']);
  assert.deepEqual(queued.find((q) => q.kind === 'credits_low').to, ['owner@acme.co', 'rep@acme.co']);
  const hook = queued.find((q) => q.kind === 'webhook_failures');
  assert.equal(hook.subscriptionName, 'CRM sync');
  assert.equal(hook.failures, 3);
  assert.equal(queued.find((q) => q.kind === 'credits_low').percentUsed, 85);
});

test('sweep: run twice, sends once', async () => {
  const db = fakeDb();
  assert.equal((await sweepApiNotifications(db, { now: NOW })).length, 2);
  assert.equal((await sweepApiNotifications(db, { now: NOW + 15 * 60_000 })).length, 0);
  // A day on with no new failure: still nothing. The credits never repeat.
  assert.deepEqual(await sweepApiNotifications(db, { now: NOW + 25 * H }), []);
  // A day on and failing again: the webhook alerts once more, nothing else does.
  db.failureAt = iso(NOW + 24.5 * H);
  const again = await sweepApiNotifications(db, { now: NOW + 25 * H });
  assert.deepEqual(again.map((q) => q.kind), ['webhook_failures']);
});

test('sweep: nothing at all when the team is not on the API plan', async () => {
  const db = fakeDb({ apiTeamPlan: 'custom' });
  assert.deepEqual(await sweepApiNotifications(db, { now: NOW }), []);
  assert.equal(db.log.length, 0);
});

test('sweep: members who switched it off get nothing, and nothing is reserved', async () => {
  const db = fakeDb();
  const off = { webhook_failures: { email: false, app: false }, credits_low: { email: false, app: false } };
  db.memberRows.wApi[0].notification_prefs = off;
  db.memberRows.wApi[1].notification_prefs = off;
  assert.deepEqual(await sweepApiNotifications(db, { now: NOW }), []);
  assert.equal(db.log.length, 0);
});

test('sweep: below the thresholds, nothing', async () => {
  const db = fakeDb({
    attempts: [{ ok: false }, { ok: false }, { ok: true }],
    credits: { used: 1000, included: 2000, percentUsed: 50, unlimited: false, periodStart: '2026-09-20T00:00:00.000Z' },
  });
  assert.deepEqual(await sweepApiNotifications(db, { now: NOW }), []);
});

test('sweep: only the kinds asked for', async () => {
  const queued = await sweepApiNotifications(fakeDb(), { kinds: ['credits_low'], now: NOW });
  assert.deepEqual(queued.map((q) => q.kind), ['credits_low']);
});

test('sweep: webhook reads are per API-plan subscription, last 3 attempts each — never a global scan', async () => {
  const db = fakeDb();
  await sweepApiNotifications(db, { kinds: ['webhook_failures'], now: NOW });
  // Only the API workspace's subscription is read; the Custom one never is.
  assert.deepEqual(db.calls.recentAttempts, [['s1', 3]]);
  assert.deepEqual(db.calls.lastDeadLetter, ['s1']);
});

test('sweep: a dead letter alone alerts; failures older than a day do not', async () => {
  const dead = fakeDb({ attempts: [{ ok: true, created_at: iso(NOW - 2 * H) }] });
  dead.deadAt = iso(NOW - H);
  const q = await sweepApiNotifications(dead, { kinds: ['webhook_failures'], now: NOW });
  assert.equal(q.length, 1);
  assert.equal(q[0].deadLettered, true);

  const stale = fakeDb();
  stale.failureAt = iso(NOW - 3 * D);
  assert.deepEqual(await sweepApiNotifications(stale, { kinds: ['webhook_failures'], now: NOW }), []);
});

test('credits: no api_credits_low once the 90% ops email (state warn) covers it', () => {
  assert.equal(creditsLowDue({ included: 2000, percentUsed: 85, state: 'ok' }), true);
  assert.equal(creditsLowDue({ included: 2000, percentUsed: 92, state: 'warn' }), false);
});
