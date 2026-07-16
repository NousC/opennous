// Shared Stripe helpers for quantity-based (per-client) subscriptions.
//
// Partner is one subscription with a per-unit price; the quantity = number of
// client workspaces. Adding a workspace bumps it, deleting one drops it, so the
// bill always tracks the real client count (both directions, prorated).

import Stripe from 'stripe';
import { isSelfHosted } from './plans.mjs';

let _stripe = null;
export function getStripe() {
  if (_stripe) return _stripe;
  if (!process.env.STRIPE_SECRET_KEY) throw new Error('STRIPE_SECRET_KEY missing');
  _stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  return _stripe;
}

export function billingEnabled() {
  if (isSelfHosted()) return false;
  return process.env.BILLING_ENABLED !== 'false' && !!process.env.STRIPE_SECRET_KEY;
}

/**
 * Set a quantity-based subscription's quantity. Updates Stripe (prorated in both
 * directions) and writes the new quantity back to our subscriptions row. No-op if
 * already at the target. Returns the resulting quantity.
 */
export async function setSubscriptionQuantity(supabase, subscription, desiredQty) {
  const stripe = getStripe();
  const sub = await stripe.subscriptions.retrieve(subscription.stripe_subscription_id);
  const item = sub.items?.data?.[0];
  if (!item) throw new Error('no_subscription_item');
  if ((item.quantity ?? 1) !== desiredQty) {
    await stripe.subscriptions.update(sub.id, {
      items: [{ id: item.id, quantity: desiredQty }],
      proration_behavior: 'create_prorations',
    });
    await supabase.from('subscriptions').update({ quantity: desiredQty }).eq('team_id', subscription.team_id);
  }
  return desiredQty;
}
