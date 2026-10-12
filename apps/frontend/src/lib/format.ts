// One way to write numbers, money, times and dates across the app (standard 8, GET-595).
//
// The interface refresh fixes a single format for each kind of value so the same figure
// never appears two ways on one screen:
//   money   — whole dollars in tables ("$186,000"), short in headline stats ("$1.42M")
//   time    — 24-hour, always ("14:30")
//   dates   — relative only inside the last 7 days ("3h ago", "Yesterday", "3 days ago"),
//             a real date after that ("2 Oct", with the year once it isn't this year)
// Pure functions with an injectable `now`, so they're pinned by tests/format.test.ts.

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DAY = 86_400_000;
/** The real minus sign, so signed numbers line up with plus signs in tabular figures. */
const MINUS = "−";

type Num = number | null | undefined;
type DateIn = string | number | Date | null | undefined;

const isNum = (n: Num): n is number => typeof n === "number" && Number.isFinite(n);
const group = (n: number) => Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
const trim = (s: string) => s.replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");

/** A plain count with thousands separators: 6700 → "6,700". Missing → "—". */
export function num(n: Num): string {
  if (!isNum(n)) return "—";
  return (n < 0 ? MINUS : "") + group(Math.abs(n));
}

/**
 * Money. `table` (default): whole units, "$186,000". `stat`: short for headline numbers,
 * "$9,800" under ten thousand, "$94.5k" / "$462k" under a million, "$1.42M" above.
 */
export function money(n: Num, mode: "table" | "stat" = "table", symbol = "$"): string {
  if (!isNum(n)) return "—";
  const sign = n < 0 ? MINUS : "";
  const a = Math.abs(n);
  if (mode === "table" || a < 10_000) return `${sign}${symbol}${group(a)}`;
  if (a < 1_000_000) return `${sign}${symbol}${trim((a / 1000).toFixed(a < 100_000 ? 1 : 0))}k`;
  return `${sign}${symbol}${trim((a / 1_000_000).toFixed(2))}M`;
}

/** A signed change: +1, −2, +3.1%. Zero reads "0". */
export function signed(n: Num, opts: { percent?: boolean; decimals?: number } = {}): string {
  if (!isNum(n)) return "—";
  const d = opts.decimals ?? (opts.percent ? 1 : 0);
  const body = trim(Math.abs(n).toFixed(d)) + (opts.percent ? "%" : "");
  if (n === 0) return body;
  return (n > 0 ? "+" : MINUS) + body;
}

/** Parse what the API sends. A bare "YYYY-MM-DD" is a calendar day, read as that day locally. */
export function toDate(d: DateIn): Date | null {
  if (d === null || d === undefined || d === "") return null;
  if (d instanceof Date) return isNaN(d.getTime()) ? null : d;
  if (typeof d === "string") {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
    if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  }
  const out = new Date(d);
  return isNaN(out.getTime()) ? null : out;
}

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
const dayDiff = (d: Date, now: Date) => Math.round((startOfDay(d) - startOfDay(now)) / DAY);

/** 24-hour clock: "14:30". */
export function time(d: DateIn): string {
  const t = toDate(d);
  if (!t) return "";
  return `${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}`;
}

/** A calendar date: "2 Oct", or "2 Oct 2025" when it isn't this year. */
export function day(d: DateIn, now: DateIn = Date.now()): string {
  const t = toDate(d);
  const n = toDate(now) ?? new Date();
  if (!t) return "";
  const base = `${t.getDate()} ${MONTHS[t.getMonth()]}`;
  return t.getFullYear() === n.getFullYear() ? base : `${base} ${t.getFullYear()}`;
}

/**
 * When something happened. Relative inside the last 7 days — "just now", "12m ago",
 * "3h ago", "Yesterday", "3 days ago" — then the date ("2 Oct").
 */
export function when(d: DateIn, now: DateIn = Date.now()): string {
  const t = toDate(d);
  const n = toDate(now) ?? new Date();
  if (!t) return "";
  const ms = n.getTime() - t.getTime();
  if (ms < 0) return day(t, n);
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const days = -dayDiff(t, n);
  if (days === 0) return `${Math.floor(mins / 60)}h ago`;
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days} days ago`;
  return day(t, n);
}

/**
 * When something is due. "Today", "Tomorrow", "Yesterday", a weekday inside the coming
 * week ("Thu"), else the date. Pair with `isOverdue` for the tone.
 */
export function due(d: DateIn, now: DateIn = Date.now()): string {
  const t = toDate(d);
  const n = toDate(now) ?? new Date();
  if (!t) return "No date";
  const diff = dayDiff(t, n);
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  if (diff === -1) return "Yesterday";
  if (diff > 1 && diff < 7) return WEEKDAYS[t.getDay()];
  return day(t, n);
}

export function isOverdue(d: DateIn, now: DateIn = Date.now()): boolean {
  const t = toDate(d);
  const n = toDate(now) ?? new Date();
  return !!t && dayDiff(t, n) < 0;
}

/** Distance to a date in whole days: "in 12 days", "in 1 day", "today", "3 days ago". */
export function inDays(d: DateIn, now: DateIn = Date.now()): string {
  const t = toDate(d);
  const n = toDate(now) ?? new Date();
  if (!t) return "";
  const diff = dayDiff(t, n);
  if (diff === 0) return "today";
  const k = Math.abs(diff);
  const unit = k === 1 ? "day" : "days";
  return diff > 0 ? `in ${k} ${unit}` : `${k} ${unit} ago`;
}
