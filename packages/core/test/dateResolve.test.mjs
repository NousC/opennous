// Due-date phrase resolution (pure). Every commitment the extractor pulls out
// of a call or an email carries the speaker's own words for timing — "by
// Friday", "in a couple of weeks" — and this is the code that turns those
// words into a date a rep can be held to. Three properties are load-bearing
// and each has cases below:
//
//   1. ANCHORED — the same words resolve differently depending on the day they
//      were said. "by Friday" is not a date until you know when it was spoken.
//   2. ZONE-CORRECT — the anchor is an instant; which calendar day it fell on
//      depends on where the speaker was. A 5pm Pacific call is already the next
//      day in UTC, and reading it that way shifts every answer by one.
//   3. HONEST — a phrase carrying no real timing returns null. A missing due
//      date is fine; an invented one sends a rep chasing a deadline nobody set.
//
// Run: pnpm --filter @nous/core run test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveDuePhrase, isoDateIn, shiftIsoDate, extractDuePhrase } from '../dist/dateResolve.js';

// Anchors used throughout. Times are chosen to sit safely inside their UTC day
// unless a case is specifically about zone handling.
const MON = new Date('2026-08-03T14:00:00Z');   // Monday 3 Aug 2026, 10am EDT
const WED = new Date('2026-07-29T14:00:00Z');   // Wednesday 29 Jul 2026
const FRI = new Date('2026-08-07T14:00:00Z');   // Friday 7 Aug 2026
const DEC = new Date('2026-12-20T14:00:00Z');   // Sunday 20 Dec 2026

const on = (phrase, anchor = MON, tz) => resolveDuePhrase(phrase, anchor, tz);

// ── 1. Anchoring: the same words, different days ────────────────────────────

test('the same phrase resolves against the day it was said, not today', () => {
  assert.equal(on('by Friday', MON), '2026-08-07');   // said Monday → that Friday
  assert.equal(on('by Friday', WED), '2026-07-31');   // said the week before
  // Said ON a Friday, "Friday" is the next one — you don't promise something
  // for the day that is already ending.
  assert.equal(on('by Friday', FRI), '2026-08-14');
});

test('relative durations count from the anchor', () => {
  assert.equal(on('in 4 days'), '2026-08-07');
  assert.equal(on('3 days'), '2026-08-06');
  assert.equal(on('in two weeks'), '2026-08-17');
  assert.equal(on('a couple of weeks'), '2026-08-17');
  assert.equal(on('a few days'), '2026-08-06');
  assert.equal(on('in a month'), '2026-09-03');
  assert.equal(on('fortnight'), '2026-08-17');
});

test('business days skip the weekend', () => {
  // Mon 3 Aug + 5 business days = Mon 10 Aug (not Sat 8 Aug).
  assert.equal(on('within 5 business days'), '2026-08-10');
  assert.equal(on('3 working days'), '2026-08-06');
});

test('today and tomorrow', () => {
  assert.equal(on('today'), '2026-08-03');
  assert.equal(on('EOD'), '2026-08-03');
  assert.equal(on('asap'), '2026-08-03');
  assert.equal(on('tomorrow'), '2026-08-04');
  assert.equal(on('day after tomorrow'), '2026-08-05');
});

// ── 2. Timezone: the anchor is an instant, the answer is a calendar date ────

test('an evening call resolves against the speakers day, not the UTC day', () => {
  // 5pm Pacific on Mon 3 Aug is already Tue 4 Aug in UTC. Reading the anchor
  // in UTC made "tomorrow" land on Wednesday — two days out — for any
  // late-afternoon conversation, which is most sales calls.
  const evening = new Date('2026-08-04T00:00:00Z');       // Mon 5pm PDT
  assert.equal(on('tomorrow', evening, 'America/Los_Angeles'), '2026-08-04');
  assert.equal(on('today', evening, 'America/Los_Angeles'), '2026-08-03');
  // Same instant read as UTC is genuinely a different calendar day.
  assert.equal(on('today', evening, 'UTC'), '2026-08-04');
});

