// When it happened vs when it was said (GET-1051).
//
// A claim is dated by when it was SAID (GET-770): its said_at is the source's date, and freshness
// and replacement ordering run on it. That is right for "how current is this", and wrong for "when
// is/was this": "We moved off Salesforce in March", said in October, read as an October move, and
// "the trial ends March 31" or "we launch in Q1" carried no date of their own at all. A timeline, a
// tech-stack switch or a staff change needs the date the thing HAPPENS or HAPPENED.
//
// Ported from Hindsight's retain/fact_extraction.py temporal rules (MIT):
//   1. Each fact is an "event" (happens at a point or over a period) or a "state" (a standing fact,
//      a preference, an opinion). Only an event carries occurred_start / occurred_end (YYYY-MM-DD,
//      end = start for a single day).
//   2. The model resolves relative dates against the conversation's own date, the ANCHOR, rendered
//      with its weekday ("Monday, June 10, 2024 (2024-06-10)") so "next Friday" has a calendar to
//      count on. A coarse period spans the whole period. A date the text does not state is never
//      invented, and never a placeholder year (0001, 9999).
//   3. Code holds it to that: strict ISO dates, years within the anchor's -120..+20, an end before
//      the start swapped, a state's dates stripped (normalizeOccurred).
//   4. A small, deterministic fallback for an event the model left undated though its text has a
//      plain relative phrase ("yesterday", "next week", "in 3 days"): relativeOccurred.
//
// Storage is the claim's value metadata (occurred_start, occurred_end, fact_kind): a reader that
// wants "when did it happen" reads it there, and said_at stays the one clock for freshness and
// replacement (claimTime.ts). No column, no migration.
//
// Pure: no database, no model, no network. tests/occurredDates.test.mjs pins it.

const DAY = 86_400_000;
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

// How far from the anchor a real date can be (GET-1051): a founding year a century back, a
// contract end two decades out. Anything beyond is a placeholder (0001, 9999) or a typo.
export const YEARS_BACK = 120;
export const YEARS_AHEAD = 20;

/** A civil date as a Date pinned to 12:00 UTC (no DST edge can move it a day), or null. */
function civil(y, m0, d) {
  const t = new Date(Date.UTC(y, m0, d, 12));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m0 && t.getUTCDate() === d ? t : null;
}
const isoOf = (t) => t.toISOString().slice(0, 10);

/** YYYY-MM-DD, a real calendar date, or null. Strict: no timestamps, no "March 2026", no 2026-02-30. Pure. */
export function strictIsoDate(value) {
  if (typeof value !== 'string') return null;
  const m = ISO_RE.exec(value.trim());
  if (!m) return null;
  const t = civil(+m[1], +m[2] - 1, +m[3]);
  return t ? isoOf(t) : null;
}

/** The anchor's civil date: a YYYY-MM-DD string kept as it is, an instant read in UTC. Pure. */
function anchorIsoOf(anchor) {
  if (typeof anchor === 'string' && strictIsoDate(anchor)) return strictIsoDate(anchor);
  const t = anchor instanceof Date ? anchor : (anchor ? new Date(anchor) : null);
  if (!t || Number.isNaN(t.getTime())) return null;
  return isoOf(t);
}

/**
 * The anchor as the model reads it: "Monday, June 10, 2024 (2024-06-10)". The weekday is what
 * lets "next Friday" be counted rather than guessed; the ISO date is what the answer is written in.
 * `anchorIso` is a YYYY-MM-DD civil date (the caller reads it in the workspace's zone). Pure.
 */
export function renderAnchor(anchorIso) {
  const iso = strictIsoDate(anchorIso);
  if (!iso) return null;
  const [y, m, d] = iso.split('-').map(Number);
  const t = civil(y, m - 1, d);
  return `${WEEKDAYS[t.getUTCDay()]}, ${MONTHS[m - 1]} ${d}, ${y} (${iso})`;
}

/**
 * The line in the USER message that carries the anchor (GET-1051). The rules are in the shared
 * system prompt (OCCURRED_RULES); the date changes with every conversation, so it lives here. Pure.
 */
export function anchorLine(anchorIso) {
  const shown = renderAnchor(anchorIso);
  if (!shown) return '';
  // The quarters spelled out (GET-1051 follow-up): said in October, "next quarter" came back as the
  // quarter the call was in. The model counts quarters badly; it copies them well.
  const [last, cur, next] = [-1, 0, 1].map(k => quarterSpan(strictIsoDate(anchorIso), k));
  const q = ([s, e]) => `Q${Math.floor(Number(s.slice(5, 7)) / 3) + 1} ${s.slice(0, 4)} (${s} to ${e})`;
  return `\nThis conversation is dated ${shown}. That is the ANCHOR: resolve every relative date in it ("yesterday", "last month", "next Friday", "in Q1") against it — in a thread, against the date of the message the phrase appears in. Against it, "this quarter" is ${q(cur)}, "next quarter" is ${q(next)} and "last quarter" is ${q(last)}.\n`;
}

