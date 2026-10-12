// The Priorities inbox (GET-678): the panel the top bar's ⚑ opens. Two panes, the way a mail client
// reads: the list on the left, the selected item read in place on the right.
//
// Since GET-681 it holds two things only:
//   After your meetings — one row per meeting, its wrap-up on the right: Home's FollowUpCard
//     (variant "pane") in three parts, the thank-you email, the tasks, the CRM updates, with every
//     action Home offers (edit, copy, Approve / Sync, Skip).
//   To approve — every other draft waiting on a person (pending_actions), opened in chat's own
//     ApprovalCard: To / Subject / body edited in place, Approve & send and Skip are the existing
//     approve and reject routes, so there is no second send path.
// A decision keeps its row with the result until the panel closes; the counts leave it out.
//
// Keyboard: ↑ / ↓ move the selection, Enter opens the item's page, Esc closes the panel. On a phone
// the panel is one pane: the list, and a tap opens the item with a back arrow.
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ArrowUpRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { day, time, when } from "@/lib/format";
import { freshAccessToken } from "@/lib/freshToken";
import { useIsMobile } from "@/hooks/use-mobile";
import { EntityAvatar } from "@/components/EntityAvatar";
import { SkeletonRows } from "@/components/ui/skeleton";
import { ListEmpty, ListGroup, ListMeta, listRowClass } from "@/components/ui/list";
import { FollowUpCard, followUpApi } from "@/components/home/FollowUps";
import { ApprovalCard, type PendingAction } from "@/components/ApprovalCard";
import { Row, type RecDetailFull } from "@/components/home/RecParts";
import type { DealChange, FollowUp, RecDetail, Recommendation } from "@/components/home/types";
import { ACTION_DECIDED, FOLLOW_UP_DECIDED, REC_DISMISSED } from "./events";
import { buildItems, groupItems, meetingWhen, openCount, visibleItems, type InboxItem, type InboxKind, type InboxRead } from "./inboxModel";
import { draftsKey, markDraftDecided } from "./drafts";
import { ApprovalPane as RunReviewPane, type Approval } from "@/components/AutomationApprovals";

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
  return isToday(i.at) ? `Drafted ${time(i.at)}` : day(i.at);
};

/** A follow-up card's decision, as its row shows it. */
const FOLLOW_UP_DONE: Record<string, string> = { approved: "Approved", synced: "Synced", skipped: "Skipped" };

