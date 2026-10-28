// The date window a search question names (GET-1056): "what did they say last week", "pricing in
// Q3 2025", "a couple of months ago". Pure, so the hybrid search, its tests and any caller share
// one clock.
//
// Ported from Hindsight's temporal_periods.py (MIT, github.com/vectorize-io/hindsight; notice in
// THIRD_PARTY_NOTICES.md), English rules only, plus the ones Hindsight leaves to dateparser that a
// sales question uses all the time: this/next week|month|quarter|year, last/this/next quarter and
// "Q3 2025". A rule returns the WHOLE period as [start, end] calendar days (UTC), so a caller can
// both filter on it and strip the matched words before the keyword arm reads the question ("last
// week" is not a term to rank facts by).
//
// Weeks start on Monday, as in Hindsight (Python's weekday()).

export interface TemporalWindow {
  /** First day of the window, YYYY-MM-DD (UTC), inclusive. */
  start: string;
  /** Last day of the window, YYYY-MM-DD (UTC), inclusive. */
  end: string;
  /** The words in the question that named it, as written. */
  match: string;
  /** Which rule fired, for logs and tests. */
  rule: string;
}

const DAY = 86_400_000;

// A UTC calendar day as a Date at 00:00Z. Every rule works on whole days.
const utcDay = (y: number, m0: number, d: number): Date => new Date(Date.UTC(y, m0, d));
const addDays = (d: Date, n: number): Date => new Date(d.getTime() + n * DAY);
const iso = (d: Date): string => d.toISOString().slice(0, 10);
const monthEnd = (y: number, m0: number): Date => utcDay(y, m0 + 1, 0);
/** Monday of the week holding `d` (Monday = 0, as Python's weekday()). */
const weekStart = (d: Date): Date => addDays(d, -((d.getUTCDay() + 6) % 7));

function anchorDay(anchor?: Date | string | number | null): Date {
  const a = anchor == null ? new Date() : new Date(anchor);
  const t = Number.isNaN(a.getTime()) ? new Date() : a;
  return utcDay(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate());
}

const MONTHS: Record<string, number> = {
  january: 0, jan: 0, february: 1, feb: 1, march: 2, mar: 2, april: 3, apr: 3, may: 4, june: 5, jun: 5,
  july: 6, jul: 6, august: 7, aug: 7, september: 8, sept: 8, sep: 8, october: 9, oct: 9,
  november: 10, nov: 10, december: 11, dec: 11,
};
const MONTH_RE = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join('|');

type Rule = { rule: string; re: RegExp; window: (m: RegExpMatchArray, today: Date) => [Date, Date] | null };