/** The calendar quarter `k` quarters from the one `iso` is in, as [start, end]. Pure. */
export function quarterSpan(iso, k = 0) {
  const [y, m] = iso.split('-').map(Number);
  const idx = y * 4 + Math.floor((m - 1) / 3) + k;
  const qy = Math.floor(idx / 4), qm = (idx % 4) * 3;
  const first = new Date(Date.UTC(qy, qm, 1, 12)), lastDay = new Date(Date.UTC(qy, qm + 3, 0, 12));
  return [first.toISOString().slice(0, 10), lastDay.toISOString().slice(0, 10)];
}

/** The temporal rules, word for word in the shared system prompt (GET-1051, from Hindsight, MIT). */
export const OCCURRED_RULES = `WHEN IT HAPPENS, NOT WHEN IT WAS SAID — the user message gives the date of the conversation, the ANCHOR. Every fact with home "claim" also carries:
- "fact_kind": "event" for something that happens or happened at a point or over a period (a switch of tools, a hire or a departure, a launch, a trial or contract ending, a renewal, a deadline, a decision taken); "state" for a standing fact, a preference or an opinion that is simply true (what they use, what they want, what they think, who they are).
- For an event only, "occurred_start" and "occurred_end": the day or period the event itself happens or happened, as YYYY-MM-DD — never the day it was mentioned. One day: occurred_end is the same as occurred_start. A state has neither.
Rules for those dates:
- Convert every relative expression to an absolute date against the anchor, and write the resolved date into "content" too: "Ines Halloran's trial ends on Friday, October 23, 2026", never "ends next Friday"; "moved off Ledgerway in March 2026", never "moved off it in March".
- A coarse period spans the whole period: "in Q1 2027" is 2027-01-01 to 2027-03-31; "in 2025" is 2025-01-01 to 2025-12-31; "in March" is March 1 to March 31 of the nearest sensible year relative to the anchor (said in October 2026, "we moved off it in March" is March 2026, "we go live in March" is March 2027).
- Open-ended ("since 2024", "by the end of the year"): set only the bound the text gives and leave the other out.
- Never invent a date the text does not state, and never write a placeholder year (0001, 9999, 20XX). An event with no stated or resolvable date gets no occurred_start or occurred_end.`;

/** The keys a fact may carry for this, for the JSON shape in each prompt. */
export const OCCURRED_FIELDS = '"fact_kind": "event|state", "occurred_start": "<YYYY-MM-DD, events only>", "occurred_end": "<YYYY-MM-DD, events only>"';

const yearOf = (iso) => Number(iso.slice(0, 4));

/** A date the anchor can stand behind: strict ISO, inside anchor -120y..+20y. Pure. */
function plausibleDate(value, anchorIso) {
  const iso = strictIsoDate(value);
  if (!iso) return null;
  const base = anchorIso ? yearOf(anchorIso) : new Date().getUTCFullYear();
  const y = yearOf(iso);
  return y >= base - YEARS_BACK && y <= base + YEARS_AHEAD ? iso : null;
}

// ── The fallback (GET-1051) ──────────────────────────────────────────────────────────────────
//
// Only the plain phrases, each with one reading. Anything with a weekday or a named month is the
// model's job (and the prompt's), because the reading depends on context a regex cannot see.
// resolveDuePhrase (core/dateResolve.ts) is not reused: it resolves DEADLINES, forward only, and
// reads "next week" as next Monday; an event is as often behind the anchor ("last week", "3 days
// ago") as ahead of it.

const COUNT_WORDS = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };
const COUNT = '(\\d{1,3}|an?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)';
const countOf = (s) => (/^\d+$/.test(s) ? Number(s) : COUNT_WORDS[s.toLowerCase()]);

function shift(iso, days) {
  const [y, m, d] = iso.split('-').map(Number);
  return isoOf(new Date(Date.UTC(y, m - 1, d, 12) + days * DAY));
}
function monthSpan(iso, delta) {
  const [y, m] = iso.split('-').map(Number);
  const first = new Date(Date.UTC(y, m - 1 + delta, 1, 12));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0, 12));
  return [isoOf(first), isoOf(last)];
}

