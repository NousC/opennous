// Resolve a relative due-date phrase ("in 4 days", "by Friday", "end of month")
// into an absolute date, anchored to when the phrase was actually said — NOT
// to whenever extraction happens to run. A commitment made in a Monday call
// ("we'll follow up in 4 days") must resolve against that Monday, or the due
// date silently drifts every time the pipeline reprocesses the observation.
//
// Deterministic on purpose, not LLM-computed: date arithmetic is exactly the
// kind of thing that should never be "probably right" (see CLAUDE.md's
// "LLM + deterministic scoring, never LLM alone", already the pattern for ICP
// and intent scoring). The LLM's job, in the callers, is spotting THAT a
// message contains a commitment and what the timing phrase is; this file's
// job is turning that phrase into a real date, in code that can be tested.
//
// resolveDuePhrase() returns null rather than guessing when a phrase doesn't
// confidently resolve — a missing due date is honest; a wrong one silently
// misleads a rep into thinking nothing is due. extractDuePhrase() is the
// companion for free text (meeting-note titles) that never had a separate
// due_phrase field to begin with — it finds the timing phrase inside the text.
//
// ── Civil dates, not instants ───────────────────────────────────────────────
//
// A due date is a CALENDAR DATE, not a moment in time: "by Friday" means the
// whole of Friday, wherever the person saying it happens to be. So all the
// arithmetic below runs on a civil (year, month, day) triple, and the ONLY
// place a timezone enters is the single conversion at the top — turning the
// anchor instant into the calendar date it fell on for the person who said it.
//
// That conversion is not cosmetic. A call at 5pm Pacific is already TOMORROW
// in UTC, so reading the anchor's UTC calendar date made "tomorrow" resolve
// two days out, and shifted every weekday computation by one, for any
// late-afternoon conversation — which is most sales calls. Pass the speaker's
// zone and the answer is right; omit it and you get UTC, which is right only
// for people who actually work in UTC.
//
// Civil dates are carried internally as a Date pinned to 12:00 UTC. Noon is
// deliberate: it leaves twelve hours of slack either side, so no arithmetic —
// DST included — can slip a value into a neighbouring day. Only the YYYY-MM-DD
// prefix is ever read back out.

const DAY_MS = 86_400_000;
const CIVIL_HOUR = 12;

/** Ceiling on any relative duration, so a garbled count can't yield a date
 *  centuries out (or spin addBusinessDays forever). Roughly ten years. */
const MAX_DURATION_DAYS = 3650;

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
// Accepts the abbreviations people actually type: mon, tues, weds, thurs, sat.
const WEEKDAY_RE = '(?:sun|mon|tues?|wed(?:s|nes)?|thur?s?|fri|sat(?:ur)?)(?:day)?';
// Spelled out in full. A trailing wildcard here ("jan[a-z]*") reads any word
// that merely STARTS like a month as one, which turned "deck 3" into December
// 3rd and "marketing 20" into March 20th.
const MONTH_RE =
  '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|' +
  'aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';

const NUMBER_WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
  seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  couple: 2, few: 3, several: 3,
};

/** Weekday name or abbreviation → 0-6, or -1 when it isn't one. */
function weekdayIndex(raw: string): number {
  const s = raw.toLowerCase().replace(/\.$/, '');
  const exact = WEEKDAYS.indexOf(s);
  if (exact !== -1) return exact;
  const p3 = s.slice(0, 3);
  return WEEKDAYS.findIndex(w => w.slice(0, 3) === p3);
}

/** Month name or abbreviation → 0-11, or -1 when it isn't one. */
function monthIndex(raw: string): number {
  return MONTHS.indexOf(raw.toLowerCase().slice(0, 3));
}

// ── Civil-date primitives ───────────────────────────────────────────────────

/** A calendar date, carried as 12:00 UTC on that date. */
type Civil = Date;

