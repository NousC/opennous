// The follow-up engine's rules (workspace redesign Phase 3, Oct 2026).
//
// A meeting with a customer ends; a person should send a follow-up, file what was promised, and
// log what was learned. This module decides WHICH meetings deserve a card and HOW a card is put
// together; the worker (apps/worker/src/workers/followUpBuilder.mjs) runs it on a schedule and the
// API (apps/api/src/routes/api/followUps.mjs) lets a person approve or skip it. Everything here is
// pure so it can be tested without a database, except the small loaders at the bottom.
//
// What live data taught us (one customer's graph), and why the rules look the way they do:
//  - Most meetings never reach the call scorer. In a typical fortnight most came from HubSpot, a
//    smaller share from Fellow, and only a handful were scored. So cards are built from whatever was ingested, not from
//    the scorer's event.
//  - A HubSpot meeting is stored ONCE PER ATTENDEE (external_id hubspot_meetings_<id>_<entity>).
//    Grouping by the HubSpot meeting id turns four rows into one meeting.
//  - A HubSpot meeting's body is mostly the calendar invite: often under 100 characters, typically
//    "Microsoft Teams meeting · Join: … · Meeting ID … · Passcode …". The invite is stripped before
//    deciding whether there is anything to follow up on, or every invite becomes a junk card.
//  - Fellow carries the real text (notes + transcript, often tens of thousands of characters), kept as a
//    meeting_notes note on the account with metadata.note_id.
//  - The same meeting can arrive from Fellow AND HubSpot. Same account within 90 minutes is one
//    meeting, never two cards.

/** Meeting events a card can come from. */
export const FOLLOW_UP_MEETING_PROPERTIES = ['interaction.meeting_held', 'interaction.meeting_scheduled'] as const;
/** Below this many characters of REAL text (after the invite is stripped) there is nothing to follow up on. */
export const MIN_MEETING_TEXT = 200;
/** Two records of one account's meeting this close together are the same meeting. */
export const SAME_MEETING_MS = 90 * 60_000;
/** The same host starting within this window is running the same meeting. */
export const SAME_HOST_MS = 20 * 60_000;
/** An unreviewed card this recent takes the next meeting in (the merge rule). */
export const MERGE_WINDOW_MS = 14 * 86_400_000;
/** A meeting is "over" this long after it started (a HubSpot meeting row is written when booked). */
export const ENDED_GRACE_MS = 30 * 60_000;
/** Live cards only for meetings this recent; older history is the launch backfill's business. */
export const LIVE_WINDOW_MS = 48 * 3_600_000;
/** How much meeting text the model reads, per meeting. Fellow transcripts can run to tens of thousands of characters. */
export const MAX_TEXT_PER_MEETING = 24_000;

// ── Shapes ────────────────────────────────────────────────────────────────────

export interface MeetingObservation {
  id: string;
  entity_id: string;
  property: string;
  source: string;
  observed_at: string;
  external_id?: string | null;
  raw?: Record<string, unknown> | null;
}

/** One meeting, however many rows it arrived as. */
export interface GroupedMeeting {
  key: string;
  source: string;
  at: string;
  title: string | null;
  entityIds: string[];
  observationIds: string[];
  /** The longest body/text any of its rows carried (HubSpot); cleaned later. */
  rawText: string;
  /** Fellow's note id, to find its notes + transcript. */
  fellowNoteId: string | null;
  hostEmail: string | null;
  /** When the meeting ends, when the source says (HubSpot end_time). A row is written when the
   *  meeting is BOOKED, so observed_at alone cannot tell a past meeting from a future one. */
  endsAt: string | null;
  /** The source's outcome (HubSpot: COMPLETED, NO_SHOW, CANCELED, RESCHEDULED, SCHEDULED). */
  outcome: string | null;
}