// Each: a pattern, and the [start, end] it means against the anchor's civil date.
const RELATIVE = [
  [/\byesterday\b/gi, (a) => [shift(a, -1), shift(a, -1)]],
  [/\btoday\b/gi, (a) => [a, a]],
  [/\btomorrow\b/gi, (a) => [shift(a, 1), shift(a, 1)]],
  [/\blast week\b/gi, (a) => [shift(a, -7), shift(a, -7)]],
  [/\bnext week\b/gi, (a) => [shift(a, 7), shift(a, 7)]],
  // A month is a coarse period, so it spans the whole calendar month (the prompt's rule too).
  [/\blast month\b/gi, (a) => monthSpan(a, -1)],
  [/\bnext month\b/gi, (a) => monthSpan(a, 1)],
  [/\blast quarter\b/gi, (a) => quarterSpan(a, -1)],
  [/\bthis quarter\b/gi, (a) => quarterSpan(a, 0)],
  [/\bnext quarter\b/gi, (a) => quarterSpan(a, 1)],
  [new RegExp(`\\bin ${COUNT} days?\\b`, 'gi'), (a, n) => [shift(a, n), shift(a, n)]],
  [new RegExp(`\\bin ${COUNT} weeks?\\b`, 'gi'), (a, n) => [shift(a, 7 * n), shift(a, 7 * n)]],
  [new RegExp(`\\b${COUNT} days? ago\\b`, 'gi'), (a, n) => [shift(a, -n), shift(a, -n)]],
  [new RegExp(`\\b${COUNT} weeks? ago\\b`, 'gi'), (a, n) => [shift(a, -7 * n), shift(a, -7 * n)]],
];

/**
 * The one date range a plain relative phrase in `text` means, against `anchorIso`, or null: no
 * phrase, or two phrases meaning different dates (which one the event is, is not ours to pick).
 * Pure. @returns {{ start: string, end: string } | null}
 */
export function relativeOccurred(text, anchorIso) {
  const a = strictIsoDate(anchorIso);
  const s = String(text ?? '');
  if (!a || !s) return null;
  const hits = new Map();
  for (const [re, at] of RELATIVE) {
    for (const m of s.matchAll(re)) {
      const n = m[1] === undefined ? null : countOf(m[1]);
      if (m[1] !== undefined && !(n > 0 && n <= 366)) continue;
      const [start, end] = at(a, n);
      hits.set(`${start}|${end}`, { start, end });
    }
  }
  return hits.size === 1 ? [...hits.values()][0] : null;
}

/**
 * One fact's temporal fields, held to the rules (GET-1051). Returns a copy with `fact_kind`,
 * `occurred_start` and `occurred_end` set or removed; nothing else changes. Pure.
 *   - fact_kind is "event" or "state"; anything else is removed. A fact with no fact_kind but a
 *     usable date is an event (the date says so); with neither it stays unkinded.
 *   - a state carries no dates.
 *   - each date strict YYYY-MM-DD within the anchor's -120y..+20y, else removed.
 *   - an end before its start: the two are swapped (the model wrote the range backwards).
 *   - an event with no date left: relativeOccurred over its content, then its quote.
 * `anchor` is the said date (YYYY-MM-DD civil, or an instant read in UTC).
 */
export function normalizeOccurred(fact, anchor) {
  if (!fact || typeof fact !== 'object') return fact;
  const anchorIso = anchorIsoOf(anchor);
  const { fact_kind: rawKind, occurred_start: rawStart, occurred_end: rawEnd, ...rest } = fact;
  const k = String(rawKind ?? '').trim().toLowerCase();
  let kind = k === 'event' || k === 'state' ? k : null;
  if (kind === 'state') return { ...rest, fact_kind: 'state' };
  let start = plausibleDate(rawStart, anchorIso);
  let end = plausibleDate(rawEnd, anchorIso);
  if (!kind && (start || end)) kind = 'event';
  if (!kind) return rest;
  if (start && end && end < start) [start, end] = [end, start];
  if (!start && !end && anchorIso) {
    const hit = relativeOccurred(fact.content, anchorIso) ?? relativeOccurred(fact.quote, anchorIso);
    if (hit) ({ start, end } = hit);
  }
  return { ...rest, fact_kind: kind, ...(start ? { occurred_start: start } : {}), ...(end ? { occurred_end: end } : {}) };
}

/** What a normalized fact stores in its claim's value metadata: only the keys it has. Pure. */
export function occurredMetaFor(fact) {
  const out = {};
  if (fact?.fact_kind === 'event' || fact?.fact_kind === 'state') out.fact_kind = fact.fact_kind;
  if (out.fact_kind === 'event') {
    const s = strictIsoDate(fact.occurred_start), e = strictIsoDate(fact.occurred_end);
    if (s) out.occurred_start = s;
    if (e) out.occurred_end = e;
  }
  return out;
}