function civil(year: number, month0: number, day: number): Civil {
  const d = new Date(Date.UTC(year, month0, day, CIVIL_HOUR, 0, 0, 0));
  // Date.UTC maps years 0-99 onto 1900-1999, which would silently turn an
  // anchor in year 50 into a 1950 due date. Put the year back as written.
  if (year >= 0 && year < 100 && !Number.isNaN(d.getTime())) d.setUTCFullYear(year);
  return d;
}
function addDays(c: Civil, n: number): Civil {
  return new Date(c.getTime() + n * DAY_MS);
}
function dayOfWeek(c: Civil): number {
  return c.getUTCDay();
}
function lastDayOfMonth(year: number, month0: number): number {
  return new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();
}
/** Add months, clamping the day to the target month (Jan 31 + 1mo = Feb 28). */
function addMonths(c: Civil, n: number): Civil {
  const m = c.getUTCMonth() + n;
  const y = c.getUTCFullYear() + Math.floor(m / 12);
  const m0 = ((m % 12) + 12) % 12;
  return civil(y, m0, Math.min(c.getUTCDate(), lastDayOfMonth(y, m0)));
}
function startOfMonth(c: Civil, monthsAhead = 0): Civil {
  const t = addMonths(civil(c.getUTCFullYear(), c.getUTCMonth(), 1), monthsAhead);
  return civil(t.getUTCFullYear(), t.getUTCMonth(), 1);
}
function endOfMonth(c: Civil, monthsAhead = 0): Civil {
  const t = startOfMonth(c, monthsAhead);
  return civil(t.getUTCFullYear(), t.getUTCMonth(), lastDayOfMonth(t.getUTCFullYear(), t.getUTCMonth()));
}
function quarterStart(c: Civil, quartersAhead = 0): Civil {
  const q = Math.floor(c.getUTCMonth() / 3) + quartersAhead;
  const y = c.getUTCFullYear() + Math.floor(q / 4);
  const q0 = ((q % 4) + 4) % 4;
  return civil(y, q0 * 3, 1);
}
function quarterEnd(c: Civil, quartersAhead = 0): Civil {
  return endOfMonth(quarterStart(c, quartersAhead), 2);
}
/** Monday of the ISO week containing `c`. */
function mondayOfWeek(c: Civil): Civil {
  const d = dayOfWeek(c);
  return addDays(c, -(d === 0 ? 6 : d - 1));
}
/** The next occurrence of `target`, STRICTLY AFTER `from` (1..7 days out). */
function nextWeekdayAfter(from: Civil, target: number): Civil {
  const delta = ((target - dayOfWeek(from) + 7) % 7) || 7;
  return addDays(from, delta);
}
/**
 * That weekday in the ISO week AFTER the anchor's — what "next Tuesday" means
 * to almost everyone. Said on a Monday, "next Friday" is eleven days out, not
 * four; said on a Friday, "next Monday" is three days out, because that Monday
 * already belongs to next week. Anchoring on the WEEK rather than on "the next
 * one to occur" is the only reading that gets both of those right.
 */
function weekdayNextWeek(anchor: Civil, target: number): Civil {
  const monday = addDays(mondayOfWeek(anchor), 7);
  return addDays(monday, target === 0 ? 6 : target - 1);
}
function addBusinessDays(c: Civil, n: number): Civil {
  let d = c;
  for (let left = Math.min(n, MAX_DURATION_DAYS); left > 0; ) {
    d = addDays(d, 1);
    const w = dayOfWeek(d);
    if (w !== 0 && w !== 6) left--;
  }
  return d;
}
/** Friday of the anchor's week — or the coming Friday if this week's has gone. */
function endOfThisWeek(base: Civil): Civil {
  const friday = addDays(mondayOfWeek(base), 4);
  return friday.getTime() < base.getTime() ? addDays(friday, 7) : friday;
}
/** Where "early" / "mid" / "late" land inside the month `c` belongs to. */
function positionInMonth(word: string, c: Civil): Civil {
  const y = c.getUTCFullYear(), m = c.getUTCMonth();
  if (/^(?:early|start|beginning|first)/.test(word)) return civil(y, m, 5);
  if (/^mid/.test(word)) return civil(y, m, 15);
  return civil(y, m, lastDayOfMonth(y, m));
}

// ── Timezone: the one place it matters ──────────────────────────────────────

/**
 * The zone used to read an anchor when a caller doesn't name one, from
 * NOUS_DEFAULT_TIMEZONE. Falls back to UTC, which is correct only for people
 * who genuinely work in UTC — which is why any caller with a better answer
 * (the workspace's own zone) should pass it explicitly.
 */
export function defaultTimeZone(): string {
  if (typeof process !== 'undefined' && process.env && process.env.NOUS_DEFAULT_TIMEZONE) {
    // Trimmed: a stray space or trailing newline in an env file makes Intl
    // reject the zone, and the fallback to UTC would be silent.
    const tz = process.env.NOUS_DEFAULT_TIMEZONE.trim();
    if (tz) return tz;
  }
  return 'UTC';
}

/** The calendar date `instant` fell on, read in `timeZone`. */
function civilDateOf(instant: Date, timeZone?: string): Civil {
  // Both entry points are called from untyped .mjs, so a non-string zone is
  // reachable and must degrade to UTC rather than throw mid-extraction.
  const named = typeof timeZone === 'string' && timeZone ? timeZone : defaultTimeZone();
  const tz = typeof named === 'string' ? named : 'UTC';
  if (tz && tz.toUpperCase() !== 'UTC') {
    try {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      }).formatToParts(instant);
      const num = (type: string) => {
        const p = parts.find(x => x.type === type);
        return p ? parseInt(p.value, 10) : NaN;
      };
      const y = num('year'), m = num('month'), d = num('day');
      if (!Number.isNaN(y) && !Number.isNaN(m) && !Number.isNaN(d)) return civil(y, m - 1, d);
    } catch {
      // An unknown zone identifier must never take down an extraction run.
    }
  }
  return civil(instant.getUTCFullYear(), instant.getUTCMonth(), instant.getUTCDate());
}

/**
 * The calendar date an instant falls on in a given zone, as YYYY-MM-DD.
 *
 * Exported so READ paths can compare due dates the same way they were written:
 * as civil dates. Putting a date-only string through `new Date()` reads it as
 * UTC midnight, which is the previous day for everyone west of Greenwich — the
 * same off-by-one as the write side, arriving from the other direction.
 */
