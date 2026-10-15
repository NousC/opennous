// A machine's notification is not evidence of a commitment (GET-423).
//
// Measured on one customer's Gmail corpus: a few percent of its tasks were "Attend the
// <meeting>" — and most of those rest on a quote a person never wrote:
//
//   "Attend the Quarry Ridge Labs x Fernpoint meeting."  ←  "Odette Marchwood has accepted this invitation."
//   "Attend Ashcombe Health | Harborline Training meeting."     ←  "Tobias Wrenfield has accepted this invitation."
//
// Google Calendar sends those. Accepting an invitation is not a promise to do a thing; it is the
// calendar working. The task then sits in a rep's worklist, cannot be completed by any action, and
// is not closable by evidence — the worst kind of row a task list can hold.
//
// The prompt now says so, and this is the half that does not depend on the model reading it: a
// quote that IS the notification cannot support any commitment, whatever the model built from it.
// Same shape as the pronoun guard and `spokenByOurSide` — the quote's provenance disqualifies it.

const AUTO_NOTIFICATION_RE =
  /\b(has (?:accepted|declined|tentatively accepted) this invitation|accepted this invitation|declined this invitation|this is an automated (?:message|email)|do not reply to this (?:message|email)|you have been invited|invitation from google calendar|unsubscribe from these emails)\b/i;

/** Was this "quote" written by a machine rather than a person? */
export function isAutoNotification(quote: string | null | undefined): boolean {
  const s = String(quote ?? '').trim();
  if (!s) return false;
  return AUTO_NOTIFICATION_RE.test(s);
}

export const AUTO_NOTIFICATION_REASON = 'the quote is an automated notification, not something a person said';
