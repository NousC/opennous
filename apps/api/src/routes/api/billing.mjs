// Billing API — what this team's plan and usage are.
//
//   GET  /api/billing/state           → current plan + ops/enrichment usage
//
// Buying and paying (subscribe, invoices, the Stripe customer portal) are Cloud's, in
// src/cloud/routes/api/billing.mjs, mounted on the same /api/billing prefix (GET-754).
//
// Self-hosted (SELF_HOSTED=true), an open-source build, or when STRIPE_SECRET_KEY is unset,
// /state answers `{ billing_disabled: true }` with the graph's size.

import { Router } from 'express';
import { customPlanFor } from '../../lib/customPlans.mjs';
import { getSupabaseClient } from '@nous/core';
import { verifySupabaseAuth } from '../../middleware/supabaseAuth.mjs';
import { resolveRequestTeam } from '../../lib/access.mjs';
import { billingEnabled } from '../../lib/billingHooks.mjs';
import {
  PLANS,
  SELLABLE_PLAN_IDS,
  getPlanFromSubscription,
  getTeamOpsState,
  getTeamAccountsState,
  getTeamEnrichmentUsage,
  getTeamAiCredits,
  isSelfHosted,
} from '../../lib/plans.mjs';

export const billingRouter = Router();

// ── GET /api/billing/state ─────────────────────────────────────────────────
billingRouter.get('/state', verifySupabaseAuth, async (req, res) => {
  if (!billingEnabled()) {
    // No billing here. That's either self-host (no plans exist) or a deployment
    // without Stripe wired up. Either way, still hand back the graph's size — the
    // page's job is to tell you where you stand, and "billing is disabled" on its
    // own tells you nothing you can act on.
    let activeAccounts = null;
    try {
      const supabase = getSupabaseClient();
      const { team } = await resolveRequestTeam(req);
      const { data: workspaces } = await supabase
        .from('workspaces').select('id').eq('team_id', team.id);
      const wsIds = (workspaces ?? []).map(w => w.id);
      if (wsIds.length) {
        const { data } = await supabase.rpc('team_active_accounts', { ws_ids: wsIds });
        activeAccounts = {
          used: Number(data) || 0,
          included: null, // unmetered
          remaining: null,
          percentUsed: 0,
          state: 'ok',
          graceUntil: null,
        };
      }
    } catch (err) {
      console.warn('[billing/state] account count unavailable:', err?.message);
    }

    return res.json({
      billing_disabled: true,
      self_hosted: isSelfHosted(),
      plan: 'free',
      activeAccounts,
      ops: null,
      enrichments: null,
    });
  }
  try {
    const supabase = getSupabaseClient();
    const { team } = await resolveRequestTeam(req);

    const { data: subscription } = await supabase
      .from('subscriptions')
      .select('*')
      .eq('team_id', team.id)
      .maybeSingle();

    const plan = getPlanFromSubscription(subscription);
    const [ops, enrichments, activeAccounts, aiCredits] = await Promise.all([
      getTeamOpsState(supabase, team.id, subscription),
      getTeamEnrichmentUsage(supabase, team.id, subscription),
      // THE meter. Everything above it is now display-only.
      getTeamAccountsState(supabase, team.id, subscription),
      // The model-spend meter — revenue-agent credits for the current period.
      getTeamAiCredits(supabase, team.id, subscription),
    ]);


    return res.json({
      billing_disabled: false,
      plan: plan.id,
      planName: plan.name,
      // What this account's Custom plan actually is: the price agreed, the credits it buys and
      // the integrations built for them. Null on every other plan, and on a Custom account with
      // no quote on file yet — the page then says "quoted" rather than inventing a number.
      customPlan: plan.id === 'custom' ? customPlanFor(team.id) : null,
      // Whether there is anything in Stripe to send them to. A comped or invoiced team has
      // no customer, so the portal would 400 and the invoice list would be empty — the page
      // says how they are billed instead of showing a button that cannot work.
      stripe: {
        customer: !!team.stripe_customer_id,
        subscription: !!subscription?.stripe_subscription_id,
      },
      // Companies we've actually had a conversation with — the only billed unit.
      // included: null = unlimited (Custom).
      activeAccounts: {
        used:        activeAccounts.used,
        included:    activeAccounts.included,
        remaining:   activeAccounts.remaining === Infinity ? null : activeAccounts.remaining,
        percentUsed: activeAccounts.percentUsed,
        state:       activeAccounts.state,
        graceUntil:  activeAccounts.graceUntil,
        graceDays:   activeAccounts.graceDays,
      },
      subscription: subscription
        ? {
            status: subscription.status,
            current_period_start: subscription.current_period_start,
            current_period_end: subscription.current_period_end,
            trial_ends_at: subscription.trial_ends_at,
            cancel_at_period_end: subscription.cancel_at_period_end,
            stripe_subscription_id: subscription.stripe_subscription_id,
            is_comp: subscription.is_comp,
          }
        : null,
      // Display-only. Retrievals are unlimited on every plan — deterministic reads
      // with no model in the path, so there is nothing to bill. `included` is null.
      ops: {
        used: ops.used,
        included: ops.included,
        remaining: ops.remaining === Infinity ? null : ops.remaining,
        periodStart: ops.periodStart,
        percentUsed: ops.percentUsed,
        state: ops.state,
        graceUntil: ops.graceUntil,
        metered: false,
      },
      enrichments: {
        used: enrichments.used,
        included: enrichments.included,
        remaining: enrichments.remaining,
      },
      // Revenue-agent credits — the only per-use model cost in the product, and
      // the one meter here that can actually stop an action (hard block at zero).
      // `included: null` = unlimited (Headless, Custom, self-host).
      aiCredits: {
        used:        aiCredits.used,
        included:    aiCredits.included,
        remaining:   aiCredits.remaining,
        percentUsed: aiCredits.percentUsed,
        state:       aiCredits.state,        // ok | warn | over | restricted
        nextTier:    aiCredits.nextTier ?? null,   // what an over-limit notice offers (GET-525)
        needsPlan:   aiCredits.needsPlan ?? false, // not paying (GET-532, GET-539)
        notLiveReason: aiCredits.notLiveReason ?? null,
        // A failed card still inside its grace (GET-698): reading continues, the card needs updating.
        paymentFailed: aiCredits.paymentFailed ?? false,
        graceUntil:  aiCredits.graceUntil ?? null,
        periodStart: aiCredits.periodStart,
        // When this period's credits reset: the subscription's own end, else a month on (GET-733).
        periodEnd:   periodEndOf(subscription, aiCredits.periodStart),
        // Credits left before reading pauses (120% on the API plan), and roughly how many days that
        // is at this period's pace. Null when nothing stops or nothing has been used yet.
        untilStop:   aiCredits.untilStop ?? null,
        daysUntilStop: daysUntilStop(aiCredits),
        unlimited:   aiCredits.unlimited,
        // The first backfill's credits, shown apart for 30 days (GET-515); null otherwise.
        backfill:    aiCredits.backfill ?? null,
      },
      // What we present in-app: the two sold plans — API (self-serve) and Headless Revenue
      // Engine (Custom, contact-us). Retired/grandfathered tiers still resolve for an existing
      // subscription but are never OFFERED here.
      allPlans: SELLABLE_PLAN_IDS.map((id) => PLANS[id]).map((p) => ({
        id: p.id,
        name: p.name,
        monthlyPriceUsd: p.monthlyPriceUsd,
        aiCreditsPerMonth: p.aiCreditsPerMonth ?? null,
        activeAccountsLimit: p.activeAccountsLimit,
        recordsLimit: p.recordsLimit,
        enrichmentsPerMonth: p.enrichmentsPerMonth,
        workspaceLimit: p.workspaceLimit,
        features: p.features,
      })),
    });
  } catch (err) {
    console.error('[GET /api/billing/state]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

/** When the credits reset: the subscription's period end, else one calendar month after the start. */
function periodEndOf(subscription, periodStart) {
  if (subscription?.current_period_end) return subscription.current_period_end;
  const t = Date.parse(periodStart ?? '');
  if (!Number.isFinite(t)) return null;
  const d = new Date(t);
  d.setUTCMonth(d.getUTCMonth() + 1);
  return d.toISOString();
}

/** Days until reading pauses at this period's average pace (GET-733). Null when nothing will stop. */
export function daysUntilStop(c, now = Date.now()) {
  if (c?.untilStop == null || !c.used) return null;
  if (c.untilStop <= 0) return 0;
  const elapsed = Math.max(1, (now - Date.parse(c.periodStart ?? '')) / 86400000);
  const perDay = c.used / elapsed;
  return perDay > 0 ? Math.floor(c.untilStop / perDay) : null;
}
