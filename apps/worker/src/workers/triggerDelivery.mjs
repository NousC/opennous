import crypto from 'node:crypto';
import {
  getSupabaseClient,
  fetchPendingDeliveries,
  markDelivered,
  markFailure,
} from '@nous/core';

// Drains pending outbound_events rows, signs each payload, POSTs to the
// subscription's URL. Cron'd every 30s by the worker entrypoint.
//
// Signing: HMAC-SHA256 of the raw JSON body, hex-encoded, sent as
//   X-Nous-Signature: sha256=<hex>
// Receivers verify by recomputing with their stored secret. Plaintext secret
// stored in trigger_subscriptions.signing_secret — industry standard for
// webhook signing (Stripe, GitHub, Linear all do the same).

const TIMEOUT_MS = 10_000;
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

async function deliverOne(supabase, d) {
  const body = JSON.stringify(d.payload);
  const signature = sign(body, d.signing_secret);
  const eventId = d.payload?.event_id ?? d.id;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(d.url, {
      method:  'POST',
      headers: {
        'Content-Type':       'application/json',
        'User-Agent':         'Nous-Triggers/1.0',
        'X-Nous-Signature':   `sha256=${signature}`,
        'X-Nous-Event-Id':    eventId,
        'X-Nous-Event-Type':  d.event_type,
      },
      body,
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (res.status >= 200 && res.status < 300) {
      await markDelivered(supabase, d.id, d.attempts, res.status);
    } else if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) {
      // Permanent client error — don't retry.
      const text = await safeReadText(res);
      await markFailure(supabase, d.id, 99, res.status, text || `http_${res.status}`);
    } else {
      // 5xx, 408, 429, network — retry with backoff.
      const text = await safeReadText(res);
      await markFailure(supabase, d.id, d.attempts, res.status, text || `http_${res.status}`);
    }
  } catch (err) {
    clearTimeout(timer);
    const msg = err?.name === 'AbortError' ? 'timeout' : (err?.message ?? 'network_error');
    await markFailure(supabase, d.id, d.attempts, null, msg);
  }
}

function sign(body, secret) {
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

async function safeReadText(res) {
  try { return (await res.text()).slice(0, 500); } catch { return null; }
}
