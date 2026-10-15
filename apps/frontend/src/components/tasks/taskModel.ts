// The task as /api/tasks returns it, and the date arithmetic every Tasks surface shares.
//
// One bucketing function decides Overdue, Today, This week and the rest, and the late count is
// read off the same function. They used to be two rules: the list bucketed by the RECORDED date
// when a task had no due date, so a promise with no deadline filed in August sat under Overdue
// while the late count (due date only) left it out, and the two numbers on one page disagreed.
// A task with no due date is not late. It goes to "No date".
import { format } from "date-fns";
import { day } from "@/lib/format";

export type Person = { id: string; name: string | null; avatar: string | null } | null;

export type TaskRecord = {
  id: string;
  entity_id: string;
  title: string;
  account: string | null;
  company: string | null;
  company_id?: string | null;
  company_domain?: string | null;
  description?: string | null;
  owner_kind?: string;
  owner_name: string | null;
  owner_email?: string | null;
  owner_label?: string | null;
  /** Did one of US commit to this. */
  owner_is_member?: boolean;
  /** Pulled from an internal (team) meeting. */
  internal?: boolean;
  assignee?: Person;
  account_owner?: Person;
  for_name?: string | null;
  asked_by?: string | null;
  /** The sentence the promise was made in. */
  quote?: string | null;
  /** Which side said it: us, them, or unknown. */
  stated_by?: "us" | "them" | null;
  /** A chase: they committed, the follow-up is ours. */
  awaiting_them?: boolean;
  owed_by?: string | null;
  deal_id?: string | null;
  deal_link?: "filed" | "only_open_deal" | null;
  /** Not served yet. Rendered when the API starts carrying it. */
  deal_name?: string | null;
  due_phrase: string | null;
  due_at?: string | null;
  /** When we filed it. */
  recorded_at: string;
  /** When it was said: the meeting's or the message's date. */
  occurred_at?: string | null;
  source_title?: string | null;
  source_url?: string | null;
  source_system?: string | null;
  source_type?: string | null;
  source_ref?: string | null;
  kind?: string;
  completed_at?: string | null;
  completed_reason?: string | null;
  completed_by?: string | null;
  completed_evidence?: TaskEvidence | null;
  /** An email that probably did it, for a person to confirm: "Looks done — close?" (GET-904). */
  suggested_done?: { reason: string | null; evidence: TaskEvidence | null } | null;
};

/** What an auto-close rested on: a quote, and for an email, who it went to and where to read it. */
export type TaskEvidence = {
  kind?: string | null;
  quote?: string | null;
  source_title?: string | null;
  source_url?: string | null;
  with_name?: string | null;
  at?: string | null;
  /** The email is in a mailbox this viewer cannot open: who and when only. */
  redacted?: boolean;
};

export type DueBucket = "overdue" | "today" | "week" | "next" | "later" | "none";

export const DUE_BUCKETS: { key: DueBucket; label: string }[] = [
  { key: "overdue", label: "Overdue" },
  { key: "today", label: "Today" },
  { key: "week", label: "This week" },
  { key: "next", label: "Next week" },
  { key: "later", label: "Later" },
  { key: "none", label: "No date" },
];

/** Past this many days late, an overdue task is usually done already or no longer needed. */
export const STALE_DAYS = 30;

export const UNASSIGNED = "\u0000unassigned";
/** The name a task's owner goes by: the member it is assigned to, else whoever was named. */
export const ownerName = (t: TaskRecord) => t.assignee?.name ?? t.owner_label ?? t.owner_name ?? null;
export const ownerKey = (t: TaskRecord) => t.assignee?.id ?? UNASSIGNED;

const DAY = 86_400_000;

function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

/** Monday of the week `d` falls in, at midnight. Sunday belongs to the week that is ending. */
export function weekStart(d: Date = new Date()): Date {
  const x = startOfDay(d);
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return x;
}

/** Calendar-day addition, so a clock change inside the week never moves a boundary by an hour. */
function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

const DAY_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * A due date as a LOCAL day. Writers store a bare "2026-10-06", and `new Date("2026-10-06")` is
 * UTC midnight, which west of Greenwich is the evening before: a task snoozed to tomorrow read as
 * due today on every North American screen. A bare day is built from its parts instead.
 */
