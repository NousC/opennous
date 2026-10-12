// Canonical reply-signal taxonomy — the single source of truth for "what did
// this reply mean?". Both the reply classifier and the lead/learning loop read
// from here, so there is ONE vocabulary across the product (no sentiment-vs-
// outcome mismatch).
//
// This file is intentionally pure (no DB, no model) so it can be imported from
// the worker, the API, and the core services alike.

export const REPLY_SIGNALS = [
  'positive', // interested — wants to talk, asks for time/pricing/details
  'negative', // not interested, wrong person/company, hostile
  'neutral', // ambiguous, "not right now", a referral elsewhere
  'objection', // pushback ("no budget", "bad timing") but still engaged
  'unsubscribe', // explicitly asked to stop / opt out
  'do_not_contact', // legal/compliance "never contact me again"
  'bounce', // hard bounce — the address is dead
  'auto_reply', // out-of-office / autoresponder — not a human reply
] as const;

export type ReplySignal = (typeof REPLY_SIGNALS)[number];

// Signals that carry learning value (a real human disposition). neutral /
// auto_reply / bounce are noise and must never pollute the evidence set.
export const LEARNABLE_REPLY_SIGNALS: readonly ReplySignal[] = [
  'positive',
  'negative',
  'objection',
  'unsubscribe',
  'do_not_contact',
];

// Signals that should suppress the address from future contact.
export const SUPPRESSING_REPLY_SIGNALS: readonly ReplySignal[] = [
  'unsubscribe',
  'do_not_contact',
  'bounce',
];

// Replies the CRM create-gate may promote — preserves today's behaviour
// ("only genuine hand-raisers reach the CRM"): positive intent, plus neutral
// (auto-reply/ambiguous) which is left to downstream judgement, never the
// clear negatives or opt-outs.
export const CRM_PROMOTABLE_REPLY_SIGNALS: readonly ReplySignal[] = ['positive', 'neutral'];

export function isReplySignal(value: unknown): value is ReplySignal {
  return typeof value === 'string' && (REPLY_SIGNALS as readonly string[]).includes(value);
}

// Collapse a canonical reply signal to the 3-way sentiment the CRM create-gate
// reads (positive promotes; negative/neutral don't). Used when a provider hands
// us a native disposition (e.g. Instantly's lead_interested) so we can preempt
// the LLM classifier entirely — the first half of classifier consolidation.
export function replySignalToSentiment(signal: ReplySignal): 'positive' | 'neutral' | 'negative' {
  switch (signal) {
    case 'positive':
      return 'positive';
    case 'negative':
    case 'unsubscribe':
    case 'do_not_contact':
    case 'bounce':
      return 'negative';
    default:
      return 'neutral'; // neutral, objection, auto_reply
  }
}

// Map the legacy `reply_outcome` vocabulary (interested/objection/wrong_fit/
// unsubscribe) and the legacy sentiment vocabulary (positive/neutral/negative)
// onto the canonical taxonomy. Used by the consolidation step and the data
// migration so no historical row is lost.
export function fromLegacyReplyOutcome(outcome: string | null | undefined): ReplySignal | null {
  switch (outcome) {
    case 'interested':
      return 'positive';
    case 'objection':
      return 'objection';
    case 'wrong_fit':
      return 'negative';
    case 'unsubscribe':
      return 'unsubscribe';
    // Already-canonical values pass through.
    case 'positive':
    case 'negative':
    case 'neutral':
    case 'do_not_contact':
    case 'bounce':
    case 'auto_reply':
      return outcome;
    default:
      return null;
  }
}
