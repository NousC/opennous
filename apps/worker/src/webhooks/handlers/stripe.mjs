// Stripe inbound webhook handler — logs payment_received → promotes contact to client.
// Wire this up in the user's own Stripe dashboard:
//   Endpoint: https://api.opennous.cloud/inbound/stripe/<workspaceId>
//   Events: payment_intent.succeeded, invoice.paid
//
// Optional: set STRIPE_INBOUND_WEBHOOK_SECRET to a shared secret for HMAC verification.

import { getSupabaseClient } from '@nous/core';
import { logActivity } from '../../utils/activity.mjs';
import { resolveContact } from '../../utils/resolveContact.mjs';
import { enqueueForRetry } from '../../utils/webhookInbox.mjs';
import { logSysEvent } from '../../utils/systemLog.mjs';

const HANDLED_EVENTS = new Set([
  'payment_intent.succeeded',
  'invoice.paid',
  'charge.succeeded',
]);

function extractEmail(event) {
  const obj = event.data?.object || {};
  return (
    obj.receipt_email ||
    obj.customer_email ||
    obj.customer_details?.email ||
    obj.billing_details?.email ||
    null
  );
}

function extractName(event) {
  const obj = event.data?.object || {};
  return (
    obj.billing_details?.name ||
    obj.customer_details?.name ||
    null
  );
}

function extractAmount(event) {
  const obj = event.data?.object || {};
  const amount = obj.amount_received ?? obj.amount_paid ?? obj.amount ?? null;
  const currency = obj.currency?.toUpperCase() ?? null;
  if (!amount) return null;
  return { amount: amount / 100, currency }; // Stripe stores in cents
}

export async function reprocessStripe(supabase, workspaceId, body) {
  const event = body || {};
  const eventType = event?.type || '';

  console.log(`[STRIPE_WEBHOOK] event=${eventType}`);

  if (!HANDLED_EVENTS.has(eventType)) return { skipped: `unhandled event: ${eventType}` };

  const email = extractEmail(event);
  if (!email) return { skipped: 'no_email' };

  const name = extractName(event);
  const nameParts = (name || '').trim().split(/\s+/);
  const amountInfo = extractAmount(event);

  const { contact } = await resolveContact(supabase, workspaceId, {
    email: email.toLowerCase().trim(),
    first_name: nameParts[0] || null,
    last_name: nameParts.slice(1).join(' ') || null,
    source: 'stripe',
  }, { createIfMissing: false });

  if (!contact) return { skipped: 'contact_not_found' };

  const obj = event.data?.object || {};
  const externalId = `stripe_payment_${obj.id || email + '_' + Date.now()}`;

  await logActivity(supabase, {
    workspaceId,
    contactId:   contact.id,
    companyId:   contact.company_id || null,
    type:        'payment_received',
    source:      'stripe',
    externalId,
    occurredAt:  new Date().toISOString(),
    description: amountInfo
      ? `Payment received: ${amountInfo.currency} ${amountInfo.amount.toLocaleString()}`
      : 'Payment received',
    rawData: {
      event_type: eventType,
      amount:     amountInfo?.amount ?? null,
      currency:   amountInfo?.currency ?? null,
      stripe_id:  obj.id ?? null,
    },
  });

  await logSysEvent(supabase, {
    workspaceId, source: 'stripe', eventType: 'webhook_received',
    summary:    amountInfo
      ? `Payment from ${email}: ${amountInfo.currency} ${amountInfo.amount.toLocaleString()}`
      : `Payment from ${email}`,
    contactId:  contact.id,
    metadata:   { event_type: eventType, email, amount: amountInfo?.amount ?? null, currency: amountInfo?.currency ?? null },
  });

  return { contactId: contact.id, type: 'payment_received' };
}

export async function handleStripe(req, res, workspaceId) {
  const supabase = getSupabaseClient();
  try {
    const result = await reprocessStripe(supabase, workspaceId, req.body);
    return res.json({ ok: true, ...result });
  } catch (err) {
    console.error('[STRIPE_WEBHOOK] processing failed, queuing for retry:', err.message);
    await enqueueForRetry(supabase, { workspaceId, source: 'stripe', req, err });
    return res.status(200).json({ ok: true, queued: true });
  }
}
