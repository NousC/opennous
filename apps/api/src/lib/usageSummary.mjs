// A team's usage for the current billing period — ONE read behind the billing panel
// (GET /api/usage), the public API (GET /v2/usage) and the budget line on
// GET /v2/workspace/whoami, so an agent and the person paying can never see two numbers.
//
// It calls exactly the meters GET /api/usage always called: getTeamOpsUsage (not
// getTeamOpsState, which stamps the ops grace clock), and getTeamAccountsState, which keeps the
// active-accounts grace clock in step just as the billing panel's read always has.

import {
  getPlanFromSubscription,
  getTeamOpsUsage,
  getTeamAccountsState,
  getTeamEnrichmentUsage,
  getTeamAiCredits,
  isSelfHosted,
} from './plans.mjs';

/** The raw meters, as the billing panel reads them. */
export async function loadTeamUsage(supabase, team) {
  const { data: subscription } = await supabase
    .from('subscriptions')
    .select('*')
    .eq('team_id', team.id)
    .maybeSingle();

  const plan = getPlanFromSubscription(subscription);
  const [ops, enrichments, accounts, aiCredits] = await Promise.all([
    getTeamOpsUsage(supabase, team.id, subscription),
    getTeamEnrichmentUsage(supabase, team.id, subscription),
    // The only meter that bills. Everything above it is display-only now.
    getTeamAccountsState(supabase, team.id, subscription),
    // Revenue-agent credits — model spend for the current period.
    getTeamAiCredits(supabase, team.id, subscription),
  ]);
  return { subscription, plan, ops, enrichments, accounts, aiCredits };
}

/**
 * When the current period ends. The subscription's own end when it is still ahead; otherwise one
 * calendar month after the period start (the same month-step periodStartFor walks), clamping the
 * day for short months.
 */
export function usagePeriodEnd(subscription, periodStartIso, now = new Date()) {
  const end = subscription?.current_period_end ? new Date(subscription.current_period_end) : null;
  const start = new Date(periodStartIso);
  if (end && !Number.isNaN(end.getTime()) && end.getTime() > now.getTime() && end.getTime() > start.getTime()) {
    return end.toISOString();
  }
  const y = start.getUTCFullYear();
  const m = start.getUTCMonth() + 1;
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const d = new Date(start);
  d.setUTCFullYear(y, m, Math.min(start.getUTCDate(), lastDay));
  return d.toISOString();
}

const finite = (n) => (n === Infinity || n === undefined ? null : n);

/** GET /v2/usage — snake_case, nulls for "unlimited". */
export function publicUsage(u) {
  const { subscription, plan, ops, enrichments, accounts, aiCredits } = u;
  const periodStart = ops.periodStart;
  return {
    plan: { id: plan.id, name: plan.name },
    self_hosted: isSelfHosted(),
    subscription_status: subscription?.status ?? null,
    period: { start: periodStart, end: usagePeriodEnd(subscription, periodStart) },
    // Retrievals. Display-only on every plan today (limit null = unlimited); kept as a stat.
    ops: {
      used: ops.used,
      limit: ops.included ?? null,
      left: finite(ops.remaining),
    },
    // Revenue-agent credits — the meter that can stop an action.
    credits: {
      used: aiCredits.used,
      limit: aiCredits.included ?? null,
      left: finite(aiCredits.remaining),
      percent_used: aiCredits.percentUsed,
      state: aiCredits.state,
      unlimited: !!aiCredits.unlimited,
    },
    enrichments: {
      used: enrichments.used,
      limit: enrichments.included ?? null,
      left: finite(enrichments.remaining),
    },
    active_accounts: {
      used: accounts.used,
      limit: accounts.included ?? null,
      left: finite(accounts.remaining),
      state: accounts.state,
    },
  };
}

/** The budget line on whoami — what an agent needs before it spends. */
export function usageBudget(u) {
  const full = publicUsage(u);
  return {
    plan: full.plan.id,
    period_start: full.period.start,
    period_end: full.period.end,
    ops_used: full.ops.used,
    ops_limit: full.ops.limit,
    ops_left: full.ops.left,
    credits_left: full.credits.unlimited ? null : full.credits.left,
  };
}
