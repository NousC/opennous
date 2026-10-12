// Record parts shared by the account page and the deal page (GET-262): intel chips, tasks, the
// health trend line, a label/value fact row and the activity feed. (The Deal Health card is
// record/DealHealthCard.tsx since GET-609.)
// One copy of each, so a deal reads exactly like the account it belongs to.
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ChevronDown, Circle, CheckCircle2, ExternalLink, Phone, Mail, Plus } from "lucide-react";
import { EntityAvatar } from "@/components/EntityAvatar";
import { ActivityIcon } from "@/components/mind/entities";
import { relTime } from "@/components/mind/shared";
import { ClaimTag, TopicTag, type IntelTopicChip } from "@/components/mind/ClaimTag";
import { resolveDue } from "@/components/reporting/shared";
import { useAuth } from "@/contexts/AuthContext";
import { toast } from "@/components/ui/sonner";
import { EmptyState } from "@/components/ui/empty-state";
import { ListCard, ListMeta, ListText, ListTile } from "@/components/ui/list";
import { cn } from "@/lib/utils";
import { when } from "@/lib/format";
import { SECTIONS, dayKey, sectionRows, sourceInfo, type TaskRecord } from "@/components/tasks/taskModel";
import { TaskDialog } from "@/components/tasks/TaskDialog";

export type Note = { id: string; source?: string; category?: string; label?: string | null; content?: string; created_at?: string; confidence?: number | null; metadata?: any; entity_id?: string; filed_to_deal?: boolean };

// The reading order of an account's intel — who decides and what they want before how they work,
// `general` last because it is the leftovers drawer. A category absent from the list sorts to the
// tail rather than vanishing. Shared by the account page and the deal's Intel tab (GET-404), so a
// deal reads exactly like the account it belongs to.
export const INTEL_ORDER = [
  "risk_signal", "expansion_signal", "declined expansion", "blocker",
  "authority", "buying_signal", "requirement", "objection", "competitor", "budget", "timeline",
  "pain", "goal", "performance", "status_quo", "adoption", "proficiency",
  "seasonality", "staff_change", "tech_stack", "firmographic", "preference", "relationship", "discovery",
  "general",
];

/** A record's topics as the API stores them: groups of claim ids per topic (packages/core intelTopics). */
export type IntelTopic = { label: string; kind: string; summary: string | null; facts: string[][] };

type Chip = { key: string; cat: string; topic?: IntelTopicChip; fact?: Note };

/**
 * The chips for a set of facts: one per topic that has any of them, and a plain chip for each fact
 * no topic covers yet (it arrived after the topics were built). Topics are restricted to `facts`,
 * so a deal shows only the part of each account topic that is on the deal.
 */
export function intelChips(facts: Note[], topics?: IntelTopic[] | null): Chip[] {
  const byId = new Map(facts.map(f => [f.id, f]));
  const chips: Chip[] = [];
  const covered = new Set<string>();
  for (const t of topics ?? []) {
    const groups = t.facts.map(g => g.map(id => byId.get(id)).filter((n): n is Note => !!n)).filter(g => g.length);
    if (!groups.length) continue;
    groups.flat().forEach(n => covered.add(n.id));
    const whole = groups.flat().length === t.facts.flat().length;
    chips.push({ key: `t:${t.label}`, cat: (t.kind || "general").toLowerCase(), topic: { label: t.label, kind: t.kind, summary: whole ? t.summary : null, facts: groups } });
  }
  for (const f of facts) {
    if (covered.has(f.id)) continue;
    let cat = (f.category || "general").toLowerCase();
    // A declined expansion is its own section (GET-417): "Customer declined Lumen ID" under a green
    // "expansion signal" heading read as good news. The category is unchanged; the grouping is.
    if (cat === "expansion_signal" && String((f.metadata as { stance?: string } | undefined)?.stance ?? "").toLowerCase() === "declined") cat = "declined expansion";
    chips.push({ key: f.id, cat, fact: f });
  }
  return chips;
}

