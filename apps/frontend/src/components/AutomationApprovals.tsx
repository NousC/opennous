// Approvals (GET-713, redesigned GET-724, laid out like Priorities in GET-729). One row per run,
// by account, with everything the run made: the call summary (the notetaker's logo), the follow-up
// email (Gmail), the HubSpot tasks. Opening it is the Priorities panel for that one account: the
// tasks, the email draft and the call summary down the left, the selected one read on the right.
// Each task and the email are approved or skipped on their own; once every one is decided, the run
// carries on with exactly those (one POST, `decisions`). Same list: GET /v2/approvals.
import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeft, Check, FileText, Loader2, Mail } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { automationsFetch, TOOL_DOMAIN } from "@/lib/automations";
import { when as ago } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useIsMobile } from "@/hooks/use-mobile";
import { AccountLogo } from "@/components/pipeline/DealBits";
import { EmptyState } from "@/components/ui/empty-state";
import { ListGroup, ListMeta, listRowClass } from "@/components/ui/list";
import { StepMark, ToolMark } from "@/components/AutomationMarks";
import { MailboxPicker } from "@/components/MailboxPicker";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import type { RunOutput } from "@/components/AutomationRunDetail";

type Item = {
  index: number; step: string; type: string; action?: string | null;
  rows: { label: string; value: string }[];
  email?: { from: string | null; to: string | null; subject: string; body: string };
  tasks?: { key: number; title: string; due_at: string | null }[];
  fields?: { name: string; value: string; quote: string }[];
  due_days?: number;
};
type Mail = { kind: "draft" | "sent"; mailbox: string | null; to: string | null; cc: string | null };
export type Approval = {
  run_id: string; requested_at: string | null;
  automation: { id: string; name: string; trigger: string | null };
  account: { id: string; name: string | null; domain: string | null } | null;
  why: string | null; step: string | null; type: string | null;
  rows: { label: string; value: string }[];
  items?: Item[];
  source?: string | null;
  call_to?: string | null;
  /** Decisions made before a reload (GET-735). */
  partial?: { choices?: Record<string, "approve" | "skip">; send?: Record<string, boolean>; edits?: Record<string, { to: string; cc: string; subject: string; body: string }> } | null;
  earlier?: { step: number; name: string; detail: string | null; mail?: Mail | null; output: RunOutput | null }[];
};

export function useApprovals() {
  const { session, userData } = useAuth();
  const token = session?.access_token ?? "";
  const workspaceId = userData?.workspace?.id ?? "";
  const [items, setItems] = useState<Approval[] | null>(null);
  const load = useCallback(async () => {
    if (!token || !workspaceId) return;
    const res = await automationsFetch(`/approvals?workspaceId=${workspaceId}`, token);
    const body = res.ok ? await res.json().catch(() => null) : null;
    setItems(body?.approvals ?? []);
  }, [token, workspaceId]);
  useEffect(() => { void load(); }, [load]);
  return { items, setItems, reload: load, token, workspaceId };
}

const itemsOf = (a: Approval): Item[] => a.items?.length ? a.items : a.step ? [{ index: 0, step: a.step, type: a.type ?? "", rows: a.rows }] : [];

// ── One entry per thing the run made ───────────────────────────────────────

type Mark = "notetaker" | "gmail" | "smtp" | "hubspot" | "slack" | "other";
/** One line on the left: a task, the email, the summary. `pending` ones wait on a decision. */
type Entry = {
  key: string; mark: Mark; title: string; sub: string | null; group: "tasks" | "email" | "call" | "other";
  pending: boolean;
  item?: Item; task?: { key: number; title: string; due_at: string | null }; output?: RunOutput;
  step?: number; mail?: Mail | null;
};

/** The date a task lands on: its own, else the step's "due in N days" from today (GET-731). */
function dueOf(task: { due_at: string | null }, item?: Item) {
  const d = task.due_at ? new Date(task.due_at) : new Date(Date.now() + (item?.due_days ?? 1) * 86_400_000);
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}
const GROUP_LABEL: Record<Entry["group"], string> = { tasks: "Tasks", email: "Email draft", call: "Call summary", other: "To approve" };
const GROUP_ORDER: Entry["group"][] = ["tasks", "email", "other", "call"];

const NOTETAKER: Record<string, string> = { granola: "Granola", fathom: "Fathom", fireflies: "Fireflies", fellow: "Fellow", otter: "Otter", zoom: "Zoom" };
const emailMark = (type: string): Mark => (type === "email" ? "smtp" : "gmail");