test('weekday maths uses the speakers weekday', () => {
  // Thu 6 Aug 8pm EDT = Fri 7 Aug 00:00 UTC. In UTC it is already Friday, so
  // "by Friday" would skip a whole week.
  const thuNight = new Date('2026-08-07T00:00:00Z');
  assert.equal(on('by Friday', thuNight, 'America/New_York'), '2026-08-07');
  assert.equal(on('by Friday', thuNight, 'UTC'), '2026-08-14');
});

test('an unknown zone falls back to UTC instead of throwing', () => {
  assert.equal(on('tomorrow', MON, 'Not/AZone'), '2026-08-04');
});

test('isoDateIn reads an instant as a calendar date in a zone', () => {
  const evening = new Date('2026-08-04T00:00:00Z');
  assert.equal(isoDateIn(evening, 'America/Los_Angeles'), '2026-08-03');
  assert.equal(isoDateIn(evening, 'UTC'), '2026-08-04');
});

// ── 3. "next <weekday>" means next week ─────────────────────────────────────

test('next Tuesday is Tuesday of next week, not tomorrow', () => {
  // Said on Monday 3 Aug: the next Tuesday to OCCUR is the 4th — tomorrow —
  // but nobody means that by "next Tuesday". It is the 11th.
  assert.equal(on('by next Tuesday'), '2026-08-11');
  assert.equal(on('next Friday'), '2026-08-14');
  // Said on a Friday, "next Monday" is three days out: that Monday already
  // belongs to next week.
  assert.equal(on('next Monday', FRI), '2026-08-10');
});

test('a bare or "this" weekday is the next one to occur', () => {
  assert.equal(on('Tuesday'), '2026-08-04');
  assert.equal(on('this Friday'), '2026-08-07');
  assert.equal(on('coming Thursday'), '2026-08-06');
});

test('weekday abbreviations resolve', () => {
  assert.equal(on('by Fri'), '2026-08-07');
  assert.equal(on('tues'), '2026-08-04');
  assert.equal(on('thurs'), '2026-08-06');
});

// ── 4. Period phrases B2B sales actually uses ───────────────────────────────

test('end of week / month / quarter / year', () => {
  assert.equal(on('end of week'), '2026-08-07');
  assert.equal(on('by the end of the week'), '2026-08-07');
  assert.equal(on('end of month'), '2026-08-31');
  assert.equal(on('EOM'), '2026-08-31');
  assert.equal(on('end of quarter'), '2026-09-30');
  assert.equal(on('EOQ'), '2026-09-30');
  assert.equal(on('end of year'), '2026-12-31');
});

test('next week / month / quarter', () => {
  assert.equal(on('next week'), '2026-08-10');              // Monday of next week
  assert.equal(on('end of next week'), '2026-08-14');
  assert.equal(on('early next week'), '2026-08-10');
  assert.equal(on('mid next week'), '2026-08-12');
  assert.equal(on('next month'), '2026-09-03');
  assert.equal(on('end of next month'), '2026-09-30');
  assert.equal(on('beginning of next month'), '2026-09-01');
  // The budget-cycle reading: "next quarter" is when the new quarter opens.
  assert.equal(on('next quarter'), '2026-10-01');
  assert.equal(on('end of next quarter'), '2026-12-31');
});

test('end of week from a weekend anchor rolls to the coming Friday', () => {
  const sat = new Date('2026-08-08T14:00:00Z');   // Saturday
  assert.equal(on('end of week', sat), '2026-08-14');
});

test('the reversed period forms people actually say', () => {
  assert.equal(on('by month end'), '2026-08-31');
  assert.equal(on('quarter end'), '2026-09-30');
  assert.equal(on('year end'), '2026-12-31');
});

test('a quarter named outright resolves to its close', () => {
  assert.equal(on('Q3'), '2026-09-30');
  assert.equal(on('sometime in Q4'), '2026-12-31');
  assert.equal(on('Q1 2027'), '2027-03-31');
  // Q1 2026 has already closed, so a bare "Q1" means next year's.
  assert.equal(on('Q1'), '2027-03-31');
});

test('a week named by its position in a month', () => {
  assert.equal(on('first week of September'), '2026-09-07');
  assert.equal(on('second week of September'), '2026-09-14');
  assert.equal(on('last week of September'), '2026-09-30');
  assert.equal(on('last week of the month'), '2026-08-31');
});

