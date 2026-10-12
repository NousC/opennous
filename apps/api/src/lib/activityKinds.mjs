// What kind of conversation an activity was — read from its PROPERTY, never its source (GET-269).
//
// The reports used to ask the source name: /meeting|call|fireflies|fathom/ for a meeting,
// /mail|email/ for an email. That worked while each tool sent one kind of thing, and breaks the
// moment a CRM carries all of them: every HubSpot call, email and meeting arrives with source
// `hubspot`, matched neither pattern, and the revenue report counted zero meetings on a portal
// holding tens of thousands of calls. The property says what happened (`interaction.meeting_held`,
// `interaction.email_received`) whichever tool delivered it.
//
// One definition for every report, so coverage, separators, leakage and win/loss silence agree.

const typeOf = (o) => String(o?.property ?? '').replace(/^interaction\./, '');

/** A conversation that actually happened with the buyer on the line or in the room. */
const HELD = new Set(['meeting_held', 'call_held', 'call_received']);
/** An outbound call that connected is a conversation too; a missed one is not. */
const CALLS = new Set(['call_made', 'call_received', 'call_held']);
const EMAILS = new Set(['email_sent', 'email_received', 'email_reply', 'reply', 'positive_reply']);
/** Inbound from the buyer: the only rows that say the buyer is still engaged. */
const INBOUND = new Set(['email_received', 'email_reply', 'reply', 'positive_reply', 'call_received', 'linkedin_reply', 'meeting_held', 'call_held']);

/**
 * Rows that are events in OUR systems rather than a touch between people: a campaign add, an
 * open pixel, a scoring run, a booking that hasn't happened. Counting them as activity would
 * make a deal nobody spoke to look busy.
 */
const NOT_A_TOUCH = /_opened$|_scheduled$|_cancelled$|_no_show$|_missed$|^added_to_campaign$|^enrichment_run$|^icp_scored$|^contact_created$|^website_visit$|^pricing_page_visit$|^deal_(won|lost|disqualified)$|^signed_up$|^trial_started$|^subscription_|^proposal_viewed$|^meeting_interest$/;

export const isInteraction = (o) => String(o?.property ?? '').startsWith('interaction.');
export const isMeeting = (o) => HELD.has(typeOf(o));
export const isCall = (o) => CALLS.has(typeOf(o));
export const isEmail = (o) => EMAILS.has(typeOf(o));
export const isInbound = (o) => INBOUND.has(typeOf(o));
/** A real touch between people, in either direction. What silence and "last touch" are measured on. */
export const isTouch = (o) => isInteraction(o) && !NOT_A_TOUCH.test(typeOf(o));

/**
 * One CRM engagement is filed once PER PERSON on it (`hubspot_calls_<id>_<entity>`), so a person's
 * timeline shows the call. Counted across people, that turned every call into two or three rows. Anything that COUNTS conversations counts each engagement once.
 */
const ENGAGEMENT = /^(hubspot_[a-z]+_\d+)_/;
export const engagementKey = (o) => ENGAGEMENT.exec(String(o?.external_id ?? ''))?.[1] ?? null;
export const oneEach = (rows) => {
  const seen = new Set();
  return (rows ?? []).filter((o) => {
    const k = engagementKey(o);
    if (!k) return true;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
};
