// The Priorities inbox (GET-678): the panel the top bar's ⚑ opens. Two panes, the way a mail client
// reads: the list on the left, the selected item read in place on the right.
//
// Since GET-681 it holds three things only:
//   After your meetings — one row per meeting, its wrap-up on the right: Home's FollowUpCard
//     (variant "pane") in three parts, the thank-you email, the tasks, the CRM updates, with every
//     action Home offers (edit, copy, Approve / Sync, Skip).
//   From signals (GET-944) — a signal a call raised, with its next move ready: what was said and by
//     whom, who the play found the person it named is, then the draft in the same ApprovalCard.
//     Send, Snooze (3 days) and Not relevant.
//   Drafts to review — every other draft waiting on a person (pending_actions), opened in chat's own
//     ApprovalCard: To / Subject / body edited in place, Approve & send and Skip are the existing
//     approve and reject routes, so there is no second send path.
// A decision keeps its row with the result until the panel closes; the counts leave it out.
//
// Since 2026-10-29 the Inbox page splits it into tabs (inboxModel TABS): Post-meetings, Follow-ups
// (signals, drafts and runs to review together) and Results, what each finished run wrote
// (OutcomePane). Each tab is a table like Accounts and Workflows, newest first; a row opens the
// item in a sheet on the right, with everything the old reading pane had.
//
// Keyboard: j / k move through the rows and Enter opens one (DataTable); Esc closes the sheet.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ArrowUpRight, Boxes, Check, Clock, Loader2, Zap } from "lucide-react";
import { cn } from "@/lib/utils";
import { day, time, when } from "@/lib/format";
import { freshAccessToken } from "@/lib/freshToken";
import { EntityAvatar } from "@/components/EntityAvatar";
import { DataTable, type Column } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { FollowUpCard, followUpApi } from "@/components/home/FollowUps";
import { ApprovalCard, type PendingAction } from "@/components/ApprovalCard";
import { Row, type RecDetailFull } from "@/components/home/RecParts";
import type { DealChange, FollowUp, RecDetail, Recommendation } from "@/components/home/types";
import { ACTION_DECIDED, FOLLOW_UP_DECIDED, REC_DISMISSED } from "./events";
import type { ItemChip } from "@/lib/cloud";
import { buildItems, builtinOf, followUpLine, meetingWhen, signalOf, tabOf, type InboxItem, type InboxRead, type InboxTab } from "./inboxModel";
import { decidedKey, draftsKey, markDraftDecided } from "./drafts";
import { Checkbox } from "@/components/ui/checkbox";
import { toast } from "sonner";
import { ApprovalPane as RunReviewPane, type Approval } from "@/components/AutomationApprovals";
import { OutputView, type RunOutput } from "@/components/AutomationRunDetail";
import { automationsFetch } from "@/lib/automations";

const apiUrl = import.meta.env.VITE_API_URL ?? "";

