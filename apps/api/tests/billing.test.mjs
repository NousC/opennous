/**
 * Pure unit tests for the billing layer — no DB required.
 *
 * DELIBERATELY PARTIAL while pricing is in transition (2026-08): the ladder
 * moved from five tiers (free/starter/pro/growth/scale) to api ($199,
 * self-serve) + headless (sales-led), and includedOpsPerMonth is now null
 * everywhere. Tests that assert the retired ladder or the old ops meter are
 * marked `skip` with a reason rather than rewritten — rewriting before the
 * new ladder settles means rewriting twice. Invariant tests (plan resolution,
 * period math, self-host flag) still run and must stay green.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

const SKIP_LADDER = 'asserts the retired 5-tier ladder — rewrite when the api/headless pricing is final (2026-08-05)';
const SKIP_OPS = 'getTeamOpsUsage query shape changed and includedOpsPerMonth is now null — rewrite with the final pricing (2026-08-05)';

test('plans: five tiers with the expected ops + enrichment ladders + prices', { skip: SKIP_LADDER }, async () => {
  const { PLANS } = await import('../src/lib/plans.mjs');
  assert.deepEqual(Object.keys(PLANS).sort(), ['free', 'growth', 'pro', 'scale', 'starter']);
  assert.equal(PLANS.free.includedOpsPerMonth, 1_000);
  assert.equal(PLANS.starter.includedOpsPerMonth, 10_000);
  assert.equal(PLANS.pro.includedOpsPerMonth, 25_000);
  assert.equal(PLANS.growth.includedOpsPerMonth, 100_000);
  assert.equal(PLANS.scale.includedOpsPerMonth, 500_000);
  // Enrichment is bring-your-own-keys: no plan includes a managed allowance.
  for (const id of ['free', 'starter', 'pro', 'growth', 'scale']) {
    assert.equal(PLANS[id].enrichmentsPerMonth, 0, `${id} should include 0 enrichments (BYOK)`);
  }
  // Pro is single-workspace like Start; Growth=3; Partner base=5 (then per-client).
  assert.equal(PLANS.starter.workspaceLimit, 1);
  assert.equal(PLANS.pro.workspaceLimit, 1);
  assert.equal(PLANS.growth.workspaceLimit, 3);
  assert.equal(PLANS.scale.workspaceLimit, 5);
  // Prices: Free $0 / Start $29 / Pro $99 / Growth $249 / Partner $500 base.
  assert.equal(PLANS.free.monthlyPriceUsd, 0);
  assert.equal(PLANS.starter.monthlyPriceUsd, 29);
  assert.equal(PLANS.pro.monthlyPriceUsd, 99);
  assert.equal(PLANS.growth.monthlyPriceUsd, 249);
  assert.equal(PLANS.scale.monthlyPriceUsd, 500);
  // Partner per-client pricing fields.
  assert.equal(PLANS.scale.perWorkspaceUsd, 100);
  assert.equal(PLANS.scale.baseWorkspaces, 5);
  // Display names: internal ids 'starter'/'scale' show as Start/Partner.
  assert.equal(PLANS.starter.name, 'Start');
  assert.equal(PLANS.scale.name, 'Partner');
});

test('hasFeature: team-layer features (crmSync/leadLists/icpScoring) on every cloud plan', { skip: SKIP_LADDER }, async () => {
  const { hasFeature } = await import('../src/lib/plans.mjs');
  // Pure-tier model: every feature is on every cloud plan; tiers differ by the ops
  // + records meters, not feature gates. Self-host is gated separately by
  // CLOUD_ONLY_FEATURES — see the requireFeature test below.
  for (const p of ['free', 'starter', 'pro', 'growth', 'scale']) {
    assert.equal(hasFeature(p, 'contextualization'), true, `${p} contextualization`);
    assert.equal(hasFeature(p, 'crmSync'), true, `${p} crmSync`);
    assert.equal(hasFeature(p, 'leadLists'), true, `${p} leadLists`);
    assert.equal(hasFeature(p, 'icpScoring'), true, `${p} icpScoring`);
  }
  // LinkedIn engagement is the one feature that still unlocks at Pro+.
  assert.equal(hasFeature('free', 'linkedinEngagement'), false);
  assert.equal(hasFeature('starter', 'linkedinEngagement'), false);
  for (const p of ['pro', 'growth', 'scale']) {
    assert.equal(hasFeature(p, 'linkedinEngagement'), true, `${p} linkedinEngagement`);
  }
});

test('requireFeature: self-host is the Self-serve plan; only the Workspace layer is blocked (GET-576)', async () => {
  process.env.SELF_HOSTED = 'true';
  try {
    const { requireFeature, blockOnSelfHost } = await import('../src/lib/access.mjs');
    const run = async (mw) => {
      let status = null, body = null, nexted = false;
      const res = { status(s) { status = s; return this; }, json(b) { body = b; return this; } };
      await mw({}, res, () => { nexted = true; });
      return { status, body, nexted };
    };
    // Self-serve surfaces pass on self-host: CRM sync (HubSpot, Salesforce), lead lists,
    // webhooks, automations, the ICP model, the open primitive.
    for (const f of ['crmSync', 'leadLists', 'triggers', 'automations', 'icpScoring', 'contextualization']) {
      assert.equal((await run(requireFeature(f))).nexted, true, `${f} must pass on self-host`);
      assert.equal((await run(blockOnSelfHost(f))).nexted, true, `${f} must not be blocked on self-host`);
    }
    // The Workspace layer is cloud-only.
    for (const f of ['inAppAgent', 'playground', 'tasks', 'skills', 'reports', 'slack']) {
      const r = await run(requireFeature(f));
      assert.equal(r.nexted, false, `${f} must NOT pass on self-host`);
      assert.equal(r.status, 403, `${f} → 403`);
      assert.equal(r.body.error, 'cloud_only_feature', `${f} → cloud_only_feature`);
    }
  } finally {
    delete process.env.SELF_HOSTED;
  }
});

test('effectiveWorkspaceLimit: flat plans static; Partner tracks Stripe quantity', { skip: SKIP_LADDER }, async () => {
  const { PLANS, effectiveWorkspaceLimit } = await import('../src/lib/plans.mjs');
  // Flat plans ignore quantity.
  assert.equal(effectiveWorkspaceLimit(PLANS.pro, { quantity: 9 }), 1);
  assert.equal(effectiveWorkspaceLimit(PLANS.growth, null), 3);
  // Partner: max(base 5, purchased quantity).
  assert.equal(effectiveWorkspaceLimit(PLANS.scale, { quantity: 5 }), 5);
  assert.equal(effectiveWorkspaceLimit(PLANS.scale, { quantity: 8 }), 8);
  assert.equal(effectiveWorkspaceLimit(PLANS.scale, { quantity: 2 }), 5, 'never below base');
  assert.equal(effectiveWorkspaceLimit(PLANS.scale, null), 5, 'no sub → base');
  // Defensive: a synthetic unlimited plan stays unlimited.
  assert.equal(effectiveWorkspaceLimit({ workspaceLimit: null }, { quantity: 3 }), null);
});

test('getPlanFromSubscription: nothing, dead or lapsed all land on API', async () => {
  const { getPlanFromSubscription } = await import('../src/lib/plans.mjs');
  assert.equal(getPlanFromSubscription(null).id, 'api');
  assert.equal(getPlanFromSubscription({ plan_id: 'custom', status: 'past_due' }).id, 'api');
  assert.equal(getPlanFromSubscription({ plan_id: 'custom', status: 'canceled' }).id, 'api');
  // The retired 'workspace' id is the Workspace plan, whose id is 'custom'.
  assert.equal(getPlanFromSubscription({ plan_id: 'workspace', status: 'active' }).id, 'custom');
  assert.equal(getPlanFromSubscription({ plan_id: 'custom', status: 'active' }).id, 'custom');
});

test('getPlanFromSubscription: a live trial keeps its plan, an expired one does not', { skip: 'trial expiry left getPlanFromSubscription with GET-532 (no trials); planIsLive gates reading. Decide whether an expired trial row should fall to api, then rewrite' }, async () => {
  const { getPlanFromSubscription } = await import('../src/lib/plans.mjs');
  const inADay = new Date(Date.now() + 86_400_000).toISOString();
  const yesterday = new Date(Date.now() - 86_400_000).toISOString();
  assert.equal(getPlanFromSubscription({ plan_id: 'workspace', status: 'trial', trial_ends_at: inADay }).id, 'custom');
  assert.equal(getPlanFromSubscription({ plan_id: 'workspace', status: 'trial', trial_ends_at: yesterday }).id, 'api');
  assert.equal(getPlanFromSubscription({ plan_id: 'workspace', status: 'trial', trial_ends_at: 'not-a-date' }).id, 'api');
});

test('the catalogue is two plans: Self-serve and Workspace', async () => {
  const { PLANS, PLAN_IDS, SELLABLE_PLAN_IDS } = await import('../src/lib/plans.mjs');
  // Free is a plan id (GET-700's hard stop) but checks out for $0, so it is never sold.
  assert.deepEqual([...PLAN_IDS].sort(), ['api', 'custom', 'free']);
  assert.deepEqual([...SELLABLE_PLAN_IDS].sort(), ['api', 'custom']);
  // Self-serve's floor bundle; the real price and credits come from the Stripe tier.
  assert.equal(PLANS.api.monthlyPriceUsd, 49);
  assert.equal(PLANS.api.aiCreditsPerMonth, 960);
  assert.equal(PLANS.custom.monthlyPriceUsd, null, 'Workspace is quoted');
});

test('Self-serve carries the graph, CRM sync and automations; the Workspace layer is not in it', async () => {
  const { PLANS } = await import('../src/lib/plans.mjs');
  for (const f of ['insights', 'automations', 'crmSync', 'leadLists', 'webhooks']) {
    assert.equal(PLANS.api.features[f], true, `api should have ${f}`);
  }
  for (const f of ['inAppAgent', 'skills', 'tasks', 'slack']) {
    assert.equal(PLANS.api.features[f], false, `api should not have ${f}`);
    assert.equal(PLANS.custom.features[f], true, `custom should have ${f}`);
  }
});

test('normalizePlanId: every retired id still resolves to what it became', async () => {
  const { normalizePlanId } = await import('../src/lib/plans.mjs');
  // Live rows still carry these retired ids.
  for (const id of ['free', 'starter', 'pro', 'scale']) {
    assert.equal(normalizePlanId(id), 'api', `${id} should resolve to api`);
  }
  for (const id of ['growth', 'headless', 'enterprise', 'workspace']) {
    assert.equal(normalizePlanId(id), 'custom', `${id} should resolve to custom (Workspace)`);
  }
  assert.equal(normalizePlanId('lifetime'), 'api', 'an id we never had falls to the entry plan');
  assert.equal(normalizePlanId(undefined), 'api');
});

test('periodStartFor: uses a running Stripe period, else start of month', async () => {
  const { periodStartFor } = await import('../src/lib/plans.mjs');
  const now = new Date('2026-09-14T01:00:00.000Z');
  const stripeStart = '2026-09-03T00:00:00.000Z';
  assert.equal(
    periodStartFor({ current_period_start: stripeStart, current_period_end: '2026-10-03T00:00:00.000Z' }, now).toISOString(),
    stripeStart,
  );
  assert.equal(periodStartFor(null, now).toISOString(), '2026-09-01T00:00:00.000Z', 'free-plan fallback is the 1st');
});

test('periodStartFor: a frozen hand-assigned period rolls forward monthly on its anchor day', async () => {
  const { periodStartFor } = await import('../src/lib/plans.mjs');
  const now = new Date('2026-09-14T01:00:00.000Z');
  // Custom/comp: assigned 2026-04-19, no end, never renewed → this period began 2026-08-19.
  assert.equal(periodStartFor({ current_period_start: '2026-04-19T09:30:00.000Z', current_period_end: null }, now).toISOString(), '2026-08-19T09:30:00.000Z');
  // Expired end, anchor day already passed this month → this month's anchor day.
  assert.equal(periodStartFor({ current_period_start: '2026-07-10T00:00:00.000Z', current_period_end: '2026-08-10T00:00:00.000Z' }, now).toISOString(), '2026-09-10T00:00:00.000Z');
  // Short month clamps: anchored on the 31st, in March → Feb 28.
  assert.equal(periodStartFor({ current_period_start: '2026-01-31T00:00:00.000Z' }, new Date('2026-03-15T00:00:00.000Z')).toISOString(), '2026-02-28T00:00:00.000Z');
});

// getTeamOpsUsage sums billable_ops via the team_ops_used RPC. No top-up balance.
function makeOpsStub(opsUsed) {
  return {
    rpc: async (fn, args) => {
      assert.equal(fn, 'team_ops_used');
      assert.ok(args.p_team_id && args.p_since, 'rpc args present');
      return { data: opsUsed, error: null };
    },
  };
}

// Stub for getTeamOpsState: team_ops_used rpc + a team_ops_grace row, recording
// any upsert writes so we can assert the grace clock is stamped/cleared.
function makeStateStub(opsUsed, graceStartedAt = null) {
  const writes = [];
  return {
    _writes: writes,
    rpc: async () => ({ data: opsUsed, error: null }),
    from: (table) => {
      assert.equal(table, 'team_ops_grace');
      return {
        select: () => ({ eq: () => ({ maybeSingle: async () => ({
          data: graceStartedAt ? { grace_started_at: graceStartedAt } : null,
        }) }) }),
        upsert: async (row) => { writes.push(row); return { data: null, error: null }; },
      };
    },
  };
}
const ago = (days) => new Date(Date.now() - days * 86400000).toISOString();

test('getTeamOpsState: under limit → ok, no grace write', { skip: SKIP_OPS }, async () => {
  const { getTeamOpsState } = await import('../src/lib/plans.mjs');
  const stub = makeStateStub(200); // free included 1000 → 20%
  const s = await getTeamOpsState(stub, 't1', null);
  assert.equal(s.state, 'ok');
  assert.equal(s.percentUsed, 20);
  assert.equal(s.graceUntil, null);
  assert.equal(stub._writes.length, 0);
});

test('getTeamOpsState: >=80% under limit → warn', { skip: SKIP_OPS }, async () => {
  const { getTeamOpsState } = await import('../src/lib/plans.mjs');
  const s = await getTeamOpsState(makeStateStub(850), 't1', null);
  assert.equal(s.state, 'warn');
  assert.equal(s.percentUsed, 85);
});

test('getTeamOpsState: just crossed the limit → grace, stamps the clock', { skip: SKIP_OPS }, async () => {
  const { getTeamOpsState } = await import('../src/lib/plans.mjs');
  const stub = makeStateStub(1000); // == included
  const s = await getTeamOpsState(stub, 't1', null);
  assert.equal(s.state, 'grace');
  assert.ok(s.graceUntil, 'graceUntil set');
  assert.equal(stub._writes.length, 1, 'grace clock stamped on first crossing');
  assert.ok(stub._writes[0].grace_started_at, 'stamp has a start time');
});

test('getTeamOpsState: over, grace started 1d ago → grace', { skip: SKIP_OPS }, async () => {
  const { getTeamOpsState } = await import('../src/lib/plans.mjs');
  const stub = makeStateStub(1200, ago(1));
  const s = await getTeamOpsState(stub, 't1', null);
  assert.equal(s.state, 'grace');
  assert.equal(stub._writes.length, 0, 'clock already running, no rewrite');
});

test('getTeamOpsState: over, grace started 5d ago → restricted', { skip: SKIP_OPS }, async () => {
  const { getTeamOpsState } = await import('../src/lib/plans.mjs');
  const s = await getTeamOpsState(makeStateStub(1200, ago(5)), 't1', null);
  assert.equal(s.state, 'restricted');
});

test('getTeamOpsState: back under with a stale clock → ok + clears the clock', { skip: SKIP_OPS }, async () => {
  const { getTeamOpsState } = await import('../src/lib/plans.mjs');
  const stub = makeStateStub(200, ago(10));
  const s = await getTeamOpsState(stub, 't1', null);
  assert.equal(s.state, 'ok');
  assert.equal(stub._writes.length, 1, 'stale clock cleared');
  assert.equal(stub._writes[0].grace_started_at, null);
});

test('getTeamOpsUsage: free plan under limit', { skip: SKIP_OPS }, async () => {
  const { getTeamOpsUsage } = await import('../src/lib/plans.mjs');
  const ops = await getTeamOpsUsage(makeOpsStub(200), 't1', null);
  assert.equal(ops.plan.id, 'free');
  assert.equal(ops.included, 1000);
  assert.equal(ops.used, 200);
  assert.equal(ops.remaining, 800);
});

test('getTeamOpsUsage: exhausted plan reports 0 remaining (no top-up)', { skip: SKIP_OPS }, async () => {
  const { getTeamOpsUsage } = await import('../src/lib/plans.mjs');
  const sub = { plan_id: 'pro', status: 'active', current_period_start: '2026-05-01T00:00:00Z' };
  const ops = await getTeamOpsUsage(makeOpsStub(99999), 't1', sub);
  assert.equal(ops.included, 25000);
  assert.equal(ops.remaining, 0);
  assert.equal(ops.topupBalance, undefined, 'no top-up balance in the pure-tier model');
});

test('getTeamEnrichmentUsage: counts enrichment_run rows against the plan allowance', async () => {
  const { getTeamEnrichmentUsage } = await import('../src/lib/plans.mjs');
  // Stub: workspaces lookup then a count query on workspace_system_log.
  const stub = {
    from: (table) => {
      if (table === 'workspaces') {
        return { select: () => ({ eq: async () => ({ data: [{ id: 'w1' }] }) }) };
      }
      // workspace_system_log count chain
      return {
        select: () => ({
          in: () => ({
            eq: () => ({
              gte: async () => ({ count: 40 }),
            }),
          }),
        }),
      };
    },
  };
  const sub = { plan_id: 'starter', status: 'active', current_period_start: '2026-05-01T00:00:00Z' };
  const e = await getTeamEnrichmentUsage(stub, 't1', sub);
  // BYOK: no managed allowance, so included is 0 and remaining clamps to 0.
  // requireEnrichmentQuota bypasses entirely when included === 0 (see access.mjs).
  assert.equal(e.included, 0);
  assert.equal(e.used, 40);
  assert.equal(e.remaining, 0);
});

test('isSelfHosted reflects SELF_HOSTED env', async () => {
  const { isSelfHosted } = await import('../src/lib/plans.mjs');
  const { HAS_CLOUD } = await import('../src/lib/cloud.mjs');
  const prior = process.env.SELF_HOSTED;
  try {
    process.env.SELF_HOSTED = 'true';
    assert.equal(isSelfHosted(), true);
    process.env.SELF_HOSTED = 'false';
    // An open-source build (no src/cloud/) is self-hosted whatever the env says (GET-754).
    assert.equal(isSelfHosted(), !HAS_CLOUD);
  } finally {
    if (prior === undefined) delete process.env.SELF_HOSTED;
    else process.env.SELF_HOSTED = prior;
  }
});
