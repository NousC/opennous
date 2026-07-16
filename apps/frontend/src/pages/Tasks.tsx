// Tasks — a ledger of what you owe, and to whom.
//
// Design thesis: these aren't "tasks", they're obligations to named people. The
// number nobody ever shows you is how long you've owed someone something, so
// that sits in the left margin and an old debt simply gets darker. No red, no
// badges — it accumulates weight, which is how it actually feels.
//
// Each row carries the team member who owns it, bottom-right. For a commitment
// that's whoever actually said they'd do it — the extraction worker reads that
// off the transcript, so nothing has to be assigned by hand.
//
// No cards. A ledger: a rail of tabular figures, hairline rules, rows that
// breathe. Every row hands its work to the agent.
import { useState, useEffect, useMemo, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { Check, Loader2, ChevronRight } from "lucide-react";
import { format, isToday, isTomorrow, differenceInCalendarDays } from "date-fns";
import { useAuth } from "@/contexts/AuthContext";
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";
import { RoutinesPanel } from "@/components/RoutinesPanel";
import { PageHeader } from "@/components/ui/page-header";

const apiUrl = import.meta.env.VITE_API_URL ?? "";

// Held across navigations. Coming back to Tasks should show what you saw a
// moment ago, immediately — then quietly refresh. A spinner on every visit to a
// page whose data changes hourly is just noise.
type Snapshot = {
  meetings: Meeting[];
  commitments: Commitment[];
  completed: Commitment[];
  autoClosed: { title: string; reason: string }[];
};
let cached: Snapshot | null = null;

type Action = { label: string; prompt: string };
type Assignee = { id: string; name: string | null; avatar: string | null } | null;

type Meeting = {
  when: string;
  title: string | null;
  status: string;
  with: string | null;
  company: string | null;
  entity_id: string;
  assignee?: Assignee;
  actions: Action[];
};

type Commitment = {
  id: string;
  entity_id: string;
  title: string;
  account: string | null;
  company: string | null;
  owner_kind: string;
  owner_is_member?: boolean;   // did one of US commit to this — the honest mine/waiting split
  internal?: boolean;          // pulled from an internal (team) meeting
  owner_name: string | null;
  due_phrase: string | null;
  due_at?: string | null;
  recorded_at: string;
  kind: string;
  assignee?: Assignee;
  actions: Action[];
  completed_at?: string | null;
  completed_reason?: string | null;
  completed_by?: string | null;
};

// ─── The team member who owns this ──────────────────────────────────────────
// Quiet by design: a face, not a label. You only need it to know whose desk this
// is, and in a workspace of one it should barely register.

function OwnerAvatar({ assignee }: { assignee?: Assignee }) {
  if (!assignee?.name) return null;
  return (
    <Avatar className="h-5 w-5 border border-border" title={assignee.name}>
      <AvatarImage src={assignee.avatar || undefined} alt={assignee.name} />
      <AvatarFallback className="text-[8.5px] font-semibold bg-muted text-muted-foreground">
        {assignee.name.charAt(0).toUpperCase()}
      </AvatarFallback>
    </Avatar>
  );
}

// ─── Rails ──────────────────────────────────────────────────────────────────

function DayRail({ iso }: { iso: string }) {
  const d = new Date(iso);
  const soon = isToday(d) || isTomorrow(d);
  return (
    <div className="text-right tabular-nums select-none">
      <div className={cn("text-[12px] leading-tight", soon ? "text-foreground font-medium" : "text-foreground/70")}>
        {isToday(d) ? "Today" : isTomorrow(d) ? "Tomorrow" : format(d, "EEE d")}
      </div>
      <div className="text-[11px] text-muted-foreground/50 leading-tight mt-0.5">
        {format(d, "h:mm a")}
      </div>
    </div>
  );
}

/**
 * How long this has been owed. The signature of the page.
 *
 * Fresh promises are barely there. Old ones darken until you can't not see them.
 */
function AgeRail({ iso }: { iso: string }) {
  const days = Math.max(0, differenceInCalendarDays(new Date(), new Date(iso)));
  const weight =
    days >= 21 ? "text-foreground font-medium"
    : days >= 10 ? "text-foreground/75"
    : days >= 4  ? "text-muted-foreground"
    : "text-muted-foreground/50";
  return (
    <div className="text-right tabular-nums select-none">
      <div className={cn("text-[12px] leading-tight", weight)}>
        {days === 0 ? "today" : `${days}d`}
      </div>
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground/40 leading-tight mt-0.5">
        {days === 0 ? "new" : "owed"}
      </div>
    </div>
  );
}

// ─── Actions ────────────────────────────────────────────────────────────────
// Text links, not chips. Buttons would rebuild the boxiness we removed.

function Actions({ actions, onPick }: { actions: Action[]; onPick: (p: string) => void }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-2">
      {actions.map(a => (
        <button
          key={a.label}
          onClick={() => onPick(a.prompt)}
          title={a.prompt}
          className="text-[12px] text-muted-foreground/70 hover:text-foreground underline-offset-[5px] decoration-border hover:decoration-foreground/40 hover:underline transition-colors focus-visible:outline-none focus-visible:underline focus-visible:text-foreground"
        >
          {a.label}
        </button>
      ))}
    </div>
  );
}

