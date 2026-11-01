// The 14-day no-card trial and the three sizes (GET-1087).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  planIsLive, needsPlan, notLiveReason, planMayBackfill, trialState, getPlanFromSubscription, getTeamAiCredits,
  STARTER_SIZES, offeredSizes, sizeForPurchase, nextSizeAfter, recommendedSize, tierForPriceId,
  planIdFromPriceId, TRIAL_CREDITS, isSelfHosted,
} from '../src/lib/plans.mjs';
import { newFreeSubscription } from '../src/lib/auth.mjs';
import { HAS_CLOUD } from '../src/lib/cloud.mjs';

const D = 86_400_000;
const trial = (ms) => ({ plan_id: 'api', status: 'trialing', trial_ends_at: new Date(Date.now() + ms).toISOString() });
const ENVS = STARTER_SIZES.map((s) => s.priceEnv);
const setEnvs = (on = ENVS) => { for (const e of ENVS) delete process.env[e]; for (const e of on) process.env[e] = `price_${e}`; };

test('a new signup is a 14-day trial with no Stripe subscription', () => {
  const now = new Date('2026-11-01T00:00:00Z');
  const row = newFreeSubscription('t1', { now, trial: true });
  assert.equal(row.plan_id, 'api');
  assert.equal(row.status, 'trialing');
  assert.equal(row.trial_ends_at, '2026-11-15T00:00:00.000Z');
  assert.equal(row.current_period_end, row.trial_ends_at, 'the allowance is one period, the trial');
  assert.equal(row.stripe_subscription_id, undefined);
});

test('where nothing can be paid, a new team keeps the Free row', () => {
  const row = newFreeSubscription('t1', { trial: false });
  assert.equal(row.plan_id, 'free');
  assert.equal(row.status, 'active');
  assert.equal(row.trial_ends_at, undefined);
});

test('a running trial is live, 500 credits, a hard cap, and no history', () => {
  const s = trial(3 * D);
  assert.equal(planIsLive(s), true);
  assert.equal(needsPlan(s), false);
  assert.equal(planMayBackfill(s), false);
  const plan = getPlanFromSubscription(s);
  assert.equal(plan.id, 'api');
  assert.equal(plan.aiCreditsPerMonth, TRIAL_CREDITS);
  assert.equal(plan.hardCreditCap, true);
  assert.deepEqual({ ...trialState(s), endsAt: null }, { endsAt: null, daysLeft: 3, ended: false });
});

test('an ended trial stops, and says so', () => {
  const s = trial(-1000);
  assert.equal(planIsLive(s), false);
  assert.equal(needsPlan(s), true);
  assert.equal(notLiveReason(s), 'trial_ended');
  assert.equal(trialState(s).ended, true);
  assert.equal(trialState(s).daysLeft, 0);
});

test('nothing that is not a no-card trial changes', () => {
  assert.equal(planIsLive({ plan_id: 'free', status: 'active' }), true);
  assert.equal(planMayBackfill({ plan_id: 'free', status: 'active' }), false);
  // A real Stripe trial past its date is Stripe's to end.
  const stripeTrial = { ...trial(-D), stripe_subscription_id: 'sub_1' };
  assert.equal(planIsLive(stripeTrial), true);
  assert.equal(needsPlan(stripeTrial), false);
  assert.equal(planMayBackfill(stripeTrial), true);
  assert.equal(trialState(stripeTrial), null);
  // No end date: what it always was.
  assert.equal(planIsLive({ plan_id: 'api', status: 'trialing' }), true);
  assert.equal(planIsLive({ ...trial(-D), is_comp: true }), true);
});

test('the sizes, and only the ones with a price configured', () => {
  assert.deepEqual(STARTER_SIZES.map((s) => [s.name, s.credits, s.priceUsd]),
    [['Starter', 2000, 79], ['Growth', 4000, 149], ['Scale', 8000, 249]]);
  setEnvs([]);
  assert.deepEqual(offeredSizes(), []);
  assert.equal(sizeForPurchase(undefined), null);
  setEnvs(['STRIPE_STARTER_79_PRICE_ID', 'STRIPE_STARTER_249_PRICE_ID']);
  assert.deepEqual(offeredSizes().map((s) => s.credits), [2000, 8000]);
  assert.equal(sizeForPurchase(undefined).credits, 2000, 'no credits buys the smallest');
  assert.equal(sizeForPurchase('8000').credits, 8000);
  assert.equal(sizeForPurchase(4000), null, 'not configured is not offered');
  assert.equal(sizeForPurchase(960), null, 'a retired size is not sold');
  assert.equal(nextSizeAfter(2000).credits, 8000, 'skips a size that is not on sale');
  setEnvs();
  assert.equal(nextSizeAfter(2000).credits, 4000);
  assert.equal(nextSizeAfter(8000), null, 'past the top is a conversation');
  assert.equal(nextSizeAfter(960).credits, 2000, 'a grandfathered allowance moves onto the new sizes');
});

