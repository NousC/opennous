import { format, isToday, isYesterday } from "date-fns";

// Shared by the cards on Home. A tile reads "$612k", not "$612,000": it is a glance, not a ledger.
export const money = (n: number | string | null | undefined): string => {
  const v = Number(n);
  if (n == null || !isFinite(v) || !v) return "$0";
  const a = Math.abs(v);
  if (a >= 1_000_000) return `$${(v / 1_000_000).toFixed(a >= 10_000_000 ? 0 : 1)}M`;
  if (a >= 1_000) return `$${Math.round(v / 1_000)}k`;
  return `$${Math.round(v)}`;
};

/** "Today", "Yesterday", or the weekday; with the time when we actually know it. */
export function dayLabel(iso: string | null | undefined, withTime = false): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const day = isToday(d) ? "Today" : isYesterday(d) ? "Yesterday" : Date.now() - d.getTime() < 6 * 86_400_000 ? format(d, "EEE") : format(d, "MMM d");
  return withTime ? `${day}, ${format(d, "h:mm a")}` : day;
}

/** A calendar date the API sends as "YYYY-MM-DD", read as that day wherever the viewer is. */
export function shortDate(s: string | null | undefined): string {
  if (!s) return "";
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  const d = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(s);
  return isNaN(d.getTime()) ? s : format(d, "MMM d");
}

export const CARD = "rounded-xl border border-border bg-card shadow-[0_1px_2px_rgba(15,23,42,0.04)]";
