import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planTier, isApiTier, PLAN_IDS, SELF_SERVE_TIERS, ENTRY_TIER, tierForCredits, getPlanFromSubscription, creditState, nextTierAfter, needsPlan, planIsLive, notLiveReason } from '../src/lib/plans.mjs';

// Two plans — self-serve (one plan at five volumes) and Custom — over ten billing ids. The
// ids are not renamed here on purpose: that is a billing migration, and this is the shape of
// the product. These tests are what stops the two drifting.

test('every billing id maps to a tier', () => {
  for (const id of PLAN_IDS) {
    const t = planTier(id);
    assert.ok(['api', 'custom'].includes(t), `${id} mapped to ${t}`);
  }
});

test('self-serve brings its own agent; every operated id is Custom', () => {
  for (const id of ['free', 'api', 'starter', 'pro', 'scale']) {
    assert.equal(planTier(id), 'api', `${id} brings its own agent`);
  }
  // The retired middle plan and its family bought the operated surface, so they keep it.
  for (const id of ['growth', 'headless', 'enterprise', 'workspace']) {
    assert.equal(planTier(id), 'custom', `${id} is operated for the customer`);
  }
  assert.equal(planTier('custom'), 'custom');
});

test('an unknown plan is the API plan, never Workspace', () => {
  // The safe direction: an id we cannot read should not hand someone the operated surface.
  assert.equal(planTier('something-we-have-not-shipped'), 'api');
  assert.equal(planTier(undefined), 'api');
  assert.equal(planTier(null), 'api');
  assert.equal(planTier(''), 'api');
});

test('a Plan object works as well as an id', () => {
  // Callers pass both. A Plan object falling through to the default would put every paying
  // team on the API view — the bug isCorePlan already had to be fixed for.
  assert.equal(planTier({ id: 'custom' }), 'custom');
  assert.equal(planTier({ id: 'growth' }), 'custom');
  assert.equal(planTier({ id: 'api' }), 'api');
});

test('isApiTier agrees with planTier', () => {
  for (const id of PLAN_IDS) {
    assert.equal(isApiTier(id), planTier(id) === 'api', id);
  }
});

// ── The ladder ─────────────────────────────────────────────────────────────────
// Self-serve is one plan at five volumes. What a customer gets is decided by the Stripe
// price they are billed on, so these two must agree or someone pays for a bundle they
// do not receive.

test('every tier holds the 80% floor at full burn', () => {
  // Measured cost per CONVERSATION on the self-serve surface with insights and automations
  // running ($0.0167), divided by the denomination — a credit is half a conversation now
  // (CREDIT_SCALE = 2). Redenominating must not move this number; if it does, the scale was
  // applied to the allowance and not to the rates.
  const COST = 0.0167 / 2, STRIPE_PCT = 0.029, STRIPE_FIXED = 0.30;
  // 79.5, not 80. Bundles are rounded to numbers a person would choose — 2,000, not 1,990 —
  // and the cost they are measured against is itself an estimate, so a tenth of a point of
  // rounding is allowed and a whole point is not. $99/2,000 sits at 79.9%.
  for (const t of SELF_SERVE_TIERS) {
    const net = t.priceUsd - (t.priceUsd * STRIPE_PCT + STRIPE_FIXED) - t.credits * COST;
    const margin = net / t.priceUsd;
    assert.ok(margin >= 0.795, `${t.priceUsd} / ${t.credits} credits = ${(margin * 100).toFixed(1)}%`);
  }
});

test('the ladder only goes up', () => {
  for (let i = 1; i < SELF_SERVE_TIERS.length; i++) {
    assert.ok(SELF_SERVE_TIERS[i].priceUsd > SELF_SERVE_TIERS[i - 1].priceUsd);
    assert.ok(SELF_SERVE_TIERS[i].credits > SELF_SERVE_TIERS[i - 1].credits);
  }
});

test('an unknown bundle buys the entry tier, it does not fail', () => {
  assert.equal(tierForCredits(undefined), ENTRY_TIER);
  assert.equal(tierForCredits(7_777), ENTRY_TIER);
  assert.equal(tierForCredits(4_000).priceUsd, 199);
});

test('a subscription carries its bundle, not the catalogue default', () => {
  process.env.STRIPE_SELF_SERVE_299_PRICE_ID = 'price_test_299';
  const plan = getPlanFromSubscription({ status: 'active', plan_id: 'api', stripe_price_id: 'price_test_299' });
  assert.equal(plan.aiCreditsPerMonth, 6_000);
  assert.equal(plan.monthlyPriceUsd, 299);
  // An unrecognised price keeps the entry numbers rather than inventing an allowance.
  const entry = getPlanFromSubscription({ status: 'active', plan_id: 'api', stripe_price_id: 'price_not_ours' });
  assert.equal(entry.aiCreditsPerMonth, 960);
});

// ── The overage band (GET-525) ─────────────────────────────────────────────────
// Credits are an allowance, not a wallet: running out is not a wall you buy past, and
// the wall is 20% beyond it.