export function isoDateIn(instant: Date | number | string = new Date(), timeZone?: string): string | null {
  // `new Date(null)` is the epoch, not an error — so null has to be rejected
  // before coercion, or a missing timestamp silently becomes 1 Jan 1970.
  if (instant === null) return null;
  // A YYYY-MM-DD string is ALREADY a civil date. Pushing it through Date would
  // read it as UTC midnight and hand back the previous day for anyone west of
  // Greenwich — precisely the off-by-one this helper exists to prevent.
  if (typeof instant === 'string') {
    const iso = instant.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  }
  const at = instant instanceof Date ? instant : new Date(instant as never);
  if (Number.isNaN(at.getTime())) return null;
  return isoOf(civilDateOf(at, timeZone));
}

/**
 * Shift a YYYY-MM-DD date by whole days, staying in civil space.
 *
 * A horizon must not be built by adding milliseconds to an instant and then
 * converting: across a DST boundary "seven days" of milliseconds is not seven
 * calendar days, so a week-ahead window quietly became six days and dropped
 * commitments that were genuinely due inside it.
 */
export function shiftIsoDate(isoDate: string, days: number): string | null {
  const m = typeof isoDate === 'string' ? isoDate.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/) : null;
  if (!m) return null;
  return isoOf(addDays(civil(+m[1], +m[2] - 1, +m[3]), days));
}

/**
 * A civil date as YYYY-MM-DD, or null if it fell outside the four-digit years.
 * Date#toISOString switches to an expanded ±YYYYYY form beyond 0000-9999, and
 * slicing that to ten characters yields a string that is not a date at all —
 * which would then be written straight into a claim and string-compared.
 */
function isoOf(c: Civil): string | null {
  const y = c.getUTCFullYear();
  if (Number.isNaN(c.getTime()) || y < 1000 || y > 9999) return null;
  return c.toISOString().slice(0, 10);
}

// ── Phrase normalisation ────────────────────────────────────────────────────

// Peeled off the front: prepositions and hedges carrying no date information.
const LEAD_NOISE = new RegExp(
  '^(?:' +
  'by|before|within|in|after|on|over|due(?:\\s+by)?|no\\s+later\\s+than|not\\s+later\\s+than|' +
  'until|till|til|sometime|some\\s+time|about|around|approximately|approx|roughly|' +
  'probably|maybe|hopefully|ideally|targeting|aiming\\s+for|the' +
  ')\\s+',
);
// Peeled off the back: politeness and hedging.
const TRAIL_NOISE = /\s+(?:at\s+the\s+latest|at\s+the\s+earliest|latest|or\s+so|ish|please|if\s+possible|at\s+best)$/;
// Peeled off the back: a time of day, which narrows a date but never moves it.
// "tomorrow morning" is still tomorrow; "friday EOD" is still Friday.
const TRAIL_TIME = /\s+(?:at\s+|in\s+the\s+|by\s+)?(?:morning|afternoon|evening|night|eod|cob|end\s+of\s+(?:the\s+)?day|close\s+of\s+business|first\s+thing|noon|midday|midnight|am|pm|\d{1,2}(?::\d{2})?\s*(?:am|pm))$/;
// The same words in front — "EOD Friday", "first thing Monday" — which is the
// commoner word order in sales prose and used to be dropped entirely. Requires
// something to follow, so a bare "end of day" still means today.
// Careful: "start of" does NOT belong here. It names a position in a period,
// not a time of day, and peeling it turned "start of Q4" into bare "Q4" — which
// resolves to the quarter's CLOSE, three months late.
const LEAD_TIME = /^(?:eod|cob|end\s+of\s+(?:the\s+)?day|close\s+of\s+business|first\s+thing|morning\s+of)\s+/;