// ─── Structure ──────────────────────────────────────────────────────────────

function Section({
  label, count, hint, children,
}: { label: string; count: number; hint?: string; children: React.ReactNode }) {
  return (
    <section className="mt-12 first:mt-8">
      <div className="flex items-baseline gap-3 pb-2.5 border-b border-border">
        <h2 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/70">{label}</h2>
        <span className="text-[11px] tabular-nums text-muted-foreground/50">{count}</span>
        {hint && <span className="text-[12px] text-muted-foreground/45 ml-auto">{hint}</span>}
      </div>
      {children}
    </section>
  );
}

/**
 * A ledger row: when (or how long) on the left, substance in the middle, and the
 * team member who owns it tucked bottom-right — the last thing you look at, and
 * only when you need it.
 */
function Row({
  rail, assignee, children,
}: { rail: React.ReactNode; assignee?: Assignee; children: React.ReactNode }) {
  return (
    <div className="group grid grid-cols-[68px_1fr] gap-x-6 py-4 border-b border-border/40 last:border-0">
      <div className="pt-0.5">{rail}</div>
      <div className="min-w-0 flex flex-col">
        {children}
        {assignee?.name && (
          <div className="flex justify-end -mt-5 pointer-events-none">
            <span className="pointer-events-auto opacity-60 group-hover:opacity-100 transition-opacity">
              <OwnerAvatar assignee={assignee} />
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Page ───────────────────────────────────────────────────────────────────

export default function Tasks() {
  const { session, userData } = useAuth();
  const navigate = useNavigate();
  const token = session?.access_token ?? "";
  const workspaceId = userData?.workspace?.id ?? "";

  const [meetings, setMeetings] = useState<Meeting[]>(cached?.meetings ?? []);
  const [commitments, setCommitments] = useState<Commitment[]>(cached?.commitments ?? []);
  const [autoClosed, setAutoClosed] = useState<{ title: string; reason: string }[]>(cached?.autoClosed ?? []);
  const [completed, setCompleted] = useState<Commitment[]>(cached?.completed ?? []);
  // Finished work is collapsed by default — it's there to check, not to read.
  const [showFinished, setShowFinished] = useState(false);
  // Open = promises a PERSON made. Scheduled = standing instructions for the AGENT.
  // Two owners of work, one page.
  const [tab, setTab] = useState<"open" | "scheduled">("open");
  // Only true on the very first visit. A revisit renders the cached page at once
  // and refreshes underneath, so you never sit on a spinner you've already paid for.
  const [loading, setLoading] = useState(!cached);
  // Have we ever actually heard back? Until we have, we must not claim the list
  // is empty — that's how you flash "Nothing owed" at someone who owes plenty.
  const [loaded, setLoaded] = useState(!!cached);

  useEffect(() => {
    if (!token || !workspaceId) return;
    let alive = true;
    fetch(`${apiUrl}/api/tasks?workspaceId=${workspaceId}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(r => (r.ok ? r.json() : null))
      .then(d => {
        if (!d || !alive) return;
        const snap: Snapshot = {
          meetings: d.meetings ?? [],
          commitments: d.commitments ?? [],
          completed: d.completed ?? [],
          // Closures are news: show them once, don't re-announce on every revisit.
          autoClosed: d.auto_closed ?? [],
        };
        cached = snap;
        setMeetings(snap.meetings);
        setCommitments(snap.commitments);
        setCompleted(snap.completed);
        setAutoClosed(snap.autoClosed);
        setLoaded(true);
      })
      .catch(() => { /* keep whatever we already had on screen */ })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [token, workspaceId]);

  const ask = useCallback((prompt: string) => {
    navigate(`/?ask=${encodeURIComponent(prompt)}`);
  }, [navigate]);

  // Evidence can't prove everything ("brainstorm the pitch"), so you have the
  // final say. Optimistic: the row goes now, the write follows.
  const markDone = useCallback(async (c: Commitment) => {
    const [entityId, property] = c.id.split(/:(.+)/);
    setCommitments(prev => prev.filter(x => x.id !== c.id));
    // Straight into Finished, so it's visibly somewhere rather than just gone.
    setCompleted(prev => [
      { ...c, completed_at: new Date().toISOString(), completed_by: "user", completed_reason: "you marked it done" },
      ...prev,
    ]);
    try {
      await fetch(`${apiUrl}/api/tasks/${entityId}/${encodeURIComponent(property)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ workspaceId, status: "done" }),
      });
    } catch { /* it returns on the next load if the write failed */ }
  }, [token, workspaceId]);

  // Mine to do vs waiting on someone. After personal scoping every row here is already
  // MINE to see; this split is "did I commit to it" (owner_is_member) or "is a client
  // on the hook to me". owner_kind is the extraction worker's guess and it calls the
  // co-founder a prospect, so we do not group on it.
  const mine   = useMemo(() => commitments.filter(c => c.owner_is_member !== false), [commitments]);
  const theirs = useMemo(() => commitments.filter(c => c.owner_is_member === false), [commitments]);
  const empty  = loaded && !meetings.length && !commitments.length && !completed.length;

  return (
    <div className="h-full overflow-y-auto bg-background">
      <div className="px-8 py-7">

        <PageHeader title="Tasks" />

        {/* Control row — the same shape every page uses: what you're looking at on
            the left, the controls for it on the right. */}
        <div className="mb-4 flex items-center justify-between gap-3">
          <div className="inline-flex items-center rounded-lg border border-border bg-muted/40 p-0.5">
            {(["open", "scheduled"] as const).map(t => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={cn(
                  "text-[13px] font-medium px-3 py-1.5 rounded-md capitalize transition-colors",
                  tab === t
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {t}
              </button>
            ))}
          </div>

        </div>

        {tab === "scheduled" ? <RoutinesPanel /> : (
          <>
            {loading ? (
              <div className="space-y-px rounded-xl overflow-hidden border border-border">
                {[...Array(6)].map((_, i) => <div key={i} className="h-12 bg-muted/50 animate-pulse" />)}
              </div>
            ) : empty ? (
              <div className="rounded-xl border border-dashed border-border py-12 text-center">
                <Check className="h-7 w-7 text-muted-foreground/50 mx-auto mb-3" strokeWidth={1.5} />
                <p className="text-[13px] font-medium text-foreground/80 mb-1">Nothing owed</p>
                <p className="text-[12px] text-muted-foreground/70">
                  Promises made in a meeting show up here once it's transcribed.
                </p>
              </div>
            ) : (
              <div className="rounded-xl border border-border overflow-hidden">
                {/* Column headers — same as Accounts. The table says what its columns
                    mean once, at the top, instead of every row re-explaining itself. */}
                <div className="flex items-center gap-4 px-4 py-2.5 bg-muted/50 border-b border-border">
                  <span className="w-[14px] flex-shrink-0" />
                  <span className="flex-1 text-[11px] font-semibold tracking-widest text-muted-foreground uppercase">Task</span>
                  <span className="w-48 flex-shrink-0 text-[11px] font-semibold tracking-widest text-muted-foreground uppercase">Account</span>
                  <span className="w-44 flex-shrink-0 text-[11px] font-semibold tracking-widest text-muted-foreground uppercase">Date</span>
                  <span className="w-7 flex-shrink-0" />
                </div>

                {/* Closed since you last looked. A row in the table, not a banner —
                    it's news about this list, so it belongs inside it. */}
                {autoClosed.length > 0 && (
                  <div className="px-4 py-2 bg-muted/25 border-b border-border/60">
                    <p className="text-[12px] text-muted-foreground">
                      Closed {autoClosed.length} — the record shows you did{" "}
                      {autoClosed.length === 1 ? "it" : "them"}:{" "}
                      <span className="text-muted-foreground/70">
                        {autoClosed.map(a => a.title).join(" · ")}
                      </span>
                    </p>
                  </div>
                )}

                {/* ── What you owe. The heart of the page. ── */}
                <GroupHeader label="Open" count={mine.length} />
                {mine.map(c => (
                  <TaskRow key={c.id} c={c} onDone={() => markDone(c)} onAsk={ask} />
                ))}

                {/* ── What they owe you. Present, never competing. ── */}
                {theirs.length > 0 && (
                  <>
                    <GroupHeader label="Waiting on" count={theirs.length} />
                    {theirs.map(c => (
                      <TaskRow key={c.id} c={c} onAsk={ask} muted />
                    ))}
                  </>
                )}

                {/* ── Finished. Collapsed: here to check, not to read. An auto-close
                       you can't inspect is indistinguishable from a bug, so every
                       finished row keeps the reason it closed. ── */}
                {completed.length > 0 && (
                  <>
                    <button
                      onClick={() => setShowFinished(o => !o)}
                      className="w-full flex items-center gap-3 px-4 py-2 bg-muted/50 border-y border-border/60 text-left hover:bg-muted/70 transition-colors"
                    >
                      <ChevronRight className={cn(
                        "h-3.5 w-3.5 shrink-0 text-muted-foreground/50 transition-transform",
                        showFinished && "rotate-90",
                      )} />
                      <span className="text-[11px] font-semibold tracking-widest text-muted-foreground uppercase">Finished</span>
                      <span className="text-[11px] text-muted-foreground/70 tabular-nums">{completed.length}</span>
                    </button>

                    {showFinished && completed.map(c => (
                      <div
                        key={c.id}
                        className="flex items-center gap-4 px-4 py-3 border-b border-border/60 last:border-0"
                      >
                        <span className="w-[14px] flex-shrink-0 h-[14px] rounded-full bg-muted flex items-center justify-center">
                          <Check className="h-2.5 w-2.5 text-muted-foreground" />
                        </span>
                        <span className="flex-1 min-w-0 text-[13px] text-muted-foreground line-through decoration-border truncate">
                          {c.title}
                        </span>
                        <span className="w-48 flex-shrink-0 text-[12px] text-muted-foreground/55 truncate">
                          {c.internal ? <span className="text-muted-foreground/45">{c.account}</span> : (c.account ?? "—")}
                        </span>
                        <span className="w-44 flex-shrink-0 text-[12px] text-muted-foreground/45 truncate">
                          {c.completed_at ? `Done ${format(new Date(c.completed_at), "MMM d")}` : "—"}
                        </span>
                        <span className="w-7 flex-shrink-0 flex justify-end">
                          <OwnerAvatar assignee={c.assignee} />
                        </span>
                      </div>
                    ))}
                  </>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ─── Table pieces ───────────────────────────────────────────────────────────
// The op log's group header, reused: a band inside the frame that names the next
// run of rows. It keeps three lists in ONE table instead of three tables stacked,
// which is what made the page read as a different product.

function GroupHeader({ label, count, hint }: { label: string; count: number; hint?: string }) {
  return (
    <div className="flex items-center gap-3 px-4 py-2 bg-muted/50 border-b border-border/60">
      <span className="text-[11px] font-semibold tracking-widest text-muted-foreground uppercase">{label}</span>
      <span className="text-[11px] text-muted-foreground/70 tabular-nums">{count}</span>
      {hint && <span className="text-[11px] text-muted-foreground/50">{hint}</span>}
    </div>
  );
}

// The date cell. Two truths in one column: when it is DUE (if anyone said), and when it
// was CAPTURED. A deadline is the thing you act on, so it leads; the capture date is how
// you feel the age of an open promise.
function DateCell({ recordedAt, duePhrase, dueAt, days }: {
  recordedAt: string; duePhrase: string | null; dueAt?: string | null; days: number;
}) {
  const captured = format(new Date(recordedAt), "MMM d");
  // A parseable due date reads cleanest; otherwise fall back to the phrase the worker
  // heard ("Thursday Jul 30"), which already contains the date.
  const dueDate = dueAt && !Number.isNaN(Date.parse(dueAt)) ? new Date(dueAt) : null;
  const deadline = dueDate ? format(dueDate, "MMM d") : (duePhrase || null);
  if (deadline) {
    return (
      <span className="w-44 flex-shrink-0 text-[12px] truncate" title={duePhrase || undefined}>
        <span className="text-foreground font-medium">Due {deadline}</span>
        <span className="text-muted-foreground/45"> · set {captured}</span>
      </span>
    );
  }
  return (
    <span className="w-44 flex-shrink-0 text-[12px] tabular-nums" title={`Captured ${captured}`}>
      <span className="text-muted-foreground">{captured}</span>
      <span className="text-muted-foreground/45"> · {days === 0 ? "today" : `${days}d ago`}</span>
    </span>
  );
}

function TaskRow({
  c, onDone, onAsk, muted = false,
}: {
  c: Commitment;
  onDone?: () => void;
  onAsk: (p: string) => void;
  muted?: boolean;
}) {
  const days = Math.max(0, differenceInCalendarDays(new Date(), new Date(c.recorded_at)));
  return (
    <div className="group flex items-center gap-4 px-4 py-3 border-b border-border/60 last:border-0 hover:bg-accent transition-colors">
      {/* Done. Only for what YOU owe — you cannot tick off someone else's promise. */}
      <span className="w-[14px] flex-shrink-0">
        {onDone && (
          <button
            onClick={onDone}
            aria-label="Mark done"
            title="Mark done"
            className="h-[14px] w-[14px] rounded-full border border-border hover:border-foreground/60 flex items-center justify-center transition-colors"
          >
            <Check className="h-2.5 w-2.5 text-foreground opacity-0 group-hover:opacity-40 hover:!opacity-100 transition-opacity" />
          </button>
        )}
      </span>

      <div className="flex-1 min-w-0">
        <p className={cn("text-[13px] leading-snug truncate", muted ? "text-foreground/75" : "text-foreground")}>
          {c.title}
        </p>
        {/* Hand it to the agent. Hidden until the row is under the cursor: an action
            on every row, always visible, is a wall of buttons. */}
        {c.actions?.length > 0 && (
          <span className="hidden group-hover:flex items-center gap-1.5 mt-1">
            {c.actions.slice(0, 2).map(a => (
              <button
                key={a.label}
                onClick={() => onAsk(a.prompt)}
                className="text-[11px] px-1.5 py-0.5 rounded border border-border text-muted-foreground hover:text-foreground hover:border-foreground/30 transition-colors"
              >
                {a.label}
              </button>
            ))}
          </span>
        )}
      </div>

      {/* Account. An internal-meeting task reads as the workspace, muted, so it never
          looks like a client obligation. */}
      <span className="w-48 flex-shrink-0 min-w-0 text-[12px] truncate">
        {c.internal
          ? <span className="text-muted-foreground/45">{c.account}</span>
          : <>
              <span className="text-muted-foreground">{c.account ?? "—"}</span>
              {c.company && <span className="text-muted-foreground/50"> · {c.company}</span>}
            </>}
      </span>

      {/* Date. A real date, not just "2 days ago". When something is DUE, that is what
          you need to see, so it leads and is emphasised; otherwise the capture date, so
          you know how old the promise is. */}
      <DateCell recordedAt={c.recorded_at} duePhrase={c.due_phrase} dueAt={c.due_at} days={days} />

      <span className="w-7 flex-shrink-0 flex justify-end">
        <OwnerAvatar assignee={c.assignee} />
      </span>
    </div>
  );
}
