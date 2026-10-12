// Waiting on you (Home; was "Follow-ups ready"): every call that left you something to send, one
// compact row each. The list grows with them on purpose; a capped list hides the sixth follow-up,
// and that is the one that goes cold. A row opens in place: the follow-up email, a "Deal change
// required" line when a stage or date should move, the tasks and updates, and what the CRM says
// now (read only). The account page shows the same card in its own, boxed form (variant "card").
//
// Two kinds of card share this component. The follow-up engine's (Phase 3: a recommendation with
// an id starting "fu:" and the card as `rec.followup`) is decided here: tick the tasks, answer
// "which deal?", edit and copy the email, then Approve, which files the ticked tasks on Tasks.
// On a workspace with write-back on (Phase 4, `followup.writeback`) the same button reads "Sync to
// HubSpot": it approves, then writes the tasks and one note on the deal to HubSpot and the email
// to the rep's Gmail drafts. Nothing is ever sent and no deal is ever changed. If HubSpot refuses
// the write, the card says why in plain words and every card falls back to Approve.
// The older after-the-call recommendation (no `followup`) keeps its own flow: Review opens its
// page, Skip dismisses it.
import { useEffect, useState, useSyncExternalStore, type ReactNode, type Ref } from "react";
import { Link } from "react-router-dom";
import { AlertTriangle, CalendarClock, Check, ChevronDown, Copy, ExternalLink, GitCommitHorizontal, Loader2, Pencil, Phone, Sparkles, Video } from "lucide-react";
import { EntityAvatar } from "@/components/EntityAvatar";
import { RecordPreview } from "@/components/record/RecordPreview";
import { ChangeRow } from "@/components/approval/ChangeRow";
import { Button } from "@/components/ui/button";
import { SkeletonRows } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { day, due as dueLabel, money, time, toDate } from "@/lib/format";
import { CARD } from "./format";
import type {
  ApproveBody, DealChange, FollowUp, FollowUpRow, FollowUpTask, FollowUpUpdate, RecDetail, Recommendation, SyncResult, Task,
} from "./types";
import { crmName } from "@/lib/crm";
import { ListTile } from "@/components/ui/list";
import { toolLogo } from "@/lib/toolLogo";
import { MailboxPicker } from "@/components/MailboxPicker";
import { CrmName } from "@/components/ui/crm-link";

// ── The follow-up API (/api/follow-ups) ─────────────────────────────────────

export type FollowUpActions = {
  approve: (id: string, body: ApproveBody) => Promise<FollowUpRow>;
  sendEmail?: (id: string, body: { to?: string[]; subject: string; body: string; from?: string }) => Promise<FollowUpRow>;
  skip: (id: string) => Promise<FollowUpRow>;
  attribute: (id: string, choice: string) => Promise<FollowUpRow>;
  /** Approve, then write to HubSpot and Gmail drafts. Only on a workspace with write-back on. */
  sync?: (id: string, body: ApproveBody) => Promise<SyncResult>;
  workspaceId?: string;
};