test('recommended: the smallest covering the month with a fifth of room, custom past the top', () => {
  setEnvs();
  assert.equal(recommendedSize(0), 2000);
  assert.equal(recommendedSize(1600), 2000);
  assert.equal(recommendedSize(1700), 4000);
  assert.equal(recommendedSize(6600), 8000);
  assert.equal(recommendedSize(6700), 'custom');
  assert.equal(recommendedSize(9000), 'custom');
  setEnvs([]);
  assert.equal(recommendedSize(100), null);
  setEnvs();
});

test('live subscribers keep what they pay for', () => {
  process.env.STRIPE_SELF_SERVE_99_PRICE_ID = 'price_old_99';
  setEnvs();
  const old = getPlanFromSubscription({ plan_id: 'api', status: 'active', stripe_subscription_id: 's', stripe_price_id: 'price_old_99' });
  assert.equal(old.monthlyPriceUsd, 99);
  assert.equal(old.aiCreditsPerMonth, 2000);
  assert.equal(tierForPriceId('price_STRIPE_STARTER_149_PRICE_ID').credits, 4000);
  assert.equal(planIdFromPriceId('price_STRIPE_STARTER_249_PRICE_ID'), 'api');
  assert.equal(planIdFromPriceId('price_old_99'), 'api');
  const fresh = getPlanFromSubscription({ plan_id: 'api', status: 'active', stripe_subscription_id: 's', stripe_price_id: 'price_STRIPE_STARTER_79_PRICE_ID' });
  assert.equal(fresh.monthlyPriceUsd, 79);
});

// One workspace, `n` reads: enough of a database for the meter.
function meterDb(n) {
  const obs = Array.from({ length: n }, (_, i) => ({ source: 'gmail', observed_at: new Date(Date.now() - i * 1000).toISOString(), value: {} }));
  const tables = { workspaces: [{ id: 'ws', team_id: 't' }], observations: obs, llm_usage: [], contact_enrichment_jobs: [] };
  return {
    from(name) {
      const q = {
        select() { return q; }, eq() { return q; }, in() { return q; }, not() { return q; }, gte() { return q; }, lt() { return q; }, order() { return q; },
        range(a) { return Promise.resolve({ data: a === 0 ? (tables[name] ?? []) : [], error: null }); },
        maybeSingle() { return Promise.resolve({ data: name === 'subscriptions' ? q.sub : tables[name]?.[0] ?? null, error: null }); },
        then(res) { return Promise.resolve({ data: tables[name] ?? [], error: null }).then(res); },
      };
      return q;
    },
  };
}

test('a trial stops at 500 and points at the smallest size; an ended one says it ended', async (t) => {
  if (!HAS_CLOUD || isSelfHosted()) return t.skip('metered on Cloud only');
  setEnvs();
  const atCap = await getTeamAiCredits(meterDb(250), 'team-trial-1', trial(3 * D));
  assert.equal(atCap.state, 'restricted');
  assert.equal(atCap.needsPlan, false);
  assert.equal(atCap.nextTier.credits, 2000);
  assert.equal(atCap.trial.ended, false);
  const under = await getTeamAiCredits(meterDb(10), 'team-trial-2', trial(3 * D));
  assert.equal(under.state, 'ok');
  assert.equal(under.hardCap, true);
  const ended = await getTeamAiCredits(meterDb(0), 'team-trial-3', trial(-D));
  assert.equal(ended.state, 'restricted');
  assert.equal(ended.notLiveReason, 'trial_ended');
  assert.equal(ended.nextTier.credits, 2000);
});

test('the stop on a paid plan names the next size up', async (t) => {
  if (!HAS_CLOUD || isSelfHosted()) return t.skip('metered on Cloud only');
  setEnvs();
  const sub = { plan_id: 'api', status: 'active', stripe_subscription_id: 's', stripe_price_id: 'price_STRIPE_STARTER_79_PRICE_ID', current_period_start: new Date(Date.now() - D).toISOString() };
  const over = await getTeamAiCredits(meterDb(1300), 'team-paid-1', sub);
  assert.equal(over.state, 'restricted');
  assert.equal(over.nextTier.credits, 4000);
});

