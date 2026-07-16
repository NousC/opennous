// Wrapper around @nous/core logActivity that auto-fires signal extraction.
// All worker webhook handlers import logActivity from here, not from @nous/core directly.

import { logActivity as _logActivity, addSuppression, recordVerificationObservation, replySignalToSentiment } from '@nous/core';
import { extractAfterActivity } from '../signals/index.mjs';
import { classifyReplySignal } from '../signals/replySentiment.mjs';

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
  if (
    REPLY_TYPES.has(params.type) &&
    params.summary &&
    params.rawData?.sentiment == null &&
    params.rawData?.is_outbound !== true
  ) {
    const signal = await classifyReplySignal(params.summary);
    if (signal) {
      params.rawData = {
        ...(params.rawData || {}),
        reply_signal: signal,
        sentiment: replySignalToSentiment(signal),
      };
    }
  }

  const result = await _logActivity(supabase, params);

  // Best-effort: never block ingestion on the bounce/suppression writes.
  if (result && params.type === 'email_bounced') {
    handleBounceOrUnsub(supabase, params).catch(() => {});
  }

  if (result && !params.suppressExtraction) {
    extractAfterActivity(supabase, result, {
      contactId:   params.contactId,
      workspaceId: params.workspaceId,
      type:        params.type,
      source:      params.source,
      summary:     params.summary || params.description || null,
      // Direction matters: a message the user SENT must never become a "fact"
      // about the contact. Forward it so the extractor can skip outbound.
      isOutbound:  params.rawData?.is_outbound === true,
    }).catch(() => {});
  }
  return result;
}
