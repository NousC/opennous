// Five shapes that look like a commitment and are not (GET-423, GET-424).
//
// Audited the Gmail tasks on a customer's graph. A real share of them were rows nobody can
// complete:
//
//   meeting logistics     the largest share   "Propose a better time", "Forward the meeting link"
//   discovery questions   a few percent       "Explain how your team handles walk-ins today"
//   bulk-marketing CTAs   a few percent       "RSVP for the Tallowmere webinar", "Apply to join Brisklane's Slack"
//   playbook steps        about one percent   "Step 1 — Pick a starting department"
//   standing states       a handful           "Continue routing leads to the old inbox"
//
// The CTAs and the template steps are worth stating plainly: they come from MARKETING EMAIL — ours and other vendors'
// — and a call-to-action in a mass send is not a promise anybody made. "Apply to join Corvelle Circle" was
// filed as a task on a customer's record because a vendor sent the customer a newsletter.
//
// FOUR OF THE FIVE ARE MECHANICAL AND ONE IS NOT, deliberately. A tracking URL, a numbered
// template line and a machine's notification are all facts about the SOURCE and can be decided in
// code. Meeting logistics live in the wording, and every regex I tried for them also ate "Send the
// deck before the meeting" — a real deliverable. So that one stays in the prompt, where being
// wrong costs a junk row rather than a real one. The prompt is the weaker instrument; it is the
// right instrument when a wrong drop is worse than a wrong keep.

/** A quote that is really a call-to-action in a bulk send: it carries a tracking or booking URL. */
const BULK_URL_RE =
  /(utm_source|utm_campaign|utm_medium|\/promotions\/|hubspot\.com\/meetings|meetings-na\d?\.hubspot|calendly\.com\/|tours\.[\w.-]+\/demo\/|\/webinars?\/|unsubscribe)/i;

/** "Step 1 — …", "1) …", "2. …": a line lifted out of a numbered template, not a promise. */
const PLAYBOOK_STEP_RE = /^\s*(?:step\s*\d+\b|\d+\s*[.)—-])/i;

/**
 * A STANDING STATE, not a task (GET-424). "Continue routing leads to the old inbox", "Keep the
 * pricing change internal until the board meets", "Continue the current discount until the
 * renewal."
 *
 * These are true, and useful, and nobody can ever tick them off: they ask a rep to CARRY ON doing
 * what is already happening, so there is no moment at which the row is done. That makes them
 * status_quo facts on the account, which the fact pass files on its own; as a task they sit open
 * forever and dilute the list. Judged on the TITLE, because the shape is in the instruction, not
 * in the sentence it was lifted from.
 *
 * Narrow on purpose. "Keep Saoirse posted on the Lumen Verify setup guide" survives — an open-ended
 * promise to communicate is still a promise someone made, and real ones are common. So the
 * carve-out for keeping a PERSON informed comes before anything else.
 */
const KEEP_SOMEONE_POSTED_RE = /^keep\s+[\w'’.-]+(?:\s+[\w'’.-]+)?\s+(?:informed|posted|updated|apprised|in the loop)\b/i;
const STANDING_STATE_RE = /^(?:continue|carry on|keep|maintain|hold off|refrain from)\b/i;

/**
 * Should this commitment be refused before it becomes a task?
 *
 * Judged on the QUOTE — what was actually written — not on the model's title, because the title is
 * the model's paraphrase and the quote is the evidence. The one exception is the standing state,
 * whose whole tell is the instruction the model wrote. Returns the reason, for the log, or null.
 */
export function notACommitment(quote: string | null | undefined, title?: string | null): string | null {
  const s = String(quote ?? '').trim();
  const t = String(title ?? '').trim();
  if (t && !KEEP_SOMEONE_POSTED_RE.test(t) && STANDING_STATE_RE.test(t)) {
    return 'the title asks us to carry on doing what we already do — a standing state, not a task';
  }
  if (!s) return null;                       // an ungrounded commitment is handled elsewhere
  if (BULK_URL_RE.test(s)) return 'the quote is a call-to-action in a bulk email, not a promise';
  if (PLAYBOOK_STEP_RE.test(s)) return 'the quote is a numbered step in a template, not a promise';
  return null;
}