export interface FollowUpMeetingRef {
  key: string; source: string; kind: string; title: string | null; at: string; observation_id?: string | null;
}
export interface FollowUpTask {
  id: string; text: string; due: string | null; due_phrase?: string | null; on: boolean;
  quote?: string | null; stated_by?: 'us' | 'them' | null; owed_by?: string | null;
  existing?: boolean; dropped?: string | null;
}
export interface FollowUpUpdate {
  id: string; label: string; value: string; on: boolean; quote?: string | null; speaker?: string | null;
}
export interface FollowUpContent {
  summary: string;
  tasks: FollowUpTask[];
  updates: FollowUpUpdate[];
  email: { to: string[]; subject: string; body: string } | null;
  attribution: { question: string; options: { id: string; name: string; value: number | null; stage: string | null }[]; chosen: string | null } | null;
  deal_change: { reason: string; deal_id: string | null } | null;
  insights?: { category: string; text: string; quote?: string | null }[];
  /** The model's own call that there is something to follow up on. False drops the card. */
  worth?: boolean;
}
export interface FollowUpCardRow {
  id: string;
  account_entity_id: string;
  status: string;
  meeting_keys: string[];
  meetings: FollowUpMeetingRef[];
  content: FollowUpContent;
  updated_at: string;
}

// ── Which meeting is which ────────────────────────────────────────────────────

/**
 * The stable identity of the meeting a row belongs to. HubSpot writes one row per attendee, so the
 * meeting is the id inside external_id, not the row; Fellow's meeting is its note.
 */
export function meetingIdentity(o: MeetingObservation): { key: string; fellowNoteId: string | null } {
  const raw = (o.raw ?? {}) as Record<string, unknown>;
  const ext = String(o.external_id ?? '');
  if (o.source === 'hubspot') {
    const m = ext.match(/^hubspot_(?:meetings|calls)_(\d+)_/);
    const id = m?.[1] ?? (raw.hubspot_id != null ? String(raw.hubspot_id) : null);
    if (id) return { key: `hubspot:${id}`, fellowNoteId: null };
  }
  if (o.source === 'fellow' && raw.note_id != null) {
    return { key: `fellow:${raw.note_id}`, fellowNoteId: String(raw.note_id) };
  }
  const id = ext || (raw.meeting_id != null ? String(raw.meeting_id) : '') || o.id;
  return { key: `${o.source}:${id}`, fellowNoteId: null };
}

const str = (v: unknown) => (typeof v === 'string' ? v : v == null ? '' : String(v));