test('a range resolves to its far end, and never mangles a date', () => {
  assert.equal(on('2-3 weeks'), '2026-08-24');
  assert.equal(on('3 to 5 days'), '2026-08-08');
  // The range rewrite must not touch a numeric date.
  assert.equal(on('8-20-2026'), '2026-08-20');
});

test('early / mid / late a named month', () => {
  assert.equal(on('early September'), '2026-09-05');
  assert.equal(on('mid-September'), '2026-09-15');
  assert.equal(on('late September'), '2026-09-30');
});

// ── 5. Explicit dates, with the year inferred from the anchor ───────────────

test('a spelled-out date takes the anchors year', () => {
  assert.equal(on('August 20'), '2026-08-20');
  assert.equal(on('Aug 20th'), '2026-08-20');
  assert.equal(on('20 August'), '2026-08-20');
  assert.equal(on('the 20th of August'), '2026-08-20');
  assert.equal(on('September 1, 2027'), '2027-09-01');
});

test('a leading preposition no longer defeats an explicit date', () => {
  // These used to reach the fallback parser verbatim ("by August 20") and fail.
  assert.equal(on('by August 20'), '2026-08-20');
  assert.equal(on('before Aug 20'), '2026-08-20');
  assert.equal(on('no later than August 20'), '2026-08-20');
});

test('a date already past rolls to next year only when it is far behind', () => {
  // Said 20 Dec, "January 5" plainly means January next year.
  assert.equal(on('January 5', DEC), '2027-01-05');
  // But "August 1" said on the 3rd is a missed deadline, not next year's.
  assert.equal(on('August 1'), '2026-08-01');
});

test('numeric and ISO dates', () => {
  assert.equal(on('2026-09-01'), '2026-09-01');
  assert.equal(on('8/20/2026'), '2026-08-20');
  assert.equal(on('8/20'), '2026-08-20');
});

test('impossible dates are rejected, not rolled over', () => {
  assert.equal(on('February 31'), null);
  assert.equal(on('2026-02-30'), null);
  assert.equal(on('13/45/2026'), null);
});

test('a bare ordinal is the next occurrence of that day', () => {
  assert.equal(on('the 15th'), '2026-08-15');
  // The 1st has passed this month, so it means next month's.
  assert.equal(on('the 1st'), '2026-09-01');
});

// ── 6. Honesty: no timing means no date ─────────────────────────────────────

test('phrases with no resolvable timing return null', () => {
  for (const p of [
    'after the demo', 'when you get a chance', 'once legal signs off',
    'soon', 'later', 'in due course', 'ASAP-ish maybe', 'sometime',
    'after the board meeting', 'next sprint',
  ]) {
    assert.equal(on(p), null, `expected null for "${p}"`);
  }
});

test('empty, missing and malformed input returns null', () => {
  assert.equal(resolveDuePhrase(null, MON), null);
  assert.equal(resolveDuePhrase(undefined, MON), null);
  assert.equal(resolveDuePhrase('', MON), null);
  assert.equal(resolveDuePhrase('   ', MON), null);
  assert.equal(resolveDuePhrase(42, MON), null);
  assert.equal(resolveDuePhrase('tomorrow', new Date('nonsense')), null);
  assert.equal(resolveDuePhrase('tomorrow', null), null);
});

test('an absurd duration is refused rather than resolved centuries out', () => {
  assert.equal(on('in 99999 days'), null);
  assert.equal(on('in 5000 weeks'), null);
});

// ── 7. Noise tolerance ──────────────────────────────────────────────────────

test('hedges and politeness are peeled off', () => {
  assert.equal(on('by Friday please'), '2026-08-07');
  assert.equal(on('by about next Friday'), '2026-08-14');
  assert.equal(on('~2 weeks'), '2026-08-17');
  assert.equal(on('roughly 3 days'), '2026-08-06');
  assert.equal(on('Friday at the latest'), '2026-08-07');
});