test('the trial has one answer: core, billing, the CLI gate and the sync gate all agree', async () => {
  const { trialHasLapsed } = await import('@nous/core');
  const { planIsLive, trialHasEnded, isNoCardTrial } = await import('../src/lib/plans.mjs');
  const { ownBackfillRefusal } = await import('../src/lib/ownBackfill.mjs');
  const now = Date.parse('2026-11-10T12:00:00Z');
  const trial = (over) => ({ plan_id: 'api', status: 'trialing', ...over });
  const cases = [
    ['running', trial({ trial_ends_at: '2026-11-14T00:00:00Z' }), false],
    ['ended', trial({ trial_ends_at: '2026-11-09T00:00:00Z' }), true],
    ['ends this instant', trial({ trial_ends_at: '2026-11-10T12:00:00Z' }), true],
    ['unreadable date', trial({ trial_ends_at: 'soon' }), true],
    ['Stripe bills it', trial({ trial_ends_at: '2026-11-09T00:00:00Z', stripe_subscription_id: 'sub_1' }), false],
    ['comped', trial({ trial_ends_at: '2026-11-09T00:00:00Z', is_comp: true }), false],
    ['no end date', trial({}), false],
    ['Free', { plan_id: 'free', status: 'active' }, false],
  ];
  for (const [name, sub, lapsed] of cases) {
    assert.equal(trialHasLapsed(sub, now), lapsed, `core: ${name}`);
    assert.equal(trialHasEnded(sub, now), lapsed, `billing: ${name}`);
    assert.equal(ownBackfillRefusal(sub, now) === 'trial_ended', lapsed, `cli: ${name}`);
    if (lapsed) assert.equal(planIsLive(sub, now), false, `live: ${name}`);
  }
  assert.equal(isNoCardTrial(trial({ trial_ends_at: '2026-11-14T00:00:00Z' })), true);
});

test('a running trial may run nous backfill, though not a hosted read', async () => {
  const { planMayBackfill } = await import('../src/lib/plans.mjs');
  const { ownBackfillRefusal } = await import('../src/lib/ownBackfill.mjs');
  const live = { plan_id: 'api', status: 'trialing', trial_ends_at: new Date(Date.now() + 86_400_000).toISOString() };
  assert.equal(planMayBackfill(live), false);
  assert.equal(ownBackfillRefusal(live), null);
});

test('a lapsed trial answers every key call with a 402 that says subscribe; usage and everyone else pass', async () => {
  const { trialEndedGate } = await import('../src/lib/trialEndedGate.mjs');
  const past = { team_id: 't', plan_id: 'api', status: 'trialing', trial_ends_at: '2020-01-01T00:00:00Z' };
  const run = async ({ sub = past, path = '/v2/accounts', selfHosted = false }) => {
    let nexted = false, sent = null;
    const res = { status(c) { sent = { c }; return this; }, json(b) { sent.b = b; return this; } };
    await trialEndedGate({ workspaceId: 'w', baseUrl: path, path: '/' }, res, () => { nexted = true; }, { subscription: async () => sub, selfHosted });
    return { nexted, sent };
  };
  const stopped = await run({});
  assert.equal(stopped.nexted, false);
  assert.equal(stopped.sent.c, 402);
  assert.equal(stopped.sent.b.error, 'subscribe_required');
  assert.equal(stopped.sent.b.reason, 'trial_ended');
  assert.match(stopped.sent.b.message, /subscribe/i);
  assert.match(stopped.sent.b.message, /kept/i);
  assert.ok(stopped.sent.b.subscribe_url);
  assert.equal((await run({ path: '/v2/usage' })).nexted, true, 'billing stays readable');
  assert.equal((await run({ sub: { ...past, stripe_subscription_id: 's', status: 'active' } })).nexted, true, 'paid');
  assert.equal((await run({ sub: { plan_id: 'free', status: 'active' } })).nexted, true, 'Free');
  assert.equal((await run({ selfHosted: true })).nexted, true, 'self-host');
  const broken = await trialEndedGate({ workspaceId: 'w', baseUrl: '/v2/x' }, {}, () => 'went on', { subscription: async () => { throw new Error('down'); }, selfHosted: false });
  assert.equal(broken, 'went on', 'fails open');
});
