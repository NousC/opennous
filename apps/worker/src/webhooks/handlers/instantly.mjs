// Instantly.ai webhook handler — receives email campaign events and logs them as activities.
// Supported events: reply_received, email_sent, email_opened, email_bounced, unsubscribed.
// reply_received creates new contacts (a reply = strong intent signal).
// All other events are update-only.

import { createHash } from 'crypto';
import { getSupabaseClient, upsertCampaignMessage, replySignalToSentiment } from '@nous/core';
import { logActivity } from '../../utils/activity.mjs';
import { resolveContact } from '../../utils/resolveContact.mjs';
import { enqueueForRetry } from '../../utils/webhookInbox.mjs';
import { logSysEvent } from '../../utils/systemLog.mjs';
import { htmlToText, saveLeadSentThread } from '../../services/instantlyEmails.mjs';

// Instantly's real event names (developer.instantly.ai webhook guide). The
// disposition events (lead_interested / lead_not_interested / lead_meeting_booked
// / lead_wrong_person / auto_reply_received / lead_unsubscribed) are ones Instantly
// already classifies — we route them through and carry the disposition in
// rawData.provider_signal, preferred over our own classifier. NOTE: the old map
// expected `unsubscribed`; the real event is `lead_unsubscribed`, so every
// Instantly opt-out was silently dropped (never suppressed) until now.
const EVENT_TYPE_MAP = {
  reply_received:      'email_received',
  email_replied:       'email_received',
  auto_reply_received: 'email_received',
  lead_interested:     'email_received',
  lead_not_interested: 'email_received',
  lead_wrong_person:   'email_received',
  lead_out_of_office:  'email_received',
  lead_neutral:        'email_received',
  // A `lead_meeting_booked` disposition is a rep marking the lead in Instantly —
  // NOT a confirmed calendar event. It maps to `meeting_interest` (a strong
  // positive signal), so "Meeting booked" on the timeline only ever means a real
  // calendar booking (Cal.com / Calendly / Google Calendar → meeting_scheduled).
  lead_meeting_booked: 'meeting_interest',
  email_sent:          'email_sent',
  email_opened:        'email_opened',
  link_clicked:        'email_opened',
  email_bounced:       'email_bounced',
  lead_unsubscribed:   'email_bounced',
};

// Instantly's native disposition → our canonical reply signal. When present we
// trust it and skip the LLM classifier. Absent (a plain reply_received) → null,
// and the classifier decides.
const PROVIDER_SIGNAL = {
  lead_interested:     'positive',
  lead_meeting_booked: 'positive',
  lead_not_interested: 'negative',
  lead_wrong_person:   'negative',
  auto_reply_received: 'auto_reply',
  lead_out_of_office:  'auto_reply',
  lead_neutral:        'neutral',
  lead_unsubscribed:   'unsubscribe',
};

// Instantly's interest status on a lead or received email → the disposition event its webhook
// sends for it (GET-1025). Anything unset or unknown is a plain reply, which our classifier reads.
const INTEREST_EVENT = { 1: 'lead_interested', 2: 'lead_meeting_booked', 3: 'lead_meeting_booked', 4: 'lead_interested',
  0: 'lead_out_of_office', '-1': 'lead_not_interested', '-2': 'lead_wrong_person', '-3': 'lead_not_interested' };
export const instantlyInterestEvent = status => (status == null ? null : INTEREST_EVENT[String(status)]) ?? 'reply_received';
export const isPositiveInterest = status => PROVIDER_SIGNAL[instantlyInterestEvent(status)] === 'positive';

