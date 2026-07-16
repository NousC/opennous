// Canonical reply classifier — ONE Haiku pass that maps an inbound reply to the
// canonical reply-signal taxonomy (@nous/core replySignals). This replaces the
// old 3-way sentiment classifier here AND the separate outcome classifier that
// lived in workers/leadReplies: ingest classifies once, and both the CRM
// create-gate (via the derived sentiment) and the lead-graduation cron read the
// single result. A provider's native disposition (rawData.sentiment already set
// by a webhook handler) preempts this call entirely.
//
// Best-effort: returns null when the text is empty, the API key is missing, or
// the call fails. Callers treat null as "unclassified" — the CRM gate stays
// closed and the lead is left for the next pass, so an outage never mislabels.

import Anthropic from 'useleak';
import { isReplySignal } from '@nous/core';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

/**
 * @param {string|null|undefined} text  The reply body.
 * @returns {Promise<import('@nous/core').ReplySignal|null>}
 */
export async function classifyReplySignal(text) {
  const body = (text || '').trim();
  if (!body || !process.env.ANTHROPIC_API_KEY) return null;

  try {
    const msg = await anthropic.messages.create({
      feature: 'reply-classify',
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 8,
      messages: [{
        role: 'user',
        content: `Classify the sender's intent in this reply to a cold outbound sales message.

- positive = interested, wants to talk, proposes a time, asks for pricing/details.
- objection = pushback ("no budget", "bad timing", "send me info") but still engaged.
- negative = not interested, wrong person/company, or hostile.
- unsubscribe = asks to stop, opt out, or be removed.
- do_not_contact = an explicit legal/compliance demand to never be contacted again.
- auto_reply = an out-of-office or automated autoresponder, not a human reply.
- neutral = ambiguous, a referral to someone else, or "not right now".

REPLY:
"""
${body.slice(0, 1500)}
"""

Answer with ONLY one word: positive | objection | negative | unsubscribe | do_not_contact | auto_reply | neutral`,
      }],
    });
    const out = (msg.content[0]?.text || '').trim().toLowerCase().replace(/[^a-z_]/g, '');
    return isReplySignal(out) ? out : null;
  } catch (err) {
    console.warn('[REPLY_CLASSIFY] classify failed:', err?.message || err);
    return null;
  }
}
