// Shared bits for the reporting surfaces (Objection Radar, Brief, Reporting).
//
// Deliberately dependency-light: these components also render inside the
// credential-free preview entry (demo.html), so nothing here may pull in
// AuthContext, ClaimTag, or anything else that assumes a signed-in app shell.

export const RED = "#ef4444";
export const AMBER = "#f59e0b";
export const GREEN = "#22c55e";
export const GRAY = "#9ca3af";

// Portfolio band → color + label. Bands come from lib/portfolio.mjs bandOf():
// won>=90, healthy 70-89, needs_attention 40-69, at_risk<40, unknown when null.
export const BAND_UI: Record<string, { label: string; color: string }> = {
  won: { label: "Won", color: "#16a34a" },
  healthy: { label: "Healthy", color: GREEN },
  needs_attention: { label: "Needs attention", color: AMBER },
  at_risk: { label: "At risk", color: RED },
  unknown: { label: "No score", color: GRAY },
};

// Claim-pattern categories (claimCategories.ts taxonomy). The radar renders
// EVERY category present in the graph payload — these are the known colorings;
// anything new the extractor starts producing falls back to neutral, visible
// rather than hidden.
export const RADAR_CAT_UI: Record<string, { label: string; color: string; bg: string }> = {
  objection: { label: "Objection", color: "#b45309", bg: "rgba(245,158,11,0.14)" },
  competitor: { label: "Competitor", color: "#7c3aed", bg: "rgba(139,92,246,0.14)" },
  pain: { label: "Pain", color: "#be123c", bg: "rgba(244,63,94,0.12)" },
  budget: { label: "Budget", color: "#047857", bg: "rgba(16,185,129,0.12)" },
  timeline: { label: "Timeline", color: "#0369a1", bg: "rgba(14,165,233,0.12)" },
  status_quo: { label: "Status quo", color: "#475569", bg: "rgba(100,116,139,0.14)" },
  goal: { label: "Goal", color: "#15803d", bg: "rgba(34,197,94,0.12)" },
  authority: { label: "Authority", color: "#a21caf", bg: "rgba(217,70,239,0.12)" },
};
export const radarCatUi = (cat: string) =>
  RADAR_CAT_UI[cat] ?? {
    label: cat ? cat.charAt(0).toUpperCase() + cat.slice(1).replace(/_/g, " ") : "Other",
    color: "#6b7280",
    bg: "rgba(107,114,128,0.12)",
  };

// The categories that read as RISK — on by default. Everything else is one chip away.
export const RADAR_DEFAULT_CATS = ["objection", "competitor", "pain"];

// Stage → display name, re-exported from the funnel so there is still exactly one
// label map. This used to just capitalise the slug it was handed, which reads fine
// until you remember the DB has not been migrated: a row still on `evaluating` or
// `client` rendered as "Evaluating" / "Client", stage names that no longer exist
// anywhere else in the app. The shared one normalizes first, so the brief and the
// reporting tables show the stage the row actually maps to. Safe for the
// dependency-light rule above: config/pipeline is plain data, it imports nothing.
export { stageLabel } from "@/config/pipeline";

/**
 * How long ago something happened, in the one phrasing every list uses.
 *
 * There were two of these. This one said "2d ago" and "3mo ago"; a second, private to the
 * accounts list, said "4d" and "3 wk" with no "ago" — so the same fact read differently on the
 * Accounts tab and the Customer success tab of the SAME page. One formatter, used everywhere.
 *
 * Weeks earn a place between days and months because that is the range a rep actually works in:
 * "3 wk ago" is a different feeling from "21d ago", and "1mo ago" hid the difference between
 * three weeks and six.
 *
 * Nothing recorded is "never", not "—". A dash reads like a rendering failure; "never" is a fact,
 * and it is the same word the dead-deal signals use for a deal nobody has touched.
 */
export function relTime(iso?: string | null): string {
  if (!iso) return "never";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "never";
  const d = Math.round((Date.now() - t) / 86_400_000);
  if (d <= 0) return "today";
  if (d === 1) return "yesterday";
  if (d < 7) return `${d}d ago`;
  if (d < 60) return `${Math.round(d / 7)} wk ago`;
  if (d < 365) return `${Math.round(d / 30)} mo ago`;
  return `${Math.round(d / 365)}y ago`;
}