test('the band is warn at 90, over at 100, stopped at 120', () => {
  assert.equal(creditState(0), 'ok');
  assert.equal(creditState(89), 'ok');
  assert.equal(creditState(90), 'warn');
  assert.equal(creditState(99), 'warn');
  assert.equal(creditState(100), 'over', 'crossing the allowance does not stop anything');
  assert.equal(creditState(119), 'over');
  assert.equal(creditState(120), 'restricted');
  assert.equal(creditState(400), 'restricted');
});

test('a quoted plan is told, never stopped', () => {
  // Custom is negotiated: going over is a conversation with us, not a locked workspace.
  assert.equal(creditState(130, { enforced: false }), 'over');
  assert.equal(creditState(999, { enforced: false }), 'over');
});

test('the next bundle up is the offer, and the top of the ladder has none', () => {
  assert.equal(nextTierAfter(960).credits, 2_000);
  assert.equal(nextTierAfter(2_000).credits, 4_000);
  assert.equal(nextTierAfter(6_000).credits, 10_000);
  assert.equal(nextTierAfter(10_000), null, 'past the top bundle it is a quote');
  assert.equal(nextTierAfter(0).credits, 960, 'an unknown allowance still has somewhere to go');
});

// ── The payment loop (GET-529) ─────────────────────────────────────────────────
// The bundle the customer clicks has to reach a Stripe price, or the only way to give us
// money is a link in an email.

test('every bundle names an env var, and they are all distinct', () => {
  const envs = SELF_SERVE_TIERS.map((t) => t.priceEnv);
  assert.equal(new Set(envs).size, envs.length, 'two bundles cannot share a price');
  for (const t of SELF_SERVE_TIERS) {
    assert.match(t.priceEnv, /^STRIPE_SELF_SERVE_\d+_PRICE_ID$/, t.priceEnv);
    assert.ok(t.priceEnv.includes(String(t.priceUsd)), `${t.priceEnv} should carry its own price`);
  }
});

test('the bundle a customer clicks resolves to that bundle', () => {
  // This is what the picker posts as `credits`, and what /subscribe reads back.
  for (const t of SELF_SERVE_TIERS) {
    assert.equal(tierForCredits(t.credits).priceEnv, t.priceEnv, `${t.credits} credits`);
  }
});


// ── Nothing bought yet (GET-532) ───────────────────────────────────────────────
// Two things exist: a credit bundle and a quote. There is no trial and no free tier, so a
// workspace that has not bought a bundle has no allowance.

test('a new signup has not bought anything', () => {
  assert.equal(needsPlan({ status: 'unpaid' }), true);
  assert.equal(needsPlan(null), true, 'no row at all is also nothing bought');
});

test('paying settles it, whatever the row still says', () => {
  // The webhook flips status, but a race between the two must never lock out someone who
  // has just given us money.
  assert.equal(needsPlan({ status: 'unpaid', stripe_subscription_id: 'sub_123' }), false);
});

test('accounts that predate this are not swept into it', () => {
  // Some live subscriptions are status 'active' with no Stripe id. Closing them is a business
  // decision, not a side effect of a predicate.
  assert.equal(needsPlan({ status: 'active' }), false);
  assert.equal(needsPlan({ status: 'canceled' }), false);
});

// ── Paying, or not (GET-533) ───────────────────────────────────────────────────
// A workspace reads while it is paying and stops when it is not. Cancel, let a card fail,
// never subscribe — same answer, same behaviour, because three ways of stopping should not
// be three different bugs.

const D = 86_400_000;
const when = (ms) => new Date(Date.now() + ms).toISOString();

test('paying reads', () => {
  assert.equal(planIsLive({ status: 'active' }), true);
  assert.equal(planIsLive({ status: 'active', stripe_subscription_id: 'sub_1' }), true);
  assert.equal(planIsLive({ status: 'active', is_comp: true }), true, 'comped is a decision we made');
});

test('not paying does not read', () => {
  assert.equal(planIsLive({ status: 'canceled' }), false);
  assert.equal(planIsLive({ status: 'unpaid' }), false);
  assert.equal(planIsLive({ status: 'incomplete_expired' }), false);
  assert.equal(planIsLive(null), false);
});

test('a failed card keeps working for a week past the period it paid for', () => {
  assert.equal(planIsLive({ status: 'past_due', current_period_end: when(-D) }), true, 'day one');
  assert.equal(planIsLive({ status: 'past_due', current_period_end: when(-6 * D) }), true);
  assert.equal(planIsLive({ status: 'past_due', current_period_end: when(-8 * D) }), false, 'grace is over');
  assert.equal(planIsLive({ status: 'past_due' }), false, 'no date to grace from');
});

test('a comped account is never cut off by any of this', () => {
  // A comped workspace may have no Stripe subscription at all. Whatever the rest of the row says, a
  // client we decided to carry does not stop reading in the night.
  assert.equal(planIsLive({ status: 'canceled', is_comp: true }), true);
  assert.equal(planIsLive({ status: 'past_due', is_comp: true }), true);
});

test('the reason is specific, because the fix is different', () => {
  assert.equal(notLiveReason({ status: 'active' }), null);
  assert.equal(notLiveReason({ status: 'unpaid' }), 'no_plan');
  assert.equal(notLiveReason({ status: 'canceled' }), 'canceled');
  assert.equal(notLiveReason({ status: 'past_due', current_period_end: when(-30 * D) }), 'payment_failed');
});