export function PrioritiesInbox({ data, loading, failed, ws, token, onClose, focus = null }: {
  data: InboxRead | undefined; loading: boolean; failed: boolean; ws: string; token: string | undefined;
  onClose: () => void;
  /** An item to open on, e.g. "run:<id>" from a test run's View (GET-739). */
  focus?: string | null;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const mobile = useIsMobile();
  // A follow-up decided here keeps its row (and shows its receipt) until the panel closes, so the
  // list does not jump under the pointer; the next open reads Home afresh.
  const [decided, setDecided] = useState<Record<string, FollowUp>>({});
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  // Automation reviews finished here keep their row, marked, until the panel closes (GET-737).
  const [runsDone, setRunsDone] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<InboxKind>>(new Set());
  const [selected, setSelected] = useState<string | null>(focus);
  useEffect(() => { if (focus) setSelected(focus); }, [focus]);
  const [showDetail, setShowDetail] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  const items = useMemo(() => buildItems(data).filter((i) => !dismissed.has(i.key)).map((i) => {
    if (i.run && runsDone.has(i.key)) return { ...i, done: "Done" };
    const fu = decided[i.key];
    return fu && fu.status && FOLLOW_UP_DONE[fu.status] ? { ...i, done: FOLLOW_UP_DONE[fu.status] } : i;
  }), [data, dismissed, decided, runsDone]);
  const groups = useMemo(() => groupItems(items, expanded), [items, expanded]);
  const visible = useMemo(() => visibleItems(groups), [groups]);
  // The first item is selected on open, and again whenever the selected one leaves the list.
  const current = items.find((i) => i.key === selected) ?? visible[0] ?? null;

  const go = useCallback((href: string | null) => { if (!href) return; onClose(); navigate(href); }, [navigate, onClose]);

  // A clicked row is already in view; a row reached by the keyboard is brought into it.
  const select = (key: string, reveal = false) => {
    setSelected(key);
    if (reveal) requestAnimationFrame(() => document.getElementById(rowId(key))?.scrollIntoView({ block: "nearest" }));
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const t = e.target as HTMLElement;
    if (t.closest("input, textarea, select, [contenteditable='true']")) return;
    if ((e.key === "ArrowDown" || e.key === "ArrowUp") && visible.length && !(mobile && showDetail)) {
      e.preventDefault();
      const at = current ? visible.findIndex((i) => i.key === current.key) : -1;
      const next = e.key === "ArrowDown" ? Math.min(visible.length - 1, at + 1) : Math.max(0, at - 1);
      select(visible[next].key, true);
      listRef.current?.focus({ preventScroll: true });
    } else if (e.key === "Enter" && current && (t === listRef.current || t.getAttribute("role") === "option")) {
      e.preventDefault();
      if (mobile && !showDetail) setShowDetail(true);
      else go(current.href);
    }
  };

  // The list takes the keyboard as the panel opens (and once its rows arrive).
  const hasRows = items.length > 0;
  useEffect(() => { if (hasRows) listRef.current?.focus({ preventScroll: true }); }, [hasRows]);
  // Anything decided here shows on Home and in the count from the next read, taken as the panel closes.
  const changed = useRef(false);
  useEffect(() => () => {
    if (!changed.current) return;
    void queryClient.invalidateQueries({ queryKey: ["home", ws] });
    void queryClient.invalidateQueries({ queryKey: draftsKey(ws) });
    void queryClient.invalidateQueries({ queryKey: ["automation-approvals", ws] });
  }, [queryClient, ws]);

  const count = openCount(items);
  const list = (
    <div className={cn("flex min-h-0 flex-col", mobile ? "h-full" : "w-[340px] flex-shrink-0 border-r border-border/50")}>
      <div className="flex items-baseline gap-2 px-4 pb-2 pt-3">
        <span className="text-[13.5px] font-medium tracking-[-0.01em]">Priorities</span>
        {count > 0 && <span className="text-[12px] tabular-nums text-muted-foreground/60">{count}</span>}
      </div>
      {loading ? (
        <div className="px-2"><SkeletonRows rows={4} /></div>
      ) : failed ? (
        <ListEmpty className="px-4">Couldn't load your priorities. Try again in a moment.</ListEmpty>
      ) : !count ? (
        <ListEmpty className="px-4">All caught up.</ListEmpty>
      ) : (
        <div ref={listRef} tabIndex={0} role="listbox" aria-label="Priorities"
          aria-activedescendant={current ? rowId(current.key) : undefined}
          className="min-h-0 flex-1 overflow-y-auto px-2 pb-2 outline-none">
          {groups.map((g) => (
            <div key={g.kind} role="group" aria-label={g.label}>
              <ListGroup className="pt-2 first:pt-1">
                {g.label}{g.count > 0 && <span className="ml-1.5 tabular-nums text-muted-foreground/45">{g.count}</span>}
              </ListGroup>
              {g.shown.map((i) => (
                <div key={i.key} id={rowId(i.key)} role="option" aria-selected={current?.key === i.key}
                  onClick={() => { select(i.key); if (mobile) setShowDetail(true); listRef.current?.focus({ preventScroll: true }); }}
                  onDoubleClick={() => go(i.href)}
                  className={cn(listRowClass, "cursor-default", current?.key === i.key && "bg-hover")}>
                  <AccountTile name={i.title} domain={i.domain} />
                  <span className={cn("flex min-w-0 flex-1 flex-col", i.done && "opacity-60")}>
                    <span className="truncate text-[13px] leading-[18px] text-foreground">{i.title}</span>
                    {i.sub && <span className="truncate text-[11.5px] leading-4 text-muted-foreground/70">{i.sub}</span>}
                  </span>
                  <ListMeta className={cn("self-start pt-px", i.done && "text-foreground/70")}>{i.done ?? dateOf(i)}</ListMeta>
                </div>
              ))}
              {g.more > 0 && (
                <button type="button" tabIndex={-1} onClick={() => { setExpanded((s) => new Set(s).add(g.kind)); listRef.current?.focus({ preventScroll: true }); }}
                  className="flex h-8 w-full items-center rounded-lg pl-[42px] text-left text-[12px] text-muted-foreground/70 transition-colors duration-fast hover:bg-hover hover:text-foreground">
                  + {g.more} more
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );

  const detail = current ? (
    <ItemPane key={current.key} item={current} ws={ws} token={token} data={data} decided={decided[current.key]}
      back={mobile ? () => setShowDetail(false) : undefined} go={go}
      onDecided={(r, fu) => {
        setDecided((d) => ({ ...d, [r.id]: fu }));
        // Home, if it is open underneath, takes the same decision (it keeps its own read).
        window.dispatchEvent(new CustomEvent(FOLLOW_UP_DECIDED, { detail: { id: r.id, followup: fu } }));
      }}
      onDismissed={(key) => {
        // The next row takes the selection (the one above at the end), and the list the keyboard.
        const at = visible.findIndex((i) => i.key === key);
        const next = visible[at + 1] ?? visible[at - 1] ?? null;
        setDismissed((s) => new Set(s).add(key));
        setSelected(next?.key ?? null);
        if (mobile) setShowDetail(false);
        listRef.current?.focus({ preventScroll: true });
      }}
      onActionDecided={(id, status) => {
        markDraftDecided(queryClient, ws, id, status);
        window.dispatchEvent(new CustomEvent(ACTION_DECIDED, { detail: { id, status } }));
        changed.current = true;
      }}
      onAfterChange={() => { changed.current = true; }}
      onRunDone={(key) => setRunsDone((s) => new Set(s).add(key))} />
  ) : (
    <div className="flex h-full items-center justify-center px-6 text-[13px] text-muted-foreground/60">
      {loading ? "" : "Nothing selected"}
    </div>
  );

  return (
    <div className="flex h-full min-h-0" onKeyDown={onKeyDown}>
      {mobile ? (showDetail && current ? <div className="min-w-0 flex-1 overflow-y-auto">{detail}</div> : <div className="min-w-0 flex-1">{list}</div>) : (
        <>
          {list}
          {/* Keyed by the item, so a newly selected one opens at its top. */}
          <div key={current?.key ?? "none"} className="min-w-0 flex-1 overflow-y-auto">{detail}</div>
        </>
      )}
    </div>
  );
}

const rowId = (key: string) => `prio-${key.replace(/[^\w-]/g, "_")}`;

/** The account's logo in the palette's 24px tile. */
function AccountTile({ name, domain, size = "h-6 w-6" }: { name: string | null; domain: string | null; size?: string }) {
  return (
    <EntityAvatar kind="company" name={name} domain={domain}
      className={cn(size, "flex-shrink-0 rounded-md shadow-[inset_0_0_0_1px_hsl(var(--border)/0.6)]")} textClassName="text-[10px] font-medium" />
  );
}

// ── The right pane ──────────────────────────────────────────────────────────

type PaneProps = {
  item: InboxItem; ws: string; token: string | undefined; data: InboxRead | undefined; decided?: FollowUp;
  back?: () => void; go: (href: string | null) => void;
  onDecided: (r: Recommendation, fu: FollowUp) => void;
  onDismissed: (key: string) => void;
  onActionDecided: (id: string, status: "sent" | "rejected") => void;
  onAfterChange: () => void;
  onRunDone: (key: string) => void;
};

function ItemPane(p: PaneProps) {
  const { item } = p;
  const m = item.meeting;
  const openLabel = m ? "Open on Home" : "Open account";
  // A meeting: "Halcyon Retail · Security review", "After the call · Today 15:00". A draft: the
  // account, "Drafted by Stale deal detection · 14:42".
  const title = m && m.title ? `${item.title} · ${m.title}` : item.title;
  const meta = item.run
    ? [item.run.automation.name, item.why].filter(Boolean).join(" · ")
    : m
    ? [`After the ${m.kind.toLowerCase()}`, meetingWhen(m.at)].filter(Boolean).join(" · ")
    : [`Drafted by ${item.by ?? "OpenNous"}`, item.at ? (isToday(item.at) ? time(item.at) : day(item.at)) : null].filter(Boolean).join(" · ");
  return (
    <div className="flex min-h-full flex-col">
      <div className="sticky top-0 z-10 flex items-center gap-2.5 border-b border-border/50 bg-popover px-4 py-3 sm:px-5">
        {p.back && (
          <button type="button" onClick={p.back} aria-label="Back to Priorities"
            className="-ml-1 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg text-muted-foreground/70 hover:bg-hover hover:text-foreground">
            <ArrowLeft className="h-4 w-4" strokeWidth={1.75} />
          </button>
        )}
        <AccountTile name={item.title} domain={item.domain} size="h-7 w-7" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13.5px] font-medium leading-tight text-foreground">{title}</p>
          <p className="truncate text-[11.5px] text-muted-foreground/70">{meta}</p>
        </div>
        {item.href && (
          <button type="button" onClick={() => p.go(item.href)}
            className="inline-flex h-7 flex-shrink-0 items-center gap-1 rounded-lg px-2 text-[12px] text-muted-foreground/80 transition-colors duration-fast hover:bg-hover hover:text-foreground">
            {openLabel}<ArrowUpRight className="h-3.5 w-3.5" strokeWidth={1.75} />
          </button>
        )}
      </div>
      <div className="px-4 py-4 sm:px-5">
        {item.run ? <RunPane {...p} /> : item.action ? <ApprovalPane {...p} /> : <MeetingPane {...p} />}
      </div>
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