export const healthColor = (score: number | null | undefined): string =>
  score == null ? GRAY : score >= 70 ? GREEN : score >= 40 ? AMBER : RED;

// ── Due dates ────────────────────────────────────────────────────────────────
//
// The extraction step records WHAT was promised and, when it was said out loud,
// WHEN — but in the speaker's own words ("by Friday", "in a couple of weeks"),
// never as a timestamp. A phrase is not a date: "Friday" said on a Monday and
// "Friday" said on a Thursday are four days apart, and neither one sorts,
// counts down, or turns red by itself.
//
// So we resolve the phrase against the moment it was SAID — the only anchor
// that makes "Friday" mean anything — and carry the confidence through with it.
// A guessed date presented as a certainty is worse than no date at all, so a
// resolved-from-words date always says so, and an unparseable phrase keeps the
// speaker's words rather than being dropped or defaulted to a fake deadline.

export type DueConfidence = "exact" | "resolved" | "unresolved" | "none";
export type Due = {
  at: Date | null;
  confidence: DueConfidence;
  daysLeft: number | null;    // negative = overdue
  overdue: boolean;
  label: string;              // "Mon 11 Aug" — the resolved calendar date
  relative: string;           // "in 3d" | "3d overdue" | "due today"
  phrase: string | null;      // the original spoken words, always preserved
};

const DAY_MS = 86_400_000;
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const NUMBER_WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, couple: 2, two: 2, few: 3, three: 3, four: 4, five: 5, six: 6, seven: 7,
};

const startOfDay = (d: Date) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
const addDays = (d: Date, n: number) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };

// The next occurrence of a weekday after the anchor. "Friday" said ON a Friday
// means next Friday — nobody promises something for the day that's already ending.
function nextWeekday(anchor: Date, target: number, weeksAhead = 0): Date {
  const a = startOfDay(anchor);
  const delta = (target - a.getDay() + 7) % 7 || 7;
  return addDays(a, delta + weeksAhead * 7);
}

/**
 * Resolve a spoken due phrase to a calendar date, anchored to when it was said.
 * Returns null when the words carry no resolvable timing ("soon", "later").
 */
