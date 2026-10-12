// Canonical reply classifier — ONE Haiku pass that maps an inbound reply to the
// canonical reply-signal taxonomy (@nous/core replySignals). This replaces the
// old 3-way sentiment classifier here AND the separate outcome classifier that
// lived in workers/leadReplies: ingest classifies once, and both the CRM
// create-gate (via the derived sentiment) and the lead-graduation cron read the
// single result. A provider's native disposition (rawData.sentiment already set
// by a webhook handler) preempts this call entirely.
//
// Best-effort: returns null when the text is empty or every model fails.
// Runs through the model door (lib/llm.mjs, extraction tier) — until GET-242 it called
// Anthropic directly and returned null on every reply from the day the credit ran out. Callers treat null as "unclassified" — the CRM gate stays
// closed and the lead is left for the next pass, so an outage never mislabels.

import { isReplySignal } from '@nous/core';
import { createMessage, messageText } from '../lib/llm.mjs';
import { meterLLM } from '../utils/meterLLM.mjs';

// Deterministic opt-out detection — runs BEFORE the model. An opt-out is the one
// reply we can never afford to mislabel: getting it wrong keeps emailing someone
// who told us to stop AND (until now) advanced them up the pipeline as "engaged".
// The LLM classifier misses a material share of replies (returns null on any API
// hiccup or off-vocabulary output), so the highest-stakes case must not depend on
// it. A body that literally says "unsubscribe" / "remove me" / "take me off" is an
// opt-out with certainty a regex can assert; the model only handles the fuzzy rest.
const DO_NOT_CONTACT_RE = /\b(do not (ever )?(contact|email)|never (contact|email) me|cease and desist|report(ing)? (you|this) (as )?spam|legal action)\b/i;
const UNSUBSCRIBE_RE = /\b(unsubscribe|opt(-|\s)?out|remove me|take me off|stop (emailing|contacting|reaching)|no longer (wish|want)|please stop)\b/i;

/**
 * Fast, model-free opt-out check. Returns 'do_not_contact', 'unsubscribe', or null.
 * @param {string} body  Trimmed reply text.
 * @returns {'do_not_contact'|'unsubscribe'|null}
 */
export function detectOptOut(body) {
  if (!body) return null;
  if (DO_NOT_CONTACT_RE.test(body)) return 'do_not_contact';
  if (UNSUBSCRIBE_RE.test(body)) return 'unsubscribe';
  return null;
}

/**
 * @param {string|null|undefined} text  The reply body.
 * @param {object|null} [supabase]      Supabase client, for credit metering.
 * @param {string|null} [workspaceId]   Workspace to bill the model call to.
 * @returns {Promise<import('@nous/core').ReplySignal|null>}
 */
export async function classifyReplySignal(text, supabase = null, workspaceId = null) {
  const body = (text || '').trim();
  if (!body) return null;

  // Opt-outs are caught deterministically — never gambled on the model.
  const optOut = detectOptOut(body);
  if (optOut) return optOut;

  const label = (t) => String(t || '').trim().toLowerCase().replace(/[^a-z_]/g, '');
  try {
    const msg = await createMessage({
      feature: 'reply-classify',
      max_tokens: 8,
      // An answer outside the taxonomy is unusable: let the fallback model try.
      accept: (text) => isReplySignal(label(text)),
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
    await meterLLM(supabase, workspaceId, 'reply-sentiment', msg);
    const out = label(messageText(msg));
    return isReplySignal(out) ? out : null;
  } catch (err) {
    console.warn('[REPLY_CLASSIFY] classify failed:', err?.message || err);
    return null;
  }
}