export function parseDay(v: string): Date | null {
  const m = DAY_ONLY.exec(v);
  const d = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function dueDate(t: Pick<TaskRecord, "due_at">): Date | null {
  if (!t.due_at) return null;
  return parseDay(t.due_at);
}

/** A local day as the API takes it. */
export const dayKey = (d: Date) => format(d, "yyyy-MM-dd");

/**
 * The snooze menu's two fixed choices. Next Monday is never today: on a Monday it is a week out,
 * and on a Sunday it is tomorrow.
 */
export function snoozeDays(now = new Date()): { today: string; tomorrow: string; nextMonday: string } {
  const t = startOfDay(now);
  const toMonday = ((8 - t.getDay()) % 7) || 7;
  return { today: dayKey(t), tomorrow: dayKey(addDays(t, 1)), nextMonday: dayKey(addDays(t, toMonday)) };
}

export function dueBucket(t: Pick<TaskRecord, "due_at">, now = new Date()): DueBucket {
  const d = dueDate(t);
  if (!d) return "none";
  const day = startOfDay(d).getTime();
  const today = startOfDay(now).getTime();
  if (day < today) return "overdue";
  if (day === today) return "today";
  const ws = weekStart(now);
  if (day < addDays(ws, 7).getTime()) return "week";
  if (day < addDays(ws, 14).getTime()) return "next";
  return "later";
}

/** Whole days past the due date; 0 when it is not late. */
export function daysLate(t: Pick<TaskRecord, "due_at">, now = new Date()): number {
  const d = dueDate(t);
  if (!d) return 0;
  const n = Math.round((startOfDay(now).getTime() - startOfDay(d).getTime()) / DAY);
  return n > 0 ? n : 0;
}

export const isLate = (t: Pick<TaskRecord, "due_at">, now = new Date()) => dueBucket(t, now) === "overdue";
export const isStale = (t: Pick<TaskRecord, "due_at">, now = new Date()) => daysLate(t, now) > STALE_DAYS;
export const lateCount = (rows: Pick<TaskRecord, "due_at">[], now = new Date()) => rows.filter((r) => isLate(r, now)).length;

/**
 * Inside a bucket, the order the question asks for. Overdue runs freshest first: a task one day
 * late can still be saved, and the long tail has its own banner. Every dated bucket after it runs
 * soonest first. Undated tasks run newest first, by when they were said.
 */
export function sortBucket(rows: TaskRecord[], bucket: DueBucket): TaskRecord[] {
  const due = (t: TaskRecord) => dueDate(t)?.getTime() ?? 0;
  const said = (t: TaskRecord) => Date.parse(t.occurred_at ?? t.recorded_at) || 0;
  const out = [...rows];
  if (bucket === "overdue") out.sort((a, b) => due(b) - due(a));
  else if (bucket === "none") out.sort((a, b) => said(b) - said(a));
  else out.sort((a, b) => due(a) - due(b));
  return out;
}

/** The due chip's words and tone. */
export function dueLabel(t: TaskRecord, now = new Date()): { text: string; tone: "late" | "soon" | "plain" | "none"; title: string } {
  const d = dueDate(t);
  if (!d) return { text: "No date", tone: "none", title: "No due date" };
  const b = dueBucket(t, now);
  const full = format(d, "EEE, MMM d");
  if (b === "overdue") {
    const n = daysLate(t, now);
    return { text: `${format(d, "MMM d")} · ${n}d late`, tone: "late", title: `${full}, ${n} day${n === 1 ? "" : "s"} late` };
  }
  if (b === "today") return { text: "Today", tone: "soon", title: full };
  if (startOfDay(d).getTime() === addDays(startOfDay(now), 1).getTime()) return { text: "Tomorrow", tone: "plain", title: full };
  if (b === "week" || b === "next") return { text: full, tone: "plain", title: full };
  return { text: format(d, d.getFullYear() === now.getFullYear() ? "MMM d" : "MMM d, yyyy"), tone: "plain", title: full };
}

/** The last day of this week, for the "This week" card's note. */
export function endOfThisWeek(now = new Date()): Date {
  return addDays(weekStart(now), 6);
}

// ─── Where it was said ──────────────────────────────────────────────────────

/** Where a task came from, as that tool's own mark. */
export const SOURCE_DOMAIN: Record<string, string> = {
  fellow: "fellow.app", fireflies: "fireflies.ai", granola: "granola.ai",
  fathom: "fathom.video", otter: "otter.ai", zoom: "zoom.us",
  gmail: "mail.google.com", gmail_oauth: "mail.google.com", email: "mail.google.com",
  instantly: "instantly.ai", hubspot: "hubspot.com", salesforce: "salesforce.com",
  linkedin: "linkedin.com", slack: "slack.com",
};
export const SOURCE_LABEL: Record<string, string> = {
  fellow: "Fellow", fireflies: "Fireflies", granola: "Granola", fathom: "Fathom",
  gmail: "Gmail", email: "Email", instantly: "Instantly", meeting: "Meeting",
  // Made in Nous (Phase 3.7): typed on Tasks, or from an Insights topic.
  manual: "Added by hand", insight: "Insights", close_loop: "Insights",
};

/**
 * The tool a task came from, so the source shows that tool's own mark. "meeting" and "email" are
 * what happened, not where: the link or the ref says which tool it was (Fellow, Gmail, …).
 */
export function sourceSystem(task: TaskRecord): string {
  const url = String(task.source_url ?? "").toLowerCase();
  const ref = String(task.source_ref ?? "").toLowerCase();
  for (const key of Object.keys(SOURCE_DOMAIN)) {
    if (key === "email" || key === "gmail_oauth") continue;
    if (ref.startsWith(`source://${key}/`) || url.includes(SOURCE_DOMAIN[key])) return key;
  }
  if (url.includes("mail.google.com")) return "gmail";
  const named = (task.source_system ?? "").toLowerCase();
  if (named && SOURCE_DOMAIN[named]) return named;
  return (task.source_type ?? named).toLowerCase();
}

export function sourceName(task: TaskRecord): string | null {
  const system = sourceSystem(task);
  if (!system) return null;
  return SOURCE_LABEL[system] ?? system.charAt(0).toUpperCase() + system.slice(1);
}

/**
 * "From Demo with Larkfield Toyota · Oct 1": the conversation's own name and the day it was said. A
 * row written before provenance existed has neither, so it says the tool and the day we filed it.
 */
export function sourceLine(task: TaskRecord): string {
  const title = task.source_title?.trim() || sourceName(task);
  const when = task.occurred_at ?? task.recorded_at;
  const d = when ? new Date(when) : null;
  const day = d && !Number.isNaN(d.getTime()) ? format(d, "MMM d") : null;
  // A task someone typed came from no conversation; "From Added by hand" would say otherwise.
  const from = task.source_type === "manual" && !task.source_title?.trim() ? SOURCE_LABEL.manual : title ? `From ${title}` : null;
  return [from, day].filter(Boolean).join(" · ");
}

// ─── The list's and the board's sections (GET-607) ──────────────────────────

/**
 * The interface refresh's five sections. Today folds into This week (the due pill already says
 * "Today" in amber), so a desk reads Overdue, This week, Next week, Later, No date.
 */
export type Section = "overdue" | "week" | "next" | "later" | "none";
export const SECTIONS: { key: Section; label: string; buckets: DueBucket[] }[] = [
  { key: "overdue", label: "Overdue", buckets: ["overdue"] },
  { key: "week", label: "This week", buckets: ["today", "week"] },
  { key: "next", label: "Next week", buckets: ["next"] },
  { key: "later", label: "Later", buckets: ["later"] },
  { key: "none", label: "No date", buckets: ["none"] },
];

/** A section's rows in the order its buckets ask for: Today's ahead of the rest of the week. */
export function sectionRows(rows: TaskRecord[], s: (typeof SECTIONS)[number], now = new Date()): TaskRecord[] {
  return s.buckets.flatMap((b) => sortBucket(rows.filter((r) => dueBucket(r, now) === b), b));
}

/** The due pill's tone: late in the risk tint, today in the warning tint, anything later muted. */
export function dueTone(t: Pick<TaskRecord, "due_at">, now = new Date()): "late" | "soon" | "later" | "none" {
  const b = dueBucket(t, now);
  return b === "none" ? "none" : b === "overdue" ? "late" : b === "today" ? "soon" : "later";
}

/**
 * Where a task came from, as the list's Source column says it: "Call · 24 Sep", "Email · 26 Sep",
 * "Added · 2 Oct" for one typed here, "Insights · …" for one made from a topic.
 */
export type SourceKind = "call" | "email" | "manual" | "insight" | "followup" | "other";
const CALL_SYSTEMS = new Set(["meeting", "fellow", "fireflies", "granola", "fathom", "otter", "zoom"]);
const EMAIL_SYSTEMS = new Set(["email", "gmail", "gmail_oauth", "instantly"]);
export function sourceInfo(t: TaskRecord, now = new Date()): { kind: SourceKind; text: string } {
  const system = sourceSystem(t);
  const type = (t.source_type ?? "").toLowerCase();
  const when = t.occurred_at ?? t.recorded_at;
  const d = when ? new Date(when) : null;
  const sameDay = d && d.toDateString() === now.toDateString();
  const on = d && !Number.isNaN(d.getTime()) ? (sameDay ? "today" : day(d, now)) : "";
  const say = (label: string) => (on ? `${label} · ${on}` : label);
  if (type === "manual") return { kind: "manual", text: say("Added") };
  if (type === "insight" || type === "close_loop") return { kind: "insight", text: say("Insights") };
  if (type === "follow_up") return { kind: "followup", text: say("Follow-up") };
  if (CALL_SYSTEMS.has(system) || type === "meeting") return { kind: "call", text: say("Call") };
  if (EMAIL_SYSTEMS.has(system) || type === "email") return { kind: "email", text: say("Email") };
  const name = sourceName(t);
  return { kind: "other", text: name ? say(name) : on };
}