// A French phrase, read as the English one it means. Calls with French-speaking customers are held in French
// and the extractor kept the phrase as said, so "juste après notre appel" and "le 30 septembre"
// reached a resolver that only reads English and came back with no date. Phrases first, so the
// words they are made of are not translated out from under them.
const FRENCH: [RegExp, string][] = [
  [/\b(?:juste |tout de suite |directement )?apr[eè]s (?:notre |l['’ ]|le |la |cet |cette )?(?:appel|r[ée]union|rencontre|meeting)\b/g, 'after the call'],
  [/\baujourd['’ ]?hui\b/g, 'today'],
  [/\bce soir\b/g, 'tonight'],
  [/\btout de suite\b|\bimm[ée]diatement\b|\bd[èe]s que possible\b|\bau plus vite\b/g, 'asap'],
  [/\bapr[eè]s[- ]demain\b/g, 'day after tomorrow'],
  [/\bdemain\b/g, 'tomorrow'],
  [/\b(?:la )?semaine prochaine\b/g, 'next week'],
  [/\b(?:le )?mois prochain\b/g, 'next month'],
  [/\b(?:[àa] la )?fin de (?:la )?semaine\b/g, 'end of week'],
  [/\b(?:[àa] la )?fin du mois\b/g, 'end of month'],
  [/\bcette semaine\b/g, 'this week'],
  [/\bd['’ ]?ici\b/g, 'by'],
  [/\bavant\b/g, 'before'],
  [/\bdans\b/g, 'in'],
  [/\b(\d+) jours?\b/g, '$1 days'],
  [/\b(\d+) semaines\b/g, '$1 weeks'],
  [/\b1 semaine\b/g, '1 week'],
  [/\b(\d+) mois\b/g, '$1 months'],
  [/\bjanvier\b/g, 'january'], [/\bf[ée]vrier\b/g, 'february'], [/\bmars\b/g, 'march'],
  [/\bavril\b/g, 'april'], [/\bmai\b/g, 'may'], [/\bjuin\b/g, 'june'], [/\bjuillet\b/g, 'july'],
  [/\bao[uû]t\b/g, 'august'], [/\bseptembre\b/g, 'september'], [/\boctobre\b/g, 'october'],
  [/\bnovembre\b/g, 'november'], [/\bd[ée]cembre\b/g, 'december'],
  [/\blundi\b/g, 'monday'], [/\bmardi\b/g, 'tuesday'], [/\bmercredi\b/g, 'wednesday'],
  [/\bjeudi\b/g, 'thursday'], [/\bvendredi\b/g, 'friday'], [/\bsamedi\b/g, 'saturday'], [/\bdimanche\b/g, 'sunday'],
  [/\b(?:le|la|les|du|de) (?=\d|monday|tuesday|wednesday|thursday|friday|saturday|sunday)/g, ''],
  [/\b1er\b/g, '1'],
];

function fromFrench(p: string): string {
  for (const [re, en] of FRENCH) p = p.replace(re, en);
  return p;
}

// The wrapping a real date arrives in, peeled so the date underneath resolves (GET-501). Measured
// on one customer's undated tasks: "Wednesday, September 16 at 11:30 AM", "2026/09/16 10:00-10:30
// (GMT-05:00) America/Chicago", "by Friday, September 18", "Monday, July 6th" — every one a date
// the resolver knew, behind a weekday, a clock or a time zone it did not.
const ZONE = '(?:gmt|utc|est|edt|cst|cdt|pst|pdt|mst|mdt|ast|adt|et|ct|pt|mt)';
const CLOCK = '\\d{1,2}(?::\\d{2})?\\s*(?:a\\.?m\\.?|p\\.?m\\.?)?';
// A time of day and everything after it: "at 11:30 am", "10:00-10:30 (gmt-05:00) america/chicago",
// "at 2pm theo's time / 11am avery's time". Only a real clock (a colon, am/pm, "at") is cut, so
// "in 2 weeks" keeps its number.
const TAIL_CLOCK = /\s+(?:at\s+\d{1,2}(?::\d{2})?(?:\s*[ap]\.?m\.?)?|\d{1,2}:\d{2}|\d{1,2}\s*[ap]\.?m\.?(?![a-z]))(?:[^a-z0-9].*|\s.*)?$/;
const HEAD_CLOCK = new RegExp(`^(by\\s+)?${CLOCK}\\s*${ZONE}?\\s+(?=today|tonight|tomorrow)`);
function unwrap(p: string): string {
  return p
    .replace(TAIL_CLOCK, '')
    .replace(HEAD_CLOCK, '$1')
    // A weekday in front of a calendar date: "wednesday, september 16", "tuesday, the 23rd".
    .replace(/\b(?:mon|tues?|wed(?:nes)?|thu(?:rs)?|fri|sat(?:ur)?|sun)(?:day)?,?\s+(?=(?:the\s+)?\d|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec))/g, '')
    .replace(/^(.+?)\s+from now$/, 'in $1')
    .replace(/\btowards?\s+(?:the\s+)?/, '')
    .replace(/\bchristmas(?: day)?\b/, 'december 25')
    .replace(/\bnew year'?s?(?: day)?\b/, 'january 1')
    .trim();
}

function normalize(raw: string): string {
  let p = unwrap(fromFrench(raw.toLowerCase()))
    .replace(/[~"'`*_]/g, ' ')
    .replace(/[.,;!?]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  // Peel repeatedly — real phrases stack hedges ("by about next Friday please").
  for (let i = 0; i < 5; i++) {
    const before = p;
    // Collapse "end of the week" first, so the leading-noise rule can't eat
    // "the" out of the middle of a phrase it belongs to.
    p = p.replace(/\bend\s+of\s+the\s+/g, 'end of ').trim();
    const lead = p.replace(LEAD_NOISE, '').trim();
    if (lead) p = lead;
    const trail = p.replace(TRAIL_NOISE, '').trim();
    if (trail) p = trail;
    // Strip a time of day only when something remains to carry the date, so a
    // bare "end of day" still resolves (to today) instead of becoming empty.
    const timed = p.replace(TRAIL_TIME, '').trim();
    if (timed) p = timed;
    const led = p.replace(LEAD_TIME, '').trim();
    if (led) p = led;
    if (p === before) break;
  }
  // A stated range is a window, and a window's deadline is its far end:
  // "2-3 weeks" is a promise to be done by the third. The unit lookahead keeps
  // this away from numeric dates — "8-20-2026" must not become "20-2026".
  return p.replace(/\b\d+\s*(?:-|–|to)\s*(\d+)(?=\s+(?:day|week|month|business|working)s?\b)/, '$1');
}

/** A count written any way people write one: "4", "four", "a couple", "a few of". */
function parseCount(raw: string): number | null {
  const s = raw.trim().toLowerCase();
  if (/^\d+$/.test(s)) {
    const n = parseInt(s, 10);
    return n >= 0 && n <= MAX_DURATION_DAYS ? n : null;
  }
  // "the next 2 weeks", "over the next few days" — by the time a phrase reaches
  // a duration rule the standalone "next week"/"next month" forms have already
  // matched, so a leading qualifier here is just noise in front of a count.
  const words = s.split(/\s+/).filter(w => w && !['of', 'the', 'next', 'coming', 'following', 'about', 'another'].includes(w));
  if (words.length === 1) return /^\d+$/.test(words[0]) ? parseInt(words[0], 10) : NUMBER_WORDS[words[0]] ?? null;
  const meaningful = words.filter(w => w !== 'a' && w !== 'an');
  if (meaningful.length === 1) {
    return /^\d+$/.test(meaningful[0]) ? parseInt(meaningful[0], 10) : NUMBER_WORDS[meaningful[0]] ?? null;
  }
  return null;
}

/** Reject impossible dates (Feb 31) rather than letting Date roll them over. */
function validCivil(year: number, month0: number, day: number): Civil | null {
  if (month0 < 0 || month0 > 11 || day < 1 || year < 1970 || year > 2999) return null;
  if (day > lastDayOfMonth(year, month0)) return null;
  return civil(year, month0, day);
}

/**
 * A month/day with no year stated takes the ANCHOR's year — "August 20" said in
 * 2026 means August 20th 2026. It only rolls into the next year when that
 * reading lands well behind the anchor, which is how a December call saying
 * "January 5th" gets the right year. A date merely a few days past stays put:
 * someone saying "August 1st" on the 4th has missed a deadline, and showing it
 * three days overdue is the truth. Showing it a year out is not.
 */
function rollToFuture(base: Civil, month0: number, day: number): Civil | null {
  const sameYear = validCivil(base.getUTCFullYear(), month0, day);
  if (!sameYear) return null;
  const daysBehind = (base.getTime() - sameYear.getTime()) / DAY_MS;
  return daysBehind > 60 ? validCivil(base.getUTCFullYear() + 1, month0, day) : sameYear;
}

// ── The resolver ────────────────────────────────────────────────────────────

/**
 * Resolve a due-timing phrase ("in 4 days", "by Friday", "end of month") into
 * an ISO date (YYYY-MM-DD), anchored to `anchor` — the moment the commitment
 * was made (a meeting's observed_at, or the message's send time) — as read in
 * `timeZone` (defaults to NOUS_DEFAULT_TIMEZONE, else UTC).
 * Returns null when the phrase isn't a confidently-parseable date.
 */
export function resolveDuePhrase(
  phrase: string | null | undefined,
  anchor: Date,
  timeZone?: string,
): string | null {
  if (!phrase || typeof phrase !== 'string') return null;
  if (!(anchor instanceof Date) || Number.isNaN(anchor.getTime())) return null;
  const p = normalize(phrase);
  if (!p) return null;
  let hit: Civil | null = null;
  try {
    hit = match(p, civilDateOf(anchor, timeZone));
  } catch {
    return null;   // arithmetic past the Date range must never take down a run
  }
  return hit ? isoOf(hit) : null;
}

function match(p: string, base: Civil): Civil | null {
  let m: RegExpMatchArray | null;

  // ── Immediate ──
  if (/^(?:today|tonight|eod|end of day|asap|as soon as possible|right away|straight away|immediately|now)$/.test(p)) return base;
  // "after this call", "right after the meeting", "later today": the day it was said. A follow-up
  // promised for after the call is due that day, and the call's date is the anchor.
  if (/^(?:(?:right|just|straight|directly|immediately)\s+)?(?:after\s+)?(?:(?:the|this|our)\s+)?(?:call|meeting)$/.test(p)) return base;
  if (/^later\s+today$/.test(p)) return base;
  // Said as "now" in all its forms, on a call or in a reply: due the day it was said.
  if (/^(?:right\s+now|shortly|as\s+quickly\s+as\s+possible|a\s+(?:second|minute|moment|few\s+minutes)|(?:the\s+)?next\s+(?:few|couple(?:\s+of)?)\s+minutes|(?:(?:right|just)\s+)?(?:after\s+)?this|(?:the\s+)?end\s+of\s+(?:the\s+)?day)$/.test(p)) return base;
  if (/^tomorrow$/.test(p)) return addDays(base, 1);
  if (/^day after tomorrow$/.test(p)) return addDays(base, 2);

  // ── Explicit calendar dates ──
  m = p.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (m) return validCivil(+m[1], +m[2] - 1, +m[3]);

  // Numeric, US order (month first). Genuinely ambiguous with D/M for the first
  // twelve days of a month and there is no signal in the string to break the
  // tie, so we commit to one reading rather than guess per-string.
  //
  // A hyphen is only accepted WITH a year. Without one, "2-3" is a range
  // ("2-3 weeks" with the unit dropped), not February 3rd — reading a bare
  // digit pair as a date invented deadlines a year out.
  m = p.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/) || p.match(/^(\d{1,2})-(\d{1,2})-(\d{2,4})$/);
  if (m) {
    const month0 = +m[1] - 1, day = +m[2];
    if (m[3]) return validCivil(+m[3] < 100 ? 2000 + +m[3] : +m[3], month0, day);
    return rollToFuture(base, month0, day);
  }

  // "august 20" / "aug 20th" / "20 august" / "20th of august", ± a year.
  m = p.match(new RegExp(`^(${MONTH_RE})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?$`));
  if (!m) {
    const alt = p.match(new RegExp(`^(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MONTH_RE})(?:,?\\s+(\\d{4}))?$`));
    if (alt) m = [alt[0], alt[2], alt[1], alt[3]] as unknown as RegExpMatchArray;
  }
  if (m) {
    const month0 = monthIndex(m[1]);
    if (month0 !== -1) {
      const day = +m[2];
      return m[3] ? validCivil(+m[3], month0, day) : rollToFuture(base, month0, day);
    }
  }

  // "early september" / "mid-october" / "late march" — hyphenated or spaced.
  m = p.match(new RegExp(`^(early|mid(?:dle)?|late|end)[\\s-]*(?:of\\s+)?(${MONTH_RE})$`));
  if (m) {
    const month0 = monthIndex(m[2]);
    if (month0 !== -1) {
      const target = rollToFuture(base, month0, 1);
      if (target) return positionInMonth(m[1], target);
    }
  }

  // Bare day-of-month: "the 15th" (normalize has already dropped the "the").
  m = p.match(/^(\d{1,2})(?:st|nd|rd|th)$/);
  if (m) {
    const day = +m[1];
    if (day >= 1 && day <= 31) {
      const here = validCivil(base.getUTCFullYear(), base.getUTCMonth(), day);
      if (here && here.getTime() > base.getTime()) return here;
      const next = startOfMonth(base, 1);
      return civil(next.getUTCFullYear(), next.getUTCMonth(),
        Math.min(day, lastDayOfMonth(next.getUTCFullYear(), next.getUTCMonth())));
    }
  }

  // ── Weeks ──
  if (/^(?:end of (?:this )?week|eow|this week|this weekend|weekend)$/.test(p)) return endOfThisWeek(base);
  // Computed from next week's Monday, not from this week's Friday: on a weekend
  // anchor endOfThisWeek has already rolled forward a week, so adding another
  // seven landed a fortnight out and disagreed with "late next week".
  if (/^end of next week$/.test(p)) return addDays(mondayOfWeek(base), 11);
  if (/^(?:start|beginning|early) of next week$/.test(p)) return addDays(mondayOfWeek(base), 7);
  if (/^early next week$/.test(p)) return addDays(mondayOfWeek(base), 7);
  if (/^mid(?:dle)?[\s-]*(?:of\s+)?next week$/.test(p)) return addDays(mondayOfWeek(base), 9);
  if (/^late next week$/.test(p)) return addDays(mondayOfWeek(base), 11);
  // "next week" is the Monday of next week — a fixed, predictable point no
  // matter which day the promise was made on. (Plain +7 days meant "next week"
  // landed on a different weekday for every anchor.)
  if (/^(?:next|following|coming) week$/.test(p)) return addDays(mondayOfWeek(base), 7);

  // ── Months ──
  if (/^(?:end of (?:this )?month|eom|this month)$/.test(p)) return endOfMonth(base);
  if (/^end of next month$/.test(p)) return endOfMonth(base, 1);
  if (/^(?:start|beginning|first) of next month$/.test(p)) return startOfMonth(base, 1);
  if (/^early next month$/.test(p)) return positionInMonth('early', startOfMonth(base, 1));
  if (/^mid(?:dle)?[\s-]*(?:of\s+)?next month$/.test(p)) return positionInMonth('mid', startOfMonth(base, 1));
  if (/^late next month$/.test(p)) return endOfMonth(base, 1);
  if (/^(?:next|following) month$/.test(p)) return addMonths(base, 1);

  // ── Quarters and years ──
  if (/^(?:end of (?:this )?quarter|eoq|this quarter)$/.test(p)) return quarterEnd(base);
  if (/^end of next quarter$/.test(p)) return quarterEnd(base, 1);
  // "next quarter" is when the new quarter OPENS — the budget-cycle reading,
  // which is what the phrase almost always means in a sales conversation.
  if (/^(?:next|following) quarter$/.test(p)) return quarterStart(base, 1);
  if (/^(?:start|beginning) of next quarter$/.test(p)) return quarterStart(base, 1);
  if (/^(?:end of (?:this )?year|eoy|this year)$/.test(p)) return civil(base.getUTCFullYear(), 11, 31);
  if (/^end of next year$/.test(p)) return civil(base.getUTCFullYear() + 1, 11, 31);
  if (/^(?:next|following) year$/.test(p)) return civil(base.getUTCFullYear() + 1, 0, 1);

  // The reversed forms, which are how people usually say these out loud:
  // "month end", "quarter end" — same dates as "end of month" / "end of quarter".
  m = p.match(/^(month|quarter|year)\s*-?\s*end$/);
  if (m) {
    if (m[1] === 'month') return endOfMonth(base);
    if (m[1] === 'quarter') return quarterEnd(base);
    return civil(base.getUTCFullYear(), 11, 31);
  }

  // A quarter named outright — "Q4", "end of Q3", "start of Q1 2027". A named
  // period means its CLOSE unless the speaker asked for its start; a bare
  // quarter already behind us means next year's.
  m = p.match(/^(?:(end|start|beginning) of\s+)?q([1-4])(?:\s+(?:of\s+)?(\d{4}))?(?:\s+(end))?$/);
  if (m && (m[1] || m[2])) {
    const q0 = (+m[2] - 1) * 3;
    let year = m[3] ? +m[3] : base.getUTCFullYear();
    const wantsStart = m[1] === 'start' || m[1] === 'beginning';
    const at = (y: number) => (wantsStart ? civil(y, q0, 1) : endOfMonth(civil(y, q0, 1), 2));
    if (!m[3] && at(year).getTime() < base.getTime()) year += 1;
    return at(year);
  }

  // "first week of September" / "last week of the month" — a week named by its
  // position. Resolves to the day that week closes, since that is the deadline.
  m = p.match(new RegExp(`^(first|second|third|fourth|last)\\s+week\\s+of\\s+(?:the\\s+)?(${MONTH_RE}|month)$`));
  if (m) {
    const closes: Record<string, number> = { first: 7, second: 14, third: 21, fourth: 28 };
    const weekClose = (c: Civil) => {
      const y = c.getUTCFullYear(), mo = c.getUTCMonth();
      return m![1] === 'last' ? civil(y, mo, lastDayOfMonth(y, mo)) : civil(y, mo, closes[m![1]]);
    };
    const named = m[2] !== 'month';
    const target = named ? rollToFuture(base, monthIndex(m[2]), 1) : base;
    if (target) {
      const here = weekClose(target);
      // Only an UNQUALIFIED month rolls onward: "first week of the month" said
      // on the 20th must mean next month's. When the speaker named a month, that
      // month is the answer even if the week has passed — rolling it forward
      // filed the item in a month nobody mentioned.
      if (named || here.getTime() >= base.getTime()) return here;
      return weekClose(startOfMonth(target, 1));
    }
  }

  // ── Weekdays ──
  // "next Friday" is checked FIRST: it means the Friday of next week, not the
  // next Friday to occur. Ahead of the bare form so the qualifier can't be
  // silently ignored, which is what made "by next Tuesday" mean tomorrow.
  m = p.match(new RegExp(`^next\\s+(${WEEKDAY_RE})$`));
  if (m) {
    const wd = weekdayIndex(m[1]);
    if (wd !== -1) return weekdayNextWeek(base, wd);
  }
  m = p.match(new RegExp(`^(?:this\\s+|coming\\s+|this\\s+coming\\s+)?(${WEEKDAY_RE})$`));
  if (m) {
    const wd = weekdayIndex(m[1]);
    if (wd !== -1) return nextWeekdayAfter(base, wd);
  }

  // ── Durations ──
  if (/^(?:a\s+)?fortnight$/.test(p)) return addDays(base, 14);
  m = p.match(/^(.+?)\s+(?:business|working|work)\s+days?$/);
  if (m) { const n = parseCount(m[1]); if (n != null) return addBusinessDays(base, n); }
  m = p.match(/^(.+?)\s+days?$/);
  if (m) { const n = parseCount(m[1]); if (n != null) return addDays(base, n); }
  m = p.match(/^(.+?)\s+weeks?$/);
  if (m) { const n = parseCount(m[1]); if (n != null && n * 7 <= MAX_DURATION_DAYS) return addDays(base, n * 7); }
  m = p.match(/^(.+?)\s+months?$/);
  if (m) { const n = parseCount(m[1]); if (n != null && n <= 120) return addMonths(base, n); }
  // Sub-day timing still lands on a calendar date: the same day, or the next
  // one when the promise reaches past midnight.
  m = p.match(/^(.+?)\s+(?:hours?|hrs?)$/);
  if (m) { const n = parseCount(m[1]); if (n != null) return n <= 12 ? base : addDays(base, Math.ceil(n / 24)); }

  // A month named with no day — "September", "August 2026". A named period
  // resolves to its close everywhere else here (end of month, Q4, end of year),
  // so it does the same: the date by which the thing must have happened.
  m = p.match(new RegExp(`^(?:(end|start|beginning) of\\s+)?(${MONTH_RE})(?:\\s+(\\d{4}))?$`));
  if (m) {
    const month0 = monthIndex(m[2]);
    if (month0 !== -1) {
      const wantsStart = m[1] === 'start' || m[1] === 'beginning';
      // Roll-forward is tested on the day actually RETURNED, not on the 1st —
      // testing the 1st while returning the 31st put a bare month name and that
      // month's last day a full year apart for a window each autumn.
      const day = wantsStart ? 1 : lastDayOfMonth(m[3] ? +m[3] : base.getUTCFullYear(), month0);
      const hit = m[3] ? validCivil(+m[3], month0, day) : rollToFuture(base, month0, day);
      if (hit) return wantsStart ? hit : endOfMonth(hit);
    }
  }

  // "end of 2027" — a bare year states a period, so again its close.
  m = p.match(/^end of (\d{4})$/);
  if (m) return validCivil(+m[1], 11, 31);

  // Deliberately NO Date.parse fallback. It looked like free recall and was
  // actually a fabrication engine: V8 skips words it doesn't understand, so
  // "renewal 2027" — and equally "asdf qwer 2027" — came back as January 1st,
  // inside any sane window. It also read its result with host-LOCAL getters,
  // making the same phrase resolve differently on the worker than on a laptop.
  // Every format it usefully covered now has an explicit rule above.
  return null;
}

// Scans free text for an embedded timing phrase — for sources (meeting-note
// action items) that were never split into a separate due_phrase field.
//
// A deadline is a time expression doing ADVERBIAL work: it says WHEN the work
// is due. Grammatically that is one of two things — it follows a temporal
// preposition ("by Friday", "within 2 weeks"), or it is a time adverb that
// cannot modify a noun ("tomorrow", "today", "ASAP").
//
// A weekday or duration standing alone is an ATTRIBUTIVE modifier and states no
// deadline at all: the Monday in "Monday standup notes" names the meeting, the
// 30 days in "30 days pilot proposal" describes the pilot, the day in "block out
// a day" is an amount of work, and the Friday in "Black Friday deck" is half a
// holiday. Nothing in those words distinguishes them from a real deadline —
// only the preposition does, which is why it is required.
//
// The cost is a deadline stated with no preposition at all ("Follow up Friday"),
// which this will miss. That is the intended trade: a missing due date is
// honest, an invented one sends a rep chasing work nobody asked for. The model
// pass in the worker is what recovers those; this is the floor beneath it.
const TEMPORAL_PREP = '(?:by|before|within|due\\s+by|no\\s+later\\s+than|until|till|in)';
const DURATION_RE = '(?:\\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten|couple|few)\\s+(?:of\\s+)?(?:day|week|month)s?';
const PERIOD_RE = '(?:end\\s+of\\s+(?:the\\s+)?(?:day|week|month|quarter|year)|eod|eow|eom|eoq|next\\s+week|next\\s+month|this\\s+week)';
const BARE_ADVERB_RE = '(?:today|tomorrow|asap)';

const PHRASE_RE = new RegExp(
  '\\b(?:' +
    TEMPORAL_PREP + '\\s+~?\\s*(?:' + DURATION_RE + '|' + WEEKDAY_RE + '|' + PERIOD_RE +
      '|the\\s+\\d{1,2}(?:st|nd|rd|th))' +
    '|' + PERIOD_RE +
    '|' + BARE_ADVERB_RE +
  ')\\b',
  'i',
);

export function extractDuePhrase(text: string | null | undefined): string | null {
  if (!text || typeof text !== 'string') return null;
  const m = text.match(PHRASE_RE);
  return m ? m[0].trim() : null;
}

// ── Does the resolved date survive what the text actually says? ──────────────
//
// The division of labour here is right and stays: the model says the phrase, code computes the
// date. What broke is that the model hands over an UNDER-SPECIFIED phrase while holding the
// missing half in the title it wrote a second earlier.
//
// From prod, on a call dated 2026-08-31:
//
//   title "Schedule the October check-in for Monday the 5th at 9 AM"
//   due_phrase "the 5th"                    → 2026-09-05, a month early
//
// "the 5th" resolves correctly against the anchor; there was simply no October in it. Two of the
// four dated commitments on that sample were wrong this way, and a wrong due date is worse than no
// due date, because `commitments_overdue` sorts the attention list on it — a task dated a month
// early reports itself overdue while the customer is still waiting, and the rep learns to distrust
// the column.
//
// So: when the text names a month and the resolved date lands in a different one, the two readings
// of one fact disagree, and we do not know. Null, exactly as resolveDuePhrase already does rather
// than guess. Deliberately NOT inferring the month from the title instead — that would be guessing
// with extra steps, and this file exists because date arithmetic must never be "probably right".

const MONTH_MENTION_RE = new RegExp('\\b' + MONTH_RE + '\\b', 'gi');

/**
 * Every month named in a piece of text, as 0-11. Empty when it names none.
 *
 * `MONTH_RE` is anchored and has no trailing wildcard, so "marketing" is not March and "deck" is
 * not December — the same trap this file already documents for phrase parsing.
 */
export function monthsMentioned(text: string | null | undefined): number[] {
  if (!text || typeof text !== 'string') return [];
  const out = new Set<number>();
  for (const m of text.matchAll(MONTH_MENTION_RE)) {
    const i = monthIndex(m[0]);
    if (i !== -1) out.add(i);
  }
  return [...out];
}

/**
 * The due date, or null when the text it came from contradicts it.
 *
 * Passes anything the text cannot disagree with: no date, no text, no month named. Only an actual
 * contradiction — the text names one or more months and the resolved date is in none of them —
 * drops the value.
 *
 * @param dueAt   ISO date (YYYY-MM-DD or a full timestamp), or null
 * @param text    what the commitment says, usually the task title
 */
export function dueDateAgreeingWith(
  dueAt: string | null | undefined,
  text: string | null | undefined,
): string | null {
  if (!dueAt) return null;
  const months = monthsMentioned(text);
  if (!months.length) return dueAt;
  // Read the calendar month off the ISO string rather than through a Date, so a timestamp near a
  // month boundary cannot be shifted into the neighbouring month by a timezone on the way past.
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(dueAt));
  if (!m) return dueAt;             // not a shape we can check — leave it alone rather than drop it
  const resolved = Number(m[2]) - 1;
  return months.includes(resolved) ? dueAt : null;
}
