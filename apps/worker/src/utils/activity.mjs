// Wrapper around @nous/core logActivity that auto-fires signal extraction.
// All worker webhook handlers import logActivity from here, not from @nous/core directly.

import { activityText } from '../signals/extractionText.mjs';
import { logActivity as _logActivity, addSuppression, recordVerificationObservation, replySignalToSentiment, closeActionItemsForActivity } from '@nous/core';
import { extractAfterActivity } from '../signals/index.mjs';
import { classifyReplySignal } from '../signals/replySentiment.mjs';
import { resolveReplyAttribution } from './replyAttribution.mjs';

// Activities that can DISCHARGE an open commitment the moment they land: a meeting
// closes "schedule a chat", an outbound send closes "I'll follow up / send X". We
// run the deterministic closer on these in real time, so a commitment closes at the
// point in the conversation we know it's done — not only when the Tasks page opens.
// (The fuzzy "thanks for the deck" cases still fall to the LLM tier on Tasks load.)
const COMPLETION_EVIDENCE_TYPES = new Set([
  'meeting_scheduled', 'meeting_held',
  'email_sent', 'email_reply', 'linkedin_message', 'message_sent',
]);

// Inbound, content-rich replies we classify. The canonical signal + the derived
// 3-way sentiment are stashed on rawData so they persist on the observation AND
// travel with the CRM push event, where the create-gate uses the sentiment to
// promote positive replies.
// 'linkedin_reply' is here alongside 'linkedin_replied' because both spellings
// exist in the wild — a June 2026 run of webhooks wrote the short one, and those
// rows matched nothing and were never classified. contacts.mjs already accepts
// both; so does the extractor. Cheap insurance against a silent miss.
const REPLY_TYPES = new Set([
  'email_received', 'email_reply',
  'linkedin_message', 'linkedin_replied', 'linkedin_reply',
]);

// A hard bounce or a provider unsubscribe both arrive as 'email_bounced' (see
// each webhook handler's EVENT_TYPE_MAP). Two things must happen, neither of
// which did before: (1) a real bounce must mark the address undeliverable so the
// lead list's STATUS + EMAIL STATUS reflect it; (2) the address must be
// suppressed so it can't be re-imported or re-contacted (until now only an
// LLM-classified unsubscribe REPLY suppressed).
//
// Caveat: providers that fire email_bounced on SOFT bounces would over-suppress;
// the reason string records the original event_type for auditability.
async function handleBounceOrUnsub(supabase, params) {
  if (!params.contactId) return;
  const evt = String(params.rawData?.event_type || 'bounce');
  const isUnsub = /unsub/i.test(evt);

  // Real bounce → mark undeliverable. A newer verification observation wins in
  // the claim engine, so this upgrades the email_status shown on the lead. An
  // unsubscribe leaves the address deliverable — don't mark it bounced.
  if (!isUnsub) {
    await recordVerificationObservation(
      supabase, params.workspaceId, params.contactId, params.source || 'webhook', 'bounced',
    ).catch(() => {});
  }

  // Suppress either way: a bounce is dead, an unsubscribe opted out.
  const { data } = await supabase
    .from('contacts')
    .select('email')
    .eq('id', params.contactId)
    .maybeSingle();
  const email = data?.email;
  if (email) {
    await addSuppression(supabase, params.workspaceId, email, `${evt} via ${params.source || 'webhook'}`);
  }
}

// Opt-out reply signals suppress the address — an unsubscribe or a do-not-contact
// that arrives as a REPLY body (not a provider unsubscribe event). Until now only
// an email_bounced event suppressed, so an opt-out typed into a reply stayed
// contactable AND (via the null-signal path) climbed the pipeline.
const SUPPRESSING_REPLY_SIGNAL = new Set(['unsubscribe', 'do_not_contact', 'bounce']);

// Stake the latest inbound reply disposition as a `reply_signal` claim (one per
// entity, newest wins) so the record can render a "Reply" chip next to Intent —
// positive / objection / neutral / negative / unsubscribe / out-of-office. Same
// direct-write shape as the intent_band claim the intent worker stakes. Also acts
// on opt-outs: suppresses the address so it can't be re-contacted or re-imported.
async function recordReplySignal(supabase, params, signal, observationId = null) {
  const entityId = params.entityId ?? params.contactId;
  const atIso = params.occurredAt || new Date().toISOString();
  await supabase.from('claims').upsert([{
    workspace_id: params.workspaceId, entity_id: entityId, property: 'reply_signal', value: signal,
    distribution: null, confidence: 0.9, epistemic_class: 'inferred', freshness: 'fresh',
    // The reply it came from, so the chip follows that email's readers (GET-253).
    valid_from: atIso, invalid_at: null, supporting_observation_ids: observationId ? [observationId] : [], observation_count: 0,
    last_observed_at: atIso, computed_at: new Date().toISOString(),
  }], { onConflict: 'workspace_id,entity_id,property' }).then(() => {}, () => {});

  if (SUPPRESSING_REPLY_SIGNAL.has(signal) && params.contactId) {
    const { data } = await supabase.from('contacts').select('email').eq('id', params.contactId).maybeSingle();
    if (data?.email) {
      await addSuppression(supabase, params.workspaceId, data.email, `${signal} reply via ${params.source || 'webhook'}`)
        .catch(() => {});
    }
  }
}