/** The decisions, for one workspace. Each answers with the card as it now is. */
export function followUpApi(apiUrl: string, token: string | undefined, workspaceId: string): FollowUpActions {
  const send = (id: string, action: string, body: object) => fetch(`${apiUrl}/api/follow-ups/${encodeURIComponent(id)}/${action}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ workspaceId, ...body }),
  });
  const post = async (id: string, action: string, body: object): Promise<FollowUpRow> => {
    const r = await send(id, action, body);
    const b = await r.json().catch(() => null);
    // A 409 that carries the card is still an answer: someone decided it first, so show theirs.
    if (b?.follow_up && (r.ok || r.status === 409)) return b.follow_up as FollowUpRow;
    throw new Error(b?.error ?? String(r.status));
  };
  return {
    workspaceId,
    // Approve & send (GET-742): the email goes out from the reviewer's own Gmail now.
    sendEmail: async (id, body) => {
      const r = await send(id, "send-email", body);
      const b = await r.json().catch(() => null);
      if (!r.ok) throw new Error(b?.message ?? b?.error ?? String(r.status));
      return b.follow_up as FollowUpRow;
    },
    approve: (id, body) => post(id, "approve", body),
    skip: (id) => post(id, "skip", {}),
    attribute: (id, choice) => post(id, "attribution", { choice }),
    sync: async (id, body) => {
      const r = await send(id, "sync", body);
      const b = await r.json().catch(() => null);
      // HubSpot refusing the write (403) still carries the card: it was approved, and that stands.
      if (b?.follow_up && (r.ok || r.status === 403 || r.status === 409)) return b as SyncResult;
      throw new Error(b?.error ?? String(r.status));
    },
  };
}

// The workspaces where HubSpot refused a write, or write-back turned out to be off, this session.
// Every card there falls back to Approve, not only the one that found out.
const refusedWorkspaces = new Set<string>();
const refusedListeners = new Set<() => void>();
function markWritebackRefused(ws: string | undefined) {
  if (!ws || refusedWorkspaces.has(ws)) return;
  refusedWorkspaces.add(ws);
  refusedListeners.forEach((l) => l());
}
function useWritebackRefused(ws: string | undefined): boolean {
  return useSyncExternalStore(
    (cb) => { refusedListeners.add(cb); return () => { refusedListeners.delete(cb); }; },
    () => !!ws && refusedWorkspaces.has(ws),
  );
}
const writeAccess = () => `Grant ${crmName()} write access (tasks, notes) to sync`;

/** A GET /api/follow-ups row as the card reads it (the same `followup` Home sends). */
export function rowToFollowUp(row: FollowUpRow): FollowUp {
  const meetings = row.meetings ?? [];
  const last = meetings[meetings.length - 1] ?? null;
  return {
    follow_up_id: row.id, status: row.status,
    tasks: row.tasks ?? [], updates: row.updates ?? [], email: row.email ?? null, attribution: row.attribution ?? null,
    meeting: last ? { kind: last.kind ?? null, at: last.at ?? null, title: last.title ?? null } : null,
    meetings, summary: row.summary ?? null, crm: row.crm ?? null,
    deal_change: row.deal_change ? { reason: row.deal_change.reason, url: row.deal_change.url ?? null } : null,
    verdict: row.verdict ?? null,
    writeback: row.writeback === true,
  };
}

/** A row as one of Home's recommendations, so the account page can show the same card. */
export function rowToRecommendation(row: FollowUpRow): Recommendation {
  const fu = rowToFollowUp(row);
  return {
    id: `fu:${row.id}`, kind: "follow_up_call", title: `Send the follow-up to ${row.account?.name ?? "this account"}`,
    why: row.summary ?? null, when: fu.meeting?.at ?? null, entity_id: row.account?.id ?? "",
    account: row.account ?? { id: null, name: null, domain: null }, assignee: null, created_at: row.created_at,
    followup: fu,
  };
}

/** The follow_ups id behind a recommendation, or null for an older one the engine did not build. */
export function followUpIdOf(r: Recommendation): string | null {
  if (!r.followup) return null;
  return r.followup.follow_up_id ?? (r.id.startsWith("fu:") ? r.id.slice(3) : null);
}

/** Tasks that become real when their cards are approved: ticked, not on Tasks already, not dropped. */
export function waitingTaskCount(rows: Pick<FollowUpRow, "tasks">[]): number {
  return rows.reduce((n, r) => n + (r.tasks ?? []).filter((t) => t.on !== false && !t.existing && !t.dropped).length, 0);
}

/** Whether a follow-up still waits on the rep. Anything without the engine's status is waiting. */
export const isReady = (r: Recommendation) => (r.followup?.status ?? "ready") === "ready";

// ── The list ────────────────────────────────────────────────────────────────

type Handlers = {
  /** The older recommendation's page. */
  onReview?: (r: Recommendation) => void;
  onOpenAccount?: (r: Recommendation) => void;
  /** Dismisses an older recommendation. An engine card skips through `actions`. */
  onSkip?: (r: Recommendation) => void;
  onTask?: (t: Task) => void;
  loadDetail?: (id: string) => Promise<RecDetail | null>;
  actions?: FollowUpActions;
  /** The card after a decision, for the page to keep (counts, cache). */
  onChange?: (r: Recommendation, fu: FollowUp) => void;
};

/** Home's "Waiting on you" card: a header with the count, then one row per follow-up. */
export function FollowUps({ recs, failed, tasks, dealChanges, ready, anchorRef, openId, ...h }: Handlers & {
  recs: Recommendation[] | null; failed: boolean; tasks: Task[] | null; dealChanges: DealChange[];
  ready: number | null; anchorRef?: Ref<HTMLElement>;
  /** A follow-up to open and scroll to on arrival (?followup=<id>, from Priorities; GET-672). */
  openId?: string | null;
}) {
  // A decided card stays on the page as a one-line receipt until the next visit.
  const shown = (recs ?? []).filter((r) => r.followup?.status !== "merged");
  return (
    <section ref={anchorRef} aria-label="Waiting on you" className="scroll-mt-6 rounded-2xl border border-border/70 bg-card p-2">
      <div className="flex items-baseline gap-2 px-2 pb-1 pt-1.5">
        <h2 className="section-title">Waiting on you</h2>
        {ready != null && <span className="text-[12px] tabular-nums text-muted-foreground/60">{ready}</span>}
        <span className="flex-1" />
        <Link to="/tasks" className="text-[12px] text-muted-foreground/70 transition-colors duration-fast hover:text-foreground">All tasks</Link>
      </div>
      {failed ? (
        <p className="px-2 py-2 text-[13px] text-muted-foreground/70">Couldn't load this right now.</p>
      ) : recs === null ? (
        <SkeletonRows rows={3} />
      ) : (
        <div>
          {shown.map((r) => (
            <FollowUpCard key={r.id} variant="row" r={r} tasks={tasksFor(r, tasks)} defaultOpen={r.id === openId}
              dealChange={dealChanges.find((d) => d.account_id && d.account_id === r.account.id) ?? null} {...h} />
          ))}
          {!shown.some(isReady) && (
            <p className="px-2 py-2 text-[13px] text-muted-foreground/70">All caught up</p>
          )}
        </div>
      )}
    </section>
  );
}

/** The account's open tasks: the rows the Tasks page shows, matched by account or person. */
export function tasksFor(r: Recommendation, tasks: Task[] | null): Task[] | null {
  if (!tasks) return null;
  const name = r.account.name?.toLowerCase() ?? null;
  return tasks.filter((t) => !t.completed_at && t.status !== "done" && (
    (r.account.id && (t.company_id === r.account.id || t.entity_id === r.account.id)) ||
    t.entity_id === r.entity_id ||
    (name && (t.company ?? t.account)?.toLowerCase() === name)
  ));
}

/** A calendar date as the card shows it: "2 Oct". */
const shortDate = (s: string | null | undefined): string => (s ? day(s) || s : "");

/** "Call · Yesterday, 15:00", or every meeting on a merged card: "Demo · 1 Oct + Call · 3 Oct". */
function meetingLine(r: Recommendation): string {
  const fu = r.followup;
  const ms = (fu?.meetings ?? []).filter((m) => m.at);
  if (ms.length > 1) return ms.map((m) => `${m.kind || "Meeting"} · ${shortDate(m.at)}`).join(" + ");
  const kind = fu?.meeting?.kind ?? ms[0]?.kind ?? "Call";
  // A recommendation knows when it was raised, not when the call ran, so without the engine's
  // meeting time the row says the day and nothing more precise.
  const at = fu?.meeting?.at ?? ms[0]?.at ?? null;
  const when = at ? `${dueLabel(at)}, ${time(at)}` : (r.when ?? r.created_at) ? dueLabel(r.when ?? r.created_at) : "";
  return `${kind}${when ? ` · ${when}` : ""}`;
}

/** When the follow-up is due. The API sends "today" for the engine's cards, else a date. */
function rowDue(r: Recommendation): string {
  if (!r.due) return "";
  if (r.due === "today") return "Today";
  return toDate(r.due) ? dueLabel(r.due) : "";
}

type TaskPick = { on: boolean; text: string; restored: boolean };

// ── One card ────────────────────────────────────────────────────────────────

/** One follow-up. Exported so an account page can show its own follow-up the same way. */
export function FollowUpCard({ r, tasks, dealChange, defaultOpen = false, variant = "card", onReview, onOpenAccount, onSkip, onTask, loadDetail, actions, onChange }: Handlers & {
  r: Recommendation; tasks: Task[] | null; dealChange: DealChange | null; defaultOpen?: boolean;
  /** "card": a boxed card (the account page). "row": a row inside Home's "Waiting on you" list.
   *  "pane": the row's open body on its own, always open (the Priorities inbox's right pane, GET-678). */
  variant?: "card" | "row" | "pane";
}) {
  const pane = variant === "pane";
  const row = variant === "row" || pane;
  const fu = r.followup ?? null;
  const fuId = followUpIdOf(r);
  // The engine's card is decided here; anything else keeps the recommendation's own flow.
  const engine = !!fu && !!fuId;
  // Read defensively: an engine that sends a follow-up without one of these must not blank the card.
  const fuTasks: FollowUpTask[] = fu?.tasks ?? [];
  const fuUpdates = fu?.updates ?? [];
  const [openState, setOpen] = useState(defaultOpen);
  const open = pane || openState;
  // What the rep keeps, and how they worded it. Dropped and existing tasks start unticked; a
  // restore turns a dropped one back into a ticked proposal.
  const [picks, setPicks] = useState<Record<string, TaskPick>>(() => Object.fromEntries(fuTasks.map((t) => [t.id, {
    on: t.on !== false && !t.existing && !t.dropped, text: t.text, restored: false,
  }])));
  const [offUpdates, setOffUpdates] = useState<Set<string>>(() => new Set(fuUpdates.filter((u) => u.on === false).map((u) => u.id)));
  const [subject, setSubject] = useState(fu?.email?.subject ?? "");
  const [body, setBody] = useState(fu?.email?.body ?? "");
  const [editing, setEditing] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // The email decided on its own (GET-742): skipped (left out of Approve and Sync) or sent now.
  const [emailSkipped, setEmailSkipped] = useState(false);
  const [sending, setSending] = useState(false);
  const [sentAt, setSentAt] = useState<string | null>(fu?.email_sent?.at ?? null);
  const [fromId, setFromId] = useState<string | null>(null);
  const emailSent = !!sentAt;
  const [busy, setBusy] = useState<"approve" | "skip" | null>(null);
  const [picking, setPicking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<{ tasks: number; copied: boolean } | null>(null);
  const [detail, setDetail] = useState<RecDetail | null | undefined>(undefined);
  // Write-back: the last sync's answer, and the plain words when HubSpot said no.
  const [synced, setSynced] = useState<SyncResult | null>(null);
  const [syncNote, setSyncNote] = useState<string | null>(null);
  const refused = useWritebackRefused(actions?.workspaceId);
  const syncMode = engine && fu?.writeback === true && !!actions?.sync && !refused;

  // What HubSpot says now, for an older recommendation, comes from its own page data, fetched the
  // first time the card opens. The engine's card carries it (fu.crm), so there is nothing to fetch.
  useEffect(() => {
    if (!open || detail !== undefined || engine || fu?.crm || !loadDetail) return;
    let alive = true;
    loadDetail(r.id).then((d) => { if (alive) setDetail(d); }, () => { if (alive) setDetail(null); });
    return () => { alive = false; };
  }, [open, detail, engine, fu?.crm, r.id, loadDetail]);

  const pickOf = (t: FollowUpTask): TaskPick => picks[t.id] ?? { on: false, text: t.text, restored: false };
  const setPick = (id: string, patch: Partial<TaskPick>) => setPicks((p) => ({ ...p, [id]: { ...(p[id] ?? { on: false, text: "", restored: false }), ...patch } }));
  const toggleUpdate = (id: string) => setOffUpdates((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  const name = r.account.name ?? r.person ?? r.title;
  const summary = fu?.summary ?? r.why;

  // Updates: the engine's, else the CRM fields the API already proposes (preview only for now).
  const updates: FollowUpUpdate[] = fu ? fuUpdates : (r.hubspot ?? []).map((p, i) => ({
    id: String(i), label: `${p.object} · ${p.field}`, value: p.value, quote: p.quote ?? null,
    speaker: p.speaker ? `${p.speaker}${p.at ? `, ${p.at}` : ""}` : null,
  }));
  const ticked = fuTasks.filter((t) => !t.existing && (!t.dropped || pickOf(t).restored) && pickOf(t).on);
  const nTasks = fu ? ticked.length : tasks?.length ?? null;
  const nUpdates = updates.filter((u) => !offUpdates.has(u.id)).length;
  const attribution = fu?.attribution?.options?.length ? fu.attribution : null;
  const answer = attribution?.chosen ?? null;
  const needsPick = !!attribution && !answer;
  const chosen = attribution?.options.find((o) => o.id === answer) ?? null;
  const chosenLabel = answer === "both" && attribution ? attribution.options.map((o) => o.name).join(" + ")
    : answer === "neither" ? "Not filed on a deal" : chosen?.name ?? null;

  const flag: { text: string; url: string | null; kind: "stage" | "close" } | null = fu?.deal_change
    ? { text: fu.deal_change.reason, url: fu.deal_change.url ?? null, kind: "stage" }
    : dealChange
      ? {
        text: `${dealChange.deal ?? "The deal"}${dealChange.stage ? ` (${dealChange.stage})` : ""} was due to close on ${shortDate(dealChange.close_date)} and is still open. Update the close date or the stage in ${crmName()}.`,
        url: dealChange.hubspot_url ?? null,
        kind: "close",
      }
      : null;
  // The deal the change is on, when the card knows it (the engine's card carries the CRM's deal).
  const flagDeal = fu?.deal_change ? fu.crm?.deal ?? null : null;

  const decided = (row: FollowUpRow) => onChange?.(r, rowToFollowUp(row));

  const answerDeal = async (choice: string) => {
    if (!actions || !fuId || picking) return;
    setPicking(choice); setError(null);
    try { decided(await actions.attribute(fuId, choice)); }
    catch { setError("Couldn't save which deal. Try again."); }
    finally { setPicking(null); }
  };

  const copyEmail = async () => {
    try {
      await navigator.clipboard.writeText(body);
      setCopied(true);
    } catch {
      setError("Couldn't copy. Select the text and copy it instead.");
    }
  };

  const approvalBody = (): ApproveBody => ({
    tasks: ticked.map((t) => ({ id: t.id, text: pickOf(t).text.trim() || t.text, due: t.due ?? null, ...(t.dropped ? { restored: true } : {}) })),
    updates: updates.filter((u) => !offUpdates.has(u.id)).map((u) => u.id),
    email: fu?.email && !emailSkipped && !emailSent ? { subject, body, ...(fromId ? { from: fromId } : {}) } : null,
  });

  const sendEmailNow = async () => {
    if (!actions?.sendEmail || !fuId || sending) return;
    setSending(true); setError(null);
    try {
      const row = await actions.sendEmail(fuId, { subject, body, ...(fromId ? { from: fromId } : {}) });
      setSentAt(row.email_sent?.at ?? new Date().toISOString());
      onChange?.(r, rowToFollowUp(row));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't send it. Try again.");
    } finally { setSending(false); }
  };

  // Sync approves first (the server does it), so a refusal from HubSpot still leaves the tasks on
  // Tasks; the card then says why and every card falls back to Approve. Pressed again on an
  // approved card, it finishes whatever did not make it last time.
  const syncNow = async () => {
    if (!actions?.sync || !fuId || needsPick || busy) return;
    setBusy("approve"); setError(null);
    try {
      const out = await actions.sync(fuId, approvalBody());
      if (out.error === "crm_write_not_allowed") {
        markWritebackRefused(actions.workspaceId);
        setSyncNote(out.message || writeAccess());
      } else if (out.error === "sync_in_progress") {
        setSyncNote("Already syncing. Check back in a moment.");
      } else if (out.failed?.length) {
        setSyncNote(out.failed[0].message || `Some of it didn't reach ${crmName()}. Try again.`);
      } else if (out.draft?.status === "failed") {
        setSyncNote(`The Gmail draft didn't save${out.draft.message ? `: ${out.draft.message}` : "."}`);
      } else {
        setSyncNote(null);
      }
      setSynced(out);
      setReceipt({ tasks: out.follow_up.verdict?.tasks_ticked ?? ticked.length, copied });
      setOpen(false);
      decided(out.follow_up);
    } catch (e) {
      const code = e instanceof Error ? e.message : "";
      if (code === "writeback_off" || code === "hubspot_not_connected") {
        markWritebackRefused(actions.workspaceId);
        setError(code === "writeback_off"
          ? `Syncing to ${crmName()} is off for this workspace. Approve adds the tasks to Tasks.`
          : `${crmName()} isn't connected. Approve adds the tasks to Tasks.`);
      } else {
        setError(code === "attribution_required" ? "Pick a deal first." : "Couldn't sync this. Try again.");
      }
    } finally {
      setBusy(null);
    }
  };

  const approve = async () => {
    if (!actions || !fuId || needsPick || busy) return;
    setBusy("approve"); setError(null);
    const payload = approvalBody();
    try {
      const row = await actions.approve(fuId, payload);
      setReceipt({ tasks: row.verdict?.tasks_ticked ?? payload.tasks.length, copied });
      setOpen(false);
      decided(row);
    } catch (e) {
      setError(e instanceof Error && e.message === "attribution_required" ? "Pick a deal first." : "Couldn't approve this. Try again.");
    } finally {
      setBusy(null);
    }
  };

  const skip = async () => {
    if (!engine) { onSkip?.(r); return; }
    if (!actions || !fuId || busy) return;
    setBusy("skip"); setError(null);
    try { decided(await actions.skip(fuId)); }
    catch { setError("Couldn't skip this. Try again."); }
    finally { setBusy(null); }
  };

  if (fu?.status === "synced") {
    // No Gmail on this seat: the draft could not be saved, so the email stays one click away.
    const copyInstead = synced?.draft?.status === "no_gmail" && !!fu.email;
    return (
      <Receipt row={row} r={r} tone="done" name={row ? r.title : name} hubspot note={copyInstead && !copied ? "No Gmail connected, so the email wasn't saved as a draft." : null}
        action={copyInstead ? (
          <button onClick={copyEmail} title="Copy the email body"
            className="inline-flex flex-shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[12.5px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground">
            {copied ? <Check className="h-3 w-3" strokeWidth={2.5} /> : <Copy className="h-3 w-3" />}{copied ? "Copied" : "Copy email"}
          </button>
        ) : undefined}>
        <SyncedLine fu={fu} synced={synced} copied={receipt?.copied || copied} />
      </Receipt>
    );
  }
  if (engine && fu?.status === "approved") {
    const n = receipt?.tasks ?? fu.verdict?.tasks_ticked ?? null;
    const s = synced?.sync ?? fu.verdict?.sync ?? null;
    const inHubspot = Object.keys(s?.tasks ?? {}).length;
    // Approved and not (all) in HubSpot yet: on a write-back workspace the receipt keeps the button,
    // which syncs what the approval chose and finishes a sync that stopped part way.
    const tried = !!s || !!synced;
    return (
      <Receipt row={row} r={r} tone="done" name={row ? r.title : name}
        note={syncNote ?? (error ? <span className="text-red-600 dark:text-red-400">{error}</span> : null)}
        action={syncMode ? (
          <button onClick={syncNow} disabled={!!busy}
            className="inline-flex flex-shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-[12.5px] font-medium text-[#E8603C] hover:bg-[#FF7A59]/10 disabled:opacity-50 dark:text-[#FF8F73]">
            {busy && <Loader2 className="h-3 w-3 animate-spin" />}
            {busy ? "Syncing…" : tried ? "Retry sync" : <>Sync to <CrmName /></>}
          </button>
        ) : undefined}>
        Approved{n != null && ` · ${n ? `${n} ${n === 1 ? "task" : "tasks"} added to Tasks` : "no tasks added"}`}
        {tried && n ? ` · ${inHubspot} of ${n} in ${crmName()}` : ""}
        {(receipt?.copied || copied) && " · email copied"}
      </Receipt>
    );
  }
  if (engine && fu?.status === "skipped") {
    // Undo is this page only: the card is skipped on the server, and can still be approved.
    return (
      <Receipt row={row} r={r} tone="muted" name={row ? r.title : name}
        action={<button onClick={() => fu && onChange?.(r, { ...fu, status: "ready" })} className="rounded-md px-2 py-1 text-[12.5px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground">Undo</button>}>
        Skipped
      </Receipt>
    );
  }

  // ── Home's row: the canvas's "Waiting on you" list (interface refresh, GET-603) ──
  if (row) {
    const dueText = rowDue(r);
    const to = fu?.email ? (Array.isArray(fu.email.to) ? fu.email.to.join(", ") : fu.email.to) : "";
    const company = r.account.name ?? r.person ?? null;
    const avatar = <EntityAvatar kind="company" name={company} domain={r.account.domain} className="h-6 w-6 rounded-md shadow-[inset_0_0_0_1px_hsl(var(--border)/0.6)]" textClassName="text-[10px] font-medium" />;
    // The account leads the row, as in the search palette; it previews on hover (GET-658).
    const companyLogo = r.account.id
      ? <RecordPreview kind="account" companyId={r.account.id}><span className="flex flex-shrink-0">{avatar}</span></RecordPreview>
      : <span title={company ?? undefined} className="flex flex-shrink-0">{avatar}</span>;
    // The wrap-up's parts, drawn in this order on Home and grouped by the Priorities pane.
    // The email, as a preview you can still edit: To, Subject, then the body. Nous never sends it.
    // THE SAME CARD AS EVERY OTHER DRAFT (GET-740): the Gmail tile, "Draft email · Not sent yet",
    // To and Subject on their own lines, the body, and a footer that says what happens to it.
    const emailPart = (fu?.email ? (
      <div className="overflow-hidden rounded-2xl border border-border/70 bg-card">
        <div className="flex items-center gap-2.5 px-3.5 py-2.5">
          <ListTile><img src={toolLogo("gmail") ?? ""} alt="" className="h-3.5 w-3.5 object-contain" /></ListTile>
          <span className="text-[13.5px] font-medium tracking-[-0.01em] text-foreground">Draft email</span>
          <span className="text-[11.5px] text-muted-foreground/60">Not sent yet</span>
          {engine && (
            <button type="button" onClick={copyEmail} title="Copy the email body"
              className="ml-auto inline-flex h-[26px] items-center gap-1 rounded-md px-2 text-[12px] text-ink-2 transition-colors duration-fast hover:bg-hover hover:text-foreground">
              {copied ? <Check className="h-3 w-3" strokeWidth={2.5} /> : <Copy className="h-3 w-3" />}{copied ? "Copied" : "Copy"}
            </button>
          )}
        </div>
        <MailboxPicker value={fromId} onChange={setFromId} prefer={fu.email_sent?.mailbox ?? null} disabled={emailSent} className="border-t border-hairline px-3.5 py-2" />
        <div className="flex items-start gap-2.5 border-t border-hairline px-3.5 py-2 text-[12.5px]">
          <span className="w-[52px] shrink-0 pt-px text-[11.5px] text-muted-foreground/70">To</span>
          <span className="min-w-0 flex-1 break-words text-foreground">{to}</span>
        </div>
        <label className="flex items-center gap-2.5 border-t border-hairline px-3.5 py-2 text-[12.5px]">
          <span className="w-[52px] shrink-0 text-[11.5px] text-muted-foreground/70">Subject</span>
          <input value={subject} onChange={(e) => setSubject(e.target.value)} aria-label="Subject" disabled={emailSent || emailSkipped}
            className="min-w-0 flex-1 bg-transparent text-foreground focus:outline-none disabled:text-muted-foreground" />
        </label>
        <textarea value={body} onChange={(e) => { setBody(e.target.value); setCopied(false); }} aria-label="Follow-up email" disabled={emailSent || emailSkipped}
          rows={Math.min(18, Math.max(5, body.split("\n").length + 2))}
          className={cn("block w-full resize-none border-t border-hairline bg-transparent px-3.5 pb-3.5 pt-3 text-[13px] leading-[1.6] text-foreground focus:outline-none", (emailSent || emailSkipped) && "opacity-60")} />
        <div className="flex items-center gap-1.5 border-t border-hairline px-3.5 py-2.5">
          <span className="min-w-0 flex-1 truncate text-[11.5px] text-muted-foreground/60">
            {emailSent ? `Sent${fu.email_sent?.mailbox ? ` from ${fu.email_sent.mailbox}` : ""}` : emailSkipped ? "Skipped. It won't be drafted or sent." : "Sends when you approve"}
          </span>
          {emailSkipped && !emailSent ? (
            <button type="button" onClick={() => setEmailSkipped(false)}
              className="inline-flex h-[26px] items-center rounded-md px-2.5 text-[12px] text-ink-2 transition-colors duration-fast hover:bg-hover hover:text-foreground">Undo</button>
          ) : !emailSent && engine && (<>
            <button type="button" onClick={() => setEmailSkipped(true)} disabled={sending}
              className="inline-flex h-[26px] items-center rounded-md px-2.5 text-[12px] text-ink-2 transition-colors duration-fast hover:bg-hover hover:text-foreground disabled:opacity-50">Skip</button>
            <button type="button" onClick={() => void sendEmailNow()} disabled={sending || !body.trim() || !actions?.sendEmail}
              className="inline-flex h-[26px] items-center gap-1.5 rounded-[7px] bg-primary px-2.5 text-[12px] font-medium text-primary-foreground shadow-[0_1px_2px_rgba(20,20,18,0.18)] transition-colors duration-fast hover:bg-primary/90 disabled:opacity-40">
              {sending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}Approve &amp; send
            </button>
          </>)}
        </div>
      </div>
            ) : engine ? (
      <p className="text-[12.5px] text-muted-foreground">No email drafted for this meeting.</p>
            ) : (
      <div className="flex items-center gap-3 rounded-[10px] border border-border bg-card px-3 py-2.5">
        <p className="min-w-0 flex-1 text-[12.5px] text-ink-2">Nous drafts the follow-up in your voice when you open it.</p>
        <Button size="sm" variant="outline" onClick={() => onReview?.(r)}>Draft follow-up</Button>
      </div>
            ));
    // The change the CRM should make (ChangeRow, GET-617). Nous never makes it: Review opens the deal in the CRM.
    const flagPart = (flag && (
      <div title={`Nous never changes a deal. This clears when ${crmName()} shows the change.`}>
        <ChangeRow
          icon={flag.kind === "close" ? <CalendarClock /> : <GitCommitHorizontal />}
          tone="warning"
          title="Deal change required"
          record={flagDeal ?? undefined}
          reason={flag.text}
          // On a phone the reason takes the full width and Review drops under it.
          className="rounded-[10px] px-3 py-2.5 max-sm:flex-wrap max-sm:[&>div:nth-child(2)]:basis-[calc(100%-38px)] max-sm:[&>div:nth-child(3)]:pl-[38px]"
          actions={flag.url ? (
            <Button asChild size="sm" variant="outline">
              <a href={flag.url} target="_blank" rel="noreferrer" title={`Open in ${crmName()}`}>Review</a>
            </Button>
          ) : undefined}
        />
      </div>
            )) || null;
    // Each task approved or skipped on its own, or all at once (GET-740); Approve files exactly those.
    const choosable = fuTasks.filter((t) => !t.existing && (!t.dropped || pickOf(t).restored));
    const setAll = (on: boolean) => setPicks((p) => Object.fromEntries(Object.entries(p).map(([k, v]) => [k, choosable.some((t) => t.id === k) ? { ...v, on } : v])));
    const tasksPart = (fu ? (
      fuTasks.length > 0 && (
        <Section label={pane ? "" : "Tasks to create"}>
          {engine && choosable.length > 1 && (
            <div className="flex items-center gap-1 px-2 pb-1 text-[12px]">
              <span className="flex-1 text-muted-foreground">{ticked.length} of {choosable.length} approved</span>
              <button type="button" onClick={() => setAll(false)} className="h-6 rounded-md px-2 text-muted-foreground transition-colors hover:bg-hover hover:text-foreground">Skip all</button>
              <button type="button" onClick={() => setAll(true)} className="h-6 rounded-md px-2 text-foreground transition-colors hover:bg-hover">Approve all</button>
            </div>
          )}
          {fuTasks.map((t) => {
            if (t.existing) return <ExistingTask key={t.id} t={t} />;
            if (t.dropped && !pickOf(t).restored) {
              return <DroppedTask key={t.id} t={t} onRestore={() => setPick(t.id, { restored: true, on: true })} />;
            }
            const p = pickOf(t);
            return (
              <TaskRow key={t.id} id={`${pane ? "pane-" : ""}fu-${fuId ?? r.id}-${t.id}`.replace(/[^\w-]/g, "_")} on={p.on} text={p.text} edited={p.text.trim() !== t.text}
                meta={t.due ? shortDate(t.due) : t.due_phrase ?? null} restored={!!t.dropped}
                editing={editing === t.id} canEdit={engine} buttons={engine}
                onToggle={() => setPick(t.id, { on: !p.on })}
                onEdit={() => setEditing(t.id)}
                onSave={(v) => { setPick(t.id, { text: v.trim() || t.text }); setEditing(null); }}
                onCancel={() => setEditing(null)} />
            );
          })}
        </Section>
      )
            ) : (
      <Section label="Open tasks" count={tasks?.length}>
        {tasks === null ? <div className="h-8 animate-pulse rounded-md bg-muted/50" />
          : !tasks.length ? <Quiet>No open tasks on this account.</Quiet>
          : tasks.map((t) => (
            <button key={t.id} type="button" onClick={() => onTask?.(t)}
              className="flex w-full items-start gap-2.5 rounded-lg px-2 py-1.5 text-left hover:bg-muted/50">
              <span className="mt-[3px] h-3.5 w-3.5 flex-shrink-0 rounded-[4px] border-[1.5px] border-border" aria-hidden />
              <span className="min-w-0 flex-1 text-[13px] leading-snug text-foreground">{t.title}</span>
              <span className="flex-shrink-0 whitespace-nowrap text-[11.5px] text-muted-foreground">{[t.assignee?.name ?? t.owner_name, taskDue(t)].filter(Boolean).join(" · ")}</span>
            </button>
          ))}
      </Section>
            )) || null;
    const updatesPart = (!!updates.length && (
      <Section label="Updates to log">
        {updates.map((u) => (
          <CheckRow key={u.id} on={!offUpdates.has(u.id)} onChange={() => toggleUpdate(u.id)} strike={false}>
            <span className="text-muted-foreground">{u.label}:</span> {u.value}
            {u.quote && (
              <span className="mt-0.5 block text-[11.5px] italic text-muted-foreground">
                "{u.quote}"{u.speaker && <span className="not-italic"> · {u.speaker}</span>}
              </span>
            )}
          </CheckRow>
        ))}
      </Section>
            )) || null;
    const crmPart = <CrmNow engine={engine} fu={fu} detail={detail} dealChange={dealChange} chosen={chosen} chosenLabel={chosenLabel} pending={needsPick} quiet />;
    return (
      <div id={pane ? undefined : `fu-${r.id}`} className={cn(!pane && "scroll-mt-20 rounded-lg", !pane && open && "bg-hover")}>
        {!pane && <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open}
          className={cn("flex h-10 w-full items-center gap-2.5 rounded-lg px-2 text-left transition-colors duration-fast", !open && "hover:bg-hover")}>
          {companyLogo}
          <span className="flex min-w-0 flex-1 items-baseline gap-2">
            <span className="truncate text-[13px] text-foreground">{r.title}</span>
            <span className="hidden min-w-0 truncate text-[11.5px] text-muted-foreground/70 sm:inline">After the call · {meetingLine(r)}</span>
          </span>
          {/* The two flags that ask for a decision; a phone keeps the row to its title. */}
          {needsPick && <Chip className="hidden text-[11px] font-medium text-ink-2 sm:inline-block">which deal?</Chip>}
          {flag && <Chip className="hidden bg-warning/10 text-[11px] font-medium text-warning sm:inline-block">deal change</Chip>}
          {dueText && <span className="hidden w-[62px] flex-shrink-0 text-right text-[12px] tabular-nums text-muted-foreground/70 min-[420px]:block">{dueText}</span>}
        </button>}

        {open && (
          <div className={cn("flex flex-col gap-3", !pane && "pb-3 pl-2 pr-2 pt-0.5 sm:pl-[42px]")}>
            {summary && <p className="text-[12.5px] leading-relaxed text-ink-2">{summary}</p>}

            {attribution && (
              <div className="rounded-[10px] border border-border bg-card p-3">
                <p className="mb-2 text-[12.5px] font-medium text-foreground">
                  {attribution.question ?? "This call touched more than one open deal. Which one should it be filed on?"}
                </p>
                <div className="flex flex-wrap gap-2">
                  {attribution.options.map((o) => (
                    <DealButton key={o.id} on={answer === o.id} busy={picking === o.id} disabled={!engine || !!picking} onClick={() => answerDeal(o.id)}>
                      {o.name}
                      <span className="opacity-60">{[o.value ? money(o.value, "stat") : null, o.stage].filter(Boolean).map((x) => ` · ${x}`).join("")}</span>
                    </DealButton>
                  ))}
                  {attribution.options.length > 1 && (
                    <DealButton quiet on={answer === "both"} busy={picking === "both"} disabled={!engine || !!picking} onClick={() => answerDeal("both")}>Both</DealButton>
                  )}
                  <DealButton quiet on={answer === "neither"} busy={picking === "neither"} disabled={!engine || !!picking} onClick={() => answerDeal("neither")}>Neither</DealButton>
                </div>
              </div>
            )}

            {pane ? (
              // The Priorities inbox reads one meeting's wrap-up in three parts, in this order
              // (GET-681): the thank-you email, the tasks, what goes back to the CRM. Same pieces
              // and the same behaviour as the row below, only grouped and labelled.
              <>
                {/* The email is its own card, "Draft email · Not sent yet": no heading above it (GET-742). */}
                <PaneGroup>{emailPart}</PaneGroup>
                <PaneGroup label="Tasks">{tasksPart ?? <Quiet>No tasks from this meeting.</Quiet>}</PaneGroup>
                <PaneGroup label={`${crmName()} updates`}>{flagPart}{updatesPart}{crmPart}</PaneGroup>
              </>
            ) : (
              // The workspace-redesign card (restored 2026-10-06): what goes to the CRM, then the
              // tasks, on the left; the drafted email on the right. Stacked below lg.
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] lg:gap-6">
                <div className="flex min-w-0 flex-col gap-3">
                  <p className="-mb-1 text-[11.5px] font-medium uppercase tracking-wide text-muted-foreground/70">Goes to {crmName()}</p>
                  {crmPart}{flagPart}{updatesPart}{tasksPart}
                </div>
                <div className="min-w-0">{emailPart}</div>
              </div>
            )}

            <div className="flex flex-wrap items-center gap-1.5">
              {syncMode ? (
                <Button size="sm" onClick={syncNow} disabled={needsPick || !!busy} title={needsPick ? "Pick a deal first" : undefined}>
                  {busy === "approve" && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                  {busy === "approve" ? "Syncing…" : <>Sync to <CrmName /></>}
                </Button>
              ) : engine ? (
                <Button size="sm" onClick={approve} disabled={needsPick || !!busy || !actions} title={needsPick ? "Pick a deal first" : undefined}>
                  {busy === "approve" && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                  {busy === "approve" ? "Approving…" : "Approve"}
                </Button>
              ) : (
                <Button size="sm" onClick={() => onReview?.(r)}>Review</Button>
              )}
              {onOpenAccount && r.account.id && (
                <Button size="sm" variant="outline" onClick={() => onOpenAccount(r)}>Open account</Button>
              )}
              <Button size="sm" variant="ghost" onClick={skip} disabled={!!busy} className="text-ink-2">
                {busy === "skip" ? "Skipping…" : "Skip"}
              </Button>
              <span className="min-w-0 flex-1 basis-[200px] text-right text-[12px] text-muted-foreground max-sm:text-left">
                {needsPick ? "Pick a deal first, so the activity lands on the right one."
                  : syncMode ? <>Adds {nTasks} {nTasks === 1 ? "task" : "tasks"} to Tasks and <CrmName />{fu?.email && !emailSent && !emailSkipped && <>, saves the email to Gmail drafts</>}.</>
                  : engine ? <>Adds {nTasks} {nTasks === 1 ? "task" : "tasks"} to Tasks. Nothing goes to <CrmName /> yet.</>
                  : null}
              </span>
            </div>
            {error && <p role="alert" className="-mt-1 text-[12px] text-risk">{error}</p>}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className={cn(CARD, "overflow-hidden transition-shadow", open && "border-foreground/15 shadow-sm")}>
      <button onClick={() => setOpen((o) => !o)} aria-expanded={open}
        className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/40">
        <EntityAvatar kind="company" name={name} domain={r.account.domain} className="h-8 w-8 flex-shrink-0 rounded-lg" textClassName="text-[11px] font-semibold" />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5 text-[13.5px]">
            {/* On a phone the name keeps most of the line and the meeting detail truncates. */}
            <span className="max-w-[65%] flex-shrink-0 truncate font-semibold text-foreground">{name}</span>
            <span className="min-w-0 truncate text-muted-foreground">· {meetingLine(r)}</span>
          </div>
          {summary && <div className="truncate text-[12.5px] text-muted-foreground">{summary}</div>}
        </div>
        {/* The counts need a wide screen; the two flags that ask for a decision show sooner. */}
        <div className="flex flex-shrink-0 items-center gap-1.5 text-[11.5px] text-muted-foreground">
          {nTasks != null && nTasks > 0 && <Chip className="hidden xl:inline-block">{nTasks} {nTasks === 1 ? "task" : "tasks"}</Chip>}
          {nUpdates > 0 && <Chip className="hidden xl:inline-block">{nUpdates} {nUpdates === 1 ? "update" : "updates"}</Chip>}
          {fu?.email && <Chip className="hidden xl:inline-block">email</Chip>}
          {flag && <Chip className="hidden bg-amber-50 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300 sm:inline-block">deal change</Chip>}
          {needsPick && <Chip className="hidden bg-violet-50 text-violet-700 dark:bg-violet-950/60 dark:text-violet-300 sm:inline-block">which deal?</Chip>}
        </div>
        <ChevronDown className={cn("h-4 w-4 flex-shrink-0 text-muted-foreground transition-transform", open && "rotate-180")} strokeWidth={1.8} />
      </button>

      {open && (
        <div className="border-t border-border">
          <div className="grid grid-cols-1 divide-y divide-border xl:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)] xl:divide-x xl:divide-y-0">
            {/* Left: what HubSpot says, what should change there, and what to do. */}
            <div className="min-w-0 space-y-4 p-4">
              {attribution && (
                <div className={cn("rounded-lg p-3", answer ? "bg-muted/60" : "bg-violet-50 ring-1 ring-violet-200 dark:bg-violet-950/40 dark:ring-violet-900")}>
                  <p className="mb-2 flex items-center gap-1.5 text-[12.5px] font-medium text-foreground">
                    <Sparkles className="h-3.5 w-3.5 flex-shrink-0 text-violet-600 dark:text-violet-400" />
                    {attribution.question ?? "This call touched more than one open deal. Which one should it be filed on?"}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {attribution.options.map((o) => (
                      <DealButton key={o.id} on={answer === o.id} busy={picking === o.id} disabled={!engine || !!picking} onClick={() => answerDeal(o.id)}>
                        {o.name}
                        <span className="opacity-60">{[o.value ? money(o.value, "stat") : null, o.stage].filter(Boolean).map((s) => ` · ${s}`).join("")}</span>
                      </DealButton>
                    ))}
                    {attribution.options.length > 1 && (
                      <DealButton quiet on={answer === "both"} busy={picking === "both"} disabled={!engine || !!picking} onClick={() => answerDeal("both")}>Both</DealButton>
                    )}
                    <DealButton quiet on={answer === "neither"} busy={picking === "neither"} disabled={!engine || !!picking} onClick={() => answerDeal("neither")}>Neither</DealButton>
                  </div>
                </div>
              )}

              <CrmNow engine={engine} fu={fu} detail={detail} dealChange={dealChange} chosen={chosen} chosenLabel={chosenLabel} pending={needsPick} />

              {flag && (
                <div className="flex gap-2.5 rounded-lg bg-amber-50 p-3 text-[12.5px] ring-1 ring-amber-200 dark:bg-amber-950/40 dark:ring-amber-900">
                  <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-600 dark:text-amber-400" strokeWidth={2} />
                  <div className="min-w-0 flex-1">
                    <p className="font-medium text-amber-900 dark:text-amber-200">Deal change required</p>
                    <p className="mt-0.5 leading-relaxed text-amber-900/80 dark:text-amber-100/80">{flag.text}</p>
                    <p className="mt-1 text-[11.5px] text-amber-900/60 dark:text-amber-100/60">Nous never changes a deal. This clears when <CrmName /> shows the change.</p>
                  </div>
                  {flag.url && (
                    <a href={flag.url} target="_blank" rel="noreferrer"
                      className="flex flex-shrink-0 items-center gap-1 self-start whitespace-nowrap font-medium text-amber-900 hover:underline dark:text-amber-200">
                      Open in <CrmName /><ExternalLink className="h-3 w-3" />
                    </a>
                  )}
                </div>
              )}

              {fu ? (
                <Section label="Tasks to create">
                  {!fuTasks.length ? <Quiet>No tasks from this call.</Quiet> : fuTasks.map((t) => {
                    if (t.existing) return <ExistingTask key={t.id} t={t} />;
                    if (t.dropped && !pickOf(t).restored) {
                      return <DroppedTask key={t.id} t={t} onRestore={() => setPick(t.id, { restored: true, on: true })} />;
                    }
                    const p = pickOf(t);
                    return (
                      <TaskRow key={t.id} id={`fu-${fuId ?? r.id}-${t.id}`.replace(/[^\w-]/g, "_")} on={p.on} text={p.text} edited={p.text.trim() !== t.text}
                        meta={t.due ? shortDate(t.due) : t.due_phrase ?? null} restored={!!t.dropped}
                        editing={editing === t.id} canEdit={engine}
                        onToggle={() => setPick(t.id, { on: !p.on })}
                        onEdit={() => setEditing(t.id)}
                        onSave={(v) => { setPick(t.id, { text: v.trim() || t.text }); setEditing(null); }}
                        onCancel={() => setEditing(null)} />
                    );
                  })}
                </Section>
              ) : (
                <Section label="Open tasks" count={tasks?.length}>
                  {tasks === null ? <div className="h-8 animate-pulse rounded-md bg-muted/50" />
                    : !tasks.length ? <Quiet>No open tasks on this account.</Quiet>
                    : tasks.map((t) => (
                      <button key={t.id} onClick={() => onTask?.(t)}
                        className="flex w-full items-start gap-2.5 rounded-lg px-2 py-1.5 text-left hover:bg-muted/50">
                        <span className="mt-[3px] h-3.5 w-3.5 flex-shrink-0 rounded-[4px] border-[1.5px] border-border" aria-hidden />
                        <span className="min-w-0 flex-1 text-[13px] leading-snug text-foreground">{t.title}</span>
                        <span className="flex-shrink-0 whitespace-nowrap text-[11.5px] text-muted-foreground">{[t.assignee?.name ?? t.owner_name, taskDue(t)].filter(Boolean).join(" · ")}</span>
                      </button>
                    ))}
                </Section>
              )}

              {!!updates.length && (
                <Section label="Updates to log">
                  {updates.map((u) => (
                    <CheckRow key={u.id} on={!offUpdates.has(u.id)} onChange={() => toggleUpdate(u.id)} strike={false}>
                      <span className="text-muted-foreground">{u.label}:</span> {u.value}
                      {u.quote && (
                        <span className="mt-0.5 block text-[11.5px] italic text-muted-foreground">
                          "{u.quote}"{u.speaker && <span className="not-italic"> · {u.speaker}</span>}
                        </span>
                      )}
                    </CheckRow>
                  ))}
                </Section>
              )}
            </div>

            {/* Right: the follow-up email. Edited here, copied out; Nous does not send it. */}
            <div className="flex min-w-0 flex-col p-4">
              <div className="mb-1.5 flex items-center justify-between gap-2">
                <p className="text-[12px] text-muted-foreground">Follow-up email</p>
                {fu?.email && (engine ? (
                  <button onClick={copyEmail} title="Copy the email body"
                    className="inline-flex flex-shrink-0 items-center gap-1 rounded-md px-2 py-0.5 text-[11.5px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground">
                    {copied ? <Check className="h-3 w-3" strokeWidth={2.5} /> : <Copy className="h-3 w-3" />}{copied ? "Copied" : "Copy email"}
                  </button>
                ) : <span className="truncate text-[11px] text-muted-foreground">in your voice · from the transcript</span>)}
              </div>
              {fu?.email ? (
                <div className="flex flex-1 flex-col rounded-lg border border-border">
                  <div className="break-all border-b border-border px-3 py-2 text-[12.5px]">
                    <span className="text-muted-foreground">To </span>
                    {Array.isArray(fu.email.to) ? fu.email.to.join(", ") : fu.email.to}
                  </div>
                  <input value={subject} onChange={(e) => setSubject(e.target.value)} aria-label="Subject"
                    className="min-w-0 border-b border-border bg-transparent px-3 py-2 text-[12.5px] font-medium text-foreground outline-none" />
                  <textarea value={body} onChange={(e) => { setBody(e.target.value); setCopied(false); }} aria-label="Follow-up email"
                    className="min-h-[220px] flex-1 resize-none rounded-b-lg bg-transparent px-3 py-2 text-[13px] leading-relaxed text-foreground outline-none" />
                </div>
              ) : engine ? (
                <p className="flex flex-1 items-center justify-center rounded-lg border border-dashed border-border px-4 py-6 text-center text-[13px] text-muted-foreground">
                  No email drafted for this meeting.
                </p>
              ) : (
                <div className="flex flex-1 flex-col items-start justify-center gap-3 rounded-lg border border-dashed border-border px-4 py-6">
                  <p className="text-[13px] leading-relaxed text-foreground/90">
                    The follow-up from the call: a recap, the next step, and what you promised. Nous drafts it in your voice when you open it.
                  </p>
                  <button onClick={() => onReview?.(r)}
                    className="rounded-lg border border-border bg-card px-3 py-1.5 text-[12.5px] font-medium text-foreground hover:bg-muted/60">
                    Draft follow-up
                  </button>
                </div>
              )}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 border-t border-border bg-muted/40 px-4 py-3">
            <div className="min-w-0 flex-1 basis-[220px] text-[12px]">
              <p className="text-muted-foreground">
                {needsPick ? "Pick a deal first, so the activity lands on the right one."
                  : syncMode ? <>
                    Adds <b className="font-semibold text-foreground">{nTasks} {nTasks === 1 ? "task" : "tasks"}</b> to Tasks and <CrmName />
                    {nUpdates > 0 && <>, logs {nUpdates === 1 ? "the update" : `${nUpdates} updates`} as a note on the deal</>}
                    {fu?.email && <>, and saves the email to your Gmail drafts</>}. Nothing is sent, and Nous never changes a deal.
                  </>
                  : engine ? <>Adds <b className="font-semibold text-foreground">{nTasks} {nTasks === 1 ? "task" : "tasks"}</b> to Tasks. Nothing goes to <CrmName /> yet, and Nous never changes a deal.</>
                  : "Review the follow-up and its sources. Nous never changes a deal stage."}
              </p>
              {error && <p role="alert" className="mt-0.5 text-red-600 dark:text-red-400">{error}</p>}
            </div>
            <button onClick={skip} disabled={!!busy}
              className="rounded-lg px-3 py-1.5 text-[13px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50">
              {busy === "skip" ? "Skipping…" : "Skip"}
            </button>
            {onOpenAccount && r.account.id && (
              <button onClick={() => onOpenAccount(r)}
                className="rounded-lg border border-border bg-card px-3 py-1.5 text-[13px] font-medium text-foreground hover:bg-muted/60">Open account</button>
            )}
            {syncMode ? (
              // HubSpot's orange: this button writes to HubSpot, the plain one only to Nous.
              <button onClick={syncNow} disabled={needsPick || !!busy} title={needsPick ? "Pick a deal first" : undefined}
                className="inline-flex items-center gap-1.5 rounded-lg bg-[#FF7A59] px-3 py-1.5 text-[13px] font-medium text-white hover:bg-[#F2643F] disabled:cursor-not-allowed disabled:opacity-40">
                {busy === "approve" && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                {busy === "approve" ? "Syncing…" : <>Sync to <CrmName /></>}
              </button>
            ) : engine ? (
              <button onClick={approve} disabled={needsPick || !!busy || !actions} title={needsPick ? "Pick a deal first" : undefined}
                className="inline-flex items-center gap-1.5 rounded-lg bg-foreground px-3 py-1.5 text-[13px] font-medium text-background hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40">
                {busy === "approve" && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                {busy === "approve" ? "Approving…" : "Approve"}
              </button>
            ) : (
              <button onClick={() => onReview?.(r)}
                className="rounded-lg bg-foreground px-3 py-1.5 text-[13px] font-medium text-background hover:opacity-90">Review</button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Receipts ────────────────────────────────────────────────────────────────
// A decided card folds to one line, so the list still shows what was done today. `note` is a second
// line for what still needs the rep (HubSpot refused, a sync stopped part way).
function Receipt({ tone, name, action, note, hubspot = false, row = false, r, children }: {
  tone: "done" | "muted"; name: string; action?: ReactNode; note?: ReactNode; hubspot?: boolean;
  /** Home's list: a row under a hairline, the account's logo on the right. */
  row?: boolean; r?: Recommendation; children: ReactNode;
}) {
  return (
    <div className={cn(row ? "flex min-h-10 items-center gap-2.5 rounded-lg px-2 py-1.5" : cn(CARD, "flex items-center gap-3 px-4 py-3"))}>
      <span className={cn("relative flex flex-shrink-0 items-center justify-center", row ? "h-[26px] w-[26px] rounded-lg" : "h-6 w-6 rounded-full",
        tone === "done" ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300" : "bg-muted text-muted-foreground")}>
        <Check className="h-3.5 w-3.5" strokeWidth={2.5} />
        {/* HubSpot's orange dot: this one reached the CRM, not only Nous. */}
        {hubspot && <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-[#FF7A59] ring-2 ring-card" aria-hidden />}
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px]">
          <span className="font-medium text-foreground">{name}</span>
          <span className="text-muted-foreground"> · {children}</span>
        </p>
        {note && <p className="truncate text-[12px] text-amber-700 dark:text-amber-300">{note}</p>}
      </div>
      {action}
      {row && r && (
        <span title={r.account.name ?? undefined} className="flex-shrink-0">
          <EntityAvatar kind="company" name={r.account.name ?? name} domain={r.account.domain} className="h-[22px] w-[22px] rounded-md shadow-[inset_0_0_0_1px_rgba(20,20,18,0.06)]" textClassName="text-[10px] font-semibold" />
        </span>
      )}
    </div>
  );
}

/** "Synced to HubSpot · 2 tasks · note on Platform · email in Gmail drafts", each part a link where there is one. */
function SyncedLine({ fu, synced, copied }: { fu: FollowUp; synced: SyncResult | null; copied: boolean }) {
  const s = synced?.sync ?? fu.verdict?.sync ?? null;
  const tasks = Object.keys(s?.tasks ?? {}).length;
  const dealUrl = fu.crm?.url ?? null;
  const draft = synced?.draft ?? null;
  const draftUrl = (draft?.status === "created" ? draft.url : null) ?? s?.draft?.url ?? null;
  const link = "text-muted-foreground underline-offset-2 hover:text-foreground hover:underline";
  const parts: ReactNode[] = [];
  if (tasks) parts.push(<span key="t">{tasks} {tasks === 1 ? "task" : "tasks"}</span>);
  if (s?.note) {
    const label = `note on ${fu.crm?.deal ?? "the account"}`;
    parts.push(dealUrl ? <a key="n" href={dealUrl} target="_blank" rel="noreferrer" className={link}>{label}</a> : <span key="n">{label}</span>);
  }
  if (draftUrl) parts.push(<a key="d" href={draftUrl} target="_blank" rel="noreferrer" className={link}>email in Gmail drafts</a>);
  else if (copied) parts.push(<span key="c">email copied</span>);
  return (
    <>
      Synced to <CrmName />
      {parts.map((p, i) => <span key={i}> · {p}</span>)}
    </>
  );
}

// ── In HubSpot now ───────────────────────────────────────────────────────────
// Read only. The engine's card carries its deal as HubSpot has it (crm), or the deal the rep just
// picked; an older recommendation reads the account's largest open deal from its own page data.
function CrmNow({ engine, fu, detail, dealChange, chosen, chosenLabel, pending, quiet = false }: {
  engine: boolean; fu: Recommendation["followup"]; detail: RecDetail | null | undefined; dealChange: DealChange | null;
  chosen: { name: string; stage?: string | null; value?: number | null } | null; chosenLabel: string | null; pending: boolean;
  /** Home's row: a white box on the row's band instead of a grey one. */
  quiet?: boolean;
}) {
  const box = quiet ? "rounded-[10px] border border-border bg-card" : "rounded-lg bg-muted/60";
  const crm = fu?.crm ?? null;
  const impact = engine ? null : detail?.impact ?? null;
  const logged = engine ? null : detail?.sources?.find((s) => (s.system ?? "").toLowerCase().includes("hubspot")) ?? null;
  const loading = !engine && !crm && detail === undefined;

  const deal = chosenLabel ?? crm?.deal ?? impact?.deal ?? dealChange?.deal ?? null;
  // Loaded and there is simply no open deal, as opposed to the read failing (detail === null).
  const nothing = !crm && !pending && !deal && (engine || (!!detail && !impact));
  const failed = !engine && !crm && !pending && !deal && detail === null;

  // THE DEAL AS HUBSPOT HAS IT (GET-740): the CRM's mark and the deal by name, its stage as a tag,
  // the numbers on one line. Nothing to show is one quiet line, not a box saying so.
  const amount = (() => { const v = chosen?.value ?? crm?.amount ?? impact?.value; return v != null && Number(v) ? money(Number(v)) : null; })();
  const stage = chosen?.stage ?? crm?.stage ?? impact?.stage ?? dealChange?.stage ?? null;
  const closes = shortDate(crm?.close_date ?? impact?.close_date ?? dealChange?.close_date ?? null) || null;
  const lastLogged = crm?.last_logged ?? (logged ? `${shortDate(logged.when)} (${activityWord(logged.kind)})` : null);
  const logo = <img src={toolLogo(crmName().toLowerCase()) ?? toolLogo("hubspot") ?? ""} alt="" className="h-3.5 w-3.5 object-contain" />;
  return (
    <div className={cn(box, "px-3.5 py-3")}>
      <div className="flex items-center gap-2.5">
        <ListTile>{logo}</ListTile>
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground">
          {pending ? "Pick a deal above" : deal ?? (loading ? "Reading the deal…" : nothing ? "No open deal" : failed ? <>Couldn't read <CrmName /> right now</> : "Deal")}
        </span>
        {stage && !pending && <span className="flex-shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-[11.5px] text-ink-2">{stage}</span>}
        {crm?.url && (
          <a href={crm.url} target="_blank" rel="noreferrer" title={`Open in ${crmName()}`}
            className="flex-shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-hover hover:text-foreground">
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
        )}
      </div>
      {loading ? (
        <div className="mt-2 h-4 w-2/3 animate-pulse rounded bg-muted/60" />
      ) : nothing ? (
        <p className="mt-1 pl-[34px] text-[12px] text-muted-foreground">Nothing open on this account in <CrmName />. Approving still files the tasks.</p>
      ) : !failed && !pending && (amount || closes || lastLogged) ? (
        <p className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 pl-[34px] text-[12px] text-muted-foreground">
          {amount && <span className="text-foreground">{amount}</span>}
          {closes && <span>Closes {closes}</span>}
          {lastLogged && <span>Last logged {lastLogged}</span>}
        </p>
      ) : null}
    </div>
  );
}

function activityWord(kind: string): string {
  const k = kind.toLowerCase();
  if (k.includes("meeting")) return "meeting";
  if (k.includes("email")) return "email";
  if (k.includes("call")) return "call";
  if (k.includes("note")) return "note";
  return k.replace(/_/g, " ");
}

// ── Pieces ──────────────────────────────────────────────────────────────────

function DealButton({ on, busy, quiet = false, disabled, onClick, children }: {
  on: boolean; busy: boolean; quiet?: boolean; disabled: boolean; onClick: () => void; children: ReactNode;
}) {
  return (
    <button onClick={onClick} disabled={disabled} aria-pressed={on}
      className={cn("inline-flex max-w-full items-center gap-1.5 truncate rounded-lg px-2.5 py-1.5 text-[12.5px] ring-1 transition-colors disabled:cursor-default",
        on ? "bg-foreground text-background ring-foreground"
          : quiet ? "text-muted-foreground ring-transparent hover:text-foreground enabled:hover:ring-border"
            : "bg-card text-foreground ring-border enabled:hover:ring-foreground/30",
        busy && "opacity-60")}>
      {busy && <Loader2 className="h-3 w-3 flex-shrink-0 animate-spin" />}
      <span className="truncate">{children}</span>
    </button>
  );
}

/** One of the Priorities pane's three parts: a title, then its pieces (GET-681). */
function PaneGroup({ label, children }: { label?: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2.5 border-t border-hairline pt-4 first:border-t-0 first:pt-0">
      {label && <h3 className="text-[13.5px] font-medium tracking-[-0.01em] text-foreground">{label}</h3>}
      {children}
    </section>
  );
}

function Section({ label, count, children }: { label: string; count?: number; children: ReactNode }) {
  return (
    <div>
      {label && (
        <p className="mb-1.5 text-[12px] text-muted-foreground">
          {label}{!!count && <span className="ml-1.5 tabular-nums text-muted-foreground/60">{count}</span>}
        </p>
      )}
      <div className="-mx-2 space-y-0.5">{children}</div>
    </div>
  );
}

/** A proposed task: tick to keep, the pencil to reword it before it is filed. */
function TaskRow({ id, on, text, edited, meta, restored, editing, canEdit, buttons = false, onToggle, onEdit, onSave, onCancel }: {
  id: string; on: boolean; text: string; edited: boolean; meta: string | null; restored: boolean;
  editing: boolean; canEdit: boolean;
  /** Approve / Skip on the row instead of a tick box (GET-740). */
  buttons?: boolean;
  onToggle: () => void; onEdit: () => void; onSave: (v: string) => void; onCancel: () => void;
}) {
  const [draft, setDraft] = useState(text);
  useEffect(() => { if (editing) setDraft(text); }, [editing, text]);
  return (
    <div className="group flex items-start gap-2.5 rounded-lg px-2 py-1.5 hover:bg-muted/50">
      {buttons
        ? <img src={toolLogo("hubspot") ?? ""} alt="" className="mt-[3px] h-3.5 w-3.5 flex-shrink-0 object-contain" />
        : <input id={id} type="checkbox" checked={on} onChange={onToggle} className="mt-0.5 flex-shrink-0 accent-slate-900 dark:accent-slate-100" />}
      {editing ? (
        <input autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} aria-label="Task"
          onBlur={() => onSave(draft)}
          onKeyDown={(e) => { if (e.key === "Enter") onSave(draft); else if (e.key === "Escape") onCancel(); }}
          className="min-w-0 flex-1 rounded-md border border-border bg-background px-1.5 py-0.5 text-[13px] leading-snug text-foreground outline-none focus:border-foreground/30" />
      ) : (
        <label htmlFor={id} className={cn("min-w-0 flex-1 cursor-pointer text-[13px] leading-snug", on ? "text-foreground" : "text-muted-foreground line-through")}>
          {text}
          {/* inline-block, so an unticked row's strike-through does not run through the tag too. */}
          {(edited || restored) && <span className="ml-1.5 inline-block text-[11px] text-muted-foreground">{edited ? "edited" : "restored"}</span>}
        </label>
      )}
      {!editing && canEdit && on && (
        <button onClick={onEdit} aria-label="Edit task"
          className="flex-shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground focus:opacity-100 sm:opacity-0 sm:group-hover:opacity-100">
          <Pencil className="h-3 w-3" />
        </button>
      )}
      {meta && <span className="flex-shrink-0 whitespace-nowrap text-[11.5px] text-muted-foreground">{meta}</span>}
      {buttons && !editing && (
        <span className="-my-0.5 flex flex-shrink-0 items-center gap-0.5">
          <button type="button" onClick={() => on && onToggle()} aria-pressed={!on}
            className={cn("h-6 rounded-md px-2 text-[12px] transition-colors", !on ? "bg-muted font-medium text-foreground" : "text-muted-foreground hover:bg-hover hover:text-foreground")}>Skip</button>
          <button type="button" onClick={() => !on && onToggle()} aria-pressed={on}
            className={cn("h-6 rounded-md px-2 text-[12px] transition-colors", on ? "bg-foreground font-medium text-background" : "text-muted-foreground hover:bg-hover hover:text-foreground")}>Approve</button>
        </span>
      )}
    </div>
  );
}

/** Already a real task (the call scorer filed it during the meeting): shown so nothing looks lost. */
function ExistingTask({ t }: { t: FollowUpTask }) {
  return (
    <div className="flex items-start gap-2.5 rounded-lg px-2 py-1.5">
      <span className="mt-[3px] flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center rounded-[4px] bg-muted text-muted-foreground" aria-hidden>
        <Check className="h-2.5 w-2.5" strokeWidth={3} />
      </span>
      <span className="min-w-0 flex-1 text-[13px] leading-snug text-muted-foreground">{t.text}</span>
      <span className="flex-shrink-0 whitespace-nowrap text-[11.5px] text-muted-foreground">Already on Tasks</span>
    </div>
  );
}

/** An earlier meeting's task the later call made moot, and why. Restore brings it back ticked. */
function DroppedTask({ t, onRestore }: { t: FollowUpTask; onRestore: () => void }) {
  return (
    <div className="flex items-start gap-2.5 rounded-lg px-2 py-1.5">
      <span className="mt-[3px] h-3.5 w-3.5 flex-shrink-0" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="text-[13px] leading-snug text-muted-foreground line-through">{t.text}</p>
        {t.dropped && <p className="mt-0.5 text-[11.5px] text-muted-foreground">{t.dropped}</p>}
      </div>
      <button onClick={onRestore} className="flex-shrink-0 rounded px-1 text-[11.5px] font-medium text-foreground hover:underline">Restore</button>
    </div>
  );
}

function CheckRow({ on, onChange, meta, strike = true, children }: {
  on: boolean; onChange: () => void; meta?: string | null; strike?: boolean; children: ReactNode;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-2.5 rounded-lg px-2 py-1.5 hover:bg-muted/50">
      <input type="checkbox" checked={on} onChange={onChange} className="mt-0.5 flex-shrink-0 accent-slate-900 dark:accent-slate-100" />
      <span className={cn("min-w-0 flex-1 text-[13px] leading-snug", on ? "text-foreground" : cn("text-muted-foreground", strike && "line-through"))}>{children}</span>
      {meta && <span className="flex-shrink-0 whitespace-nowrap text-[11.5px] text-muted-foreground">{meta}</span>}
    </label>
  );
}

function Chip({ className, children }: { className?: string; children: ReactNode }) {
  return <span className={cn("whitespace-nowrap rounded-md bg-muted px-1.5 py-0.5", className)}>{children}</span>;
}

function Quiet({ children }: { children: ReactNode }) {
  return <p className="px-2 text-[12.5px] text-muted-foreground">{children}</p>;
}

function taskDue(t: Task): string | null {
  if (t.due_at) return shortDate(t.due_at) || null;
  return t.due_phrase;
}
