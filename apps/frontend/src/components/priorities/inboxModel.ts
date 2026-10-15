// The Priorities inbox's list (GET-678, reshaped by GET-681). Priorities holds two things and
// nothing else, in this order:
//
//   After your meetings — one row per meeting: the follow-up card the worker writes after every
//     call (a follow_up_call recommendation carrying `followup`): the thank-you email, the tasks it
//     would create and what goes back to the CRM. A meeting, not an email: the row names the
//     meeting, and the pane reads its wrap-up.
//   To approve — every other draft waiting on a person: pending_actions rows from GET /api/actions
//     (an automation's, a play's, one made in chat or from a recommendation), each named by the
//     `origin` the API reads back.
//
// Briefs, reach-outs, quiet accounts, handoffs and deals past close are Home's and the pages',
// not Priorities'. Pure, so the rules are pinned by tests/prioritiesInbox.test.ts.
//
// A group of more than three shows three and a "+ N more" row.

export type InboxKind = "meeting" | "approve";

export const GROUPS: { kind: InboxKind; label: string }[] = [
  { kind: "meeting", label: "After your meetings" },
  { kind: "approve", label: "To approve" },
];

/** The fields of a /api/home recommendation the inbox reads. */
export type InboxRec = {
  id: string; kind: string; title: string; why: string | null; entity_id: string;
  account: { id: string | null; name: string | null; domain: string | null };
  person?: string | null;
  due?: string | null; when?: string | null; created_at?: string | null;
  document_id?: string | null;
  followup?: {
    status?: string | null;
    email?: { subject?: string | null } | null;
    meeting?: { kind?: string | null; at?: string | null; title?: string | null } | null;
    meetings?: { kind?: string | null; at?: string | null; title?: string | null }[] | null;
  } | null;
};
/** Home's deal changes, passed through for the meeting pane (a deal change on the same account). */
export type InboxDeal = {
  deal_id: string; deal: string | null; account_id: string | null; account: string | null; domain?: string | null;
  stage?: string | null; close_date: string; value?: number | string | null; hubspot_url?: string | null;
};

/** A waiting draft from GET /api/actions?status=pending&include=origin (a pending_actions row). */
export type InboxAction = {
  id: string; kind: "email" | "linkedin_message" | "linkedin_invite";
  recipient: string | null; recipient_email?: string | null; linkedin_url: string | null;
  subject?: string | null; body: string; rationale: string | null;
  status: "pending" | "sent" | "rejected" | "failed";
  error?: string | null; entity_id?: string | null; rec_id?: string | null; thread_id?: string | null;
  created_at?: string | null;
  /** Who wrote it: the automation, play or conversation, and why (lib/actionOrigin.mjs). */
  origin?: { source: string; name: string; why?: string | null; at?: string | null; run_id?: string | null; routine_id?: string | null; builtin?: string | null } | null;
  /** The company it is for (the person's, for a draft to a person). */
  account?: { id: string | null; name: string | null; domain: string | null; person?: string | null } | null;
};
/** An automation run paused for review (GET-737): GET /api/automations/approvals, on the Workspace plan. */
export type InboxRun = {
  run_id: string; requested_at: string | null;
  automation: { id: string; name: string };
  account: { id: string; name: string | null; domain: string | null } | null;
  why: string | null;
  /** "Email draft · 3 tasks". */
  what?: string | null;
};
export type InboxRead = { recommendations?: InboxRec[]; deal_changes?: InboxDeal[]; actions?: InboxAction[]; runs?: InboxRun[] };

export type InboxItem = {
  key: string; kind: InboxKind;
  /** The account's name (the recipient's, for a draft with no account). */
  title: string;
  /** The quiet line: the meeting and when it ran, or "<automation> · <subject>". */
  sub: string | null;
  domain: string | null;
  /** When the meeting ran, or when the draft was written. */
  at: string | null;
  href: string | null;
  /** For a meeting: its title (or kind) and kind, for the pane's header. */
  meeting?: { title: string; kind: string; at: string | null };
  /** For a draft: the automation that drafted it, and the reason it gives. */
  by?: string | null; why?: string | null;
  /** Decided already: what happened ("Sent", "Skipped", "Approved"). The row stays; the counts leave it out. */
  done?: string | null;
  rec?: InboxRec; action?: InboxAction; run?: InboxRun;
};

const pad = (n: number) => String(n).padStart(2, "0");
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/** When a meeting ran, as the row says it: "Today 15:00", "Yesterday 09:30", "29 Sep 14:00". */
export function meetingWhen(at: string | null | undefined, now: Date = new Date()): string {
  const t = at ? new Date(at) : null;
  if (!t || Number.isNaN(t.getTime())) return "";
  const hm = `${pad(t.getHours())}:${pad(t.getMinutes())}`;
  const diff = Math.round((startOfDay(now) - startOfDay(t)) / 86_400_000);
  const d = diff === 0 ? "Today" : diff === 1 ? "Yesterday" : `${t.getDate()} ${MONTHS[t.getMonth()]}`;
  return `${d} ${hm}`;
}