test('a time of day narrows a date but never moves it', () => {
  assert.equal(on('tomorrow morning'), '2026-08-04');
  assert.equal(on('Friday EOD'), '2026-08-07');
  assert.equal(on('Monday first thing'), '2026-08-10');
  assert.equal(on('tomorrow at 5pm'), '2026-08-04');
  // "end of day" on its own still means today — the time-of-day strip must not
  // consume the only thing carrying the date.
  assert.equal(on('end of day'), '2026-08-03');
});

// ── 8. Regressions found by adversarial review ──────────────────────────────

test('prose containing a stray year is not a date', () => {
  // A Date.parse fallback used to skip words it did not understand and invent
  // January 1st from the year alone — for garbage as readily as for prose.
  for (const p of ['renewal 2027', 'budget 2027', 'asdf qwer 2027', 'sprint 2027']) {
    assert.equal(on(p), null, `expected null for "${p}"`);
  }
});

test('an ordinary word that merely starts like a month is not a month', () => {
  for (const p of ['deck 3', 'decision 5', 'marketing 20', 'late marketing', '3 decks']) {
    assert.equal(on(p), null, `expected null for "${p}"`);
  }
});

test('a bare digit pair is a range, not a date', () => {
  for (const p of ['2-3', '5-10', '1-2', '3-5']) {
    assert.equal(on(p), null, `expected null for "${p}"`);
  }
  // A hyphenated date still works when the year makes the intent unambiguous.
  assert.equal(on('8-20-2026'), '2026-08-20');
});

test('the three "next week" phrases agree from a weekend anchor', () => {
  const sat = new Date('2026-08-08T14:00:00Z');
  assert.equal(on('next week', sat), '2026-08-10');
  assert.equal(on('late next week', sat), '2026-08-14');
  assert.equal(on('end of next week', sat), '2026-08-14');
});

test('a week named by position never resolves before its anchor', () => {
  const late = new Date('2026-08-20T14:00:00Z');
  assert.equal(on('first week of the month', late), '2026-09-07');
  assert.equal(on('second week of the month', late), '2026-09-14');
  // Still this month when that week is genuinely still ahead.
  assert.equal(on('last week of the month', late), '2026-08-31');
});

test('a time of day is stripped from the front as well as the back', () => {
  assert.equal(on('EOD Friday'), '2026-08-07');
  assert.equal(on('COB Friday'), '2026-08-07');
  assert.equal(on('first thing Monday'), '2026-08-10');
  assert.equal(on('EOD tomorrow'), '2026-08-04');
});

test('a month named with no day resolves to its close', () => {
  assert.equal(on('in September'), '2026-09-30');
  assert.equal(on('August 2026'), '2026-08-31');
  assert.equal(on('end of 2027'), '2027-12-31');
});

test('every entry point is total — bad input returns null, never throws', () => {
  assert.equal(isoDateIn(new Date('nope')), null);
  assert.equal(isoDateIn(null), null);
  assert.equal(isoDateIn('not a date'), null);
  // A non-string zone reaches here from untyped .mjs; it must fall back to UTC.
  assert.equal(resolveDuePhrase('tomorrow', MON, 5), '2026-08-04');
  // Arithmetic past the four-digit years yields null, not a malformed string.
  assert.equal(on('next year', new Date('9999-12-31T00:00:00Z')), null);
  assert.equal(on('today', new Date(8.64e15)), null);
});

// ── 9. Regressions from the second adversarial pass ─────────────────────────

test('"start of" names a position in a period, not a time of day', () => {
  // Peeling "start of" as noise made these resolve to the period's CLOSE —
  // "start of Q4" came back as 31 December, three months late.
  assert.equal(on('start of Q4'), '2026-10-01');
  assert.equal(on('start of September'), '2026-09-01');
  assert.equal(on('beginning of September'), '2026-09-01');
  assert.equal(on('start of next month'), '2026-09-01');
  assert.equal(on('beginning of next month'), '2026-09-01');
  assert.equal(on('start of next quarter'), '2026-10-01');
});

test('a quarter resolves however it is written', () => {
  assert.equal(on('end of Q3'), '2026-09-30');
  assert.equal(on('by end of Q3'), '2026-09-30');
  assert.equal(on('Q3 end'), '2026-09-30');
  assert.equal(on('end of Q1 2027'), '2027-03-31');
});

