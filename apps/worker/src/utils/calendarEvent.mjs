// Google Calendar events → the shape the graph needs. Pure functions, no I/O, so the rules
// that decide who a meeting is with can be tested without a database (tests/calendarEvent.test.mjs).
// The reconcile that uses them: services/calendarSync.mjs (GET-221).


// Scheduler / no-reply senders (Zoom Scheduler, Calendly, Cal.com, …) are transport, not
// people. Their address must never be matched to or saved as a person.
const NOREPLY_RE = /(no-?reply|do-?not-?reply|scheduler|notification|invite|mailer-daemon|calendar-server)/i;
const SCHEDULER_DOMAIN_RE = /(^|\.)(zoom\.us|calendly\.com|cal\.com|savvycal\.com|acuityscheduling\.com|chilipiper\.com|hubspot\.com|youcanbook\.me|group\.calendar\.google\.com|resource\.calendar\.google\.com)$/i;

/**
 * Arguments for GOOGLECALENDAR_EVENTS_LIST. Composio's published schema is Google's own camelCase
 * (singleEvents, maxResults, pageToken, showDeleted). The first calendar lookup here sent
 * snake_case (single_events, max_results) and the action still succeeded — unknown keys are
 * tolerated, which means they were silently IGNORED: no singleEvents, so a recurring meeting
 * came back as one series record instead of the dates it happens on. Both spellings go out, so
 * the call is right whichever the pinned toolkit version reads.
 */
export function calendarListArgs({ timeMin, timeMax, maxResults = 50, pageToken = null, showDeleted = true } = {}) {
  return {
    calendarId: 'primary',           // required by the action; omitting it fails the call
    timeMin, timeMax,
    singleEvents: true, single_events: true,
    orderBy: 'startTime', order_by: 'startTime',
    maxResults, max_results: maxResults,
    showDeleted, show_deleted: showDeleted,   // a cancelled meeting must be seen to be cancelled
    alwaysIncludeEmail: true,
    ...(pageToken ? { pageToken, page_token: pageToken } : {}),
  };
}

export function isNonHumanEmail(email) {
  const e = (email || '').toLowerCase();
  const at = e.indexOf('@');
  if (at < 1) return true;
  return NOREPLY_RE.test(e.slice(0, at)) || SCHEDULER_DOMAIN_RE.test(e.slice(at + 1));
}

export function emailDomainOf(email) {
  const e = (email || '').toLowerCase().trim();
  const at = e.lastIndexOf('@');
  return at > 0 ? e.slice(at + 1) : null;
}

const lower = (v) => (typeof v === 'string' && v.trim() ? v.trim().toLowerCase() : null);

// `_` is a single-character wildcard in LIKE; event and entity ids are full of them.
export const likeEscape = (s) => String(s).replace(/[\\%_]/g, '\\$&');

/**
 * A Google Calendar event (as GOOGLECALENDAR_EVENTS_LIST returns it) → the fields we use.
 * Tolerates the flattened shapes Composio has used elsewhere; returns null for anything
 * without an id and a start.
 */
export function normalizeCalendarEvent(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = raw.id || raw.event_id || raw.eventId || null;
  const start = raw.start?.dateTime || raw.start?.date || raw.start_time || raw.startTime
    || (typeof raw.start === 'string' ? raw.start : null);
  if (!id || !start || Number.isNaN(new Date(start).getTime())) return null;

  const organizerEmail = lower(raw.organizer?.email || raw.organizer_email
    || (typeof raw.organizer === 'string' ? raw.organizer : null));

  const list = Array.isArray(raw.attendees) ? raw.attendees : [];
  const attendees = [];
  const seen = new Set();
  for (const a of list) {
    const email = lower(typeof a === 'string' ? a : a?.email);
    if (!email || seen.has(email)) continue;
    seen.add(email);
    attendees.push({
      email,
      name: typeof a === 'object' ? (a.displayName || a.display_name || null) : null,
      self: typeof a === 'object' && a.self === true,
      organizer: (typeof a === 'object' && a.organizer === true) || email === organizerEmail,
      responseStatus: typeof a === 'object' ? (a.responseStatus || a.response_status || null) : null,
    });
  }
  // An organizer who isn't in the guest list is still in the meeting.
  if (organizerEmail && !seen.has(organizerEmail)) {
    attendees.push({
      email: organizerEmail, name: raw.organizer?.displayName || null,
      self: raw.organizer?.self === true, organizer: true, responseStatus: 'accepted',
    });
  }

  const selfEmail = attendees.find(a => a.self)?.email || null;
  return {
    id: String(id),
    summary: (raw.summary || raw.title || '').trim() || 'Calendar meeting',
    status: raw.status || 'confirmed',
    start: new Date(start).toISOString(),
    allDay: !!raw.start?.date && !raw.start?.dateTime,
    attendees,
    organizerEmail,
    selfEmail,
  };
}

/**
 * The people in an event who are neither us nor a machine. `internal` = our team's emails,
 * `internalDomains` = our team's work domains (a colleague who isn't seated yet is still ours).
 */
export function externalAttendees(event, { internal = new Set(), internalDomains = new Set(), ownEmail = null } = {}) {
  return event.attendees.filter(a => {
    if (a.self) return false;
    if (ownEmail && a.email === ownEmail) return false;
    if (internal.has(a.email)) return false;
    if (isNonHumanEmail(a.email)) return false;
    const d = emailDomainOf(a.email);
    if (d && internalDomains.has(d)) return false;
    return true;
  });
}

/** scheduled | held, and the label the timeline + stage derivation read. */
export function meetingKind(event, attendee, now = Date.now()) {
  const isPast = new Date(event.start).getTime() < now;
  const rsvp = attendee?.responseStatus || null;
  if (rsvp === 'declined') return { type: 'meeting_scheduled', label: '(Declined)' };
  // A past meeting counts as held unless the guest never said yes. Invitations from the other
  // side (they organised it) count as accepted by them.
  if (isPast && (rsvp === 'accepted' || attendee?.organizer)) return { type: 'meeting_held', label: '(Held)' };
  if (isPast) return { type: 'meeting_scheduled', label: '(Held)' };
  return { type: 'meeting_scheduled', label: '(Scheduled)' };
}
