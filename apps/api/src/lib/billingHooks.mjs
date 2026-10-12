// Billing as public code sees it — GET-754.
//
// Public routes ask two things of billing: is it on, and "this team now has N workspaces,
// bill it". On an open-source build there is no billing: billingEnabled() is false and
// setSubscriptionQuantity() changes nothing. On Cloud, src/cloud/billing.mjs supplies the
// Stripe versions (lib/stripe.mjs), loaded here directly rather than registered at boot so a
// test that imports a route without booting index.mjs sees the same billing as production.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const CLOUD_BILLING = new URL('../cloud/billing.mjs', import.meta.url);
const impl = existsSync(fileURLToPath(CLOUD_BILLING)) ? await import(CLOUD_BILLING.href) : null;

export function billingEnabled() {
  return impl ? impl.billingEnabled() : false;
}

export async function setSubscriptionQuantity(supabase, subscription, desiredQty) {
  return impl ? impl.setSubscriptionQuantity(supabase, subscription, desiredQty) : desiredQty;
}