/** Facts grouped by category in reading order, as chips — one chip per topic when the record has topics. The one intel renderer for a record. */
export function IntelGroups({ facts, topics, voicedByName, empty }: { facts: Note[]; topics?: IntelTopic[] | null; voicedByName?: (id?: string | null) => string | null; empty?: string }) {
  if (facts.length === 0) {
    return <EmptyState title={empty ?? "No intel yet"} />;
  }
  const groups = new Map<string, Chip[]>();
  for (const c of intelChips(facts, topics)) {
    if (!groups.has(c.cat)) groups.set(c.cat, []);
    groups.get(c.cat)!.push(c);
  }
  const cats = [...groups.keys()].sort(
    (a, b) => ((INTEL_ORDER.indexOf(a) + 1) || 99) - ((INTEL_ORDER.indexOf(b) + 1) || 99));
  return (
    <ListCard className="space-y-1 pb-3">
      {cats.map(cat => (
        <div key={cat}>
          <SectionLabel label={sentenceCat(cat)} count={groups.get(cat)!.length} />
          <div className="flex flex-wrap gap-1.5 px-2">
            {groups.get(cat)!.map(c => c.topic
              ? <TopicTag key={c.key} topic={c.topic} voicedBy={voicedByName} />
              : <ClaimTag key={c.key} note={c.fact!} voicedBy={voicedByName?.(c.fact!.metadata?.voiced_by_contact_id)} />)}
          </div>
        </div>
      ))}
    </ListCard>
  );
}
const sentenceCat = (c: string) => { const t = c.replace(/_/g, " "); return t.charAt(0).toUpperCase() + t.slice(1); };

/** A list section's label on a record tab, the palette's group label: small, light, the count lighter. */
export function SectionLabel({ label, count, className }: { label: string; count?: number; className?: string }) {
  return (
    <div className={cn("flex items-baseline gap-1.5 px-2 pb-1 pt-2 text-[11.5px] font-medium text-muted-foreground/60", className)}>
      {label}{count != null && <span className="font-normal tabular-nums text-muted-foreground/50">{count}</span>}
    </div>
  );
}

export type DealSignal = {
  key: string; label: string; level?: string; tone: "good" | "warn" | "bad" | "unknown"; value?: string; evidence?: string[]; reason?: string | null;
  /** The meter from the grade (GET-804, account health): bars filled and their colour. */
  meter?: { bars: number; color: string };
  /** The pop-up's first line, the verdict in plain words (GET-804). */
  verdict?: string | null;
  /** Small labelled numbers under the verdict (GET-804). */
  stats?: { label: string; value: string }[];
  /** The panel's one line after the label, "5 open, one is three weeks old" (GET-807, account health). */
  summary?: string | null;
  /** What the factor counted, as rows: claims for blockers and risks, people for decision makers (GET-807). */
  items?: FactorItem[];
  /** One plain line on what would improve the factor, picked from its items (GET-807). */
  improve?: string | null;
  /** Engagement only: conversations per week (8, oldest first) and the numbers behind it (GET-807). */
  detail?: { weeks: number[]; last_at: string | null; recent: number; prior: number; meetings: number } | null;
};
/** One row in a factor panel (GET-807): a claim (blocker, risk) or a decision maker. */
export type FactorItem = {
  id?: string; key?: string; label?: string; content?: string; quote?: string | null; speaker?: string | null;
  said_at?: string | null; status?: string; aging?: boolean; age_days?: number | null;
  name?: string | null; title?: string | null; role?: string; unnamed?: boolean;
};
export type HealthPoint = { at: string; score: number };
export type DealHealth = { score: number | null; band: string | null; smart: DealSignal[]; numeric: DealSignal[]; history?: HealthPoint[] };




/**
 * Close a task by hand, or reopen one (GET-407). The one write on this surface: PATCH the
 * action_item claim's status. Optimistic — the row moves at once and moves back if the write
 * fails — because a tick that waits on a round trip reads as a tick that did not take.
 *
 * `setTasks` is the page's own state setter over {open, done}; the hook moves the row between
 * the two lists and stamps the same fields the API will, so the done row can say "closed by
 * hand" before the next load.
 */
export function useTaskToggle(setTasks: (f: (t: { open: any[]; done: any[] }) => { open: any[]; done: any[] }) => void) {
  const { session, userData } = useAuth();
  const token = session?.access_token;
  const wsId = (userData as any)?.workspace?.id;
  const apiUrl = import.meta.env.VITE_API_URL ?? "";
  const run = async (t: any, next: "open" | "done"): Promise<void> => {
    if (!token || !wsId || !t?.id) return;
    const property = String(t.id).includes(":") ? String(t.id).slice(String(t.id).indexOf(":") + 1) : "";
    if (!property) return;
    const now = new Date().toISOString();
    const stamped = next === "done"
      ? { ...t, status: "done", completed_at: now, completed_by: "user", completed_reason: "you marked it done", completed_evidence: null }
      : { ...t, status: "open", completed_at: null, completed_by: null, completed_reason: null, completed_evidence: null, reopened_at: now };
    const move = (rows: { open: any[]; done: any[] }, row: any, to: "open" | "done") => ({
      open: [...rows.open.filter(x => x.id !== row.id), ...(to === "open" ? [row] : [])],
      done: [...(to === "done" ? [row] : []), ...rows.done.filter(x => x.id !== row.id)],
    });
    setTasks(rows => move(rows, stamped, next));
    try {
      const r = await fetch(`${apiUrl}/api/tasks/${t.entity_id}/${encodeURIComponent(property)}`, {
        method: "PATCH", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ workspaceId: wsId, status: next }),
      });
      if (!r.ok) throw new Error(String(r.status));
      // Say it was saved (GET-808): the row leaves for Done, often far down the list, and without a
      // word it read as a click that did nothing.
      if (next === "done") toast("Marked done", { action: { label: "Undo", onClick: () => { void run(stamped, "open"); } } });
      else toast("Reopened");
    } catch {
      setTasks(rows => move(rows, t, next === "done" ? "open" : "done"));
      toast.error(next === "done" ? "Couldn't mark it done. Try again." : "Couldn't reopen it. Try again.");
    }
  };
  return run;
}

