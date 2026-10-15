// A paid backfill runs to its own allowance, and the month's reads neither stop it nor are
// stopped by it (GET-699). It used to pause as paused_no_credits around a hardcoded 2,000 a
// month, counting its own reads against the month.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { backfillCreditState, backfillWindowOf, backfillAllowanceOf, BACKFILL_CREDIT_FLOOR } from '../src/utils/credits.mjs';
import { readWorkspace } from '../src/workers/emailThreadsDaily.mjs';

const D = 86_400_000;
const NOW = Date.parse('2026-10-04T12:00:00Z');
const job = (over = {}) => ({
  job_id: 'j1', workspace_id: 'ws1', window_days: 90,
  state: { started_at: new Date(NOW - 2 * D).toISOString(), estimate: { allowance: 6000 } },
  ...over,
});

// conversationCredits stand-in: backfill-window credits only (the month's reads land in total).
const counted = (backfill, total = 0) => async () => ({ backfill, total });
const noGate = async () => { throw new Error('the month gate must not be asked for a backfill'); };

test('a paid backfill keeps going past 2,000 credits: it runs to its 6,000 allowance', async () => {
  const at2500 = await backfillCreditState({}, job(), { selfHosted: false, now: NOW, conversationCredits: counted(2500, 9000), mayReadWorkspace: noGate });
  assert.equal(at2500.gated, true);
  assert.equal(at2500.kind, 'backfill');
  assert.equal(at2500.allowance, 6000);
  assert.equal(at2500.remaining, 3500, 'the month (9,000 read) does not touch the backfill');
  assert.ok(at2500.remaining > BACKFILL_CREDIT_FLOOR, 'so it does not pause');
  const at6000 = await backfillCreditState({}, job(), { selfHosted: false, now: NOW, conversationCredits: counted(6000), mayReadWorkspace: noGate });
  assert.equal(at6000.remaining, 0, 'and stops at its own allowance');
});

test('the count is the backfill window, the way the billing page counts it', async () => {
  let args = null;
  await backfillCreditState({}, job(), { selfHosted: false, now: NOW, conversationCredits: async (...a) => { args = a; return { backfill: 0, total: 0 }; } });
  const [, wsIds, since, until, windows] = args;
  assert.deepEqual(wsIds, ['ws1']);
  assert.equal(since, job().state.started_at);
  assert.equal(until, null);
  assert.deepEqual(windows, [{ from: job().state.started_at, to: new Date(NOW).toISOString() }]);
});

test('no limit (Custom) is not gated', async () => {
  const s = await backfillCreditState({}, job({ state: { started_at: job().state.started_at, estimate: { allowance: null } } }), { selfHosted: false, now: NOW, conversationCredits: counted(50_000) });
  assert.equal(s.gated, false);
});

test('a 30-day confirmation uses the 30-day estimate', () => {
  assert.equal(backfillAllowanceOf({ window_days: 30, state: { estimate: { allowance: 1 }, estimate_30: { allowance: 2 } } }), 2);
  assert.equal(backfillAllowanceOf({ window_days: 90, state: { estimate: { allowance: 1 }, estimate_30: { allowance: 2 } } }), 1);
  assert.equal(backfillAllowanceOf({ state: {} }), undefined);
});

test('the window closes after 30 days, like the api', () => {
  assert.ok(backfillWindowOf(job(), NOW));
  assert.equal(backfillWindowOf(job({ state: { started_at: new Date(NOW - 31 * D).toISOString() } }), NOW), null);
  assert.equal(backfillWindowOf({ state: {} }, NOW), null);
});

test('a job with no backfill window (an import) spends the month, as the real plan says', async () => {
  const imp = { job_id: 'j2', workspace_id: 'ws1', state: null };
  const asks = [];
  const s = await backfillCreditState({}, imp, { selfHosted: false,
    mayReadWorkspace: async (ws, o) => { asks.push(o); return { allowed: true, reason: null, untilStop: 7000 }; },
    conversationCredits: async () => { throw new Error('not counted locally'); },
  });
  assert.deepEqual(s, { gated: true, remaining: 7000, allowance: null, used: 0, kind: 'month' });
  assert.equal(asks[0].fresh, true);
  const over = await backfillCreditState({}, imp, { selfHosted: false, mayReadWorkspace: async () => ({ allowed: false, reason: 'over_credit_limit' }) });
  assert.equal(over.remaining, 0);
});

test('a counting error does not wedge the backfill', async () => {
  const s = await backfillCreditState({}, job(), { selfHosted: false, now: NOW, conversationCredits: async () => { throw new Error('db'); } });
  assert.equal(s.gated, false);
});

// The backfill's email read: month gate over its allowance must not size or stop it.
function harness(n, gateAnswer) {
  const due = Array.from({ length: n }, (_, i) => ({ key: `t${i}` }));
  const spent = [];
  return {
    spent,
    deps: {
      threadsToRead: async () => ({ due, externalIds: new Set(), reread: 0, skippedThreads: [] }),
      hydrateThreadBodies: async () => {},
      selectEmailThreads: ({ threads }) => ({ units: [...threads.values()], skippedThreads: [] }),
      markThreadSkipped: async () => {},
      readGmailThread: async () => ({ facts: [], commitments: [] }),
      mayReadWorkspace: async () => gateAnswer,
      noteCreditsSpent: (ws, c) => spent.push(c),
    },
  };
}

test('a backfill read is not stopped by the month being over, and does not spend the month', async () => {
  const h = harness(40, { allowed: false, reason: 'over_credit_limit', hardCap: false, untilStop: 0 });
  const stats = await readWorkspace({}, 'ws1', { maxThreads: 30, countsAgainstMonth: false, deps: h.deps });
  assert.equal(stats.read, 30, 'capped by the backfill allowance (maxThreads), not the month');
  assert.equal(h.spent.length, 0, "the month's spend-down is untouched");
});

test('a backfill read still stops for a workspace that is not paying', async () => {
  const h = harness(10, { allowed: false, reason: 'no_plan', hardCap: false, untilStop: 0 });
  const stats = await readWorkspace({}, 'ws1', { countsAgainstMonth: false, deps: h.deps });
  assert.equal(stats.read, 0);
  assert.equal(stats.paused, 'no_plan');
});

test('the daily read (the month) is still stopped by the month', async () => {
  const h = harness(10, { allowed: false, reason: 'over_credit_limit', hardCap: false, untilStop: 0 });
  const stats = await readWorkspace({}, 'ws1', { deps: h.deps });
  assert.equal(stats.read, 0);
});

test('self-host: a backfill is never held to an allowance, even one priced against a free plan (GET-850)', async () => {
  const s = await backfillCreditState({}, job(), { selfHosted: true, now: NOW, conversationCredits: counted(50_000), mayReadWorkspace: async () => ({ allowed: false }) });
  assert.equal(s.gated, false);
  assert.equal(s.kind, 'self_hosted');
});