/** Collapse rows into meetings (one per identity), keeping every attendee entity. */
export function groupMeetings(rows: MeetingObservation[]): GroupedMeeting[] {
  const out = new Map<string, GroupedMeeting>();
  for (const o of rows) {
    if (!o?.entity_id || !Number.isFinite(Date.parse(o.observed_at))) continue;
    const { key, fellowNoteId } = meetingIdentity(o);
    const raw = (o.raw ?? {}) as Record<string, unknown>;
    const text = str(raw.body) || str(raw.text) || str(raw.notes) || str(raw.summary) || str(raw.description);
    const g = out.get(key);
    if (!g) {
      out.set(key, {
        key, source: o.source, at: o.observed_at, title: str(raw.title) || null,
        entityIds: [o.entity_id], observationIds: [o.id], rawText: text, fellowNoteId,
        hostEmail: str(raw.host_email) || str(raw.owner_email) || null,
        endsAt: Number.isFinite(Date.parse(str(raw.end_time))) ? str(raw.end_time) : null,
        outcome: str(raw.outcome) || null,
      });
      continue;
    }
    if (!g.entityIds.includes(o.entity_id)) g.entityIds.push(o.entity_id);
    g.observationIds.push(o.id);
    if (text.length > g.rawText.length) g.rawText = text;
    if (!g.title && raw.title) g.title = str(raw.title);
    if (Date.parse(o.observed_at) < Date.parse(g.at)) g.at = o.observed_at;
  }
  return [...out.values()].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

// ── What is real text ─────────────────────────────────────────────────────────

// Lines that are the calendar invite, not the meeting. Matched per line after HTML is flattened.
const INVITE_LINE = new RegExp([
  'teams\\.microsoft\\.com', 'zoom\\.us', 'meet\\.google\\.com', 'webex\\.com', 'gotomeet', 'whereby\\.com',
  'microsoft teams meeting', 'join (?:the |on your |with |a )?(?:meeting|microsoft teams|zoom|google meet|computer|call)',
  '^join:', 'meeting id', 'passcode', 'password:', 'dial[- ]?in', 'one tap mobile', 'find a local number',
  'join by phone', 'need help\\?', 'for organizers', 'meeting options', 'conference id', 'pin:',
  'this meeting was (?:scheduled|booked)', 'reschedule', 'cancel(?:led)? (?:this|the) (?:event|meeting)',
  'invitation from google calendar', 'you are receiving this', 'calendly', 'learn more about',
  '^description:?$', '^_{3,}$', '^-{3,}$', '^\\*{3,}$',
].join('|'), 'i');
// A line that is, or starts with, a phone number / conference bridge ("+1 555-010-0199,,000012345#
// United States, Springfield"): a dial-in, never a note.
const PHONE_ONLY = /^\+?\(?\d[\d\s().,#*-]{8,}/;

/**
 * Text that is a record of what HAPPENED rather than the invitation: a note-taker's notes pushed
 * into the CRM ("This meeting has notes on Fellow"), or a recap / summary / transcript. A HubSpot
 * meeting's body is the calendar description the rep wrote before the call ("Hi Marisol, really
 * appreciate you booking a demo…"), which is not something to follow up on.
 */
export function hasMeetingNotes(input: unknown): boolean {
  return /notes on fellow|meeting notes|action items|next steps|recap|summary|transcript|key takeaways/i.test(str(input));
}

/** Meeting text with the HTML, the calendar invite and the dial-ins removed. */
export function cleanMeetingText(input: unknown): string {
  const html = str(input);
  const text = html
    .replace(/<\s*(br|\/p|\/div|\/li|\/h\d)\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&#39;|&rsquo;/gi, "'").replace(/&quot;/gi, '"');
  const lines = text.split(/\r?\n/).map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const kept = lines.filter((l) => !INVITE_LINE.test(l) && !PHONE_ONLY.test(l) && !/^https?:\/\/\S+$/i.test(l));
  return kept.join('\n').replace(/_{3,}/g, ' ').replace(/[ \t]+/g, ' ').trim();
}

/** "Demo", "Check-in", "Discovery", … from the title; "Meeting" when it says nothing. */
export function meetingKind(title: string | null | undefined): string {
  const t = str(title).toLowerCase();
  if (/\bdemo\b/.test(t)) return 'Demo';
  if (/discovery|intro\b|introduction/.test(t)) return 'Discovery';
  if (/check[- ]?in|\bqbr\b|business review|review\b/.test(t)) return 'Check-in';
  if (/kick[- ]?off|onboard|training|install|setup|go[- ]live/.test(t)) return 'Onboarding';
  if (/proposal|pricing|quote|contract|negotiat/.test(t)) return 'Proposal';
  if (/\bcall\b/.test(t)) return 'Call';
  return 'Meeting';
}

// ── Which meetings get a card ─────────────────────────────────────────────────

/**
 * Why a meeting gets no card, or null when it should get one. `text` is the CLEANED text.
 * `since` is the window's start (now − 48h live, or the launch backfill's start).
 */
export function skipReason(
  m: { at: string; endsAt?: string | null; outcome?: string | null; source?: string; hasNotes?: boolean },
  text: string,
  { now, since }: { now: number; since: number },
): string | null {
  const at = Date.parse(m.at);
  if (!Number.isFinite(at)) return 'no time';
  const outcome = String(m.outcome ?? '').toUpperCase();
  if (/NO_?SHOW|CANCEL|RESCHEDUL/.test(outcome)) return 'no-show or cancelled';
  // Still "scheduled" in the CRM and nothing but the invitation in it: no record of the meeting yet.
  if (m.source === 'hubspot' && outcome === 'SCHEDULED' && m.hasNotes === false) return 'only the invitation, no notes';
  // Over by its END when the source knows it (a booked demo next week is not a follow-up today).
  const ends = m.endsAt ? Date.parse(m.endsAt) : NaN;
  if (Number.isFinite(ends) ? ends > now - ENDED_GRACE_MS / 3 : at > now - ENDED_GRACE_MS) return 'not over yet';
  if (at < since) return 'older than the window';
  if (text.length < MIN_MEETING_TEXT) return 'no real notes (invite or empty)';
  return null;
}

/** The open card on this account that a new meeting should merge into, if any. */
export function mergeTarget(cards: FollowUpCardRow[], accountId: string, now: number): FollowUpCardRow | null {
  const open = cards
    .filter((c) => c.account_entity_id === accountId && c.status === 'ready' && now - Date.parse(c.updated_at) <= MERGE_WINDOW_MS)
    .sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at));
  return open[0] ?? null;
}

/** This meeting is one the card already holds, arriving from another source (Fellow vs HubSpot). */
export function isSameMeetingAsCard(card: FollowUpCardRow, meetingAt: string): boolean {
  const t = Date.parse(meetingAt);
  return (card.meetings ?? []).some((m) => Math.abs(Date.parse(m.at) - t) <= SAME_MEETING_MS);
}

/** Within one batch: the meetings of one account that are really one meeting (keep the richest). */
export function dedupeSameMeeting<T extends { at: string; textLength: number }>(meetings: T[]): T[] {
  const sorted = [...meetings].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const kept: T[] = [];
  for (const m of sorted) {
    const twin = kept.findIndex((k) => Math.abs(Date.parse(k.at) - Date.parse(m.at)) <= SAME_MEETING_MS);
    if (twin < 0) kept.push(m);
    else if (m.textLength > kept[twin].textLength) kept[twin] = m;
  }
  return kept;
}

/**
 * The same meeting recorded by two tools, possibly filed on two different accounts (Fellow put
 * Oriane's call on "Ashcombe RV", HubSpot on "Quarry Ridge Campers", the company her address belongs to).
 * Two meetings within 90 minutes that share a CUSTOMER attendee's address are one meeting; the one
 * with the most text wins, and its account is the card's. Our own people are on every meeting, so
 * they never prove anything (callers pass customer addresses only).
 */
export function dedupeAcrossSources<T extends { at: string; textLength: number; attendeeEmails: string[]; hostEmail?: string | null }>(meetings: T[]): T[] {
  const sorted = [...meetings].sort((a, b) => b.textLength - a.textLength);
  const kept: T[] = [];
  const emailsOf = (m: T) => new Set(m.attendeeEmails.map((e) => String(e).toLowerCase()));
  const host = (m: T) => String(m.hostEmail ?? '').toLowerCase();
  for (const m of sorted) {
    const mine = emailsOf(m);
    const gap = (k: T) => Math.abs(Date.parse(k.at) - Date.parse(m.at));
    const twin = kept.some((k) => (gap(k) <= SAME_MEETING_MS && [...emailsOf(k)].some((e) => mine.has(e)))
      // One person cannot host two meetings at once: the same host starting within 20 minutes is
      // the same meeting even when the two tools filed it on different contacts (Ashcombe: Fellow
      // used oriane@ashcombe.example, HubSpot oriane.d@quarryridge.example; both hosted by Theo at 17:00).
      || (host(m) && host(k) === host(m) && gap(k) <= SAME_HOST_MS));
    if (!twin) kept.push(m);
  }
  return kept.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

// ── The model's brief, and reading its answer ─────────────────────────────────

export interface FollowUpPromptInput {
  ourCompany: string | null;
  repName: string | null;
  account: { name: string | null; domain: string | null; isCustomer: boolean };
  deals: { id: string; name: string | null; stage: string | null; value: number | null; close_date: string | null }[];
  meetings: { kind: string; title: string | null; at: string; text: string }[];
  /** Tasks already filed from this meeting by the call scorer: shown, never proposed again. */
  existingTasks: string[];
  /** The open card this meeting merges into: its tasks (with ids) and its email, if any. */
  previous: { tasks: { id: string; text: string }[]; summary: string | null } | null;
}

const FOLLOW_UP_SYSTEM = `You prepare the follow-up a salesperson or account manager does right after a customer meeting.
You are given the notes or transcript of the meeting(s). Use ONLY what the text says. Never invent prices, dates,
products, names or commitments. If something is unclear, leave it out.`;

export function buildFollowUpPrompt(input: FollowUpPromptInput): { system: string; user: string } {
  const deals = input.deals.length
    ? input.deals.map((d) => `- ${d.name ?? 'Deal'} · stage ${d.stage ?? '?'} · ${d.value != null ? `$${d.value}` : 'no amount'} · closes ${d.close_date ?? '?'}`).join('\n')
    : '- (no open deal in the CRM)';
  const meetings = input.meetings.map((m, i) =>
    `### Meeting ${i + 1}: ${m.kind}${m.title ? ` "${m.title}"` : ''} on ${m.at.slice(0, 10)}\n${m.text.slice(0, MAX_TEXT_PER_MEETING)}`).join('\n\n');
  const existing = input.existingTasks.length ? input.existingTasks.map((t) => `- ${t}`).join('\n') : '- (none)';
  const previous = input.previous
    ? `\nAN EARLIER FOLLOW-UP FOR THIS ACCOUNT IS STILL UNREVIEWED. Its tasks (by id):\n${input.previous.tasks.map((t) => `- [${t.id}] ${t.text}`).join('\n') || '- (none)'}\nDecide for EACH earlier task whether it still applies after the newest meeting: keep it, or drop it with a short reason (e.g. "done on the call", "replaced by: send the 3-rooftop quote"). The email and summary must cover ALL the meetings.\n`
    : '';
  const user = `We are ${input.ourCompany ?? 'the seller'}. The person following up is ${input.repName ?? 'the account owner'}.
Account: ${input.account.name ?? 'Unknown'}${input.account.domain ? ` (${input.account.domain})` : ''} — ${input.account.isCustomer ? 'an existing CUSTOMER' : 'a PROSPECT'}.
Open deals in the CRM:
${deals}

Tasks ALREADY on our task list from this meeting (do not repeat them):
${existing}
${previous}
${meetings}

Return ONLY a JSON object, no prose, with exactly these keys:
{
  "worth_following_up": true | false (false when the text has no real customer substance: small talk, audio trouble, a cancelled or no-show meeting, an internal call, or notes too thin to say what happened),
  "summary": "one or two plain sentences: what happened and where it stands",
  "tasks": [ { "text": "a concrete next action for OUR side, starting with a verb", "due_phrase": "Friday | next week | null", "quote": "the words from the text that created it, or null", "stated_by": "us | them", "owed_by": "the customer's name if they owe it, else null" } ],
  "keep_previous": ["ids of earlier tasks that still apply"],
  "drop_previous": [ { "id": "earlier task id", "reason": "why it no longer applies" } ],
  "updates": [ { "label": "Next step | Note | Budget | Timeline | Decision maker | Competitor | Risk", "value": "a fact worth logging in the CRM, one line", "quote": "supporting words or null", "speaker": "who said it or null" } ],
  "email": { "subject": "short subject", "body": "the follow-up email to the customer, plain text, under 150 words, warm and specific: thank them, recap what was agreed, state the next steps with owners and dates when known, signed by ${input.repName ?? 'the rep'}" },
  "stage_change": { "should_move": true | false, "reason": "only when the text clearly shows the deal moved (e.g. they asked for a proposal, signed, or said no); else null" },
  "insights": [ { "category": "pain | goal | objection | budget | timeline | competitor | authority | risk_signal | expansion_signal", "text": "one line", "quote": "supporting words" } ]
}
Rules: 0-6 tasks, 0-5 updates, 0-5 insights. Tasks are only things OUR side must do (a thing the customer owes becomes "Follow up with <name> on …"). No task that repeats one already on our list. If the meeting was internal or had no customer substance, return empty arrays and "email": null.`;
  return { system: FOLLOW_UP_SYSTEM, user };
}

/** First JSON object in a model answer, or null. */
function firstJsonObject(text: string): Record<string, unknown> | null {
  const s = String(text ?? '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(s.slice(start, end + 1)) as Record<string, unknown>; } catch { return null; }
}

const clean = (v: unknown, max = 600) => {
  const s = typeof v === 'string' ? v.trim() : '';
  return s && s.toLowerCase() !== 'null' ? s.slice(0, max) : null;
};

/**
 * Turn the model's answer into card content. Earlier tasks it kept stay (with their ids), earlier
 * tasks it dropped stay too, struck through with the reason, so a person can restore them; earlier
 * tasks it said nothing about are kept, because silence is not a reason to hide work.
 */
export function parseFollowUpAnswer(
  text: string,
  { previous, existingTasks = [], openDeals = [], recipients = [] }: {
    previous?: FollowUpContent | null;
    existingTasks?: string[];
    openDeals?: { id: string; name: string | null; value: number | null; stage: string | null }[];
    recipients?: string[];
  } = {},
): FollowUpContent | null {
  const j = firstJsonObject(text);
  if (!j) return null;

  const prevTasks = (previous?.tasks ?? []).filter((t) => !t.existing);
  const dropIn = Array.isArray(j.drop_previous) ? j.drop_previous as { id?: unknown; reason?: unknown }[] : [];
  const dropped = new Map(dropIn.map((d) => [String(d?.id ?? ''), clean(d?.reason, 200) ?? 'No longer applies']));
  const carried: FollowUpTask[] = prevTasks.map((t) => (dropped.has(t.id)
    ? { ...t, on: false, dropped: dropped.get(t.id) ?? 'No longer applies' }
    : { ...t, dropped: null }));

  const seen = new Set([...existingTasks, ...carried.map((t) => t.text)].map((t) => t.toLowerCase().trim()));
  let n = carried.length;
  const fresh: FollowUpTask[] = [];
  for (const t of (Array.isArray(j.tasks) ? j.tasks : []) as Record<string, unknown>[]) {
    const textOf = clean(t?.text, 300);
    if (!textOf || seen.has(textOf.toLowerCase())) continue;
    seen.add(textOf.toLowerCase());
    n += 1;
    fresh.push({
      id: `t${n}`, text: textOf, due: null, due_phrase: clean(t?.due_phrase, 60), on: true,
      quote: clean(t?.quote, 400),
      stated_by: t?.stated_by === 'us' || t?.stated_by === 'them' ? t.stated_by : null,
      owed_by: clean(t?.owed_by, 80),
    });
    if (fresh.length >= 6) break;
  }
  const existing: FollowUpTask[] = existingTasks.slice(0, 6).map((textOf, i) => ({ id: `e${i + 1}`, text: textOf, due: null, on: false, existing: true }));

  const updates: FollowUpUpdate[] = ((Array.isArray(j.updates) ? j.updates : []) as Record<string, unknown>[])
    .map((u, i) => ({ id: `u${i + 1}`, label: clean(u?.label, 40) ?? 'Note', value: clean(u?.value, 300) ?? '', on: true, quote: clean(u?.quote, 400), speaker: clean(u?.speaker, 80) }))
    .filter((u) => u.value).slice(0, 5);

  const e = (j.email ?? null) as Record<string, unknown> | null;
  const email = e && clean(e.body, 4000)
    ? { to: recipients, subject: clean(e.subject, 160) ?? 'Following up', body: clean(e.body, 4000) as string }
    : null;

  const sc = (j.stage_change ?? null) as Record<string, unknown> | null;
  const deal_change = sc?.should_move === true && clean(sc.reason, 300)
    ? { reason: clean(sc.reason, 300) as string, deal_id: openDeals.length === 1 ? openDeals[0].id : null }
    : null;

  const attribution = openDeals.length >= 2
    ? { question: `This meeting is with an account that has ${openDeals.length} open deals. Which one should it be filed on?`, options: openDeals.map((d) => ({ id: d.id, name: d.name ?? 'Deal', value: d.value ?? null, stage: d.stage ?? null })), chosen: null }
    : null;

  const insights = ((Array.isArray(j.insights) ? j.insights : []) as Record<string, unknown>[])
    .map((x) => ({ category: clean(x?.category, 40) ?? 'note', text: clean(x?.text, 300) ?? '', quote: clean(x?.quote, 400) }))
    .filter((x) => x.text).slice(0, 5);

  return {
    worth: j.worth_following_up !== false,
    summary: clean(j.summary, 600) ?? '',
    tasks: [...existing, ...carried, ...fresh],
    updates, email, attribution, deal_change, insights,
  };
}

/**
 * Who the follow-up goes to: the customer's own addresses (the account's domain) when there are
 * any, else everyone outside our company on the meeting; one address per person, at most four.
 * A dealer-group meeting copied five people across two companies; the email is for the account.
 */
export function pickRecipients(emails: string[], accountDomain: string | null | undefined, max = 4): string[] {
  const norm = [...new Set(emails.map((e) => String(e ?? '').trim().toLowerCase()).filter((e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)))];
  const root = (d: string) => d.replace(/^www\./, '').split('.').slice(0, -1).join('.') || d;
  const domain = String(accountDomain ?? '').toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
  const own = domain ? norm.filter((e) => root(e.split('@')[1]) === root(domain)) : [];
  const pool = own.length ? own : norm;
  const byPerson = new Map<string, string>();
  for (const e of pool) { const local = e.split('@')[0]; if (!byPerson.has(local)) byPerson.set(local, e); }
  return [...byPerson.values()].slice(0, max);
}

/** A card with nothing a person could act on is not worth showing. */
export function isWorthACard(c: FollowUpContent | null): boolean {
  if (!c || c.worth === false) return false;
  const live = c.tasks.filter((t) => !t.existing && !t.dropped).length;
  return live > 0 || c.updates.length > 0 || !!c.email;
}