test('the "this <period>" family resolves like its "end of" twin', () => {
  assert.equal(on('end of this week'), '2026-08-07');
  assert.equal(on('end of this month'), '2026-08-31');
  assert.equal(on('this month'), '2026-08-31');
  assert.equal(on('this quarter'), '2026-09-30');
  assert.equal(on('this year'), '2026-12-31');
});

test('"the next N days/weeks" resolves like a bare duration', () => {
  assert.equal(on('in the next 2 weeks'), '2026-08-17');
  assert.equal(on('next 3 days'), '2026-08-06');
  assert.equal(on('over the next two weeks'), '2026-08-17');
  assert.equal(on('the next few days'), '2026-08-06');
});

test('weekday abbreviations include the ones with a trailing s', () => {
  assert.equal(on('weds'), '2026-08-05');
  assert.equal(on('next weds'), '2026-08-12');
});

test('a named month is never silently swapped for a different one', () => {
  // Said after that week has passed, the speaker still named September.
  const sep10 = new Date('2026-09-10T14:00:00Z');
  assert.equal(on('first week of September', sep10), '2026-09-07');
  // An UNQUALIFIED month still rolls, because it can only mean the next one.
  assert.equal(on('first week of the month', sep10), '2026-10-07');
});

test('a bare month and that month s last day agree on the year', () => {
  const nov = new Date('2026-11-15T14:00:00Z');
  assert.equal(on('September', nov), on('September 30', nov));
});

test('a date-only string round-trips through isoDateIn unchanged', () => {
  // It is already a civil date; re-reading it as an instant lost a day west of
  // Greenwich — the exact off-by-one the helper exists to prevent.
  assert.equal(isoDateIn('2026-08-04', 'America/Los_Angeles'), '2026-08-04');
  assert.equal(isoDateIn('2026-08-04', 'Asia/Tokyo'), '2026-08-04');
});

test('shiftIsoDate moves whole calendar days, DST included', () => {
  assert.equal(shiftIsoDate('2026-08-04', 7), '2026-08-11');
  // Spans the US fall-back; still exactly seven calendar days.
  assert.equal(shiftIsoDate('2026-10-28', 7), '2026-11-04');
  assert.equal(shiftIsoDate('not a date', 7), null);
});

test('an anchor in a two-digit year does not become a 19xx date', () => {
  // Built with setUTCFullYear because Date.UTC(50, ...) would itself map to
  // 1950 — the very coercion under test.
  const year50 = new Date(Date.UTC(2000, 5, 14));
  year50.setUTCFullYear(50);
  assert.equal(on('tomorrow', year50), null);
});

// ── 10. extractDuePhrase — free-text scan (meeting titles) ──────────────────
//
// Known limitation, deliberately asserted rather than hidden: this scan cannot
// tell a DEADLINE from a noun phrase that merely contains a time word, so
// "Monday standup notes" reads as a Monday deadline. The email path does not
// have this problem (its LLM returns due_phrase as its own field, null when no
// timing was stated). Fixing the meeting path is tracked separately; these
// assertions pin the current behaviour so the fix has something to change.

test('extractDuePhrase finds a stated deadline in a title', () => {
  assert.equal(extractDuePhrase('Send the deck by Friday'), 'by Friday');
  assert.equal(extractDuePhrase('Share the MVP within ~2 weeks'), 'within ~2 weeks');
  assert.equal(extractDuePhrase('Get the pricing over by end of week'), 'by end of week');
  assert.equal(extractDuePhrase('Send the revised SOW tomorrow'), 'tomorrow');
  assert.equal(extractDuePhrase('Circle back in 3 days'), 'in 3 days');
  assert.equal(extractDuePhrase('Get the redlines back by the 15th'), 'by the 15th');
  assert.equal(extractDuePhrase('Send the security pack'), null);
});