/** Where a meeting opens: its card on Home. */
export const hrefOf = (r: InboxRec): string => `/?followup=${encodeURIComponent(r.id)}`;

/** A follow-up card still waiting on you (the worker's, with its wrap-up). */
const isWaitingCard = (r: InboxRec) => r.kind === "follow_up_call" && !!r.followup && (r.followup.status ?? "ready") === "ready";

const DONE: Partial<Record<InboxAction["status"], string>> = { sent: "Sent", rejected: "Skipped" };

function meetingItem(r: InboxRec, now: Date): InboxItem {
  const fu = r.followup!;
  const ms = (fu.meetings ?? []).filter((m) => m && m.at);
  const last = fu.meeting ?? ms[ms.length - 1] ?? null;
  const kind = last?.kind || "Meeting";
  const title = last?.title || kind;
  const at = last?.at ?? r.when ?? r.created_at ?? null;
  // A merged card ran over several meetings: the latest names the row, a count says the rest.
  const more = ms.length > 1 ? ` +${ms.length - 1}` : "";
  return {
    key: r.id, kind: "meeting", title: r.account.name ?? r.person ?? r.title,
    sub: [`${title}${more}`, meetingWhen(at, now)].filter(Boolean).join(" · "),
    domain: r.account.domain, at, href: hrefOf(r),
    meeting: { title, kind, at }, rec: r,
  };
}

function actionItem(a: InboxAction): InboxItem {
  const by = a.origin?.name ?? null;
  const what = a.kind === "email" ? a.subject || null : a.kind === "linkedin_invite" ? "LinkedIn connection request" : "LinkedIn message";
  const accountId = a.account?.id ?? null;
  return {
    key: `act:${a.id}`, kind: "approve",
    title: a.account?.name ?? a.recipient ?? a.account?.person ?? "Draft",
    sub: [by, what].filter(Boolean).join(" · ") || null,
    domain: a.account?.domain ?? null, at: a.created_at ?? null,
    href: accountId ? `/accounts/${accountId}` : null,
    by, why: a.origin?.why ?? null, done: DONE[a.status] ?? null, action: a,
  };
}

function runItem(r: InboxRun): InboxItem {
  return {
    key: `run:${r.run_id}`, kind: "approve",
    title: r.account?.name ?? r.automation.name,
    sub: [r.automation.name, r.what].filter(Boolean).join(" · ") || null,
    domain: r.account?.domain ?? null, at: r.requested_at ?? null,
    href: r.account?.id ? `/accounts/${r.account.id}` : null,
    by: r.automation.name, why: r.why ?? null, run: r,
  };
}

const newestFirst = (x: InboxItem, y: InboxItem) => (Date.parse(y.at ?? "") || 0) - (Date.parse(x.at ?? "") || 0);

export function buildItems(data: InboxRead | null | undefined, now: Date = new Date()): InboxItem[] {
  const meetings = (data?.recommendations ?? []).filter(isWaitingCard).map((r) => meetingItem(r, now)).sort(newestFirst);
  // Drafts still on the table, and any decided while the panel is open (they keep their row). A
  // failed send is not waiting on anyone's approval any more.
  const drafts = [...(data?.actions ?? []).filter((a) => a.status !== "failed").map(actionItem), ...(data?.runs ?? []).map(runItem)].sort(newestFirst);
  return [...meetings, ...drafts];
}

/**
 * The RevBox built-in job behind an item (GET-897), for its box chip: a meeting's wrap-up is the
 * after-call follow-up's; a draft says so in its origin (a detector's). Null for anything else.
 */
export function builtinOf(item: InboxItem): string | null {
  if (item.kind === "meeting") return "sales_follow_up";
  return item.action?.origin?.builtin ?? null;
}

/** What still needs you: the rows not yet decided. The count on the ⚑ and in each group. */
export const openCount = (items: InboxItem[]) => items.filter((i) => !i.done).length;

export type InboxGroup = { kind: InboxKind; label: string; count: number; shown: InboxItem[]; more: number };

/** The groups in their fixed order; a group of more than `cap` shows `cap` unless expanded. */
export function groupItems(items: InboxItem[], expanded: Set<InboxKind>, cap = 3): InboxGroup[] {
  return GROUPS.map(({ kind, label }) => {
    const all = items.filter((i) => i.kind === kind);
    const shown = expanded.has(kind) || all.length <= cap ? all : all.slice(0, cap);
    return { kind, label, count: openCount(all), shown, more: all.length - shown.length };
  }).filter((g) => g.shown.length > 0);
}

/** The rows on screen, top to bottom: the order ↑ and ↓ walk. */
export const visibleItems = (groups: InboxGroup[]): InboxItem[] => groups.flatMap((g) => g.shown);