// Order matters: the first rule that matches wins, as in Hindsight (yesterday before last week,
// "last weekend" before "last week", a month+year before a bare year).
const RULES: Rule[] = [
  { rule: 'yesterday', re: /\byesterday\b/i, window: (_m, t) => [addDays(t, -1), addDays(t, -1)] },
  { rule: 'today', re: /\btoday\b/i, window: (_m, t) => [t, t] },
  { rule: 'couple_days_ago', re: /\b(?:a\s+)?couple\s+(?:of\s+)?days?\s+ago\b/i, window: (_m, t) => [addDays(t, -3), addDays(t, -1)] },
  { rule: 'few_days_ago', re: /\b(?:a\s+)?few\s+days?\s+ago\b/i, window: (_m, t) => [addDays(t, -5), addDays(t, -2)] },
  { rule: 'couple_weeks_ago', re: /\b(?:a\s+)?couple\s+(?:of\s+)?weeks?\s+ago\b/i, window: (_m, t) => [addDays(t, -21), addDays(t, -7)] },
  { rule: 'few_weeks_ago', re: /\b(?:a\s+)?few\s+weeks?\s+ago\b/i, window: (_m, t) => [addDays(t, -35), addDays(t, -14)] },
  { rule: 'couple_months_ago', re: /\b(?:a\s+)?couple\s+(?:of\s+)?months?\s+ago\b/i, window: (_m, t) => [addDays(t, -90), addDays(t, -30)] },
  { rule: 'few_months_ago', re: /\b(?:a\s+)?few\s+months?\s+ago\b/i, window: (_m, t) => [addDays(t, -150), addDays(t, -60)] },
  {
    // Hindsight: on a weekend day "last weekend" is the one before this one, not today and yesterday.
    rule: 'last_weekend', re: /\blast\s+weekend\b/i, window: (_m, t) => {
      let back = (((t.getUTCDay() + 6) % 7) + 2) % 7;
      if (back <= 1) back += 7;
      const sat = addDays(t, -back);
      return [sat, addDays(sat, 1)];
    },
  },
  {
    rule: 'rel_week', re: /\b(last|past|previous|this|next)\s+week\b/i, window: (m, t) => {
      const off = { last: -7, past: -7, previous: -7, this: 0, next: 7 }[m[1].toLowerCase() as 'last'] ?? 0;
      const s = addDays(weekStart(t), off);
      return [s, addDays(s, 6)];
    },
  },
  {
    rule: 'rel_month', re: /\b(last|past|previous|this|next)\s+month\b/i, window: (m, t) => {
      const off = { last: -1, past: -1, previous: -1, this: 0, next: 1 }[m[1].toLowerCase() as 'last'] ?? 0;
      const y = t.getUTCFullYear(), mo = t.getUTCMonth() + off;
      return [utcDay(y, mo, 1), monthEnd(y, mo)];
    },
  },
  {
    rule: 'rel_quarter', re: /\b(last|past|previous|this|next)\s+quarter\b/i, window: (m, t) => {
      const off = { last: -1, past: -1, previous: -1, this: 0, next: 1 }[m[1].toLowerCase() as 'last'] ?? 0;
      const q0 = Math.floor(t.getUTCMonth() / 3) * 3 + off * 3;
      const y = t.getUTCFullYear();
      return [utcDay(y, q0, 1), monthEnd(y, q0 + 2)];
    },
  },
  {
    rule: 'rel_year', re: /\b(last|past|previous|this|next)\s+year\b/i, window: (m, t) => {
      const off = { last: -1, past: -1, previous: -1, this: 0, next: 1 }[m[1].toLowerCase() as 'last'] ?? 0;
      const y = t.getUTCFullYear() + off;
      return [utcDay(y, 0, 1), utcDay(y, 11, 31)];
    },
  },
  {
    // "Q3 2025", "Q3'25", "Q3 of 2025", or a bare "Q3" (this year's).
    rule: 'quarter', re: /\bq([1-4])(?:\s*(?:of\s+)?(?:'(\d{2})|(\d{4})))?\b/i, window: (m, t) => {
      const y = m[3] ? Number(m[3]) : m[2] ? 2000 + Number(m[2]) : t.getUTCFullYear();
      if (!plausibleYear(y, t)) return null;
      const q0 = (Number(m[1]) - 1) * 3;
      return [utcDay(y, q0, 1), monthEnd(y, q0 + 2)];
    },
  },
  {
    // "May 2024", "in sept 2025". Hindsight skips a day number before the month ("13 July 2026"):
    // that is an exact date, and a whole-month window would lose it. Handled in monthYear below.
    rule: 'month_year', re: new RegExp(`(?<!\\d\\s{0,3})\\b(${MONTH_RE})\\.?\\s+(\\d{4})\\b`, 'i'), window: (m, t) => {
      const y = Number(m[2]);
      if (!plausibleYear(y, t)) return null;
      const mo = MONTHS[m[1].toLowerCase()];
      return [utcDay(y, mo, 1), monthEnd(y, mo)];
    },
  },
  {
    // A bare four-digit year, only within -120..+20 of the anchor (Hindsight's guard), and not when
    // the word before it makes it a number ("port 2019", "ticket 2024", "#2025") or it is part of a
    // longer number or date ("2025-03", "2025/4").
    rule: 'year', re: /(?<![\w#$.\/-])(?<!\b(?:port|ticket|order|invoice|id|no|number|version|v|room|issue|pr)\.?\s{1,3})(\d{4})\b(?![-\/.]\d)/i,
    window: (m, t) => {
      const y = Number(m[1]);
      if (!plausibleYear(y, t)) return null;
      // "since 2024" / "from 2024" opens an interval that ends now (Hindsight leaves these out of
      // its year rule for the same reason: Jan-Dec would be narrower than asked). A day before the
      // month ("12 May 2024") falls through to here too: the whole year holds the date.
      if (/\b(?:since|from|after)\s+$/i.test((m.input ?? '').slice(0, m.index ?? 0)) && y <= t.getUTCFullYear()) {
        return [utcDay(y, 0, 1), t];
      }
      return [utcDay(y, 0, 1), utcDay(y, 11, 31)];
    },
  },
];

function plausibleYear(y: number, today: Date): boolean {
  const now = today.getUTCFullYear();
  return y >= now - 120 && y <= now + 20;
}

/**
 * The period a question names, or null when it names none. `anchor` is "now" (default: the
 * current time); tests and replays pass a fixed one.
 */
export function parseTemporalWindow(query: string, anchor?: Date | string | number | null): TemporalWindow | null {
  const q = String(query ?? '').normalize('NFKC');
  if (!q.trim()) return null;
  const today = anchorDay(anchor);
  for (const r of RULES) {
    const m = q.match(r.re);
    if (!m) continue;
    const w = r.window(m, today);
    if (!w) continue;   // an implausible year: try the next rule rather than inventing a window
    const [s, e] = w;
    return { start: iso(s), end: iso(e), match: m[0], rule: r.rule };
  }
  return null;
}

/** The question with the words that named the window taken out, for the keyword and name arms. */
export function stripTemporal(query: string, window: TemporalWindow | null): string {
  const q = String(query ?? '');
  if (!window?.match) return q;
  const i = q.indexOf(window.match);
  const out = i < 0 ? q : q.slice(0, i) + ' ' + q.slice(i + window.match.length);
  // A dangling preposition the date hung off ("in", "during", "from", "since") goes with it.
  return out.replace(/\b(?:in|during|from|since|over|of|for)\s*(?=[?.!,]*\s*$)/i, '').replace(/\s+/g, ' ').trim();
}

/**
 * Whether a claim's dates overlap the window. A claim is dated when it was SAID (valid_from) and,
 * for an event fact, when it HAPPENED (value.metadata.occurred_start/_end, GET-1051). Either one
 * inside the window counts. Returns null when the claim carries no date at all (neutral).
 */
export function claimInWindow(
  claim: { valid_from?: string | null; value?: unknown },
  window: Pick<TemporalWindow, 'start' | 'end'>,
): boolean | null {
  const meta = (claim.value && typeof claim.value === 'object' ? (claim.value as any).metadata : null) ?? {};
  const said = typeof claim.valid_from === 'string' && claim.valid_from ? claim.valid_from.slice(0, 10) : null;
  const os = typeof meta.occurred_start === 'string' && /^\d{4}-\d{2}-\d{2}/.test(meta.occurred_start) ? meta.occurred_start.slice(0, 10) : null;
  const oe = typeof meta.occurred_end === 'string' && /^\d{4}-\d{2}-\d{2}/.test(meta.occurred_end) ? meta.occurred_end.slice(0, 10) : os;
  if (!said && !os) return null;
  if (said && said >= window.start && said <= window.end) return true;
  if (os && oe && os <= window.end && oe >= window.start) return true;
  return false;
}