function entriesOf(a: Approval): Entry[] {
  const out: Entry[] = [];
  for (const it of itemsOf(a)) {
    if (it.tasks?.length) {
      for (const t of it.tasks) out.push({ key: `t${it.index}:${t.key}`, mark: "hubspot", title: t.title, sub: `Due ${dueOf(t, it)}`, group: "tasks", pending: true, item: it, task: t });
    } else if (it.email) {
      out.push({ key: `i${it.index}`, mark: emailMark(it.type), title: it.email.subject || "Follow-up email", sub: it.email.to ? `To ${it.email.to}` : null, group: "email", pending: true, item: it });
    } else {
      out.push({ key: `i${it.index}`, mark: it.type === "hubspot" ? "hubspot" : it.type === "slack" ? "slack" : "other", title: it.step.replace(/^Step \d+ · /, ""), sub: it.fields ? `${it.fields.length} field${it.fields.length === 1 ? "" : "s"}` : null, group: "other", pending: true, item: it });
    }
  }
  // The email waiting on a decision IS the send of the run's earlier Gmail draft ("Sending
  // replaces it"), so that draft is not listed again beside it (GET-834). A sent one still is.
  const emailPending = out.some(x => x.group === "email" && x.pending);
  for (const e of a.earlier ?? []) {
    if (!e.output) continue;
    if (e.output.kind === "email") {
      const sent = e.mail?.kind === "sent" || /Sent from Gmail/.test(e.detail ?? "");
      if (!sent && emailPending) continue;
      out.push({ key: `e${e.step}`, mark: /smtp/i.test(e.name) ? "smtp" : "gmail", title: e.output.subject ?? "Follow-up email", sub: sent ? "Sent" : "Draft in Gmail", group: "email", pending: false, output: e.output, step: e.step, mail: sent ? { ...(e.mail ?? { mailbox: null, to: null, cc: null }), kind: "sent" } : (e.mail ?? null) });
    } else {
      out.push({ key: `e${e.step}`, mark: "notetaker", title: "Call summary", sub: e.output.headline ?? e.output.title ?? null, group: "call", pending: false, output: e.output });
    }
  }
  return GROUP_ORDER.flatMap(g => out.filter(x => x.group === g));
}

function EntryMark({ mark, source }: { mark: Mark; source?: string | null }) {
  if (mark === "hubspot" || mark === "gmail" || mark === "slack") return <StepMark type={mark} />;
  if (mark === "smtp") return <StepMark type="email" />;
  if (mark === "notetaker" && source && TOOL_DOMAIN[source]) return <ToolMark tool={{ slug: source, label: NOTETAKER[source] ?? source }} size="sm" />;
  if (mark === "notetaker") return <StepMark type="agent" />;
  return <span className="flex h-[22px] w-[22px] items-center justify-center rounded-[6px] bg-foreground/[0.07] text-foreground/55"><FileText className="h-3 w-3" /></span>;
}

/** The marks on a list row: "▣ Call summary  ✉ Email draft  ▣ 3 tasks". */
function Chips({ a }: { a: Approval }) {
  const es = entriesOf(a);
  const tasks = es.filter(e => e.group === "tasks");
  const chips: { key: string; mark: Mark; label: string }[] = [];
  const call = es.find(e => e.group === "call");
  if (call) chips.push({ key: "call", mark: "notetaker", label: "Call summary" });
  const email = es.find(e => e.group === "email");
  if (email) chips.push({ key: "email", mark: email.mark, label: "Email draft" });
  if (tasks.length) chips.push({ key: "tasks", mark: "hubspot", label: `${tasks.length} task${tasks.length === 1 ? "" : "s"}` });
  for (const o of es.filter(e => e.group === "other")) chips.push({ key: o.key, mark: o.mark, label: o.title });
  return (
    <span className="flex flex-shrink-0 items-center gap-3.5">
      {chips.map(c => (
        <span key={c.key} className="flex items-center gap-1.5 text-[12px] text-foreground/80">
          <EntryMark mark={c.mark} source={a.source} />{c.label}
        </span>
      ))}
    </span>
  );
}