/**
 * @param {object}  params
 * @param {boolean} [params.suppressExtraction]  Log the activity, don't extract.
 *   Meetings set this. The transcript is logged once per attendee (each of them
 *   wants the call on their timeline), but extraction must run ONCE for the whole
 *   room — see extractMeetingSignals. Without this flag, a three-person call
 *   extracted the same transcript three times.
 */
export async function logActivity(supabase, params) {
  // Classify the reply once, here — the single choke point every worker webhook
  // handler routes through. Skips outbound messages and anything a provider
  // already labelled (rawData.sentiment set by a handler's native-disposition
  // preemption). Writes BOTH the canonical reply_signal and the 3-way sentiment.
  // A source that knows an email is NOT a reply to us (a newsletter, a teammate, a message that
  // answers nothing we sent) says so with reply_eligible: false. Classifying it anyway labelled a
  // founder's whole inbox and could suppress a contact from a regex on a footer (GET-245).
  if (
    REPLY_TYPES.has(params.type) &&
    params.summary &&
    params.rawData?.sentiment == null &&
    params.rawData?.is_outbound !== true &&
    params.rawData?.reply_eligible !== false
  ) {
    // The whole newly written reply when the source keeps it (GET-256), else the preview.
    const signal = await classifyReplySignal(params.rawData?.text || params.summary, supabase, params.workspaceId);
    if (signal) {
      params.rawData = {
        ...(params.rawData || {}),
        reply_signal: signal,
        sentiment: replySignalToSentiment(signal),
      };
    }
  }

  // Attribute the reply to the exact sequence step/variant it answers. Cold-email
  // providers only stamp step/variant on SENT events, so a reply arrives with them
  // null — recover them from this contact's last send in the same campaign. This is
  // what lets feedback loops say "variant B earned the positive reply", not just
  // "someone in campaign X replied". Provider-generic; runs for every reply that
  // carries a campaign_id but is missing its path. Best-effort.
  if (
    REPLY_TYPES.has(params.type) &&
    params.contactId &&
    params.rawData?.campaign_id &&
    (params.rawData?.step == null || params.rawData?.variant == null)
  ) {
    const attr = await resolveReplyAttribution(supabase, {
      workspaceId: params.workspaceId,
      entityId:    params.entityId ?? params.contactId,
      source:      params.source,
      campaignId:  params.rawData.campaign_id,
      before:      params.occurredAt,
    });
    if (attr && (attr.step != null || attr.variant != null)) {
      params.rawData = {
        ...(params.rawData || {}),
        step:    params.rawData.step    ?? attr.step,
        variant: params.rawData.variant ?? attr.variant,
        subject: params.rawData.subject ?? attr.subject,
        // Marks step/variant as joined from the sent email rather than present on
        // the reply payload — lets us audit attribution quality later.
        attribution_source: 'sent_join',
      };
    }
  }

  const result = await _logActivity(supabase, params);

  // Best-effort: never block ingestion on the bounce/suppression writes.
  if (result && params.type === 'email_bounced') {
    handleBounceOrUnsub(supabase, params).catch(() => {});
  }

  // Stake the reply disposition (the "Reply" chip) + suppress opt-outs. Runs for any
  // inbound reply we have a canonical signal for — whether we classified it or the
  // provider handed us its native disposition (e.g. Instantly's auto_reply). Skips
  // outbound and unclassified replies (no signal → nothing to show). Fire-and-forget.
  if (result && params.contactId && REPLY_TYPES.has(params.type) && params.rawData?.is_outbound !== true) {
    const replySignal = params.rawData?.reply_signal ?? params.rawData?.provider_signal ?? null;
    if (replySignal) recordReplySignal(supabase, params, replySignal, result.id ?? null).catch(() => {});
  }

  // Close any open commitment this activity discharges (a booking closes "schedule
  // a chat"; our outbound touch closes "I'll follow up"). Deterministic + auditable,
  // event-driven so it closes at the moment we know. Fire-and-forget.
  if (result && params.contactId && COMPLETION_EVIDENCE_TYPES.has(params.type)) {
    closeActionItemsForActivity(supabase, params.workspaceId, params.contactId, {
      activityType: params.type,
      isOutbound:   params.rawData?.is_outbound === true,
      occurredAt:   params.occurredAt || null,
    }).then(n => { if (n) console.log(`[ACTION_ITEMS] closed ${n} item(s) on ${params.type} — contact ${params.contactId}`); })
      .catch(() => {});
  }

  if (result && !params.suppressExtraction) {
    extractAfterActivity(supabase, result, {
      contactId:   params.contactId,
      workspaceId: params.workspaceId,
      type:        params.type,
      source:      params.source,
      // The fullest copy of the message, never the 200-character timeline summary.
      summary:     activityText({ summary: params.summary, description: params.description, raw: params.rawData }),
      // The anchor for resolving relative due-timing phrases ("in 4 days") —
      // must be when this activity actually happened, not whenever extraction
      // runs, or a Monday commitment silently resolves against today instead.
      occurredAt:  params.occurredAt || null,
      // Direction matters: a message the user SENT must never become a "fact"
      // about the contact. Forward it so the extractor can skip outbound.
      isOutbound:  params.rawData?.is_outbound === true,
    }).catch(() => {});
  }
  return result;
}