export function parseDuePhrase(phrase: string, anchor: Date): Date | null {
  const p = phrase.toLowerCase().trim();
  if (!p) return null;
  const a = startOfDay(anchor);

  // Explicit calendar dates win over everything — no inference needed.
  const iso = p.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/);
  if (iso) return startOfDay(new Date(+iso[1], +iso[2] - 1, +iso[3]));

  const monthDay = p.match(/\b([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b/);
  const dayMonth = p.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?([a-z]{3,9})\b/);
  for (const [mRaw, dRaw] of [
    monthDay ? [monthDay[1], monthDay[2]] : null,
    dayMonth ? [dayMonth[2], dayMonth[1]] : null,
  ].filter(Boolean) as [string, string][]) {
    const mi = MONTHS.indexOf(mRaw.slice(0, 3));
    const day = +dRaw;
    if (mi === -1 || day < 1 || day > 31) continue;
    // No year in the phrase: pick the reading that lands ahead of the anchor.
    let year = a.getFullYear();
    if (new Date(year, mi, day) < a) year += 1;
    return startOfDay(new Date(year, mi, day));
  }

  if (/\b(today|tonight|end of (?:the )?day|eod|asap|right away|immediately)\b/.test(p)) return a;
  if (/\btomorrow\b/.test(p)) return addDays(a, 1);

  // End-of-period phrases resolve to the closing day of that period.
  if (/\b(end of (?:the )?week|eow|by (?:the )?weekend|this week)\b/.test(p)) return nextWeekday(a, 5);
  if (/\b(end of (?:the )?month|eom)\b/.test(p)) {
    return startOfDay(new Date(a.getFullYear(), a.getMonth() + 1, 0));
  }
  if (/\b(end of (?:the )?quarter|eoq)\b/.test(p)) {
    const q = Math.floor(a.getMonth() / 3);
    return startOfDay(new Date(a.getFullYear(), q * 3 + 3, 0));
  }

  // Named weekday, optionally qualified: "monday", "by friday", "next tuesday".
  const wd = p.match(/\b(next\s+|this\s+|by\s+|on\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/);
  if (wd) return nextWeekday(a, WEEKDAYS.indexOf(wd[2]), wd[1]?.trim() === "next" ? 1 : 0);

  // Durations: "in 2 weeks", "within 3 days", "~2 weeks", "a couple of weeks".
  const dur = p.match(/\b(?:in|within|after|next)?\s*~?\s*(\d+|a|an|one|two|three|four|five|six|seven|couple|few)\s*(?:of\s+)?(day|week|month|business day|working day)s?\b/);
  if (dur) {
    const n = /^\d+$/.test(dur[1]) ? +dur[1] : NUMBER_WORDS[dur[1]] ?? 1;
    if (/month/.test(dur[2])) return startOfDay(new Date(a.getFullYear(), a.getMonth() + n, a.getDate()));
    if (/week/.test(dur[2])) return addDays(a, n * 7);
    if (/business|working/.test(dur[2])) {
      let d = a, left = n;
      while (left > 0) { d = addDays(d, 1); if (d.getDay() !== 0 && d.getDay() !== 6) left--; }
      return d;
    }
    return addDays(a, n);
  }

  if (/\bnext week\b/.test(p)) return nextWeekday(a, 1);           // Monday coming
  if (/\bnext month\b/.test(p)) return startOfDay(new Date(a.getFullYear(), a.getMonth() + 1, 1));

  return null;   // "soon", "later", "when you get a chance" — genuinely no date
}

/**
 * The one place a commitment's timing is turned into something a person can act
 * on. Prefers a real stored timestamp; falls back to resolving the spoken
 * phrase against when it was said; never invents a deadline out of nothing.
 */
export function resolveDue(
  input: { due_at?: string | null; due_phrase?: string | null; recorded_at?: string | null },
  now: Date = new Date(),
): Due {
  const phrase = input.due_phrase?.trim() || null;
  const base: Due = {
    at: null, confidence: "none", daysLeft: null, overdue: false,
    label: "", relative: "", phrase,
  };

  let at: Date | null = null;
  let confidence: DueConfidence = "none";

  if (input.due_at) {
    // due_at is a CIVIL date (YYYY-MM-DD) — the calendar day the commitment is
    // owed, carrying no time and no zone. Handing that string to `new Date()`
    // reads it as UTC midnight, and every getter below (startOfDay,
    // toLocaleDateString, getFullYear) is LOCAL — so for any viewer west of
    // Greenwich the date renders a day early and flips to "overdue" a day
    // early, turning work due today into a red "1d overdue" against a named
    // rep. Build it from its own parts instead, the same rule Tasks.tsx
    // already follows. A full ISO timestamp (with a time/zone) still parses
    // normally — only the date-only form needs the civil reading.
    const civil = input.due_at.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    const t = civil
      ? new Date(+civil[1], +civil[2] - 1, +civil[3])
      : new Date(input.due_at);
    if (!Number.isNaN(t.getTime())) { at = t; confidence = "exact"; }
  }
  if (!at && phrase) {
    const anchor = input.recorded_at ? new Date(input.recorded_at) : now;
    const parsed = parseDuePhrase(phrase, Number.isNaN(anchor.getTime()) ? now : anchor);
    if (parsed) { at = parsed; confidence = "resolved"; }
    else confidence = "unresolved";
  }
  if (!at) return { ...base, confidence, label: phrase ?? "no due date", relative: "" };

  const daysLeft = Math.round((startOfDay(at).getTime() - startOfDay(now).getTime()) / DAY_MS);
  const sameYear = at.getFullYear() === now.getFullYear();
  const label = at.toLocaleDateString(undefined, {
    weekday: "short", day: "numeric", month: "short",
    ...(sameYear ? {} : { year: "numeric" }),
  });
  const relative =
    daysLeft === 0 ? "due today"
    : daysLeft === 1 ? "tomorrow"
    : daysLeft === -1 ? "1d overdue"
    : daysLeft > 0 ? `in ${daysLeft}d`
    : `${-daysLeft}d overdue`;

  return { at, confidence, daysLeft, overdue: daysLeft < 0, label, relative, phrase };
}