/** A person a task can point at, as the page holding the list knows them. */
export type TaskPerson = { id: string; name: string; title?: string | null; photo_url?: string | null };

/**
 * Which tool a task came out of, for the logo — the note-taker behind a call, the mailbox behind
 * an email. Read off the row: the link's host first, then the source_ref, then the claim's own
 * property ("action_item.gmail_…"), and only then the bare source type.
 */
export function taskSourceTool(t: any): { tool: string; label: string } | null {
  const url = String(t?.source_url ?? "");
  const ref = String(t?.source_ref ?? "");
  const prop = String(t?.id ?? "").split(":")[1] ?? "";
  const host = /https?:\/\/([^/]+)/.exec(url)?.[1]?.toLowerCase() ?? "";
  const pick = (tool: string, label: string) => ({ tool, label });
  if (host.includes("fellow")) return pick("fellow", "Fellow");
  if (host.includes("fireflies")) return pick("fireflies", "Fireflies");
  if (host.includes("fathom")) return pick("fathom", "Fathom");
  if (host.includes("granola")) return pick("granola", "Granola");
  if (host.includes("hubspot")) return pick("hubspot", "HubSpot");
  for (const tool of ["fellow", "fireflies", "fathom", "granola", "gmail", "hubspot", "linkedin"]) {
    if (ref.startsWith(`source://${tool}/`) || prop.startsWith(`${tool}_`)) return pick(tool, tool === "gmail" ? "Gmail" : tool[0].toUpperCase() + tool.slice(1));
  }
  if (prop.startsWith("email_") || t?.source_type === "email") return pick("gmail", "Email");
  if (prop.startsWith("linkedin_") || t?.source_type === "linkedin") return pick("linkedin", "LinkedIn");
  return null;
}

function fullDate(iso?: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric" });
}

/**
 * One task, the way every record page shows it (GET-408).
 *
 * Collapsed: the task, its context sentence, and who owes it — with their picture when they hold
 * a seat — and the due date on the far right. Open: who it is owed to, who asked, the source with
 * the tool's logo and the link back to it. Never the transcript's words — the link is where those
 * live. Every field is off the row; nothing is looked up. A task written before the writers stamped provenance shows what it
 * has and no more.
 */