// `backfill`: a reply fetched from Instantly's API after the webhook missed it (GET-1025). Filed the
// same way, but not logged as a webhook delivery, so the Webhooks page never reads it as one.
export async function reprocessInstantly(supabase, workspaceId, body, { backfill = false } = {}) {
  body = body || {};
  const eventType  = body.event_type  || body.event  || body.type || '';
  const leadEmail  = (body.lead_email || body.email  || body.lead?.email || '').toLowerCase().trim();
  const firstName  = body.lead_first_name || body.first_name || body.firstName || body.lead?.first_name || null;
  const lastName   = body.lead_last_name  || body.last_name  || body.lastName  || body.lead?.last_name  || null;
  // Company off the lead so a created contact isn't a bare email. Instantly's
  // custom lead variables vary, so try the common shapes.
  const companyName = body.company_name || body.companyName || body.lead_company || body.organization
    || body.lead?.company_name || body.lead?.companyName || body.lead?.company || null;
  const campaignId = body.campaign_id   || null;
  const campaignName = body.campaign_name || body.campaign || null;
  // Reply body: Instantly's real fields are reply_text_snippet / reply_text /
  // reply_html (preview_text does not exist — kept last as a defensive fallback).
  const preview    = body.reply_text_snippet || body.reply_text || body.reply_html || body.preview_text || body.body || null;
  const messageId  = body.message_id    || body.email_id   || null;
  // Variant attribution — which email earned this event. Lands on the
  // observation via rawData, so the People timeline and the lead-list
  // campaign analysis both read it. Defensive picks; null when absent.
  // CAVEAT: Instantly documents step/variant on SENT events; reply events may
  // not carry them — reply→sent attribution is joined downstream (see PLAN N1).
  const step       = body.step ?? body.step_number ?? body.sequence_step ?? null;
  const variant    = body.variant ?? body.email_variant ?? body.step_variant ?? null;
  const subject    = body.reply_subject ?? body.email_subject ?? body.subject ?? null;
  // Instantly's SENT webhook almost never carries the body — the campaignStats
  // cron backfills it from GET /api/v2/emails. But if a body IS present, store a
  // clean plain-text preview (never raw HTML) so it matches the backfilled shape.
  const sentBodyRaw = body.email_body ?? body.sent_message ?? body.body_html ?? null;
  const sentText    = sentBodyRaw ? (body.email_body_text || htmlToText(sentBodyRaw)) : null;

  console.log(`[INSTANTLY_WEBHOOK] event=${eventType} email=${leadEmail}`);

  if (!leadEmail) throw new Error('lead_email_required');

  const activityType = EVENT_TYPE_MAP[eventType];
  if (!activityType) return { skipped: `unhandled event: ${eventType}` };

  const isReply = activityType === 'email_received';
  const isSent  = activityType === 'email_sent';
  // Prefer Instantly's native disposition over our own classifier when present.
  const provSignal = PROVIDER_SIGNAL[eventType] ?? null;

  const { contact } = await resolveContact(supabase, workspaceId, {
    email:        leadEmail,
    first_name:   firstName,
    last_name:    lastName,
    company_name: companyName,
    source:       'instantly',
  }, { createIfMissing: isReply });

  if (!contact) return { skipped: 'contact not found' };

  // externalId dedups repeat webhooks. Instantly fires the SAME out-of-office as
  // TWO events — one WITH a message_id, one WITHOUT — so keying on message_id lets
  // both land as duplicate rows. For any REPLY we therefore key on its CONTENT
  // (lead + subject + body), which collapses those dual events into one and is
  // stable across re-deliveries. Non-reply events keep message_id / timestamp.
  const contentKey = createHash('sha1')
    .update(`${(subject || '').trim()}|${(preview || '').replace(/\s+/g, ' ').trim().slice(0, 200)}`)
    .digest('hex').slice(0, 16);
  const externalId = isReply
    ? `instantly_reply_${leadEmail}_${contentKey}`
    : (messageId ? `instantly_${messageId}` : `instantly_${eventType}_${leadEmail}_${Date.now()}`);

  await logActivity(supabase, {
    workspaceId,
    contactId:   contact.id,
    companyId:   contact.company_id || null,
    type:        activityType,
    source:      'instantly',
    externalId,
    // When it happened, as Instantly stamps it; a backfilled reply would otherwise be dated today.
    occurredAt:  body.timestamp && !Number.isNaN(Date.parse(body.timestamp)) ? new Date(body.timestamp).toISOString() : new Date().toISOString(),
    description: campaignName
      ? `${activityType.replace('_', ' ')}: ${campaignName}`
      : activityType.replace('_', ' '),
    summary:     isReply && preview ? preview.slice(0, 500)
                 : isSent ? ((sentText ? sentText.replace(/\s+/g, ' ').trim().slice(0, 240) : subject) || null)
                 : null,
    rawData:     {
      event_type: eventType, campaign_id: campaignId, campaign_name: campaignName,
      step, variant, subject,
      ...(sentText ? { sent_body: sentText, body_html: sentBodyRaw } : {}),
      // Native disposition preempts the LLM classifier: set both the canonical
      // signal and the 3-way sentiment the CRM gate reads.
      ...(provSignal ? { provider_signal: provSignal, sentiment: replySignalToSentiment(provSignal) } : {}),
      ...(isSent ? { is_outbound: true } : {}),
    },
  });

  // Stash the sent copy per (campaign, step, variant) so the timeline can show
  // the body and replies can be attributed to the exact email later.
  if (isSent && campaignId && (subject || sentBodyRaw)) {
    upsertCampaignMessage(supabase, workspaceId, {
      provider: 'instantly', campaignId, campaignName, step, variant,
      subject, body: sentBodyRaw, source: 'webhook',
    }).catch(() => {});
  }

  // Instantly is bulk outbound — the company's outreach engine, not a personal
  // 1:1 conversation. Left owner-less on purpose: it belongs in the company op
  // log, not any one member's Activity feed. (Decision 2026-08-15.)
  if (!backfill) await logSysEvent(supabase, {
    workspaceId, source: 'instantly', eventType: 'webhook_received',
    summary:    `${activityType.replace('_', ' ')} from ${leadEmail}${campaignName ? ` (${campaignName})` : ''}`,
    contactId:  contact.id,
    metadata:   { type: eventType, email: leadEmail, campaign_name: campaignName },
  });

  // Reply-driven: someone replied → pull the exact email(s) we sent this lead and
  // save the outbound thread it answered (bodies included). Only for repliers —
  // that's the one conversation where the per-person copy matters. Fire-and-forget
  // so the webhook response isn't blocked on the API round-trip; dedup keeps it safe.
  if (isReply) {
    saveLeadSentThread(supabase, { workspaceId, entityId: contact.id, leadEmail })
      .catch(() => {});
  }

  return { contactId: contact.id, type: activityType };
}

export async function handleInstantly(req, res, workspaceId) {
  const supabase = getSupabaseClient();
  try {
    const result = await reprocessInstantly(supabase, workspaceId, req.body);
    return res.json({ ok: true, ...result });
  } catch (err) {
    console.error('[INSTANTLY_WEBHOOK] processing failed, queuing for retry:', err.message);
    await enqueueForRetry(supabase, { workspaceId, source: 'instantly', req, err });
    return res.status(200).json({ ok: true, queued: true });
  }
}