/** The authorised GET every read here makes. */
async function getJson<T>(path: string, fallbackToken: string | undefined): Promise<T> {
  const token = (await freshAccessToken()) ?? fallbackToken ?? "";
  const r = await fetch(`${apiUrl}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(String(r.status));
  return r.json();
}

const isToday = (iso: string) => new Date(iso).toDateString() === new Date().toDateString();

/** The right-hand date: how long ago a meeting ran ("2h ago", "Yesterday"); when a draft was
 *  written ("Drafted 14:05" today, else its day). */
const dateOf = (i: InboxItem) => {
  if (!i.at) return "";
  if (i.kind === "meeting") return when(i.at);
  if (i.kind === "outcome") return isToday(i.at) ? time(i.at) : day(i.at);
  return isToday(i.at) ? `Drafted ${time(i.at)}` : day(i.at);
};

/** What an empty tab says. */
const EMPTY: Record<InboxTab, string> = {
  meetings: "No meetings waiting on a follow-up.",
  act: "No follow-ups waiting. Signals and drafts land here.",
  workflows: "No workflow results in the last 14 days.",
};

/** A follow-up card's decision, as its row shows it. */
const FOLLOW_UP_DONE: Record<string, string> = { approved: "Approved", synced: "Synced", skipped: "Skipped" };

export function PrioritiesInbox({ tab, data, loading, failed, ws, token, onClose, focus = null, chipFor = null }: {
  /** The tab whose rows the list shows. */
  tab: InboxTab;
  data: InboxRead | undefined; loading: boolean; failed: boolean; ws: string; token: string | undefined;
  onClose: () => void;
  /** Where the built-in job behind an item lives (GET-897), as a chip; none without it. */
  chipFor?: ((builtinKey: string | null) => ItemChip | null) | null;
  /** An item to open on, e.g. "run:<id>" from a test run's View (GET-739). */
  focus?: string | null;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  // A follow-up decided here keeps its row (and shows its receipt) until the page closes, so the
  // table does not jump under the pointer; the next open reads Home afresh.
  const [decided, setDecided] = useState<Record<string, FollowUp>>({});
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  // Automation reviews finished here keep their row, marked, until the page closes (GET-737).
  const [runsDone, setRunsDone] = useState<Set<string>>(new Set());
  // The row open in the sheet; a link's ?item= opens on it.
  const [selected, setSelected] = useState<string | null>(focus);
  useEffect(() => { if (focus) setSelected(focus); }, [focus]);

  const items = useMemo(() => buildItems(data).filter((i) => !dismissed.has(i.key)).map((i) => {
    if (i.run && runsDone.has(i.key)) return { ...i, done: "Done" };
    const fu = decided[i.key];
    return fu && fu.status && FOLLOW_UP_DONE[fu.status] ? { ...i, done: FOLLOW_UP_DONE[fu.status] } : i;
  }), [data, dismissed, decided, runsDone]);
  // This tab's rows, newest first (buildItems sorts within each kind; Follow-ups mixes three).
  const visible = useMemo(() => items.filter((i) => tabOf(i) === tab)
    .sort((x, y) => (Date.parse(y.at ?? "") || 0) - (Date.parse(x.at ?? "") || 0)), [items, tab]);
  const current = visible.find((i) => i.key === selected) ?? null;

  const go = useCallback((href: string | null) => { if (!href) return; onClose(); navigate(href); }, [navigate, onClose]);
  // Anything decided here shows on Home and in the count from the next read, taken as the page closes.
  const changed = useRef(false);
  useEffect(() => () => {
    if (!changed.current) return;
    void queryClient.invalidateQueries({ queryKey: ["home", ws] });
    void queryClient.invalidateQueries({ queryKey: draftsKey(ws) });
    void queryClient.invalidateQueries({ queryKey: decidedKey(ws) });
    void queryClient.invalidateQueries({ queryKey: ["automation-approvals", ws] });
  }, [queryClient, ws]);

  // DONE BY HAND (2026-10-29): a follow-up handled somewhere else is ticked here. Nothing is sent: a
  // draft or signal is closed with the reject route and reason "done" (so the engine reads it as
  // handled, not as noise), a run waiting on a review ends as skipped. A sent email is done by
  // itself. There is no reopening: the API has no way back for either.
  const [marking, setMarking] = useState<string | null>(null);
  const markDone = useCallback(async (i: InboxItem) => {
    if (i.done || marking) return;
    setMarking(i.key);
    try {
      const t = (await freshAccessToken()) ?? token ?? "";
      if (i.action) {
        const r = await fetch(`${apiUrl}/api/actions/${i.action.id}/reject`, {
          method: "POST", headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" }, body: JSON.stringify({ reason: "done" }),
        });
        if (!r.ok) throw new Error(String(r.status));
        markDraftDecided(queryClient, ws, i.action.id, "rejected");
        window.dispatchEvent(new CustomEvent(ACTION_DECIDED, { detail: { id: i.action.id, status: "rejected" } }));
      } else if (i.run) {
        const r = await automationsFetch(`/approvals/${i.run.run_id}/reject?workspaceId=${ws}`, t, { method: "POST", body: "{}" });
        if (!r.ok) throw new Error(String(r.status));
        setRunsDone((s) => new Set(s).add(i.key));
      }
      changed.current = true;
    } catch {
      toast.error("Couldn't mark it done. Try again in a moment.");
    } finally {
      setMarking(null);
    }
  }, [marking, token, queryClient, ws]);
  const columns = useMemo(() => (tab === "act" ? followUpColumns(markDone, marking) : COLUMNS[tab]), [tab, markDone, marking]);

  return (
    <div className="h-full min-h-0 overflow-y-auto">
      {failed ? (
        <EmptyState bordered={false} className="mx-4 mt-4" title="Couldn't load your inbox." body="Try again in a moment." />
      ) : (
        <DataTable<InboxItem> aria-label="Inbox" columns={columns} rows={visible} rowKey={(i) => i.key}
          loading={loading} minWidth={720} keyboard activeKey={current?.key ?? null}
          onRowClick={(i) => setSelected(i.key)}
          empty={<EmptyState bordered={false} title={EMPTY[tab]} />} />
      )}

      <Sheet open={!!current} onOpenChange={(o) => { if (!o) setSelected(null); }}>
        <SheetContent side="right" className="flex w-full flex-col gap-0 overflow-y-auto p-0 outline-none sm:max-w-[720px]"
          onOpenAutoFocus={(e) => { e.preventDefault(); (e.currentTarget as HTMLElement | null)?.focus(); }}>
          {current && <ItemPane key={current.key} item={current} ws={ws} token={token} data={data} decided={decided[current.key]} chip={chipFor?.(builtinOf(current)) ?? null}
            go={go}
            onMarkDone={tabOf(current) === "act" && !current.done ? () => void markDone(current) : undefined}
            marking={marking === current.key}
            onDecided={(r, fu) => {
              setDecided((d) => ({ ...d, [r.id]: fu }));
              // Home, if it is open underneath, takes the same decision (it keeps its own read).
              window.dispatchEvent(new CustomEvent(FOLLOW_UP_DECIDED, { detail: { id: r.id, followup: fu } }));
            }}
            onDismissed={(key) => {
              // Skipped or snoozed: the row leaves the table and the sheet closes.
              setDismissed((s) => new Set(s).add(key));
              setSelected(null);
            }}
            onActionDecided={(id, status) => {
              markDraftDecided(queryClient, ws, id, status);
              window.dispatchEvent(new CustomEvent(ACTION_DECIDED, { detail: { id, status } }));
              changed.current = true;
            }}
            onAfterChange={() => { changed.current = true; }}
            onRunDone={(key) => setRunsDone((s) => new Set(s).add(key))} />}
        </SheetContent>
      </Sheet>
    </div>
  );
}

// ── The tables ──────────────────────────────────────────────────────────────

/** The account (or workflow) with its tile, the first column of every tab. */
const nameCell = (i: InboxItem) => (
  <span className={cn("flex min-w-0 items-center gap-2.5", i.done && "opacity-60")}>
    {i.kind === "outcome" ? <WorkflowTile /> : <AccountTile name={i.title} domain={i.domain} />}
    <span className="truncate text-foreground">{i.title}</span>
  </span>
);
// A table cell sized by its column, not its text: with max-width 0 a cell takes its column's share
// and a truncated line inside ends in "…" (the table lays columns out by content otherwise).
const FIT = "max-w-0";
const quiet = (text: ReactNode, i: InboxItem) => <span title={typeof text === "string" ? text : undefined} className={cn("block truncate text-[12.5px] text-ink-2", i.done && "opacity-60")}>{text || "—"}</span>;
const dateCol: Column<InboxItem> = {
  key: "when", header: "When", align: "right", width: "130px",
  cell: (i) => <span className={cn("whitespace-nowrap text-[12px] tabular-nums", i.done ? "text-foreground/70" : "text-muted-foreground")}>{i.done ?? dateOf(i)}</span>,
};

/**
 * Follow-ups (2026-10-29): what to follow up on first, then the account, the signal or workflow
 * that raised it, the date, and Done: ticked by itself once the email is sent, or by you.
 */
function followUpColumns(markDone: (i: InboxItem) => void, marking: string | null): Column<InboxItem>[] {
  return [
    // A long line ends in "…" inside its share of the row (the whole line on hover, all of it in
    // the sheet): the table fits the page instead of scrolling sideways. Same for every text column.
    { key: "follow", header: "Follow-up", width: "44%", className: FIT, cell: (i) => (
      <span title={followUpLine(i)} className={cn("block truncate text-foreground", i.done && "text-muted-foreground line-through decoration-muted-foreground/40")}>{followUpLine(i)}</span>
    ) },
    { key: "name", header: "Account", width: "22%", className: FIT, cell: nameCell },
    { key: "signal", header: "Signal", width: "18%", className: FIT, cell: (i) => quiet(signalOf(i), i) },
    { key: "date", header: "Date", align: "right", width: "96px",
      cell: (i) => <span className="whitespace-nowrap text-[12px] tabular-nums text-muted-foreground">{i.at ? (isToday(i.at) ? time(i.at) : day(i.at)) : "—"}</span> },
    { key: "done", header: "Done", align: "right", width: "64px", cell: (i) => (
      <span className="inline-flex" onClick={(e) => e.stopPropagation()} title={i.done ? (i.done === "Sent" ? "Done: the email was sent" : `Done: ${i.done.toLowerCase()}`) : "Mark done"}>
        {marking === i.key
          ? <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          : <Checkbox checked={!!i.done} disabled={!!i.done} onCheckedChange={() => markDone(i)}
              aria-label={i.done ? `${followUpLine(i)}: done` : `Mark done: ${followUpLine(i)}`} className="disabled:cursor-default disabled:opacity-100" />}
      </span>
    ) },
  ];
}

/** Each tab's columns: who it is about, what it is, where it came from, when. Follow-ups' are
 *  followUpColumns, which carry the Done tick. */
const COLUMNS: Record<InboxTab, Column<InboxItem>[]> = {
  meetings: [
    { key: "name", header: "Account", width: "34%", className: FIT, cell: nameCell },
    { key: "meeting", header: "Meeting", className: FIT, cell: (i) => quiet(i.meeting?.title, i) },
    dateCol,
  ],
  act: [],
  workflows: [
    { key: "name", header: "Workflow", width: "36%", className: FIT, cell: nameCell },
    { key: "output", header: "Output", className: FIT, cell: (i) => quiet(i.outcome?.document_title, i) },
    dateCol,
  ],
};

/** The account's logo in the palette's 24px tile. */
function AccountTile({ name, domain, size = "h-6 w-6" }: { name: string | null; domain: string | null; size?: string }) {
  return (
    <EntityAvatar kind="company" name={name} domain={domain}
      className={cn(size, "flex-shrink-0 rounded-md shadow-[inset_0_0_0_1px_hsl(var(--border)/0.6)]")} textClassName="text-[10px] font-medium" />
  );
}

/** A workflow's mark in the same tile, for a row that is a run, not an account. */
function WorkflowTile({ size = "h-6 w-6" }: { size?: string }) {
  return (
    <span className={cn(size, "flex flex-shrink-0 items-center justify-center rounded-md text-muted-foreground shadow-[inset_0_0_0_1px_hsl(var(--border)/0.6)]")}>
      <Zap className="h-3 w-3" strokeWidth={1.75} />
    </span>
  );
}

// ── The right pane ──────────────────────────────────────────────────────────

type PaneProps = {
  item: InboxItem; ws: string; token: string | undefined; data: InboxRead | undefined; decided?: FollowUp;
  /** Where the built-in that made this item lives (GET-897), as a small link. */
  chip?: ItemChip | null;
  back?: () => void; go: (href: string | null) => void;
  /** A follow-up still open: "Mark done" in the header (the table's tick). */
  onMarkDone?: () => void; marking?: boolean;
  onDecided: (r: Recommendation, fu: FollowUp) => void;
  onDismissed: (key: string) => void;
  onActionDecided: (id: string, status: "sent" | "rejected") => void;
  onAfterChange: () => void;
  onRunDone: (key: string) => void;
};

function ItemPane(p: PaneProps) {
  const { item } = p;
  const m = item.meeting;
  const o = item.outcome;
  const openLabel = m ? "Open on Home" : o ? (o.document_id ? "Open page" : "Open workflow") : "Open account";
  // A meeting: "Halcyon Retail · Security review", "After the call · Today 15:00". A draft: the
  // account, "Drafted by Stale deal detection · 14:42".
  const title = m && m.title ? `${item.title} · ${m.title}` : item.title;
  const meta = o
    ? [o.document_title, `Ran ${isToday(o.started_at) ? time(o.started_at) : day(o.started_at)}`].filter(Boolean).join(" · ")
    : item.run
    ? [item.run.automation.name, item.why].filter(Boolean).join(" · ")
    : m
    ? [`After the ${m.kind.toLowerCase()}`, meetingWhen(m.at)].filter(Boolean).join(" · ")
    : [`Drafted by ${item.by ?? "OpenNous"}`, item.at ? (isToday(item.at) ? time(item.at) : day(item.at)) : null].filter(Boolean).join(" · ");
  return (
    <div className="flex min-h-full flex-col">
      {/* In the sheet: room on the right for its ✕. */}
      <div className="sticky top-0 z-10 flex items-center gap-2.5 border-b border-border/50 bg-card py-3 pl-4 pr-12 sm:pl-5">
        <SheetTitle className="sr-only">{title}</SheetTitle>
        <SheetDescription className="sr-only">{meta}</SheetDescription>
        {p.back && (
          <button type="button" onClick={p.back} aria-label="Back to Priorities"
            className="-ml-1 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg text-muted-foreground/70 hover:bg-hover hover:text-foreground">
            <ArrowLeft className="h-4 w-4" strokeWidth={1.75} />
          </button>
        )}
        {o ? <WorkflowTile size="h-7 w-7" /> : <AccountTile name={item.title} domain={item.domain} size="h-7 w-7" />}
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13.5px] font-medium leading-tight text-foreground">{title}</p>
          <p className="flex min-w-0 items-center gap-1.5 text-[11.5px] text-muted-foreground/70">
            <span className="truncate">{meta}</span>
            {p.chip && <button type="button" onClick={() => p.go(p.chip!.href)} title={p.chip.title}
              className="inline-flex flex-shrink-0 items-center gap-1 rounded-md bg-muted/70 px-1.5 py-px text-[10.5px] text-muted-foreground transition-colors duration-fast hover:bg-hover hover:text-foreground">
              <Boxes className="h-2.5 w-2.5" strokeWidth={2} aria-hidden />{p.chip.name}</button>}
          </p>
        </div>
        {p.onMarkDone && (
          <button type="button" onClick={p.onMarkDone} disabled={p.marking} title="Handled somewhere else: close it without sending"
            className="inline-flex h-7 flex-shrink-0 items-center gap-1.5 rounded-lg px-2 text-[12px] text-muted-foreground/80 transition-colors duration-fast hover:bg-hover hover:text-foreground disabled:opacity-50">
            {p.marking ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" strokeWidth={1.75} />}Mark done
          </button>
        )}
        {!p.onMarkDone && item.done && tabOf(item) === "act" && (
          <span className="inline-flex h-7 flex-shrink-0 items-center gap-1.5 px-2 text-[12px] text-muted-foreground"><Check className="h-3.5 w-3.5" strokeWidth={1.75} />{item.done}</span>
        )}
        {item.href && (
          <button type="button" onClick={() => p.go(item.href)}
            className="inline-flex h-7 flex-shrink-0 items-center gap-1 rounded-lg px-2 text-[12px] text-muted-foreground/80 transition-colors duration-fast hover:bg-hover hover:text-foreground">
            {openLabel}<ArrowUpRight className="h-3.5 w-3.5" strokeWidth={1.75} />
          </button>
        )}
      </div>
      <div className="px-4 py-4 sm:px-5">
        {o ? <OutcomePane {...p} /> : item.run ? <RunPane {...p} /> : item.kind === "signal" ? <SignalPane {...p} /> : item.action ? <ApprovalPane {...p} /> : <MeetingPane {...p} />}
      </div>
    </div>
  );
}

type OutcomeStep = { step: number; name: string; status: string; detail: string | null; output: RunOutput | null };

/** What a finished workflow run wrote (2026-10-29): each step's output (the brief, the email) in
 *  order, read from the run itself; a run that wrote a page links to it in the header. */
function OutcomePane({ item, ws, token }: PaneProps) {
  const runId = item.outcome!.id;
  const [steps, setSteps] = useState<OutcomeStep[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    setSteps(null); setFailed(false);
    automationsFetch(`/runs/${runId}?workspaceId=${ws}`, token ?? "", { signal: AbortSignal.timeout(20_000) })
      .then(async (r) => {
        const b = await r.json().catch(() => null);
        if (!alive) return;
        if (r.ok && Array.isArray(b?.steps)) setSteps(b.steps);
        else setFailed(true);
      })
      .catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, [runId, ws, token]);

  if (failed) return <p className="text-[13px] text-muted-foreground">Couldn't open this run. Try again in a moment.</p>;
  if (!steps) return <div className="flex h-24 items-center justify-center"><Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /></div>;
  const written = steps.filter((s) => s.output);
  if (!written.length) return (
    <div className="flex flex-col gap-1.5">
      <p className="text-[13px] text-foreground">This run finished without writing anything to read here.</p>
      {steps.length > 0 && <p className="text-[12.5px] text-muted-foreground">{steps.map((s) => s.detail ? `${s.name}: ${s.detail}` : s.name).join(" · ")}</p>}
    </div>
  );
  return (
    <div className="flex flex-col gap-5">
      {written.map((s) => (
        <section key={s.step}>
          <p className="text-[11.5px] font-medium text-muted-foreground/70">{s.name}</p>
          <OutputView output={s.output!} />
        </section>
      ))}
    </div>
  );
}

/** An automation run waiting on its review (GET-737): the tasks, the email draft, the call summary. */
function RunPane({ item, ws, token, onAfterChange, onRunDone }: PaneProps) {
  const queryClient = useQueryClient();
  return (
    <RunReviewPane approval={item.run as unknown as Approval} token={token ?? ""} workspaceId={ws}
      onDone={() => { onAfterChange(); onRunDone(item.key); }}
      // A decision made here is in the cached run too, so leaving the row and coming back keeps it.
      onChoices={(partial) => queryClient.setQueryData<Approval[]>(["automation-approvals", ws],
        (list) => (list ?? []).map((a) => (a.run_id === item.run?.run_id ? { ...a, partial } : a)))} />
  );
}

/** The meeting's wrap-up, with every action Home offers for it: Home's own card, always open. */
function MeetingPane({ item, ws, token, data, decided, go, onDecided, onDismissed, onAfterChange }: PaneProps) {
  const queryClient = useQueryClient();
  const base = item.rec as unknown as Recommendation;
  const r = decided ? { ...base, followup: decided } : base;
  const actions = useMemo(() => followUpApi(apiUrl, token, ws), [token, ws]);
  const loadDetail = useCallback((id: string) => queryClient.fetchQuery({
    queryKey: ["home-rec", ws, id], staleTime: 5 * 60_000,
    queryFn: async () => (await getJson<{ recommendation: RecDetailFull }>(`/api/home/recommendations/${id}?workspaceId=${ws}`, token)).recommendation,
  }).then((d): RecDetail | null => (d ? { impact: d.impact ?? null, sources: d.sources ?? [] } : null), () => null), [queryClient, ws, token]);
  const dealChange = (data?.deal_changes ?? []).find((d) => d.account_id && d.account_id === r.account.id) as DealChange | undefined;

  return (
    <FollowUpCard variant="pane" r={r} tasks={null} dealChange={dealChange ?? null}
      loadDetail={loadDetail} actions={actions}
      onChange={(rec, fu) => { onDecided(rec, fu); onAfterChange(); }}
      onReview={(rec) => go(`/home/${rec.id}`)}
      onOpenAccount={(rec) => rec.account.id && go(`/accounts/${rec.account.id}`)}
      onSkip={(rec) => {
        onDismissed(item.key);
        onAfterChange();
        window.dispatchEvent(new CustomEvent(REC_DISMISSED, { detail: { id: rec.id } }));
        void freshAccessToken().then((t) => fetch(`${apiUrl}/api/home/recommendations/${rec.id}/dismiss?workspaceId=${ws}`, {
          method: "POST", headers: { Authorization: `Bearer ${t ?? token ?? ""}`, "Content-Type": "application/json" }, body: "{}",
        })).then(() => queryClient.invalidateQueries({ queryKey: ["home", ws] }), () => {});
      }}
      onTask={(t) => go(`/tasks/${encodeURIComponent(t.id)}`)} />
  );
}

/** A draft an automation wrote (a pending_actions row): why it was written, then the message in
 *  chat's own ApprovalCard. Edits are made in place and are what sends; Approve & send and Skip
 *  are the existing approve and reject routes. */
function ApprovalPane({ item, token, onActionDecided }: PaneProps) {
  const a = item.action!;
  // The trigger's reason when there is one ("Deal sat in Proposal for 38 days"), and what the
  // draft says it is based on; either alone is the why.
  const why = item.why || a.rationale;
  const basedOn = item.why && a.rationale && a.rationale !== item.why ? a.rationale : null;
  const kind = draftKind(item.by ?? a.origin?.name ?? null);
  const first = (a.recipient ?? "").trim().split(/\s+/)[0] || null;
  return (
    <div className="flex flex-col gap-4">
      {/* WHAT KIND OF MOVE, THEN WHAT TO DO, THEN WHY (GET-740): a tag, a short line, the reason. */}
      <div>
        <span className={cn("inline-flex h-[22px] items-center rounded-md px-2 text-[11.5px] font-medium", KIND_TONE[kind.tone])}>{kind.tag}</span>
        <p className="mt-2 text-[14px] font-medium leading-snug text-foreground">{kind.action(first)}</p>
        {why && <p className="mt-1 text-[12.5px] leading-relaxed text-muted-foreground">{why}</p>}
        {basedOn && <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground/80">{basedOn}</p>}
      </div>
      <ApprovalCard key={`${a.id}:${a.status}`} action={a as PendingAction} token={token ?? ""} apiUrl={apiUrl} className="mt-0"
        labels={{ send: "Approve & send", discard: "Skip", discarded: "Skipped. Nothing was sent." }}
        onDecided={(outcome) => onActionDecided(a.id, outcome === "rejected" ? "rejected" : "sent")} />
    </div>
  );
}

/** A signal's next move (GET-944): what happened, who it is, then the draft. Send is the existing
 *  approve route; Not relevant rejects with that reason (it teaches the engine which signals are
 *  noise); Snooze writes snoozed_until on the signal's ledger row and the row leaves until then. */
function SignalPane({ item, ws, token, onActionDecided, onDismissed, onAfterChange }: PaneProps) {
  const queryClient = useQueryClient();
  const a = item.action!;
  const s = a.origin?.signal ?? null;
  const r = s?.research ?? null;
  const first = (a.recipient ?? "").trim().split(/\s+/)[0] || null;
  const [snoozeError, setSnoozeError] = useState<string | null>(null);
  const [snoozing, setSnoozing] = useState(false);
  const move = s?.nudge
    ? `No reply in 5 days. Follow up${first ? ` with ${first}` : ""}`
    : s?.kind === "stakeholder_identified"
    ? `Ask ${first ?? "your contact"} to bring ${r?.name ?? "them"} into the next call`
    : s?.kind === "next_step_missed"
    ? `Pick the missed next step back up${first ? ` with ${first}` : ""}`
    : s?.kind === "next_step_slipped"
    ? `Pin down a firm date${first ? ` with ${first}` : ""}`
    : draftKind(s?.kind === "churn_risk" ? "risk" : s?.kind === "expansion_signal" ? "expansion" : "signal").action(first);
  const snooze = async () => {
    if (snoozing) return;
    setSnoozing(true);
    setSnoozeError(null);
    try {
      const t = (await freshAccessToken()) ?? token ?? "";
      const res = await fetch(`${apiUrl}/api/actions/${a.id}/snooze`, {
        method: "POST", headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" }, body: JSON.stringify({ days: 3 }),
      });
      if (!res.ok) throw new Error(String(res.status));
      onDismissed(item.key);
      onAfterChange();
      void queryClient.invalidateQueries({ queryKey: draftsKey(ws) });
    } catch {
      setSnoozeError("Couldn't snooze it. Try again in a moment.");
    }
    setSnoozing(false);
  };
  return (
    <div className="flex flex-col gap-4">
      <div>
        <span className={cn("inline-flex h-[22px] items-center rounded-md px-2 text-[11.5px] font-medium", KIND_TONE.quiet)}>{s?.label ?? "Signal"}</span>
        <p className="mt-2 text-[14px] font-medium leading-snug text-foreground">{move}</p>
      </div>
      {/* WHAT HAPPENED: their words, who said them, when. */}
      {s && (s.quote || s.text) && (
        <div>
          <p className="text-[11.5px] font-medium text-muted-foreground/70">What happened</p>
          {s.quote
            ? <blockquote className="mt-1 border-l-2 border-border pl-3 text-[13px] leading-relaxed text-foreground/90">“{s.quote}”</blockquote>
            : <p className="mt-1 text-[13px] leading-relaxed text-foreground/90">{s.text}</p>}
          <p className="mt-1 text-[12px] text-muted-foreground/70">{[s.speaker, s.said_at ? day(s.said_at) : null].filter(Boolean).join(" · ")}</p>
        </div>
      )}
      {/* WHO IT IS: what the play found, and where. */}
      {r && (
        <div>
          <p className="text-[11.5px] font-medium text-muted-foreground/70">Who it is</p>
          <p className="mt-1 text-[13px] text-foreground">{[r.name, r.title].filter(Boolean).join(", ")}</p>
          <p className="mt-0.5 text-[12px] text-muted-foreground/70">
            {r.contact_id ? "Already a contact on this account" : "Not a contact yet"}
            {r.source_url && <> · <a href={r.source_url} target="_blank" rel="noreferrer" className="underline decoration-border underline-offset-2 hover:text-foreground">{r.source_title || "Source"}</a></>}
          </p>
        </div>
      )}
      <ApprovalCard key={`${a.id}:${a.status}`} action={a as PendingAction} token={token ?? ""} apiUrl={apiUrl} className="mt-0"
        labels={{ send: "Send", discard: "Not relevant", discarded: "Marked not relevant. Nothing was sent." }} rejectReason="not_relevant"
        onDecided={(outcome) => onActionDecided(a.id, outcome === "rejected" ? "rejected" : "sent")} />
      {a.status === "pending" && (
        <div className="-mt-2 flex items-center gap-2">
          <button type="button" onClick={snooze} disabled={snoozing}
            className="inline-flex disabled:opacity-50 h-7 items-center gap-1.5 rounded-lg px-2 text-[12px] text-muted-foreground/80 transition-colors duration-fast hover:bg-hover hover:text-foreground">
            <Clock className="h-3.5 w-3.5" strokeWidth={1.75} />Snooze 3 days
          </button>
          <span role="status" aria-live="polite" className="text-[12px] text-destructive">{snoozeError}</span>
        </div>
      )}
    </div>
  );
}

// ── What kind of draft this is (GET-740) ────────────────────────────────────
const KIND_TONE = {
  risk: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
  good: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  quiet: "bg-foreground/[0.06] text-foreground/70",
};
type DraftKind = { tag: string; tone: keyof typeof KIND_TONE; action: (first: string | null) => string };
/** The tag and the one-line move, from the automation that drafted it. Pure. */
export function draftKind(by: string | null): DraftKind {
  const b = String(by ?? "").toLowerCase();
  const who = (f: string | null) => (f ? ` with ${f}` : "");
  if (/stale|quiet|inactiv/.test(b)) return { tag: "Stalled deal", tone: "risk", action: (f) => `Re-engage${who(f)} before the deal goes cold` };
  if (/risk|churn/.test(b)) return { tag: "Risk", tone: "risk", action: (f) => `Address the risk${who(f)}` };
  if (/expansion|upsell/.test(b)) return { tag: "Expansion", tone: "good", action: (f) => `Follow up${who(f)} on the expansion` };
  if (/signal/.test(b)) return { tag: "Signal", tone: "quiet", action: (f) => `Reply${f ? ` to ${f}` : ""} on what they raised` };
  if (/handoff|won/.test(b)) return { tag: "Handoff", tone: "good", action: (f) => `Hand over${f ? ` to ${f}` : ""}` };
  return { tag: "Follow-up", tone: "quiet", action: (f) => `Follow up${who(f)}` };
}