export function AutomationApprovals({ state }: { state: ReturnType<typeof useApprovals> }) {
  const { items, setItems } = state;
  const [open, setOpen] = useState<Approval | null>(null);
  // ?run=<id> (a test run's View, GET-739) opens that run's review once the list is in.
  const wanted = useMemo(() => new URLSearchParams(typeof window !== "undefined" ? window.location.search : "").get("run"), []);
  useEffect(() => {
    if (wanted && items) setOpen(o => o ?? items.find(a => a.run_id === wanted) ?? null);
  }, [wanted, items]);

  if (!items) return <p className="px-6 py-10 text-[13px] text-muted-foreground">Loading…</p>;
  if (!items.length) return <div className="px-6 py-10"><EmptyState bordered={false} title="Nothing waiting for you." /></div>;

  return (
    <div className="px-6 pb-10 pt-[18px]">
      {items.map(a => (
        <button key={a.run_id} onClick={() => setOpen(a)}
          className="flex w-full items-center gap-3 rounded-lg px-2 py-2.5 text-left transition-colors hover:bg-hover">
          <AccountLogo name={a.account?.name ?? a.automation.name} domain={a.account?.domain ?? null} size={24} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13.5px] text-foreground">{a.account?.name ?? "Account"}</span>
            <span className="block truncate text-[12px] text-muted-foreground">{a.automation.name}{a.why ? ` · ${a.why}` : ""}</span>
          </span>
          <Chips a={a} />
          {a.requested_at && <span className="w-[64px] flex-shrink-0 text-right text-[12px] text-muted-foreground/70">{ago(a.requested_at)}</span>}
        </button>
      ))}
      <ApprovalReview approval={open} state={state} onClose={() => setOpen(null)}
        onDone={(id) => { setItems(list => (list ?? []).filter(x => x.run_id !== id)); }} />
    </div>
  );
}

/** A brief laid out with its headings; an email as subject and body. */
function Readable({ output }: { output: RunOutput }) {
  if (output.kind === "email") return (
    <div>
      <p className="text-[14px] font-medium text-foreground">{output.subject ?? "Email"}</p>
      <p className="mt-3 whitespace-pre-line text-[13px] leading-relaxed text-foreground/85">{output.body}</p>
    </div>
  );
  const parts = (output as RunOutput & { parts?: { label: string; body: string }[] }).parts;
  return (
    <div className="space-y-4">
      {output.headline && <p className="text-[13.5px] text-foreground">{output.headline}</p>}
      {(parts?.length ? parts : [{ label: "", body: output.text }]).map((p, i) => (
        <div key={i}>
          {p.label && <p className="mb-1 text-[12px] font-medium text-muted-foreground">{p.label}</p>}
          <p className="whitespace-pre-line text-[13px] leading-relaxed text-foreground/85">{p.body}</p>
        </div>
      ))}
    </div>
  );
}

const Field = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div className="flex gap-3 text-[12.5px]"><span className="w-[64px] flex-shrink-0 text-muted-foreground">{label}</span><span className="min-w-0 flex-1 text-foreground">{children}</span></div>
);

type Choice = "approve" | "skip";
type Draft = { to: string; cc: string; subject: string; body: string; from?: string | null };

/** The email as an editable draft: To, Cc, Subject, then the body (GET-731). */
function EmailEditor({ draft, onChange, readOnly, mailbox = null }: { draft: Draft; onChange: (d: Draft) => void; readOnly?: boolean; mailbox?: string | null }) {
  const line = "min-w-0 flex-1 bg-transparent py-1.5 text-[13px] text-foreground outline-none placeholder:text-muted-foreground/50 disabled:text-foreground";
  const row = (label: string, key: "to" | "cc" | "subject", placeholder: string) => (
    <label className="flex items-center gap-3 border-b border-border/50">
      <span className="w-[52px] flex-shrink-0 text-[12.5px] text-muted-foreground">{label}</span>
      <input value={draft[key]} disabled={readOnly} placeholder={placeholder} onChange={e => onChange({ ...draft, [key]: e.target.value })} className={line} />
    </label>
  );
  return (
    <div className="flex min-h-full flex-col">
      {/* From (GET-745): starts on the mailbox the draft is in, and can be changed before it goes. */}
      <MailboxPicker value={draft.from ?? null} onChange={(id) => onChange({ ...draft, from: id })} prefer={mailbox} disabled={readOnly}
        className="border-b border-border/50 py-1.5" />
      {row("To", "to", "name@company.com")}
      {row("Cc", "cc", readOnly ? "" : "Add people, comma separated")}
      {/* A labelled row like To and Cc (GET-834): as a bare heading it read as the panel's title,
          not as the subject the email goes out with. */}
      {row("Subject", "subject", "Add a subject")}
      <textarea value={draft.body} disabled={readOnly} onChange={e => onChange({ ...draft, body: e.target.value })} rows={14}
        className="mt-3 w-full flex-1 resize-none bg-transparent text-[13px] leading-relaxed text-foreground/90 outline-none" />
    </div>
  );
}