test('extractDuePhrase ignores a time word that names something', () => {
  // None of these states a deadline. A weekday or duration standing alone is
  // describing a noun, not timing the work — only the preposition tells them
  // apart, so it is required.
  for (const t of [
    'Share the Monday standup notes',
    'Send the 30 days pilot proposal',
    'Review the two weeks trial feedback',
    'Update the Friday forecast dashboard',
    'Block out a day for onboarding',
    'Give the team a week to review',
    'Send the Black Friday deck to Juno',
    'Prepare the week one onboarding plan',
  ]) {
    assert.equal(extractDuePhrase(t), null, `expected null for "${t}"`);
  }
});

test('what extractDuePhrase does find still resolves to a date', () => {
  // The scan is only useful if the resolver understands its output.
  for (const t of ['Send the deck by Friday', 'Share the MVP within ~2 weeks',
                   'Circle back in 3 days', 'Get the redlines back by the 15th']) {
    const phrase = extractDuePhrase(t);
    assert.ok(phrase, `no phrase from "${t}"`);
    assert.ok(resolveDuePhrase(phrase, MON), `"${phrase}" from "${t}" did not resolve`);
  }
});

test('a follow-up promised for after the call is due the day of the call', () => {
  for (const p of ['after this call', 'after the call', 'right after the meeting', 'just after our call', 'later today']) {
    assert.equal(resolveDuePhrase(p, MON), resolveDuePhrase('today', MON), `"${p}"`);
  }
});

test('French phrases resolve like the English they mean', () => {
  // Calls held in French keep the phrase as said.
  const pairs = [
    ['tout de suite', 'asap'], ['Juste après notre appel', 'today'], ["aujourd'hui", 'today'],
    ['demain', 'tomorrow'], ['après-demain', 'day after tomorrow'], ['vendredi', 'friday'],
    ["d'ici vendredi", 'by friday'], ['la semaine prochaine', 'next week'], ['fin de la semaine', 'end of week'],
    ['fin du mois', 'end of month'], ['le mois prochain', 'next month'], ['dans 2 jours', 'in 2 days'],
    ['dans 3 semaines', 'in 3 weeks'], ['le 30 septembre', 'september 30'], ['1er octobre', 'october 1'],
  ];
  for (const [fr, en] of pairs) {
    const want = resolveDuePhrase(en, MON);
    assert.ok(want, `English "${en}" should resolve`);
    assert.equal(resolveDuePhrase(fr, MON), want, `"${fr}" should read as "${en}"`);
  }
});

test('a vague French or English phrase stays undated', () => {
  for (const p of ['eventually', 'probablement un à deux mois', 'plus tard', 'when possible']) {
    assert.equal(resolveDuePhrase(p, MON), null, `"${p}"`);
  }
});

test('a date wrapped in a weekday, a clock or a time zone still resolves to that date', () => {
  // Measured on Harborline's undated tasks (GET-501): each is a date the resolver knew.
  const cases = [
    ['Wednesday, September 16 at 11:30 AM', 'september 16'],
    ['2026/09/16 10:00-10:30 (GMT-05:00) America/Detroit', '2026/09/16'],
    ['by Friday, September 18', 'september 18'],
    ['Monday, July 6th', 'july 6th'],
    ['July 9 at 10 a.m.', 'july 9'],
    ["tomorrow at 2pm Odile's time / 11am Tobin's time", 'tomorrow'],
    ['by 12 EST today', 'today'],
    ['two weeks from now', 'in two weeks'],
    ['before Christmas', 'december 25'],
  ];
  for (const [wrapped, plain] of cases) {
    const want = resolveDuePhrase(plain, MON);
    assert.ok(want, `"${plain}" should resolve`);
    assert.equal(resolveDuePhrase(wrapped, MON), want, `"${wrapped}" should read as "${plain}"`);
  }
  // …and a bare number is not a clock: "in 2 weeks" keeps it.
  assert.equal(resolveDuePhrase('in 2 weeks', MON), resolveDuePhrase('in two weeks', MON));
});

test('"now" in its many forms is due the day it was said', () => {
  for (const p of ['right now', 'shortly', 'in a few minutes', 'in the next couple minutes', 'in a second', 'as quickly as possible', 'right after this']) {
    assert.equal(resolveDuePhrase(p, MON), resolveDuePhrase('today', MON), `"${p}"`);
  }
});
