// Stripe webhook endpoint for OUR billing events (subscriptions + pack purchases).
// Mounted at POST /stripe/webhook in apps/api/src/index.mjs with `express.raw()`
// so Stripe's signature can be verified against the original byte payload.
//
// Not to be confused with the per-workspace inbound Stripe webhook in the worker
// (apps/worker/src/webhooks/handlers/stripe.mjs) — that one ingests our
// customers' Stripe events into their CRM.
//
// Self-hosted (SELF_HOSTED=true) responds 200 and no-ops.

import Stripe from 'stripe';
import { getSupabaseClient } from '@nous/core';
import { normalizePlanId, isSelfHosted } from '../lib/plans.mjs';
import { logNousObservation } from '../lib/dogfood.mjs';

// Look up the founder's email for a team — used to attach Stripe lifecycle
// events to the right person on our own Nous timeline.
async function founderEmailForTeam(supabase, teamId) {
  if (!teamId) return null;
  try {
    const { data } = await supabase
      .from('team_members')
      .select('users:user_id(email)')
      .eq('team_id', teamId)
      .eq('role', 'founder')
      .limit(1);
    return data?.[0]?.users?.email || null;
  } catch (err) {
    console.warn('[stripe-webhook] founder email lookup failed:', err.message);
    return null;
  }
}

let _stripe = null;
function getStripe() {
  if (_stripe) return _stripe;
  if (!process.env.STRIPE_SECRET_KEY) throw new Error('STRIPE_SECRET_KEY missing');
  _stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  return _stripe;
}

function tsToIso(ts) {
  if (!ts) return null;
  return new Date(Number(ts) * 1000).toISOString();
}

/**
 * Express handler for POST /stripe/webhook.
 * Must be mounted with express.raw({ type: 'application/json' }).
 */
export async function stripeWebhookHandler(req, res) {
  if (isSelfHosted()) return res.status(200).json({ ok: true, self_hosted: true });

  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    console.error('[stripe-webhook] STRIPE_WEBHOOK_SECRET not set — refusing');
    return res.status(500).json({ error: 'webhook_not_configured' });
  }

  const sig = req.headers['stripe-signature'];
  if (!sig) return res.status(400).json({ error: 'missing_signature' });

  let event;
  try {
    event = getStripe().webhooks.constructEvent(req.body, sig, secret);
  } catch (err) {
    console.warn('[stripe-webhook] signature verification failed:', err.message);
    return res.status(400).json({ error: 'invalid_signature' });
  }

  const supabase = getSupabaseClient();

  try {
    switch (event.type) {
      case 'checkout.session.completed':
        // Subscriptions are pure-tier — full details land via
        // customer.subscription.created/updated. Nothing to do here.
        break;

      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const sub = event.data.object;
        const teamId = sub.metadata?.team_id;
        const planId = normalizePlanId(sub.metadata?.plan_id);
        if (!teamId) break;

        await supabase.from('subscriptions').upsert(
          {
            team_id: teamId,
            plan_id: planId,
            plan_name: planId,
            status: sub.status,
            stripe_subscription_id: sub.id,
            stripe_price_id: sub.items?.data?.[0]?.price?.id ?? null,
            // Per-unit count (Partner clients). Flat plans report quantity 1.
            quantity: sub.items?.data?.[0]?.quantity ?? 1,
            current_period_start: tsToIso(sub.current_period_start),
            current_period_end: tsToIso(sub.current_period_end),
            cancel_at_period_end: !!sub.cancel_at_period_end,
            trial_ends_at: tsToIso(sub.trial_end),
          },
          { onConflict: 'team_id' },
        );

        // Dogfood: log the paid-plan transition on the founder's timeline in
        // our own Nous workspace, and promote their state.stage to Customer.
        if (sub.status === 'active' && planId !== 'free') {
          const founderEmail = await founderEmailForTeam(supabase, teamId);
          if (founderEmail) {
            const price = sub.items?.data?.[0]?.price;
            const isCreate = event.type === 'customer.subscription.created';
            logNousObservation(founderEmail, [
              { kind: 'event',
                property: isCreate ? 'interaction.subscription_started' : 'interaction.subscription_updated',
                value: {
                  source: 'stripe',
                  plan: planId,
                  status: sub.status,
                  billing_interval: price?.recurring?.interval || 'month',
                  amount: price?.unit_amount ? price.unit_amount / 100 : null,
                  currency: sub.currency || 'eur',
                  stripe_subscription_id: sub.id,
                  at: new Date().toISOString(),
                } },
              { kind: 'state', property: 'stage', value: 'client' },
              { kind: 'state', property: 'pipeline_stage', value: 'client' },
              { kind: 'state', property: 'plan', value: planId },
            ]).catch(err => console.error('[stripe-webhook] obs failed:', err.message));
          }
        }
        break;
      }

      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        const teamId = sub.metadata?.team_id;
        if (!teamId) break;
        // Downgrade to free, keep the row for history.
        await supabase
          .from('subscriptions')
          .update({
            plan_id: 'free',
            plan_name: 'free',
            status: 'canceled',
            cancel_at_period_end: false,
          })
          .eq('team_id', teamId);

        // Dogfood: log the cancellation + flip stage to Churned.
        const founderEmail = await founderEmailForTeam(supabase, teamId);
        if (founderEmail) {
          logNousObservation(founderEmail, [
            { kind: 'event', property: 'interaction.subscription_canceled',
              value: {
                source: 'stripe',
                plan: sub.metadata?.plan_id || null,
                stripe_subscription_id: sub.id,
                reason: sub.cancellation_details?.reason || null,
                feedback: sub.cancellation_details?.feedback || null,
                at: new Date().toISOString(),
              } },
            { kind: 'state', property: 'stage', value: 'churned' },
            { kind: 'state', property: 'pipeline_stage', value: 'churned' },
          ]).catch(err => console.error('[stripe-webhook] obs failed:', err.message));
        }
        break;
      }

      // Note: no ops reset on renewal. "Ops used this period" is computed live
      // as SUM(workspace_system_log.billable_ops) since current_period_start —
      // so when customer.subscription.updated advances the period, usage
      // automatically re-scopes. invoice.paid needs no billing side-effect.

      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        const stripeSubId = invoice.subscription;
        if (!stripeSubId) break;
        await supabase
          .from('subscriptions')
          .update({ status: 'past_due' })
          .eq('stripe_subscription_id', stripeSubId);
        break;
      }

      default:
        // Other events are uninteresting for billing; acknowledge quietly.
        break;
    }
  } catch (err) {
    console.error('[stripe-webhook] handler error', event.type, err);
    return res.status(500).json({ error: 'handler_error' });
  }

  return res.json({ received: true });
}