const Tag = ({ children }: { children: React.ReactNode }) => (
  <span className="inline-flex h-6 items-center rounded-md bg-foreground/[0.05] px-2 text-[12px] text-foreground/80">{children}</span>
);

/**
 * One review's state and actions (GET-726, shared since GET-737): what each item is, what was
 * decided (kept on the run as you go), the email as edited, and the send. The dialog on the API
 * plan's Approvals tab and the Priorities pane on the Workspace plan both read it.
 */
function useReview(approval: Approval | null, token: string, workspaceId: string, onDone: (runId: string) => void,
  onChoices?: (partial: NonNullable<Approval["partial"]>) => void) {
  const entries = useMemo(() => (approval ? entriesOf(approval) : []), [approval]);
  const [choice, setChoice] = useState<Record<string, Choice>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [sendNow, setSendNow] = useState<Record<string, boolean>>({});
  const [sent, setSent] = useState<Set<string>>(new Set());

  /** The email as the reviewer has it: their edits, else what the run wrote. */
  const draftOf = (e: Entry): Draft => drafts[e.key] ?? (e.item?.email
    ? { to: e.item.email.to ?? approval?.call_to ?? "", cc: "", subject: e.item.email.subject, body: e.item.email.body }
    : { to: e.mail?.to ?? approval?.call_to ?? "", cc: e.mail?.cc ?? "", subject: e.output?.subject ?? "", body: e.output?.body ?? e.output?.text ?? "" });

  useEffect(() => {
    const kept = approval?.partial ?? null;
    setChoice(kept?.choices ?? {}); setError(null); setSubmitted(false); setDrafts(kept?.edits ?? {}); setSendNow(kept?.send ?? {}); setSent(new Set());
  }, [approval]);

  const pending = entries.filter(e => e.pending);

  const submit = async (all: Record<string, Choice>, sendRef: Record<string, boolean>) => {
    if (!approval) return;
    setBusy(true); setError(null);
    try {
      const decisions: Record<number, { approve: boolean; tasks?: number[] }> = {};
      for (const it of itemsOf(approval)) {
        if (it.tasks?.length) {
          const keys = it.tasks.filter(t => all[`t${it.index}:${t.key}`] === "approve").map(t => t.key);
          decisions[it.index] = { approve: keys.length > 0, tasks: keys };
        } else if (it.email) {
          const e = entries.find(x => x.key === `i${it.index}`);
          decisions[it.index] = { approve: all[`i${it.index}`] === "approve", ...(e ? { email: { ...draftOf(e), send: !!sendRef[`i${it.index}`] } } : {}) } as never;
        } else decisions[it.index] = { approve: all[`i${it.index}`] === "approve" };
      }
      const anyYes = Object.values(decisions).some(d => d.approve);
      const res = await automationsFetch(`/approvals/${approval.run_id}/${anyYes ? "approve" : "reject"}?workspaceId=${workspaceId}`, token,
        { method: "POST", body: JSON.stringify(anyYes ? { decisions } : {}) });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) { setError(out.message ?? out.error ?? "Could not do that."); return; }
      setSubmitted(true);
      onDone(approval.run_id);
    } finally { setBusy(false); }
  };

  /** Send a draft the run already made, as edited here; the Gmail draft is replaced. */
  const sendEarlier = async (e: Entry) => {
    if (!approval || e.step == null) return;
    setBusy(true); setError(null);
    try {
      const res = await automationsFetch(`/runs/${approval.run_id}/send-email?workspaceId=${workspaceId}`, token,
        { method: "POST", body: JSON.stringify({ step: e.step, ...draftOf(e) }) });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) { setError(out.message ?? out.error ?? "Could not send it."); return; }
      setSent(x => new Set(x).add(e.key));
      // The send was all the run waited on: it is done, so it leaves Approvals (GET-834).
      if (out.finished) { setSubmitted(true); onDone(approval.run_id); }
    } finally { setBusy(false); }
  };

  /** Decide one and keep it on the run; the last one sends them all. Returns the next undecided item. */
  const decide = (key: string, c: Choice, send = false): string | null => {
    const next = { ...choice, [key]: c };
    const sendRef = { ...sendNow, [key]: send };
    setChoice(next); setSendNow(sendRef);
    const after = pending.filter(e => !next[e.key]);
    if (!after.length) { void submit(next, sendRef); return null; }
    // Kept on the run, so a reload shows it decided (GET-735).
    if (approval) {
      const edits = Object.fromEntries(entries.filter(e => e.group === "email" && e.pending && drafts[e.key]).map(e => [e.key, drafts[e.key]]));
      void automationsFetch(`/approvals/${approval.run_id}/choices?workspaceId=${workspaceId}`, token,
        { method: "POST", body: JSON.stringify({ choices: next, send: sendRef, edits }) }).catch(() => {});
      onChoices?.({ choices: next, send: sendRef, edits });
    }
    const at = pending.findIndex(e => e.key === key);
    return (pending.slice(at + 1).find(e => !next[e.key]) ?? after[0]).key;
  };

  return { entries, pending, choice, busy, error, submitted, drafts, setDrafts, sendNow, sent, draftOf, decide, sendEarlier };
}

