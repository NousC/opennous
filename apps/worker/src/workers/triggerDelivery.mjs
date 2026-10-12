import {
  getSupabaseClient,
  fetchPendingDeliveries,
  markDelivered,
  markFailure,
  deliverToSubscription,
  recordDeliveryAttempt,
  eventIdOf,
} from '@nous/core';
import { decrypt } from '../utils/encryption.mjs';

// Drains pending outbound_events rows and delivers each to its subscription: a signed POST to its
// URL, or a repository_dispatch to its GitHub repo (GET-670). Cron'd every 30s by the worker
// entrypoint.
//
// Signing: HMAC-SHA256 of the raw JSON body, hex-encoded, sent as
//   X-Nous-Signature: sha256=<hex>
// Receivers verify by recomputing with their stored secret. Plaintext secret
// stored in trigger_subscriptions.signing_secret — industry standard for
// webhook signing (Stripe, GitHub, Linear all do the same). The send itself
// is deliverToSubscription in @nous/core, shared with the API's Resend and test send. A GitHub
// destination's token is decrypted here, at send time, and never leaves this function.
//
// Every attempt, retries included, is also written to webhook_deliveries
// (GET-624) — the history the Webhooks page reads. That write is best-effort:
// it runs after the outbox state is settled and never throws.

const BATCH_SIZE = 50;

let isRunning = false;

export async function deliverTriggers() {
  if (isRunning) return;
  isRunning = true;
  try {
    const supabase = getSupabaseClient();
    const pending = await fetchPendingDeliveries(supabase, BATCH_SIZE);
    if (pending.length === 0) return;

    console.log(`[TRIGGERS] delivering ${pending.length} pending event(s)`);

    // Sequential rather than parallel — keeps a slow URL from monopolising
    // the loop and avoids overwhelming any single receiver. Still fast at
    // BATCH_SIZE=50 and a 10s timeout each (worst case 8 min, typical < 5s).
    for (const d of pending) {
      if (!d.active) {
        // Subscription was deactivated after enqueue. Mark as dead, no retry.
        await markFailure(supabase, d.id, d.attempts, null, 'subscription_inactive');
        continue;
      }
      await deliverOne(supabase, d);
    }
  } catch (err) {
    console.error('[TRIGGERS] delivery loop error:', err?.message ?? err);
  } finally {
    isRunning = false;
  }
}

export async function deliverOne(supabase, d, { fetchImpl } = {}) {
  const eventId = eventIdOf(d.payload, d.id);
  const result = await deliverToSubscription(d, {
    eventType: d.event_type, eventId, payload: d.payload, decryptToken: decrypt, fetchImpl,
  });

  if (result.ok) {
    await markDelivered(supabase, d.id, d.attempts, result.status_code);
  } else if (result.permanent) {
    // Permanent client error — don't retry.
    await markFailure(supabase, d.id, 99, result.status_code, result.error);
  } else {
    // 5xx, 408, 429, network, timeout — retry with backoff.
    await markFailure(supabase, d.id, d.attempts, result.status_code, result.error);
  }

  await recordDeliveryAttempt(supabase, {
    workspaceId: d.workspace_id, subscriptionId: d.subscription_id, outboundEventId: d.id,
    event: d.event_type, eventId, attempt: (d.attempts ?? 0) + 1, result,
  });
  return result;
}
