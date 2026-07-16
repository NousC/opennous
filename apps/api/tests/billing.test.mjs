/**
 * Pure unit tests for the billing layer — no DB required.
 *
 * Pure-tier model (Free/Start/Pro/Growth/Agency), no top-up packs. Ops are metered
 * off the live op log via team_ops_used; enrichments are a separate capped
 * allowance. These tests cover the deterministic plan logic against stubs.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

test('plans: five tiers with the expected ops + enrichment ladders + prices', async () => {
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

test('hasFeature: team-layer features (crmSync/leadLists/icpScoring) on every cloud plan', async () => {
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

test('requireFeature: the Cloud team layer is blocked on self-host, the open primitive passes', async () => {
  process.env.SELF_HOSTED = 'true';
  try {
    const { requireFeature } = await import('../src/lib/access.mjs');
    const run = async (feature) => {
      let status = null, body = null, nexted = false;
      const res = { status(s) { status = s; return this; }, json(b) { body = b; return this; } };
      await requireFeature(feature)({}, res, () => { nexted = true; });
      return { status, body, nexted };
    };
    // CRM sync, lead lists + the ICP model are Cloud-only — 403 on self-host.
    for (const f of ['crmSync', 'leadLists', 'icpScoring']) {
      const r = await run(f);
      assert.equal(r.nexted, false, `${f} must NOT pass on self-host`);
      assert.equal(r.status, 403, `${f} → 403`);
      assert.equal(r.body.error, 'cloud_only_feature', `${f} → cloud_only_feature`);
    }
    // The open primitive is unmetered + available on self-host.
    const open = await run('contextualization');
    assert.equal(open.nexted, true, 'contextualization must pass on self-host');
  } finally {
    delete process.env.SELF_HOSTED;
  }
});

test('effectiveWorkspaceLimit: flat plans static; Partner tracks Stripe quantity', async () => {
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

test('getPlanFromSubscription: missing → free; past_due → free; starter/scale resolve', async () => {
  const { getPlanFromSubscription } = await import('../src/lib/plans.mjs');
  assert.equal(getPlanFromSubscription(null).id, 'free');
  assert.equal(getPlanFromSubscription({ plan_id: 'scale', status: 'past_due' }).id, 'free');
  assert.equal(getPlanFromSubscription({ plan_id: 'scale', status: 'active' }).id, 'scale');
  assert.equal(getPlanFromSubscription({ plan_id: 'starter', status: 'active' }).id, 'starter');
});

test('normalizePlanId: unknown → free; starter is valid', async () => {
  const { normalizePlanId } = await import('../src/lib/plans.mjs');
  assert.equal(normalizePlanId('starter'), 'starter');
  assert.equal(normalizePlanId('lifetime'), 'free');
  assert.equal(normalizePlanId(undefined), 'free');
});

test('periodStartFor: uses Stripe period when present, else start of month', async () => {
  const { periodStartFor } = await import('../src/lib/plans.mjs');
  const stripeStart = '2026-05-03T00:00:00.000Z';
  assert.equal(
    periodStartFor({ current_period_start: stripeStart }).toISOString(),
    new Date(stripeStart).toISOString(),
  );
  assert.equal(periodStartFor(null).getUTCDate(), 1, 'free-plan fallback is the 1st');
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

test('getTeamOpsState: under limit → ok, no grace write', async () => {
  const { getTeamOpsState } = await import('../src/lib/plans.mjs');
  const stub = makeStateStub(200); // free included 1000 → 20%
  const s = await getTeamOpsState(stub, 't1', null);
  assert.equal(s.state, 'ok');
  assert.equal(s.percentUsed, 20);
  assert.equal(s.graceUntil, null);
  assert.equal(stub._writes.length, 0);
});

test('getTeamOpsState: >=80% under limit → warn', async () => {
  const { getTeamOpsState } = await import('../src/lib/plans.mjs');
  const s = await getTeamOpsState(makeStateStub(850), 't1', null);
  assert.equal(s.state, 'warn');
  assert.equal(s.percentUsed, 85);
});

test('getTeamOpsState: just crossed the limit → grace, stamps the clock', async () => {
  const { getTeamOpsState } = await import('../src/lib/plans.mjs');
  const stub = makeStateStub(1000); // == included
  const s = await getTeamOpsState(stub, 't1', null);
  assert.equal(s.state, 'grace');
  assert.ok(s.graceUntil, 'graceUntil set');
  assert.equal(stub._writes.length, 1, 'grace clock stamped on first crossing');
  assert.ok(stub._writes[0].grace_started_at, 'stamp has a start time');
});

test('getTeamOpsState: over, grace started 1d ago → grace', async () => {
  const { getTeamOpsState } = await import('../src/lib/plans.mjs');
  const stub = makeStateStub(1200, ago(1));
  const s = await getTeamOpsState(stub, 't1', null);
  assert.equal(s.state, 'grace');
  assert.equal(stub._writes.length, 0, 'clock already running, no rewrite');
});

test('getTeamOpsState: over, grace started 5d ago → restricted', async () => {
  const { getTeamOpsState } = await import('../src/lib/plans.mjs');
  const s = await getTeamOpsState(makeStateStub(1200, ago(5)), 't1', null);
  assert.equal(s.state, 'restricted');
});

test('getTeamOpsState: back under with a stale clock → ok + clears the clock', async () => {
  const { getTeamOpsState } = await import('../src/lib/plans.mjs');
  const stub = makeStateStub(200, ago(10));
  const s = await getTeamOpsState(stub, 't1', null);
  assert.equal(s.state, 'ok');
  assert.equal(stub._writes.length, 1, 'stale clock cleared');
  assert.equal(stub._writes[0].grace_started_at, null);
});

test('getTeamOpsUsage: free plan under limit', async () => {
  const { getTeamOpsUsage } = await import('../src/lib/plans.mjs');
  const ops = await getTeamOpsUsage(makeOpsStub(200), 't1', null);
  assert.equal(ops.plan.id, 'free');
  assert.equal(ops.included, 1000);
  assert.equal(ops.used, 200);
  assert.equal(ops.remaining, 800);
});

test('getTeamOpsUsage: exhausted plan reports 0 remaining (no top-up)', async () => {
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
  const prior = process.env.SELF_HOSTED;
  try {
    process.env.SELF_HOSTED = 'true';
    assert.equal(isSelfHosted(), true);
    process.env.SELF_HOSTED = 'false';
    assert.equal(isSelfHosted(), false);
  } finally {
    if (prior === undefined) delete process.env.SELF_HOSTED;
    else process.env.SELF_HOSTED = prior;
  }
});