export function TaskRow({ t, checked: checkedProp, onToggle, personOf, showQuote = false, onOpen }: {
  t: any; checked: boolean;
  /** Open the task in its dialog (GET-808). Without it, the row expands in place as before. */
  onOpen?: (t: any) => void;
  onToggle?: (t: any, next: "open" | "done") => void;
  /** The page's own people, so "owed to" can carry a picture and a title and open the person. */
  personOf?: (id: string) => TaskPerson | null | undefined;
  /**
   * The sentence the promise was made in, under the task. Off by default: the record pages that
   * predate it keep GET-408's rule (provenance is the link). The account page opts in, because a
   * rep reading an account's task list asks "why is this here" before "where did it come from".
   */
  showQuote?: boolean;
}) {
  const [open, setOpen] = useState(false);
  // A tick shows at once, struck through in place, and the row moves to Done a beat later (GET-808).
  const [ticking, setTicking] = useState(false);
  const checked = checkedProp || ticking;
  const tick = () => {
    if (!onToggle) return;
    if (checkedProp) { onToggle(t, "open"); return; }
    setTicking(true);
    window.setTimeout(() => { onToggle(t, "done"); setTicking(false); }, 650);
  };
  const navigate = useNavigate();
  const due = resolveDue(t);
  const Icon = checked ? CheckCircle2 : Circle;

  // Who owes it: a seat (with avatar) beats the recorded name beats the address made readable.
  const ownerName: string | null = t.assignee?.name ?? t.owner_label ?? t.owner_name ?? null;
  const ownerAvatar: string | null = t.assignee?.avatar ?? null;

  // Who it is owed to. `for_entity_id` resolves against the page's people for the picture/title.
  const forPerson = t.for_entity_id ? personOf?.(t.for_entity_id) ?? null : null;
  const forName: string | null = forPerson?.name ?? t.for_name ?? null;

  const tool = taskSourceTool(t);
  const sourceTitle: string | null = t.source_title ?? null;
  const sourceKind = t.source_type === "meeting" ? "call" : t.source_type === "email" ? "email thread" : t.source_type === "linkedin" ? "LinkedIn message" : "source";
  const said = fullDate(t.occurred_at);
  // The transcript is never quoted on the row (product decision, GET-408): the logo and the link are the
  // provenance, and the sentence lives one click away in the tool that recorded it.
  const hasDetail = !!(forName || t.asked_by || sourceTitle || t.source_url || tool || t.completed_reason);

  const made = sourceInfo(t as TaskRecord).text || null;
  const created = fullDate(t.recorded_at);
  const createdTitle = created ? `Created ${created}` : null;

  const dueText = due.at ? `${due.label} · ${due.relative}` : due.phrase;
  const dueTone = due.overdue ? "text-risk"
    : due.at && (due.daysLeft ?? 99) <= 2 ? "text-warning" : "text-muted-foreground/70";

  return (
    <div className="group/task rounded-lg transition-colors duration-fast hover:bg-hover">
      <div className="flex items-start gap-2.5 px-2 py-2.5">
        {onToggle ? (
          <button type="button" onClick={tick}
            aria-label={checked ? "Reopen" : "Mark done"} title={checked ? "Reopen" : "Mark done"}
            className={cn("flex h-5 w-6 flex-shrink-0 items-center justify-center rounded-full transition-colors duration-fast", checked ? "text-positive hover:text-muted-foreground/60" : "text-muted-foreground/35 hover:text-positive")}>
            <Icon className="h-4 w-4" />
          </button>
        ) : (
          <span className="flex h-5 w-6 flex-shrink-0 items-center justify-center"><Icon className={cn("h-4 w-4", checked ? "text-positive" : "text-muted-foreground/35")} /></span>
        )}

        <button type="button" onClick={() => (onOpen ? onOpen(t) : hasDetail && setOpen(o => !o))} className={cn("min-w-0 flex-1 text-left", onOpen || hasDetail ? "cursor-pointer" : "cursor-default")}>
          <div className={cn("text-[13px] leading-5", checked ? "text-muted-foreground/60 line-through" : "text-foreground")}>{t.title}</div>
          {t.description && !checked && <p className="mt-0.5 text-[12.5px] leading-snug text-muted-foreground/70">{t.description}</p>}
          {showQuote && typeof t.quote === "string" && t.quote.trim() && (
            <span className={cn("mt-1 block border-l-2 border-border pl-2 text-[12px] italic leading-snug line-clamp-2 [overflow-wrap:anywhere]", checked ? "text-muted-foreground/45" : "text-muted-foreground/75")}>
              “{t.quote.trim()}”
              {(t.stated_by === "them" || t.stated_by === "us") && (
                <span className="not-italic text-muted-foreground/50"> · {t.stated_by === "them" ? "they said" : "we said"}</span>
              )}
            </span>
          )}
          <div className="mt-1 flex items-center gap-1.5 text-[11.5px] text-muted-foreground/70">
            {ownerName ? (
              <>
                <EntityAvatar kind="person" name={ownerName} photoUrl={ownerAvatar} className="h-4 w-4 rounded-full flex-shrink-0" textClassName="text-[7px] font-medium" />
                <span className="truncate">{ownerName}</span>
              </>
            ) : (
              <span className="italic text-muted-foreground/45">unassigned</span>
            )}
            {/* A CHASE (GET-425): the commitment was theirs, the follow-up is ours. The row is
                ours either way; this is what makes it read as a chase rather than a deliverable. */}
            {t.awaiting_them && !checked && (
              <span className="whitespace-nowrap text-warning">
                · waiting on {t.owed_by ?? "them"}
              </span>
            )}
            {/* Where and when it was made (GET-785): "Call · 7 Oct", "Added · today". */}
            {made && (
              <span className="truncate text-muted-foreground/55" title={createdTitle ?? undefined}>· {made}</span>
            )}
            {checked && t.completed_by && (
              <span className="text-muted-foreground/50">· {t.completed_by === "user" ? "closed by hand" : "closed automatically"}{t.completed_at ? ` ${relTime(t.completed_at)}` : ""}</span>
            )}
          </div>
        </button>

        <div className="flex h-5 items-center gap-1.5 flex-shrink-0">
          {dueText && !checked && <span title={due.phrase ?? undefined} className={cn("text-[12px] tabular-nums whitespace-nowrap", dueTone)}>{dueText}</span>}
          {hasDetail && !onOpen && (
            <button type="button" onClick={() => setOpen(o => !o)} aria-label={open ? "Hide details" : "Show details"}
              className="rounded p-0.5 text-muted-foreground/40 opacity-0 transition-[opacity,color] group-hover/task:opacity-100 focus-visible:opacity-100 hover:text-foreground aria-expanded:opacity-100" aria-expanded={open}>
              <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", open && "rotate-180")} />
            </button>
          )}
        </div>
      </div>

      {open && hasDetail && !onOpen && (
        <div className="mb-2 ml-[42px] mr-2 space-y-2 border-l border-hairline pl-3 text-[12.5px]">
          {(forName || t.asked_by) && (
            <div className="flex items-start gap-2">
              <span className="w-[72px] flex-shrink-0 text-[12px] text-muted-foreground pt-px">{t.awaiting_them ? "Waiting on" : "Owed to"}</span>
              <div className="min-w-0 flex-1">
                {forName ? (
                  <button type="button" disabled={!forPerson} onClick={() => forPerson && navigate(`/people/${forPerson.id}`)}
                    className={cn("flex items-center gap-2 text-left", forPerson ? "hover:underline underline-offset-2" : "cursor-default")}>
                    <EntityAvatar kind="person" name={forName} photoUrl={forPerson?.photo_url ?? null} className="h-5 w-5 rounded-full flex-shrink-0" textClassName="text-[8px] font-medium" />
                    <span className="text-foreground/90">{forName}</span>
                    {forPerson?.title && <span className="text-muted-foreground/55">· {forPerson.title}</span>}
                  </button>
                ) : <span className="text-muted-foreground/45">not said</span>}
                {t.asked_by && <div className="mt-0.5 text-muted-foreground/60">asked for by {t.asked_by}</div>}
              </div>
            </div>
          )}

          {(sourceTitle || t.source_url || tool) && (
            <div className="flex items-start gap-2">
              <span className="w-[72px] flex-shrink-0 text-[12px] text-muted-foreground pt-px">From</span>
              <div className="min-w-0 flex-1 flex items-center gap-2">
                {tool
                  ? <img src={`/provider-logos/${tool.tool}.${tool.tool === "fellow" || tool.tool === "linkedin" ? "png" : "svg"}`} alt={tool.label} className="h-4 w-4 rounded-sm object-contain flex-shrink-0" onError={e => { (e.target as HTMLImageElement).style.display = "none"; }} />
                  : t.source_type === "meeting" ? <Phone className="h-4 w-4 text-muted-foreground/45 flex-shrink-0" /> : <Mail className="h-4 w-4 text-muted-foreground/45 flex-shrink-0" />}
                <span className="min-w-0 truncate text-foreground/85">{sourceTitle ?? `a ${sourceKind}`}{said ? <span className="text-muted-foreground/55"> · {said}</span> : null}</span>
                {t.source_url && (
                  <a href={t.source_url} target="_blank" rel="noreferrer" className="ml-auto flex-shrink-0 inline-flex items-center gap-1 text-[12px] text-ink-2 underline decoration-border underline-offset-2 hover:text-foreground">
                    Open {tool?.label ?? "source"} <ExternalLink className="h-3 w-3" />
                  </a>
                )}
              </div>
            </div>
          )}

          {checked && t.completed_reason && (
            <div className="flex items-start gap-2">
              <span className="w-[72px] flex-shrink-0 text-[12px] text-muted-foreground pt-px">Closed</span>
              <div className="min-w-0 flex-1 text-muted-foreground/70">{t.completed_reason}</div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** How a record's task list is doing. `error` is shown as such — an outage must not read as "no tasks". */
export type TaskListState = "loading" | "error" | "ready";



/**
 * A record's tasks as its Tasks tab lists them (GET-785): the open ones cut by when they are due,
 * the way the Tasks page cuts them (Overdue, This week, Next week, Later, No date), then Done.
 */
export function taskSections(open: any[], done: any[], now = new Date()): { label: string; rows: any[]; done?: boolean }[] {
  // Bucket on the day the row shows, not on due_at alone: a task said "by Friday" often arrives
  // with only its phrase, and the row resolves it (resolveDue) — the section must agree with it.
  const byDay = new Map<any, any>();
  const dated = open.map(t => {
    const at = resolveDue(t, now).at;
    const row = { ...t, due_at: at ? dayKey(at) : null };
    byDay.set(row, t);
    return row as TaskRecord;
  });
  return [
    ...SECTIONS.map(s => ({ label: s.label, rows: sectionRows(dated, s, now).map(r => byDay.get(r)) })),
    { label: "Done", rows: done, done: true },
  ];
}

/**
 * The Tasks tab of a record. `sections` are rendered in order, each with its own heading; a
 * section with no rows is skipped. The empty message is the caller's — an account and a deal
 * say different things — and it is only shown once the list has actually loaded (GET-400: the
 * account tab used to say "No tasks" while the request was still in flight, and forever after a
 * failure, and the two were indistinguishable from an account with nothing owed).
 */
/** Sections a long list starts folded (GET-808): the work due soon stays open, the rest one click away. */
const FOLDED_BY_DEFAULT = new Set(["Later", "No date", "Done"]);

export function TaskList({ state, sections, empty, onToggle, personOf, showQuote = false, onAdd, recordName, recordDomain }: {
  state: TaskListState;
  sections: { label: string; rows: any[]; done?: boolean; hint?: string }[];
  empty: string;
  /** Tick to close, click to reopen. Omitted, the rows are read-only. */
  onToggle?: (t: any, next: "open" | "done") => void;
  /** The page's people, for the "owed to" line. */
  personOf?: (id: string) => TaskPerson | null | undefined;
  /** Show each task's source sentence under it (TaskRow.showQuote). */
  showQuote?: boolean;
  /** Add a task on this record. Omitted, there is no Add button. */
  onAdd?: () => void;
  /** The record, for the task dialog's header. */
  recordName?: string | null;
  recordDomain?: string | null;
}) {
  const [folded, setFolded] = useState<Set<string>>(() => new Set(FOLDED_BY_DEFAULT));
  const [openTask, setOpenTask] = useState<any | null>(null);
  // A due day changed in the dialog shows on the row at once; the next load reads it from the API.
  const [dueOverride, setDueOverride] = useState<Record<string, string | null>>({});
  const withDue = (t: any) => (t?.id && t.id in dueOverride ? { ...t, due_at: dueOverride[t.id], due_phrase: dueOverride[t.id] ? null : t.due_phrase } : t);

  if (state === "loading") return <p className="py-12 text-center text-[13px] text-muted-foreground/70">Loading tasks…</p>;
  if (state === "error") return <EmptyState title="Tasks could not be loaded right now" body="Reload to try again." />;
  const live = sections.filter(s => s.rows.length > 0);
  const addButton = onAdd ? (
    <button type="button" onClick={onAdd}
      className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[12.5px] text-muted-foreground transition-colors duration-fast hover:bg-hover hover:text-foreground">
      <Plus className="h-3.5 w-3.5" /> Add task
    </button>
  ) : null;
  if (!live.length) return (
    <div className="space-y-2">
      {addButton && <div className="flex justify-end">{addButton}</div>}
      <EmptyState title={empty} />
    </div>
  );
  return (
    <>
      <ListCard>
        {/* The list's own header (GET-808): the count on the left, Add task on the right. */}
        <div className="flex min-h-8 items-center gap-2 px-2 pb-1">
          <span className="text-[13px] font-medium text-foreground">Tasks</span>
          <span className="flex-1" />
          {addButton}
        </div>
        {live.map(sec => {
          const isFolded = folded.has(sec.label);
          return (
            <div key={sec.label} className="mb-0.5 last:mb-0">
              <button type="button" aria-expanded={!isFolded}
                onClick={() => setFolded(f => { const x = new Set(f); if (x.has(sec.label)) x.delete(sec.label); else x.add(sec.label); return x; })}
                className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-[12px] font-medium text-muted-foreground/70 transition-colors duration-fast hover:bg-hover hover:text-foreground">
                <ChevronDown className={cn("h-3.5 w-3.5 transition-transform duration-fast", isFolded && "-rotate-90")} />
                <span className={cn(sec.label === "Overdue" && "text-risk/80")}>{sec.label}</span>
                <span className="font-normal tabular-nums text-muted-foreground/50">{sec.rows.length}</span>
              </button>
              {!isFolded && (
                <>
                  {sec.hint && <p className="px-2 pb-1 text-[12px] text-muted-foreground/70">{sec.hint}</p>}
                  {sec.rows.map((t, i) => <TaskRow key={t.id ?? i} t={withDue(t)} checked={!!sec.done} onToggle={onToggle} personOf={personOf} showQuote={showQuote} onOpen={setOpenTask} />)}
                </>
              )}
            </div>
          );
        })}
      </ListCard>
      <TaskDialog task={openTask ? withDue(openTask) : null} open={!!openTask} onOpenChange={o => { if (!o) setOpenTask(null); }}
        recordName={recordName} recordDomain={recordDomain} onToggle={onToggle}
        onDue={(t, dueAt) => setDueOverride(d => ({ ...d, [t.id]: dueAt }))} />
    </>
  );
}

// The health LINE: where this account's score has actually been, ending on today's. A flat
// line is now a real statement (the score hasn't moved), not the absence of history — and a
// single point says so in words rather than drawing a fake trend.
export function HealthChart({ score, color, history }: { score: number | null; color: string; history?: HealthPoint[] }) {
  if (score == null) return null;
  const W = 320, H = 88, pad = 6;
  const yOf = (s: number) => H - pad - (Math.max(0, Math.min(100, s)) / 100) * (H - pad * 2);

  // Today's score ends the line, unless the history already has a point for today. Appended even
  // when it equals the last point, so a steady score reads as a flat line up to today (GET-804),
  // not as "First score" because the one earlier point matched.
  const pts: HealthPoint[] = [...(history ?? [])];
  const last = pts[pts.length - 1];
  const todayKey = new Date().toISOString().slice(0, 10);
  if (!last || last.at.slice(0, 10) !== todayKey) pts.push({ at: new Date().toISOString(), score });
  else if (last.score !== score) pts[pts.length - 1] = { at: last.at, score };

  const grid = [pad, H / 2, H - pad].map((gy, i) =>
    <line key={i} x1="0" x2={W} y1={gy} y2={gy} className="text-border" stroke="currentColor" strokeWidth="0.5" />);

  if (pts.length < 2) {
    const y = yOf(score);
    return (
      <div>
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-[88px]" preserveAspectRatio="none">
          {grid}
          <line x1={pad} x2={W - pad} y1={y} y2={y} stroke={color} strokeWidth="2.5" strokeLinecap="round" />
          <circle cx={pad} cy={y} r="3.5" fill={color} /><circle cx={W - pad} cy={y} r="3.5" fill={color} />
        </svg>
        <div className="text-[10px] text-muted-foreground/40 mt-0.5">First score — no history to compare yet</div>
      </div>
    );
  }

  const t0 = Date.parse(pts[0].at), t1 = Date.parse(pts[pts.length - 1].at);
  const span = Math.max(1, t1 - t0);
  const xOf = (at: string) => pad + ((Date.parse(at) - t0) / span) * (W - pad * 2);
  const d = pts.map((p, i) => `${i ? "L" : "M"}${xOf(p.at).toFixed(1)},${yOf(p.score).toFixed(1)}`).join(" ");
  const first = pts[0], latest = pts[pts.length - 1];
  const delta = latest.score - first.score;
  const day = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });

  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-[88px]" preserveAspectRatio="none">
        {grid}
        <path d={d} fill="none" stroke={color} strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
        {pts.map((p, i) => <circle key={i} cx={xOf(p.at)} cy={yOf(p.score)} r={i === pts.length - 1 ? 3.5 : 2} fill={color} opacity={i === pts.length - 1 ? 1 : 0.55} />)}
      </svg>
      <div className="flex justify-between text-[10px] text-muted-foreground/40 mt-0.5">
        <span>{day(first.at)} · {first.score}</span>
        <span>{delta === 0 ? "no change" : `${delta > 0 ? "+" : ""}${delta} since ${day(first.at)}`}</span>
        <span>{day(latest.at)} · {latest.score}</span>
      </div>
    </div>
  );
}

export function Fact({ label, value, icon: Icon }: { label: string; value: string | null; icon?: any }) {
  return (
    <div className="flex items-start gap-2">
      <span className="w-[104px] flex-shrink-0 flex items-center gap-1.5 text-[12px] text-muted-foreground/55">
        {Icon && <Icon className="h-3.5 w-3.5 text-muted-foreground/40 flex-shrink-0" strokeWidth={1.75} />}
        <span className="truncate">{label}</span>
      </span>
      <span className={cn("text-[13px] flex-1 min-w-0 break-words", value ? "text-foreground" : "text-muted-foreground/40")}>{value ?? "—"}</span>
    </div>
  );
}

/**
 * One row per thing that happened. An email says who it went to or came from and shows the FIRST
 * few lines of what was written — the rest opens on click (GET-277). Before this, a reply printed
 * the whole quoted thread inline, so one row read as four people's emails at once.
 */
const nameOfAddress = (a?: string | null) => {
  const s = String(a ?? "").trim();
  const m = /^\s*"?([^"<]+?)"?\s*<(.+)>\s*$/.exec(s);
  return (m ? m[1] : s.split("@")[0] || s).trim() || null;
};

export function ActivityRow({ a }: { a: any }) {
  const [open, setOpen] = useState(false);
  const raw = a.raw_data ?? {};
  const type = String(a.activity_type || "");
  const isEmail = type.startsWith("email");
  const body: string | null = a.subtitle || raw.text || raw.body_text || raw.body || null;
  const subject: string | null = isEmail ? (raw.subject ?? null) : null;
  // Who the counterpart is, so "email sent" never reads as if THEY sent it.
  const other = a.contactName
    || (type === "email_sent" ? nameOfAddress((raw.to ?? [])[0]) : nameOfAddress(raw.from));
  const label = isEmail
    ? `${type === "email_sent" ? "Email sent to" : "Email from"} ${other ?? "someone"}`
    : sentenceCat(type) || "Activity";
  // Someone else's email: the row stays (it is real activity on this account) but its words are
  // only for the people who were on it. Say that, rather than "no text" — which reads as empty.
  const hidden = a.redacted === true || raw.redacted === true;
  const long = !!body && body.length > 160;
  // A palette row: the tool's logo in the 24px tile, what it was at 13px, who it was with in the
  // quiet tone, when; the first lines of what was said under it, lighter.
  return (
    <div className="rounded-lg px-2 py-2 transition-colors duration-fast hover:bg-hover">
      <div className="flex min-w-0 items-center gap-2.5">
        <ListTile><ActivityIcon source={a.source} type={type} /></ListTile>
        <ListText title={label} sub={subject ?? (!isEmail ? a.contactName : null) ?? undefined} />
        <ListMeta>{when(a.occurred_at || a.created_at)}</ListMeta>
      </div>
      {hidden && (
        <p className="mt-0.5 pl-[34px] text-[12.5px] text-muted-foreground/60">Only the people on this email can read it</p>
      )}
      {!hidden && body && (
        <div className="mt-0.5 pl-[34px]">
          <p className={cn("text-[12.5px] leading-relaxed text-muted-foreground/90 whitespace-pre-wrap", !open && "line-clamp-2")}>{body}</p>
          {long && (
            <button onClick={() => setOpen(o => !o)} className="mt-1 text-[11.5px] text-muted-foreground/60 hover:text-foreground transition-colors">
              {open ? "Show less" : "Show more"}
            </button>
          )}
        </div>
      )}
      {raw.quoted_chars > 0 && open && (
        <p className="pl-[34px] mt-1 text-[11px] text-muted-foreground/45">Replying to earlier messages in this thread — each is its own row.</p>
      )}
    </div>
  );
}

// A meeting is filed once per attendee, and again by every source that saw it. On a four-person
// call recorded by Fellow and mirrored into HubSpot that is EIGHT rows for one conversation —
// which is what a customer's account feed actually looked like: "meeting held" five times over, the
// same September review, under two different icons.
//
// No id dedupes it. The per-attendee rows are genuinely distinct observations, and the two sources
// have unrelated id spaces. What identifies a meeting across both is WHEN it happened and WHAT it
// was called. Times round to five minutes because a calendar entry and a recording rarely agree to
// the second; the title is stripped to letters and digits so "Larkfield Toyota | review with
// Harborline" matches "Meeting: Larkfield Toyota | review with Harborline".
//
// A meeting with no parseable time keeps its row — losing a real conversation to tidy a feed is
// the wrong trade.
export const meetingKey = (a: any): string | null => {
  if (!String(a?.activity_type || "").toLowerCase().includes("meeting")) return null;
  const when = Date.parse(a.occurred_at ?? a.created_at ?? "");
  if (!Number.isFinite(when)) return null;
  const title = String(a.subject ?? a.title ?? a.raw_data?.title ?? a.subtitle ?? "")
    .toLowerCase().replace(/^\s*meeting:\s*/, "").replace(/[^a-z0-9]+/g, "");
  return `mtg:${Math.round(when / 300_000)}:${title}`;
};

/**
 * One row per thing that actually happened. The same email is filed on every person it involves,
 * and the same meeting on every attendee AND in every source that saw it. Exported so a page that
 * mixes activity with other rows (the account's Activity tab) collapses them by the same rule.
 */
export function dedupeActivity(acts: any[] | null | undefined): any[] {
  const seen = new Set<string>();
  return (acts ?? []).filter((a: any) => {
    const key = meetingKey(a)
      || a.raw_data?.rfc_message_id || a.raw_data?.message_id || a.raw_data?.hubspot_id || null;
    if (!key) return true;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function ActivityFeed({ acts }: { acts: any[] }) {
  const rows = useMemo(() => dedupeActivity(acts), [acts]);
  if (rows.length === 0) return <EmptyState title="No activity yet" />;
  return (
    // The account's Activity tab draws the same card, so a deal's and a person's feed read alike.
    <ListCard className="min-w-0 [overflow-wrap:anywhere]">
      {rows.slice(0, 80).map((a: any, i: number) => <ActivityRow key={a.id ?? i} a={a} />)}
    </ListCard>
  );
}

export const bandOf = (score: number | null, band?: string | null) =>
  band ?? (score == null ? "Not enough data" : score >= 70 ? "Healthy" : score >= 40 ? "Needs attention" : "At risk");