function ApprovalReview({ approval, state, onClose, onDone }: { approval: Approval | null; state: ReturnType<typeof useApprovals>; onClose: () => void; onDone: (runId: string) => void }) {
  const { token, workspaceId } = state;
  const mobile = useIsMobile();
  const r = useReview(approval, token, workspaceId, onDone);
  const { entries, choice, busy, error, submitted, setDrafts, sendNow, sent, draftOf, sendEarlier } = r;
  const [selected, setSelected] = useState<string | null>(null);
  const [showDetail, setShowDetail] = useState(false);
  useEffect(() => {
    const was = approval?.partial?.choices ?? {};
    setShowDetail(false);
    setSelected(entries.find(e => e.pending && !was[e.key])?.key ?? entries[0]?.key ?? null);
  }, [approval, entries]);
  const current = entries.find(e => e.key === selected) ?? entries[0] ?? null;
  const decide = (key: string, c: Choice, send = false) => { const next = r.decide(key, c, send); if (next) setSelected(next); };

  const groups = GROUP_ORDER.map(g => ({ g, rows: entries.filter(e => e.group === g) })).filter(x => x.rows.length);

  const list = (
    <div className={cn("flex min-h-0 flex-col", mobile ? "h-full" : "w-[320px] flex-shrink-0 border-r border-border/50")}>
      <div className="flex items-center gap-2.5 px-4 pb-2 pt-3.5">
        <AccountLogo name={approval?.account?.name ?? ""} domain={approval?.account?.domain ?? null} size={24} />
        <div className="min-w-0 flex-1">
          <DialogTitle className="truncate text-[13.5px] font-medium tracking-[-0.01em]">{approval?.account?.name ?? "Account"}</DialogTitle>
          <DialogDescription className="truncate text-[11.5px] text-muted-foreground/70">{approval?.why ?? approval?.automation.name}</DialogDescription>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {groups.map(({ g, rows }) => (
          <div key={g}>
            <ListGroup className="pt-2 first:pt-1">
              {GROUP_LABEL[g]}{g === "tasks" && <span className="ml-1.5 tabular-nums text-muted-foreground/45">{rows.length}</span>}
            </ListGroup>
            {rows.map(e => {
              const c = choice[e.key];
              return (
                <div key={e.key} role="option" aria-selected={current?.key === e.key}
                  onClick={() => { setSelected(e.key); if (mobile) setShowDetail(true); }}
                  className={cn(listRowClass, "cursor-default", current?.key === e.key && "bg-hover")}>
                  <EntryMark mark={e.mark} source={approval?.source} />
                  <span className={cn("flex min-w-0 flex-1 flex-col", c === "skip" && "opacity-50")}>
                    <span className={cn("truncate text-[13px] leading-[18px] text-foreground", c === "skip" && "line-through")}>{e.title}</span>
                    {e.sub && <span className="truncate text-[11.5px] leading-4 text-muted-foreground/70">{e.sub}</span>}
                  </span>
                  <ListMeta className="self-start pt-px">
                    {sent.has(e.key) ? <span className="text-foreground/70">Sent</span> : c === "approve" ? <span className="text-foreground/70">{sendNow[e.key] ? "Send" : "Approved"}</span> : c === "skip" ? "Skipped" : e.pending ? <span className="inline-block h-1.5 w-1.5 rounded-full bg-amber-500" aria-label="Needs you" /> : null}
                  </ListMeta>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );

  const detail = current ? (
    <div className="flex min-h-full flex-col">
      <div className="sticky top-0 z-10 flex items-center gap-2.5 border-b border-border/50 bg-card px-5 py-3 pr-12">
        {mobile && (
          <button type="button" onClick={() => setShowDetail(false)} aria-label="Back"
            className="-ml-1 flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground/70 hover:bg-hover hover:text-foreground">
            <ArrowLeft className="h-4 w-4" strokeWidth={1.75} />
          </button>
        )}
        <EntryMark mark={current.mark} source={approval?.source} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13.5px] font-medium leading-tight text-foreground">
            {current.group === "tasks" ? "Create a task in HubSpot" : current.group === "email" ? "Follow-up email" : current.group === "call" ? "Call summary" : current.title}
          </p>
          <p className="truncate text-[11.5px] text-muted-foreground/70">
            {current.pending ? "Waiting for you" : current.group === "email" ? (current.mail?.kind === "sent" || sent.has(current.key) ? "Sent" : "Draft in Gmail") : current.group === "call" ? (approval?.source ? `From the ${NOTETAKER[approval.source] ?? approval.source} call` : "From the call") : "Already done"}
          </p>
        </div>
      </div>
      <div className="flex flex-1 flex-col px-5 py-5">
        {current.task && (
          <div className="space-y-4">
            <p className="text-[14px] leading-snug text-foreground">{current.task.title}</p>
            <div className="flex flex-wrap items-center gap-1.5">
              <Tag>Due {dueOf(current.task, current.item)}</Tag>
              {approval?.account?.name && <Tag>{approval.account.name}</Tag>}
              <Tag>Deal</Tag>
              <Tag>People on the call</Tag>
            </div>
          </div>
        )}
        {current.group === "email" && (
          <EmailEditor draft={draftOf(current)} mailbox={current.item?.email?.from ?? current.mail?.mailbox ?? null} readOnly={current.mail?.kind === "sent" || sent.has(current.key) || (current.pending && !!choice[current.key])}
            onChange={d => setDrafts(x => ({ ...x, [current.key]: d }))} />
        )}
        {current.item && !current.task && !current.item.email && (
          <div className="space-y-2">
            {current.item.rows.map((r, i) => (
              <div key={i} className="flex gap-3 text-[13px]">
                <span className="w-[96px] flex-shrink-0 text-muted-foreground">{r.label}</span>
                <span className="min-w-0 flex-1 whitespace-pre-line text-foreground/85">{r.value}</span>
              </div>
            ))}
          </div>
        )}
        {current.output && current.group !== "email" && <Readable output={current.output} />}
      </div>
      {current.pending && !submitted && (
        <div className="sticky bottom-0 flex items-center gap-2 border-t border-border/50 bg-card px-5 py-3">
          {error && <p className="mr-auto text-[12px] text-risk">{error}</p>}
          <span className="flex-1" />
          <button onClick={() => decide(current.key, "skip")} disabled={busy}
            className={cn("h-8 rounded-lg px-3 text-[12.5px] transition-colors hover:bg-hover disabled:opacity-40", choice[current.key] === "skip" ? "bg-hover text-foreground" : "text-muted-foreground hover:text-foreground")}>
            Skip
          </button>
          {current.group === "email" && current.mark === "gmail" && (
            <button onClick={() => decide(current.key, "approve", false)} disabled={busy}
              className="h-8 rounded-lg border border-border px-3 text-[12.5px] text-foreground transition-colors hover:bg-hover disabled:opacity-40">
              Save as draft
            </button>
          )}
          <button onClick={() => decide(current.key, "approve", current.group === "email" && current.mark === "gmail")} disabled={busy}
            className="flex h-8 items-center gap-1.5 rounded-lg bg-foreground px-3.5 text-[12.5px] font-medium text-background transition-opacity hover:opacity-90 disabled:opacity-40">
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : current.group === "email" ? <Mail className="h-3.5 w-3.5" /> : <Check className="h-3.5 w-3.5" />}
            {current.group === "tasks" ? "Approve task" : current.group === "email" ? "Send" : "Approve"}
          </button>
        </div>
      )}
      {!current.pending && current.group === "email" && current.mark === "gmail" && (
        <div className="sticky bottom-0 flex items-center gap-2 border-t border-border/50 bg-card px-5 py-3">
          {error ? <p className="mr-auto text-[12px] text-risk">{error}</p>
            : <p className="mr-auto text-[12px] text-muted-foreground">
                {current.mail?.kind === "sent" || sent.has(current.key) ? `Sent${current.mail?.mailbox ? ` from ${current.mail.mailbox}` : ""}.` : `In your Gmail drafts${current.mail?.mailbox ? ` (${current.mail.mailbox})` : ""}. Sending replaces it.`}
              </p>}
          {!(current.mail?.kind === "sent" || sent.has(current.key)) && (
            <button onClick={() => void sendEarlier(current)} disabled={busy}
              className="flex h-8 items-center gap-1.5 rounded-lg bg-foreground px-3.5 text-[12.5px] font-medium text-background transition-opacity hover:opacity-90 disabled:opacity-40">
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Mail className="h-3.5 w-3.5" />}Send
            </button>
          )}
        </div>
      )}
      {submitted && (
        <div className="sticky bottom-0 border-t border-border/50 bg-card px-5 py-3 text-[12.5px] text-muted-foreground">
          Done. {Object.values(choice).filter(c => c === "approve").length} approved, {Object.values(choice).filter(c => c === "skip").length} skipped.
        </div>
      )}
    </div>
  ) : null;

  return (
    <Dialog open={!!approval} onOpenChange={o => { if (!o) onClose(); }}>
      <DialogContent className="flex h-[min(80vh,680px)] w-[940px] max-w-[calc(100vw-16px)] gap-0 overflow-hidden p-0 max-md:h-[calc(100dvh-64px)]">
        {mobile ? (showDetail && current ? <div className="min-w-0 flex-1 overflow-y-auto">{detail}</div> : <div className="min-w-0 flex-1">{list}</div>) : (<>
          {list}
          <div key={current?.key ?? "none"} className="min-w-0 flex-1 overflow-y-auto">{detail}</div>
        </>)}
      </DialogContent>
    </Dialog>
  );
}

/**
 * The same review inside Priorities on the Workspace plan (GET-737): one account's run read top to
 * bottom, the way Priorities reads a meeting's wrap-up. The tasks, each approved or skipped on its
 * own; the email draft, edited in place and sent or saved; then the call summary to read.
 */
export function ApprovalPane({ approval, token, workspaceId, onDone, onChoices }: {
  approval: Approval; token: string; workspaceId: string; onDone: (runId: string) => void;
  onChoices?: (partial: NonNullable<Approval["partial"]>) => void;
}) {
  const r = useReview(approval, token, workspaceId, onDone, onChoices);
  const { entries, choice, busy, error, submitted, setDrafts, sent, draftOf, decide, sendEarlier } = r;
  const tasks = entries.filter(e => e.group === "tasks");
  const emails = entries.filter(e => e.group === "email");
  const others = entries.filter(e => e.group === "other");
  const summary = entries.find(e => e.group === "call");
  const small = "h-7 rounded-lg px-2.5 text-[12px] transition-colors disabled:opacity-40";
  const decided = (key: string) => choice[key] === "approve" ? <span className="text-[12px] text-foreground/70">Approved</span> : choice[key] === "skip" ? <span className="text-[12px] text-muted-foreground">Skipped</span> : null;
  return (
    <div className="flex flex-col gap-6">
      {error && <p className="text-[12px] text-risk">{error}</p>}
      {submitted && <p className="text-[12.5px] text-muted-foreground">Done. {Object.values(choice).filter(c => c === "approve").length} approved, {Object.values(choice).filter(c => c === "skip").length} skipped.</p>}

      {tasks.length > 0 && (
        <section>
          <p className="mb-1.5 text-[12px] font-medium text-muted-foreground">Tasks <span className="tabular-nums text-muted-foreground/50">{tasks.length}</span></p>
          <ul className="space-y-0.5">
            {tasks.map(t => (
              <li key={t.key} className="flex items-start gap-2.5 rounded-lg px-1.5 py-2 hover:bg-hover">
                <EntryMark mark="hubspot" />
                <span className={cn("min-w-0 flex-1", choice[t.key] === "skip" && "opacity-50")}>
                  <span className={cn("block text-[13px] leading-snug text-foreground", choice[t.key] === "skip" && "line-through")}>{t.title}</span>
                  {t.task && <span className="mt-1 flex flex-wrap gap-1"><Tag>Due {dueOf(t.task, t.item)}</Tag>{approval.account?.name && <Tag>{approval.account.name}</Tag>}</span>}
                </span>
                {decided(t.key) ?? (!submitted && (
                  <span className="flex flex-shrink-0 items-center gap-1">
                    <button disabled={busy} onClick={() => decide(t.key, "skip")} className={cn(small, "text-muted-foreground hover:bg-accent hover:text-foreground")}>Skip</button>
                    <button disabled={busy} onClick={() => decide(t.key, "approve")} className={cn(small, "bg-foreground font-medium text-background hover:opacity-90")}>Approve</button>
                  </span>
                ))}
              </li>
            ))}
          </ul>
        </section>
      )}

      {emails.map(e => {
        const wasSent = e.mail?.kind === "sent" || sent.has(e.key);
        const locked = wasSent || (e.pending && !!choice[e.key]) || submitted;
        return (
          <section key={e.key}>
            <p className="mb-1.5 flex items-center gap-2 text-[12px] font-medium text-muted-foreground">
              <EntryMark mark={e.mark} />Email draft
              <span className="ml-auto font-normal">{wasSent ? "Sent" : e.pending ? decided(e.key) : "In your Gmail drafts"}</span>
            </p>
            <div className="rounded-xl border border-border px-4 pb-3 pt-1">
              <EmailEditor draft={draftOf(e)} mailbox={e.item?.email?.from ?? e.mail?.mailbox ?? null} readOnly={locked} onChange={d => setDrafts(x => ({ ...x, [e.key]: d }))} />
              {!locked && (
                <div className="flex items-center justify-end gap-1.5 border-t border-border/50 pt-3">
                  {e.pending ? (<>
                    <button disabled={busy} onClick={() => decide(e.key, "skip")} className={cn(small, "text-muted-foreground hover:bg-accent hover:text-foreground")}>Skip</button>
                    {e.mark === "gmail" && <button disabled={busy} onClick={() => decide(e.key, "approve", false)} className={cn(small, "border border-border text-foreground hover:bg-hover")}>Save as draft</button>}
                    <button disabled={busy} onClick={() => decide(e.key, "approve", e.mark === "gmail")} className={cn(small, "flex items-center gap-1.5 bg-foreground font-medium text-background hover:opacity-90")}><Mail className="h-3 w-3" />Send</button>
                  </>) : e.mark === "gmail" && (
                    <button disabled={busy} onClick={() => void sendEarlier(e)} className={cn(small, "flex items-center gap-1.5 bg-foreground font-medium text-background hover:opacity-90")}>
                      {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Mail className="h-3 w-3" />}Send
                    </button>
                  )}
                </div>
              )}
            </div>
          </section>
        );
      })}

      {others.map(o => (
        <section key={o.key}>
          <p className="mb-1.5 flex items-center gap-2 text-[12px] font-medium text-muted-foreground"><EntryMark mark={o.mark} />{o.title}<span className="ml-auto font-normal">{decided(o.key)}</span></p>
          <div className="space-y-1.5">
            {o.item?.rows.map((row, i) => (
              <div key={i} className="flex gap-3 text-[13px]"><span className="w-[96px] flex-shrink-0 text-muted-foreground">{row.label}</span><span className="min-w-0 flex-1 whitespace-pre-line text-foreground/85">{row.value}</span></div>
            ))}
          </div>
          {!choice[o.key] && !submitted && (
            <div className="mt-2 flex justify-end gap-1.5">
              <button disabled={busy} onClick={() => decide(o.key, "skip")} className={cn(small, "text-muted-foreground hover:bg-accent hover:text-foreground")}>Skip</button>
              <button disabled={busy} onClick={() => decide(o.key, "approve")} className={cn(small, "bg-foreground font-medium text-background hover:opacity-90")}>Approve</button>
            </div>
          )}
        </section>
      ))}

      {summary?.output && (
        <section>
          <p className="mb-1.5 flex items-center gap-2 text-[12px] font-medium text-muted-foreground"><EntryMark mark="notetaker" source={approval.source} />Call summary</p>
          <Readable output={summary.output} />
        </section>
      )}
    </div>
  );
}

/** "Email draft · 3 tasks": what a run waits on, for its row in Priorities. */
export function approvalWhat(a: Approval): string {
  const es = entriesOf(a);
  const tasks = es.filter(e => e.group === "tasks").length;
  return [es.some(e => e.group === "email") ? "Email draft" : null, tasks ? `${tasks} task${tasks === 1 ? "" : "s"}` : null].filter(Boolean).join(" · ");
}

