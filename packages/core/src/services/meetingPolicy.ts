// How much of the pipeline a meeting is worth, decided by its age.
//
// Backfilling a year of calls, we were paying for four things per meeting: the claims, the health
// read, the call page, and the coaching grade. Three of them are worthless on an old call, and one
// of them is worthless in a measurable rather than an arguable way.
//
// THE CLAIMS ARE THE POINT. "They push every application through a lender portal and re-key the lead by hand",
// "spend over $50k needs VP sign-off", "Corwin Haskett left the dealership" — none of that goes stale, and
// it is the entire reason an account page is worth opening. Skipping extraction to save money
// would save the money and delete the product.
//
// THE HEALTH READ EXPIRES ON ARRIVAL. `HEALTH_WINDOW_DAYS` is { risk: 120, expansion: 90,
// adoption: 180 }, and `deriveAccountHealth` drops anything older than its window. A health read
// on a call from last November writes rows that the very next read filters out. That is not a
// judgement about value; it is arithmetic, and it is why the cut has a principled place rather
// than a number someone picked.
//
// THE CALL PAGE IS DEAD WEIGHT. Nobody browses to a ten-month-old call summary, and at the scale
// of a year's backfill they bury the reports they sit beside (GET-349).
//
// THE COACHING GRADE CANNOT BE ACTED ON. A rep cannot re-run March (GET-350).
//
// The rule is about AGE, not about a date someone has to maintain, so it keeps applying itself
// correctly forever: today's meetings get everything, and the same meeting becomes archival on its
// own schedule.

import { HEALTH_WINDOW_DAYS } from './accountHealthState.js';

const DAY = 86_400_000;

/**
 * Past this, a meeting is history: extract what it permanently teaches us and nothing else.
 *
 * Derived from the widest health window rather than chosen, so the two cannot drift. Using the
 * WIDEST is the deliberately conservative choice — at 180 days an adoption signal is still inside
 * its window even though risk and expansion have long expired, and paying for a few reads that
 * land is better than dropping ones that would have counted.
 */
export const ARCHIVAL_AFTER_DAYS = Math.max(...Object.values(HEALTH_WINDOW_DAYS));

/**
 * Past this, a backfilled meeting writes no SUMMARY — no call page, no meeting notes.
 *
 * Product decision, 2026-09-18: "since this is a backfill for the last 12 months it doesn't get anything,
 * ONLY last 30 days get that summary report."
 *
 * A separate, tighter cut than ARCHIVAL_AFTER_DAYS on purpose, because the two answer different
 * questions. A summary is read by a person, and a person does not read last March. A health read
 * feeds the account's standing, and a risk raised ninety days ago is still inside its own 120-day
 * window — still live, still worth acting on. One number could not honestly serve both.
 */
export const SUMMARY_AFTER_DAYS = 30;

/**
 * Past this, a conversation files no TASKS (GET-514).
 *
 * Product decision, 2026-09-28: the backfill reads three months for facts and insights, "plus 30 days of
 * tasks". A promise made on a call in July is either done or dead by now; filing it lands a
 * backlog of stale rows on the Tasks page on day one. Facts and insights still come out of it.
 */
export const TASKS_AFTER_DAYS = 30;

/**
 * How far back a backfill READS conversations (GET-514): three months. The CRM import reaches
 * twelve months of records, but those are imported, not read — no model call, no credit.
 */
export const BACKFILL_READ_DAYS = 90;

export type MeetingTreatment = 'live' | 'archival';

/**
 * `live` — everything: claims, health read, tasks, call page.
 * `archival` — claims only.
 *
 * A meeting with no date is treated as live. We would rather pay for a call whose date we could not
 * read than silently downgrade it: the failure of guessing "old" is invisible, and the failure of
 * guessing "new" is a small bill.
 */
export function meetingTreatment(
  occurredAt: string | Date | null | undefined,
  now: number = Date.now(),
): MeetingTreatment {
  if (!occurredAt) return 'live';
  const at = occurredAt instanceof Date ? occurredAt.getTime() : Date.parse(String(occurredAt));
  if (!Number.isFinite(at)) return 'live';
  // A meeting dated in the future is a calendar artefact, not history.
  if (at > now) return 'live';
  return (now - at) / DAY > ARCHIVAL_AFTER_DAYS ? 'archival' : 'live';
}

/** Does this meeting get the health read and the commitments it files? */
export function writesCallArtifacts(
  occurredAt: string | Date | null | undefined,
  now: number = Date.now(),
): boolean {
  return meetingTreatment(occurredAt, now) === 'live';
}

/**
 * Does this meeting get a SUMMARY a person would read — the call page and the meeting notes?
 *
 * Only the last thirty days. Everything older is history: nobody browses to it, and at the scale of
 * a year's backfill the summaries bury the reports they sit beside (GET-349).
 *
 * Unreadable and missing dates fall on the writing side, same as everywhere else here: guessing
 * "old" loses something silently, guessing "new" costs a row someone can see.
 */
export function writesCallSummary(
  occurredAt: string | Date | null | undefined,
  now: number = Date.now(),
): boolean {
  if (!occurredAt) return true;
  const at = occurredAt instanceof Date ? occurredAt.getTime() : Date.parse(String(occurredAt));
  if (!Number.isFinite(at)) return true;
  if (at > now) return true;
  return (now - at) / DAY <= SUMMARY_AFTER_DAYS;
}

/**
 * Does this conversation file TASKS? Only the last thirty days (TASKS_AFTER_DAYS). Unreadable and
 * missing dates fall on the writing side, as everywhere else here.
 */
export function writesTasks(
  occurredAt: string | Date | null | undefined,
  now: number = Date.now(),
): boolean {
  if (!occurredAt) return true;
  const at = occurredAt instanceof Date ? occurredAt.getTime() : Date.parse(String(occurredAt));
  if (!Number.isFinite(at)) return true;
  if (at > now) return true;
  return (now - at) / DAY <= TASKS_AFTER_DAYS;
}
