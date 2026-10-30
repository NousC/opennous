// One automation, drawn as its flow (GET-523). /automations/new and /automations/:id.
//
// Top to bottom on a canvas (GET-705): the trigger card, then a card per step, joined by dashed
// lines with ⊕ to add a step there, and "Add step" at the end. Each card says what it does in
// plain words — "Signals: Objection, Competitor", "To: the account owner" — and whether it is
// ready, so the flow reads without opening anything. The selected card is set up in the panel on
// the right. One view for everyone: it replaced the Simple form and the left-to-right tiles.
//
// Simpler than n8n on purpose: a flow here runs in one order, so there is nothing to drag or
// wire.
//
// The look (2026-10-26): the canvas and the settings sit as two framed cards, each node is a
// compact chip (a small "Trigger" or "Action" over its name, what it does on hover), nodes are
// joined by a thin line with a handle at each end, a Draft tag sits on the canvas while there are
// unpublished changes, and the bar carries the verbs: Activate, Discard draft, See runs, Versions, Test.
import { trackProductEvent } from "@/lib/posthog";
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Check, ChevronLeft, ChevronRight, History, Layers, Loader2, MousePointerClick, PanelRightClose, PanelRightOpen, Play, Plus, Power, Search, Trash2, Undo2, X as XIcon, Zap } from "lucide-react";
import { AutomationRunDetail } from "@/components/AutomationRunDetail";
import { AccountLogo } from "@/components/pipeline/DealBits";
import { usePlan } from "@/hooks/usePlan";
import { isApiTier } from "@/config/plans";
import { OPEN_PRIORITIES } from "@/components/shell/PrioritiesButton";
import { useAuth } from "@/contexts/AuthContext";
import { cn } from "@/lib/utils";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { StepMark, TriggerMark } from "@/components/AutomationMarks";
import { StepPanel, TriggerPanel, type Mailbox } from "@/components/FlowPanels";
import { AutomationRuns } from "@/components/AutomationRuns";
import { AutomationVersions } from "@/components/AutomationVersions";
import { stepCardRows, stepCardTitle, triggerCardRows, triggerCardTitle, type CardRow } from "@/lib/flowCards";
import { PreviewContext, type Preview } from "@/lib/automationPreview";
import { hubspotVarGroups, withSources, type HsField } from "@/lib/hubspotVars";
import { templateById } from "@/lib/templates";
import {
  JOBS, automationsFetch, marksFor, payloadFor, toolsFor, toolKindFor, withDraft,
  type Automation, type Job, type Payload, type Tool,
} from "@/lib/automations";
import {
  TOOL_CATALOG, agentJob, flowFromRow, flowPayload, newStep,
  agentPrompt, checkBeforeSave, stepReady, varsAt,
  type Action, type Flow, type Issue, type Step, type StepConfig,
} from "@/lib/flows";

// ── Adding a step ────────────────────────────────────────────────────────────

/** A quiet verb in the bar: icon and word, no border, like the canvas tools around it. */
const BAR_BTN = "flex h-8 items-center gap-1.5 whitespace-nowrap rounded-lg px-2.5 text-[12.5px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40";

/** The picker: search, then tools, then the tool's actions. */
function AddStep({ onAdd, variant }: { onAdd: (a: Action) => void; variant: "link" | "end" }) {
  const [open, setOpen] = useState(false);
  const [tool, setTool] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const close = () => { setOpen(false); setTool(null); setQ(""); };
  const pick = (a: Action) => { onAdd(a); close(); };

  const needle = q.trim().toLowerCase();
  const hits = needle
    ? TOOL_CATALOG.flatMap(t => t.actions.map(a => ({ t, a })))
        .filter(({ t, a }) => `${t.label} ${a.label}`.toLowerCase().includes(needle))
    : [];
  const entry = TOOL_CATALOG.find(t => t.key === tool) ?? null;

  const row = "flex w-full items-center gap-2.5 rounded-[8px] px-2 py-1.5 text-left text-[13px] text-foreground transition-colors hover:bg-foreground/[0.05] focus-visible:bg-foreground/[0.05] focus-visible:outline-none";

  return (
    <Popover open={open} onOpenChange={o => (o ? setOpen(true) : close())}>
      <PopoverTrigger asChild>
        {variant === "end" ? (
          <button
            aria-label="Add a step"
            className={cn(
              "flex h-9 items-center gap-1.5 rounded-[10px] border border-dashed bg-background px-3.5 text-[12.5px] text-muted-foreground transition-colors hover:border-foreground/40 hover:text-foreground",
              open ? "border-foreground/40 text-foreground" : "border-foreground/25",
            )}
          >
            <Plus className="h-3.5 w-3.5" strokeWidth={2} /> Add step
          </button>
        ) : (
          <button
            aria-label="Add a step here"
            className="flex h-5 w-5 items-center justify-center rounded-full border border-foreground/30 bg-background text-foreground/70 shadow-sm transition-colors hover:border-foreground/60 hover:text-foreground"
          >
            <Plus className="h-2.5 w-2.5" strokeWidth={2.6} />
          </button>
        )}
      </PopoverTrigger>
      <PopoverContent align="start" sideOffset={8} className="w-[240px] rounded-[12px] p-1 shadow-[0_8px_24px_-8px_rgba(0,0,0,0.16)]">
        <div className="flex items-center gap-2 border-b border-border/60 px-2 pb-1.5 pt-1">
          <Search className="h-3.5 w-3.5 text-muted-foreground/60" />
          <input
            autoFocus
            value={q}
            onChange={e => { setQ(e.target.value); setTool(null); }}
            placeholder="Search"
            className="h-6 w-full bg-transparent text-[13px] text-foreground placeholder:text-muted-foreground/50 focus:outline-none"
          />
        </div>
        <div className="max-h-[320px] overflow-y-auto pt-1">
          {needle ? (
            hits.length ? hits.map(({ t, a }) => (
              <button key={`${t.key}:${a.label}`} onClick={() => pick(a)} className={row}>
                <StepMark type={t.mark} model={a.config?.model} />
                <span className="min-w-0 flex-1 truncate">{a.label}</span>
                <span className="text-[11px] text-muted-foreground/60">{t.label}</span>
              </button>
            )) : <p className="px-2 py-2 text-[12.5px] text-muted-foreground">Nothing matches.</p>
          ) : entry ? (<>
            <button onClick={() => setTool(null)} className={cn(row, "text-muted-foreground")}>
              <ChevronLeft className="h-3.5 w-3.5" /> {entry.label}
            </button>
            {entry.actions.map(a => (
              <button key={a.label} onClick={() => pick(a)} className={row}>
                <StepMark type={a.type === "wait" || a.type === "approval" || a.type === "only_if" ? a.type : entry.mark} model={a.config?.model ?? entry.model} />
                <span className="min-w-0 flex-1 truncate">{a.label}</span>
              </button>
            ))}
          </>) : TOOL_CATALOG.map(t => (
            <button key={t.key} onClick={() => (t.actions.length === 1 ? pick(t.actions[0]) : setTool(t.key))} className={row}>
              <StepMark type={t.mark} model={t.model} />
              <span className="min-w-0 flex-1 truncate">{t.label}</span>
              {t.actions.length > 1 && <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/50" />}
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

// ── The canvas ───────────────────────────────────────────────────────────────

/** One card: its mark, what it is, whether it is ready, and what it does in a few rows. */
/** A card's place in a test run (GET-724): where the run is, and what this step did. */
type CardRun = { status: "pending" | "running" | "ok" | "failed" | "waiting" | "skipped" | "stopped"; detail?: string | null; onView?: () => void };
const RUN_CHIP: Record<CardRun["status"], { text: string; tone: string }> = {
  pending: { text: "Up next", tone: "text-muted-foreground/60" },
  running: { text: "Running", tone: "text-foreground" },
  ok: { text: "Done", tone: "text-emerald-600 dark:text-emerald-400" },
  failed: { text: "Failed", tone: "text-red-600 dark:text-red-400" },
  waiting: { text: "Waiting for you", tone: "text-amber-600 dark:text-amber-400" },
  skipped: { text: "Skipped", tone: "text-muted-foreground" },
  stopped: { text: "Stopped here", tone: "text-muted-foreground" },
};

function FlowCard({ mark, title, rows, on, ready = true, trigger = false, onClick, run }: {
  mark: React.ReactNode; title: string; rows: CardRow[]; on: boolean; ready?: boolean; trigger?: boolean; onClick: () => void; run?: CardRun | null;
}) {
  // What it does, in the card's own rows, on hover: the chip itself stays a kind and a name.
  const summary = rows.map(r => `${r.label}: ${r.value}`).join("\n");
  return (
    <div className="flex flex-col items-center">
      <button
        onClick={onClick}
        title={summary || undefined}
        className={cn(
          "group relative flex w-[248px] max-w-full flex-shrink-0 items-center gap-2.5 rounded-[10px] border bg-background px-2.5 py-2 text-left transition-all duration-300 focus-visible:outline-none",
          run?.status === "running" ? "border-foreground/70 shadow-[0_0_0_4px_rgba(0,0,0,0.06)] animate-pulse"
            : run?.status === "ok" ? "border-emerald-500/60 shadow-[0_0_0_3px_rgba(16,185,129,0.10)]"
            : run?.status === "failed" ? "border-red-500/60 shadow-[0_0_0_3px_rgba(239,68,68,0.10)]"
            : run?.status === "waiting" ? "border-amber-500/70 shadow-[0_0_0_3px_rgba(245,158,11,0.12)]"
            : run?.status === "pending" ? "border-border opacity-60"
            : on ? "border-[#6E7FC4] shadow-[0_0_0_3px_rgba(110,127,196,0.16)]"
            : ready ? "border-border shadow-[0_1px_2px_rgba(0,0,0,0.04)] hover:border-foreground/25"
            : "border-dashed border-foreground/30 hover:border-foreground/50",
        )}
      >
        <span className="relative flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-[8px] border border-border/60 bg-foreground/[0.025]">
          {mark}
          {trigger && (
            <span className="absolute -left-1.5 -top-1.5 flex h-[14px] w-[14px] items-center justify-center rounded-full bg-foreground text-background ring-2 ring-background">
              <Zap className="h-[7px] w-[7px]" strokeWidth={2.4} fill="currentColor" />
            </span>
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span className={cn("block text-[11px] leading-tight", on ? "text-[#6E7FC4]" : "text-muted-foreground/70")}>{trigger ? "Trigger" : "Action"}</span>
          <span className={cn("block truncate text-[13px] font-medium leading-snug", ready ? "text-foreground" : "text-muted-foreground")}>{title}</span>
        </span>
        {run ? (
          <span className={cn("flex flex-shrink-0 items-center", RUN_CHIP[run.status].tone)} title={RUN_CHIP[run.status].text}>
            {run.status === "running" ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
              : run.status === "ok" ? <Check className="h-3.5 w-3.5" />
              : <span className="text-[11px]">{RUN_CHIP[run.status].text}</span>}
          </span>
        ) : !ready && (
          <span className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-amber-500" title="Needs setup" />
        )}
      </button>
      {run?.detail && (
        <span className={cn("mt-1.5 flex max-w-[300px] items-center gap-2 text-[11.5px] leading-snug", run.status === "failed" ? "text-red-600 dark:text-red-400" : "text-muted-foreground")}>
          <span className="min-w-0 flex-1 line-clamp-2">{run.detail}</span>
          {run.onView && (
            <span role="link" tabIndex={0} onClick={e => { e.stopPropagation(); run.onView?.(); }}
              className="flex-shrink-0 text-foreground underline-offset-2 hover:underline">View</span>
          )}
        </span>
      )}
    </div>
  );
}

/** The handle where a line meets a node. */
function Handle() {
  return <span className="h-[7px] w-[7px] flex-shrink-0 rounded-full border border-foreground/30 bg-background" />;
}

/** The line between two nodes, a handle at each end, with ⊕ to add a step there on hover. */
function Link({ onAdd }: { onAdd?: (a: Action) => void }) {
  return (
    <div className="group/link relative flex h-16 w-full flex-shrink-0 flex-col items-center">
      <span className="-mt-[4px]"><Handle /></span>
      <span className="w-px flex-1 bg-foreground/20" />
      <span className="-mb-[4px]"><Handle /></span>
      {onAdd && (
        <span className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 opacity-0 transition-opacity focus-within:opacity-100 group-hover/link:opacity-100 has-[[data-state=open]]:opacity-100">
          <AddStep onAdd={onAdd} variant="link" />
        </span>
      )}
    </div>
  );
}

// ── The page ─────────────────────────────────────────────────────────────────

export default function AutomationEditor() {
  const { id = "new" } = useParams();
  const [params, setParams] = useSearchParams();
  // Editor or Runs — n8n's Editor | Executions. In the URL, so the list can link straight to runs.
  const tab = params.get("tab") === "runs" ? "runs" : params.get("tab") === "versions" ? "versions" : "editor";
  // Simple (GET-664) or Advanced: the sentence form, or the canvas. Simple whenever the
  // automation fits it; Advanced when you ask, or when it has steps the form cannot show.
  const jobParam = params.get("job");
  const templateParam = params.get("template");
  const setTab = (t: "editor" | "runs" | "versions") => setParams(p => { const n = new URLSearchParams(p); if (t !== "editor") n.set("tab", t); else n.delete("tab"); return n; }, { replace: true });
  const navigate = useNavigate();
  const { session, userData } = useAuth();
  const token = session?.access_token ?? "";
  const workspaceId = userData?.workspace?.id ?? "";
  const isNew = id === "new";

  const [data, setData] = useState<Payload | null>(null);
  const [tools, setTools] = useState<{ meeting: Tool[]; crm: Tool[] }>({ meeting: [], crm: [] });
  // Your own model keys, and every connected slug — for the agent's "runs on" and the save check.
  const [models, setModels] = useState<Tool[]>([]);
  const [connected, setConnected] = useState<string[]>([]);
  // The mailboxes an email can go from (GET-716).
  const [mailboxes, setMailboxes] = useState<Mailbox[]>([]);
  // Every HubSpot deal and company property the portal has (GET-567), for the variable picker.
  const [hsFields, setHsFields] = useState<{ deal: HsField[]; company: HsField[] }>({ deal: [], company: [] });
  const [issues, setIssues] = useState<Issue[] | null>(null);
  const [saved, setSaved] = useState<Automation | null>(null);
  const [flow, setFlow] = useState<Flow | null>(null);
  // A published version opened from Versions (GET-739): read on the canvas, nothing editable.
  const [viewing, setViewing] = useState<{ version: number; publishedAt: string; by: string | null; live: boolean; flow: Flow } | null>(null);
  const [name, setName] = useState<{ value: string; touched: boolean }>({ value: "", touched: false });
  // The node you are on, in the URL: a reload, a shared link or the back button lands on the
  // same step. Step ids are stable across loads, so the address holds. A saved workflow opens
  // with nothing selected, the flow to read; a new one opens on its trigger, the first thing
  // it needs. A click on the empty canvas lets go of the selection.
  const sel: string | null = params.get("step") ?? (isNew ? "trigger" : null);
  const setSel = (sid: string | null) => setParams(p => {
    const n = new URLSearchParams(p);
    if (sid) n.set("step", sid); else n.delete("step");
    return n;
  }, { replace: true });
  // The settings panel folds away for room on the canvas; picking a node opens it again.
  const [panelOpen, setPanelOpen] = useState(() => {
    try { return localStorage.getItem("nous.automations.panel") !== "closed"; } catch { return true; }
  });
  const showPanel = (open: boolean) => {
    setPanelOpen(open);
    try { localStorage.setItem("nous.automations.panel", open ? "open" : "closed"); } catch { /* private mode */ }
  };
  const pick = (sid: string) => { setSel(sid); if (!panelOpen) showPanel(true); };
  const [busy, setBusy] = useState<null | "save" | "toggle" | "delete" | "restore">(null);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [dirty, setDirty] = useState(false);
  // Every edit bumps this. A save that finishes after you typed again must not mark the newer
  // text as saved — it compares the version it sent with the one on screen.
  const version = useRef(0);

  // TEST RUN (GET-724): run it now on the latest real trigger and watch the canvas follow it.
  type TestStep = { step: number; status: string; detail: string | null; document_id?: string | null };
  type TestRun = { id: string; status: string; error: string | null; trigger: { label: string; at: string | null; source: string | null } | null; steps: TestStep[] };
  const [testId, setTestId] = useState<string | null>(null);
  const [testRun, setTestRun] = useState<TestRun | null>(null);
  const [testError, setTestError] = useState<string | null>(null);
  const [viewRun, setViewRun] = useState<string | null>(null);
  useEffect(() => {
    if (!testId || !token || !workspaceId) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = async () => {
      const r = await automationsFetch(`/runs/${testId}?workspaceId=${workspaceId}`, token).catch(() => null);
      const b = r && r.ok ? await r.json().catch(() => null) : null;
      if (!alive) return;
      if (b) setTestRun(b);
      if (!b || b.status === "running") timer = setTimeout(poll, 1400);
    };
    void poll();
    return () => { alive = false; if (timer) clearTimeout(timer); };
  }, [testId, token, workspaceId]);

  const load = useCallback(async () => {
    if (!token || !workspaceId) return null;
    const [res, toolRes] = await Promise.all([
      automationsFetch(`?workspaceId=${workspaceId}`, token),
      automationsFetch(`/tools?workspaceId=${workspaceId}`, token),
    ]);
    const body: Payload | null = res.ok ? await res.json() : null;
    const tb = toolRes.ok ? await toolRes.json().catch(() => ({})) : {};
    setTools({ meeting: tb.meeting ?? [], crm: tb.crm ?? [] });
    setModels(tb.models ?? []);
    setConnected(tb.connected ?? []);
    setMailboxes(tb.mailboxes ?? []);
    if ((tb.connected ?? []).includes("hubspot")) {
      automationsFetch(`/hubspot-fields?workspaceId=${workspaceId}`, token)
        .then(r => (r.ok ? r.json() : null)).then(b => { if (b) setHsFields({ deal: b.deal ?? [], company: b.company ?? [] }); })
        .catch(() => {});
    }
    setData(body);
    return body ? { body, ownModel: (tb.models?.[0]?.slug as string | undefined) ?? null } : null;
  }, [token, workspaceId]);

  // Hydrate once per automation: an existing row, or a new one from its template. The login token
  // refreshes about hourly (and when the tab comes back), which rebuilds `load`; that must refresh
  // the tools and the list, never the flow on screen. Re-hydrating on it reset a half-built flow to
  // blank and threw away unsaved edits (GET-710).
  const hydrated = useRef<string | null>(null);
  const hydrateKey = `${id}|${jobParam ?? ""}|${templateParam ?? ""}`;
  useEffect(() => {
    let alive = true;
    void load().then(got => {
      if (!alive || !got) return;
      if (hydrated.current === hydrateKey) return;
      hydrated.current = hydrateKey;
      const { body } = got;
      const onOwnModel = (f: Flow): Flow => f;
      const tpl = isNew ? templateById(templateParam) : null;
      if (tpl && !tpl.byDefault) {
        // From a template: the whole flow drawn, named, the trigger open first.
        setFlow(onOwnModel(tpl.flow()));
        setName({ value: tpl.name, touched: true });
        setDirty(true);
      } else if (isNew) {
        const job = JOBS.find(j => j.id === jobParam) ?? null;
        // A blank one is only its trigger: every step is one you add (GET-710). From a job, that
        // job as an OpenNous step.
        const steps: Step[] = [];
        if (job) { const agent = newStep("agent"); agent.config = { mode: "pick", job: job.id, model: "opennous", extra: "", prompt: "" }; steps.push(agent); }
        // No trigger on a blank one: "when a call ends" already filled in is your first
        // decision made for you, and it is the one that decides whether it ever runs.
        setFlow(onOwnModel({ trigger: { kind: job?.when ?? "", config: {} }, steps }));
        setName({ value: job?.name ?? "", touched: false });
        setDirty(true);
      } else {
        const a = body.automations.find(x => x.id === id);
        if (!a) { setNotFound(true); return; }
        setSaved(a);
        // The draft, when there is one: you pick up where you left off, and the live version
        // keeps running until you publish.
        const shown = withDraft(a);
        setFlow(flowFromRow(shown));
        setName({ value: shown.name, touched: true });
        setDirty(false);
      }
    });
    return () => { alive = false; };
  }, [load, id, isNew, jobParam, templateParam, hydrateKey]);

  const edit = (next: Flow) => { setFlow(next); setDirty(true); version.current++; };

  const lockedBy = (j: Job) =>
    j.artifact ? data?.catalogue.find(r => r.artifact === j.artifact && !r.available)?.needs_plan ?? null : null;
  const triggerTools = flow ? toolsFor(flow.trigger.kind, flow.trigger.config.tools ?? [], tools) : [];
  const tool = triggerTools.length === 1 ? triggerTools[0] : null;
  const firstAgent = flow?.steps.find(s => s.type === "agent") ?? null;
  const autoName = (firstAgent && agentJob(firstAgent)?.name) || "Custom workflow";
  const shownName = name.touched ? name.value : (name.value || autoName);

  const allReady = !!flow && !!flow.trigger.kind && flow.steps.length > 0 && flow.steps.every(stepReady)
    && !flow.steps.some(s => { const j = agentJob(s); return j ? !!lockedBy(j) : false; });

  /** Add an action at `index`. Anything that acts outside the app gets an Approval in front
   *  of it unless one is already above — you take the approval out, we never put a send first. */
  const addAt = (index: number, action: Action) => {
    if (!flow) return;
    const s = newStep(action.type);
    s.config = { ...s.config, ...(action.config ?? {}) };
    // After a call, a HubSpot task is the call's next steps by default: one each (GET-710).
    if (s.type === "hubspot" && s.config.action === "task" && flow.trigger.kind === "call_ended") s.config.task_from = "call";
    // An approval goes in front of what SENDS to someone, unless one is already above. A Gmail
    // draft, a CRM write and an AI step send nothing, so they go in as they are (GET-710).
    const sends = ["email", "slack", "webhook"].includes(s.type) || (s.type === "gmail" && s.config.mode === "send");
    const guarded = flow.steps.slice(0, index).some(x => x.type === "approval");
    const insert: Step[] = sends && !guarded ? [newStep("approval"), s] : [s];
    edit({ ...flow, steps: [...flow.steps.slice(0, index), ...insert, ...flow.steps.slice(index)] });
    setSel(s.id);
  };
  const removeStep = (sid: string) => {
    if (!flow) return;
    edit({ ...flow, steps: flow.steps.filter(s => s.id !== sid) });
    setSel(null);
  };
  const setStep = (sid: string, patch: StepConfig) => {
    if (!flow) return;
    edit({ ...flow, steps: flow.steps.map(s => s.id === sid ? { ...s, config: { ...s.config, ...patch } } : s) });
  };

  /** Save, but first say what would stop it working. Nothing to say → it just saves. */
  const trySave = () => {
    if (!flow || !data) return;
    const live = new Map((data.triggers ?? []).map(t => [t.key, t.live !== false]));
    const found = checkBeforeSave(flow, { meeting: tools.meeting, crm: tools.crm, connected, live });
    if (found.length) setIssues(found);
    else void save();
  };

  /** Create or update; returns the saved row. */
  const save = async (): Promise<Automation | null> => {
    if (!flow || !allReady) return null;
    const sent = version.current;
    setBusy("save"); setError(null);
    try {
      // An AI step on your own key sends words, never a server artifact: the artifacts run on
      // OpenNous's model, and this step runs on yours.
      const agentCols = !firstAgent ? { artifact: null, prompt: null }
        : firstAgent.config.model && firstAgent.config.model !== "opennous"
          ? { artifact: null, prompt: agentPrompt(firstAgent.config) || null }
          : payloadFor(agentJob(firstAgent), firstAgent.config.extra ?? "", firstAgent.config.prompt ?? "");
      const body = { ...flowPayload(flow, shownName.trim() || autoName), ...agentCols };
      // A saved automation saves to its DRAFT (GET-584); the live version is untouched until
      // Publish. A new one is created live, as v1.
      const res = await automationsFetch(
        saved ? `/${saved.id}?workspaceId=${workspaceId}` : `?workspaceId=${workspaceId}`, token,
        { method: saved ? "PATCH" : "POST", body: JSON.stringify(saved ? { draft: body } : body) },
      );
      const out = await res.json().catch(() => ({}));
      if (!res.ok) { setError(out.message ?? out.error ?? "Could not save that."); return null; }
      setSaved(out);
      if (version.current === sent) setDirty(false);
      if (!saved) navigate(`/rev-plays/${out.id}`, { replace: true });
      return out;
    } finally { setBusy(null); }
  };

  // THE PREVIEW (GET-566): this flow's variables filled from a real trigger, refetched a moment
  // after the trigger or the steps change, and when you pick another sample.
  const [previewData, setPreviewData] = useState<Omit<Preview, "pick" | "loading">>({ samples: [], sample: null, vars: {} });
  const [previewWith, setPreviewWith] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const previewKey = flow ? JSON.stringify([flow.trigger.kind, flow.steps.map(s => [s.id, s.type])]) : "";
  useEffect(() => {
    if (!flow || !token || !workspaceId) return;
    let alive = true;
    const t = setTimeout(async () => {
      setPreviewLoading(true);
      try {
        const res = await automationsFetch(`/preview?workspaceId=${workspaceId}`, token, {
          method: "POST",
          body: JSON.stringify({ when: flow.trigger.kind || null, steps: flow.steps, entity_id: previewWith }),
        });
        const body = res.ok ? await res.json().catch(() => null) : null;
        if (alive && body) setPreviewData({ samples: body.samples ?? [], sample: body.sample ?? null, vars: body.vars ?? {} });
      } finally { if (alive) setPreviewLoading(false); }
    }, 400);
    return () => { alive = false; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewKey, previewWith, token, workspaceId]);
  const preview: Preview = { ...previewData, loading: previewLoading, pick: setPreviewWith };

  /** The draft goes live as the next version. Unsaved edits are saved into it first. */
  const publish = async () => {
    if (!saved) return;
    if (dirty) { const ok = await save(); if (!ok) return; }
    setBusy("save"); setError(null);
    try {
      const res = await automationsFetch(`/${saved.id}/publish?workspaceId=${workspaceId}`, token, { method: "POST" });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) { setError(out.message ?? out.error ?? "Could not publish that."); return; }
      setSaved(out);
    } finally { setBusy(null); }
  };

  /** Throw the draft away: the editor goes back to what is live. */
  const discard = async () => {
    if (!saved) return;
    setBusy("save"); setError(null);
    try {
      const res = await automationsFetch(`/${saved.id}?workspaceId=${workspaceId}`, token, { method: "PATCH", body: JSON.stringify({ draft: null }) });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) { setError(out.message ?? out.error ?? "Could not discard that."); return; }
      setSaved(out);
      setFlow(flowFromRow(out));
      setName({ value: out.name, touched: true });
      version.current++;
      setDirty(false);
    } finally { setBusy(null); }
  };

  // AUTOSAVE. A saved automation keeps what you change a moment after you stop: no Save button
  // to find, nothing lost to a closed tab. A new one is still created on purpose (Create), and
  // an edit that leaves a step unfinished waits, saying which.
  useEffect(() => {
    if (!saved || !dirty || !allReady || busy !== null) return;
    const t = setTimeout(() => { void save(); }, 900);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flow, name, dirty, saved?.id, allReady, busy]);

  // The last real triggers to test on (GET-735): pick one, or it runs on the newest.
  type TestTrigger = { id: string; label: string; at: string | null; source: string | null; account: { name: string | null; domain: string | null } | null };
  const [testPicking, setTestPicking] = useState(false);
  const [testTriggers, setTestTriggers] = useState<TestTrigger[] | null>(null);
  useEffect(() => {
    if (!testPicking || !saved?.id || !token || !workspaceId) return;
    setTestTriggers(null);
    automationsFetch(`/${saved.id}/test-triggers?workspaceId=${workspaceId}`, token)
      .then(r => (r.ok ? r.json() : null)).then(b => setTestTriggers(b?.triggers ?? [])).catch(() => setTestTriggers([]));
  }, [testPicking, saved?.id, token, workspaceId]);

  /** Restore a published version from the canvas (GET-739): the same route Versions uses. */
  const restoreVersion = async (v: number) => {
    if (!saved) return;
    setBusy("restore");
    try {
      const res = await automationsFetch(`/${saved.id}/versions/${v}/restore?workspaceId=${workspaceId}`, token, { method: "POST" });
      const row = await res.json().catch(() => ({}));
      if (!res.ok) { setError(row.message ?? row.error ?? "Could not restore that version."); return; }
      setSaved(row); setFlow(flowFromRow(row)); setName({ value: row.name, touched: true }); version.current++; setDirty(false); setViewing(null);
    } finally { setBusy(null); }
  };

  // Where a review waits (GET-737): the Approvals tab on the API plan, Priorities on the Workspace plan.
  const { plan } = usePlan();
  // With a run, straight to that run's review (GET-739).
  const openApprovals = (runId: string | null = null) => (isApiTier(plan)
    ? navigate(`/rev-plays?view=approvals${runId ? `&run=${encodeURIComponent(runId)}` : ""}`)
    : window.dispatchEvent(new CustomEvent(OPEN_PRIORITIES, { detail: { runId } })));

  const startTest = async (triggerId: string | null = null) => {
    if (!saved) return;
    setTestPicking(false);
    setTestError(null); setTestRun(null); setTestId(null);
    const res = await automationsFetch(`/${saved.id}/test-run?workspaceId=${workspaceId}`, token, { method: "POST", body: JSON.stringify(triggerId ? { trigger_id: triggerId } : {}) });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) { setTestError(out.message ?? out.error ?? "Could not start a test."); return; }
    setTestRun({ id: out.run_id, status: "running", error: null, trigger: out.trigger ?? null, steps: [] });
    setTestId(out.run_id);
  };
  /** Where a card stands in the test run: done, failed, waiting, running, or up next. */
  const cardRun = (n: number): CardRun | null => {
    if (!testRun) return null;
    const hit = testRun.steps.find(x => x.step === n);
    // "View" on a run waiting for you opens its review; otherwise the run itself (GET-739).
    if (hit) return { status: (hit.status as CardRun["status"]), detail: hit.detail,
      onView: () => (testRun.status === "awaiting_approval" ? openApprovals(testRun.id) : setViewRun(testRun.id)) };
    if (testRun.status !== "running") return { status: "pending", detail: null };
    const first = (flow?.steps ?? []).findIndex((_, i) => !testRun.steps.some(x => x.step === i + 1));
    return first + 1 === n ? { status: "running", detail: null } : { status: "pending", detail: null };
  };

  const toggle = async () => {
    if (!saved) return;
    setBusy("toggle"); setError(null);
    try {
      const res = await automationsFetch(`/${saved.id}?workspaceId=${workspaceId}`, token, {
        method: "PATCH", body: JSON.stringify({ enabled: !saved.enabled }),
      });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) setError(out.message ?? out.error ?? "Could not change that.");
      else {
        if (!saved.enabled) trackProductEvent('automation_enabled', { built_in: false, workspace_id: workspaceId ?? null });
        setSaved(out);
      }
    } finally { setBusy(null); }
  };

  const remove = async () => {
    if (!saved) return;
    setBusy("delete");
    try {
      await automationsFetch(`/${saved.id}?workspaceId=${workspaceId}`, token, { method: "DELETE" });
      navigate("/rev-plays");
    } finally { setBusy(null); }
  };

  if (notFound) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-[13px] text-muted-foreground">
        That workflow is gone.
        <button onClick={() => navigate("/rev-plays")} className="text-foreground underline-offset-2 hover:underline">Back to Rev Plays</button>
      </div>
    );
  }
  if (!flow || !data) return <div className="py-16 text-center text-[13px] text-muted-foreground">Loading…</div>;

  const kind = flow.trigger.kind;
  // Where the trigger listens: the connected tools it reads, else the kind of tool it needs.
  const source =
    triggerTools.length ? triggerTools.map(t => t.label)
    : toolKindFor(kind) === "crm" ? ["Your CRM"] : toolKindFor(kind) === "meeting" ? ["Any recorder"]
    : [];
  const selStep = flow.steps.find(s => s.id === sel) ?? null;
  const selIndex = selStep ? flow.steps.indexOf(selStep) : -1;

  return (
    <div className="flex h-full flex-col bg-muted/30">
      {/* The bar — where you are, what state it is in, and the verbs, quiet, on the right. */}
      <div className="flex h-[52px] flex-shrink-0 items-center gap-3 px-4">
        {/* Just the name and the version (2026-10-26): the rail already says where you are. */}
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <input
            value={shownName}
            onChange={e => { setName({ value: e.target.value, touched: true }); setDirty(true); version.current++; }}
            onFocus={() => tab !== "editor" && setTab("editor")}
            aria-label="Name"
            size={Math.max(12, shownName.length + 1)}
            className="min-w-0 max-w-[320px] truncate rounded-md bg-transparent px-1.5 py-1 text-[13.5px] font-medium text-foreground transition-colors hover:bg-accent/60 focus:bg-accent/60 focus:outline-none"
          />
          <span className="flex-shrink-0 rounded-[6px] border border-border/70 px-1.5 py-[1px] text-[11.5px] tabular-nums text-muted-foreground">
            {saved ? `v${saved.version ?? 1}` : "New"}
          </span>
        </div>

        <div className="flex flex-shrink-0 items-center gap-0.5">
          {saved && (
            <button onClick={() => void toggle()} disabled={busy !== null} className={BAR_BTN} title={saved.enabled ? "Stop it running" : "Let it run on its trigger"}>
              {busy === "toggle" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Power className={cn("h-3.5 w-3.5", saved.enabled && "text-emerald-600 dark:text-emerald-400")} />}
              {saved.enabled ? "Deactivate" : "Activate"}
            </button>
          )}
          {saved?.draft && !dirty && (
            <button onClick={() => void discard()} disabled={busy !== null} className={BAR_BTN}>
              <Undo2 className="h-3.5 w-3.5" /> Discard draft
            </button>
          )}
          {saved && (
            <button onClick={() => setTab(tab === "runs" ? "editor" : "runs")} className={cn(BAR_BTN, tab === "runs" && "bg-accent text-foreground")}>
              <History className="h-3.5 w-3.5" /> See runs
            </button>
          )}
          {saved && (
            <button onClick={() => setTab(tab === "versions" ? "editor" : "versions")} className={cn(BAR_BTN, tab === "versions" && "bg-accent text-foreground")}>
              <Layers className="h-3.5 w-3.5" /> Versions
            </button>
          )}
          {saved && (
            <Popover open={testPicking} onOpenChange={setTestPicking}>
              <PopoverTrigger asChild>
                <button
                  disabled={busy !== null || dirty || testRun?.status === "running"}
                  title={dirty ? "Save first" : "Run it now on a real trigger"}
                  className={BAR_BTN}
                >
                  {testRun?.status === "running" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
                  Test
                </button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-[360px] p-1.5">
                <p className="px-2 pb-1.5 pt-1 text-[11.5px] text-muted-foreground">Run it on</p>
                {testTriggers === null ? (
                  <p className="flex items-center gap-2 px-2 py-3 text-[12.5px] text-muted-foreground"><Loader2 className="h-3 w-3 animate-spin" />Loading…</p>
                ) : !testTriggers.length ? (
                  <p className="px-2 py-3 text-[12.5px] text-muted-foreground">Nothing to test on yet.</p>
                ) : testTriggers.map(t => (
                  <button key={t.id} onClick={() => void startTest(t.id)}
                    className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-hover">
                    <AccountLogo name={t.account?.name ?? t.label} domain={t.account?.domain ?? null} size={20} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[12.5px] text-foreground">{t.label}</span>
                      <span className="block truncate text-[11.5px] text-muted-foreground">
                        {[t.account?.name, t.at ? new Date(t.at).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : null].filter(Boolean).join(" · ")}
                      </span>
                    </span>
                  </button>
                ))}
              </PopoverContent>
            </Popover>
          )}
          {saved && (
            <button onClick={() => void remove()} aria-label="Delete" title="Delete" className={cn(BAR_BTN, "w-8 justify-center px-0")}>
              {busy === "delete" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
            </button>
          )}
          {saved?.draft && !dirty && (
            <button
              onClick={() => void publish()}
              disabled={busy !== null || !allReady}
              className="ml-1.5 flex h-8 items-center gap-1.5 rounded-lg bg-foreground px-3.5 text-[12.5px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-40 dark:bg-white dark:text-background"
            >
              {busy === "save" && <Loader2 className="h-3 w-3 animate-spin" />}
              Publish v{(saved.version ?? 1) + 1}
            </button>
          )}
          {!saved && (
            <Popover open={!!issues} onOpenChange={o => { if (!o) setIssues(null); }}>
              <PopoverTrigger asChild>
                <button
                  onClick={trySave}
                  disabled={!allReady || busy !== null}
                  title={allReady ? undefined : "Finish the dashed nodes first"}
                  className="ml-1.5 flex h-8 items-center gap-1.5 rounded-lg bg-foreground px-3.5 text-[12.5px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-40 dark:bg-white dark:text-background"
                >
                  {busy === "save" && <Loader2 className="h-3 w-3 animate-spin" />}
                  Create
                </button>
              </PopoverTrigger>
              {/* BEFORE YOU SAVE — what would stop it working. Never a wall: say it, let them go on. */}
              <PopoverContent align="end" sideOffset={8} className="w-[320px] rounded-[12px] p-3 shadow-[0_8px_24px_-8px_rgba(0,0,0,0.16)]">
                <ul className="space-y-2">
                  {(issues ?? []).map((it, i) => (
                    <li key={i} className="flex gap-2 text-[12.5px] leading-snug text-foreground/85">
                      <span className={cn("mt-[6px] h-1.5 w-1.5 flex-shrink-0 rounded-full", it.level === "warn" ? "bg-amber-500" : "bg-foreground/25")} />
                      {it.text}
                    </li>
                  ))}
                </ul>
                <div className="mt-3 flex justify-end gap-1.5">
                  <button onClick={() => setIssues(null)} className="h-7 rounded-md px-2.5 text-[12.5px] text-muted-foreground hover:text-foreground">Keep editing</button>
                  <button
                    onClick={() => { setIssues(null); void save(); }}
                    className="h-7 rounded-md bg-foreground px-2.5 text-[12.5px] font-medium text-white hover:opacity-90 dark:bg-white dark:text-background"
                  >
                    Create anyway
                  </button>
                </div>
              </PopoverContent>
            </Popover>
          )}
        </div>
      </div>

      {saved && tab === "versions" ? (
        <div className="mx-2 mb-2 min-h-0 flex-1 overflow-y-auto rounded-[14px] border border-border/70 bg-background">
          <AutomationVersions
            automation={saved}
            onView={v => { setViewing(v); setTab("editor"); }}
            onRestored={row => { setSaved(row); setFlow(flowFromRow(row)); setName({ value: row.name, touched: true }); version.current++; setDirty(false); setTab("editor"); }}
          />
        </div>
      ) : saved && tab === "runs" ? (
        <div className="mx-2 mb-2 min-h-0 flex-1 overflow-y-auto rounded-[14px] border border-border/70 bg-background"><AutomationRuns automationId={saved.id} /></div>
      ) : (
      <div className="flex min-h-0 flex-1 gap-2 px-2 pb-2">
        {/* The canvas. */}
        <div className="relative flex-1 overflow-auto rounded-[14px] border border-border/70 bg-background bg-[radial-gradient(hsl(var(--foreground)/0.09)_1px,transparent_1px)] [background-size:18px_18px]">
          {/* Draft: changes not live yet (a new one, or a saved one with an unpublished draft). */}
          {!viewing && (!saved || saved.draft || dirty) && (
            <span className="absolute left-3 top-3 z-10 rounded-[6px] bg-amber-100 px-2 py-0.5 text-[12px] font-medium text-amber-800 dark:bg-amber-500/15 dark:text-amber-300">Draft</span>
          )}
          {panelOpen && (
            <button
              onClick={() => showPanel(false)}
              title="Fold the settings away"
              aria-label="Fold the settings away"
              className="absolute right-3 top-3 z-10 flex h-8 w-8 items-center justify-center rounded-lg border border-border/70 bg-background text-muted-foreground shadow-sm transition-colors hover:text-foreground"
            >
              <PanelRightClose className="h-4 w-4" />
            </button>
          )}
          {error && (
            <p className="absolute left-1/2 top-5 z-10 -translate-x-1/2 rounded-lg border border-border bg-background px-3 py-1.5 text-[12.5px] text-foreground shadow-sm">
              {error}
            </p>
          )}
          {(testRun || testError) && (
            <div className="sticky top-3 z-10 mx-auto mt-3 flex w-fit max-w-[90%] items-center gap-3 rounded-full border border-border bg-background px-4 py-1.5 text-[12.5px] shadow-sm">
              {testError ? <span className="text-red-600 dark:text-red-400">{testError}</span> : testRun && (<>
                <span className="font-medium text-foreground">Test run</span>
                <span className="text-muted-foreground">
                  {testRun.status === "running" ? "Running…" : testRun.status === "ok" ? "Done" : testRun.status === "error" ? "Failed" : testRun.status === "awaiting_approval" ? "Waiting for your approval" : testRun.status === "rejected" ? "Skipped" : testRun.status}
                </span>
                {testRun.status === "awaiting_approval" && (
                  <button onClick={() => openApprovals(testRun.id)} className="text-foreground underline-offset-2 hover:underline">Review</button>
                )}
                {testRun.status !== "running" && (
                  <button onClick={() => setViewRun(testRun.id)} className="text-foreground underline-offset-2 hover:underline">See the run</button>
                )}
              </>)}
              <button onClick={() => { setTestRun(null); setTestId(null); setTestError(null); }} aria-label="Clear the test" className="text-muted-foreground hover:text-foreground"><XIcon className="h-3.5 w-3.5" /></button>
            </div>
          )}
          <AutomationRunDetail runId={viewRun} onClose={() => setViewRun(null)} onOpenApprovals={() => openApprovals(viewRun)} />
          {viewing ? (
          <div className="flex min-h-full flex-col items-center px-6 pb-14 pt-6">
            <div className="sticky top-3 z-10 mb-8 flex w-fit max-w-[90%] items-center gap-3 rounded-full border border-border bg-background px-4 py-1.5 text-[12.5px] shadow-sm">
              <span className="font-medium text-foreground">Viewing v{viewing.version}</span>
              <span className="text-muted-foreground">
                {new Date(viewing.publishedAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}{viewing.by ? ` · ${viewing.by}` : ""}{viewing.live ? " · live" : ""}
              </span>
              {!viewing.live && (
                <button onClick={() => void restoreVersion(viewing.version)} disabled={busy !== null} className="text-foreground underline-offset-2 hover:underline disabled:opacity-50">Restore this version</button>
              )}
              <button onClick={() => setViewing(null)} className="text-foreground underline-offset-2 hover:underline">Back to editing</button>
            </div>
            <FlowCard trigger on={false} ready onClick={() => {}}
              mark={<TriggerMark when={viewing.flow.trigger.kind} tools={marksFor(viewing.flow.trigger.kind, viewing.flow.trigger.config.tools ?? [], tools)} />}
              title={triggerCardTitle(viewing.flow)} rows={triggerCardRows(viewing.flow, source)} />
            {viewing.flow.steps.map(s => (
              <div key={s.id} className="flex w-full flex-col items-center">
                <Link />
                <FlowCard on={false} ready onClick={() => {}} mark={<StepMark type={s.type} model={s.config.model} />}
                  title={stepCardTitle(s)} rows={stepCardRows(s, viewing.flow)} />
              </div>
            ))}
          </div>
          ) : (
          <div className="flex min-h-full flex-col items-center px-6 py-14" onClick={e => { if (e.target === e.currentTarget) setSel(null); }}>
            <FlowCard
              trigger
              on={sel === "trigger"}
              ready={!!kind}
              onClick={() => pick("trigger")}
              mark={<TriggerMark when={kind} tools={marksFor(kind, flow.trigger.config.tools ?? [], tools)} />}
              title={triggerCardTitle(flow)}
              rows={triggerCardRows(flow, source)}
              run={testRun ? { status: "ok", detail: testRun.trigger ? `Using ${testRun.trigger.label}${testRun.trigger.at ? ` · ${new Date(testRun.trigger.at).toLocaleDateString(undefined, { month: "short", day: "numeric" })}` : ""}` : null } : null}
            />
            {flow.steps.map((s, i) => (
              <div key={s.id} className="flex w-full flex-col items-center">
                <Link onAdd={a => addAt(i, a)} />
                <FlowCard
                  on={sel === s.id}
                  ready={stepReady(s)}
                  onClick={() => pick(s.id)}
                  mark={<StepMark type={s.type} model={s.config.model} />}
                  title={stepCardTitle(s)}
                  rows={stepCardRows(s, flow)}
                  run={cardRun(i + 1)}
                />
              </div>
            ))}
            <span className="h-8 border-l border-dashed border-foreground/20" />
            <AddStep onAdd={a => addAt(flow.steps.length, a)} variant="end" />
          </div>
          )}
        </div>

        {/* The selected node — or, folded, a thin rail that opens it again. */}
        {viewing ? null : !panelOpen ? (
          <button
            onClick={() => showPanel(true)}
            title="Open the settings"
            aria-label="Open the settings"
            className="flex w-10 flex-shrink-0 items-start justify-center rounded-[14px] border border-border/70 bg-background pt-4 text-muted-foreground transition-colors hover:text-foreground"
          >
            <PanelRightOpen className="h-4 w-4" />
          </button>
        ) : (
        <div className="w-[400px] flex-shrink-0 overflow-y-auto rounded-[14px] border border-border/70 bg-background px-5 py-5">
          {sel === "trigger" ? (
            <TriggerPanel
              flow={flow}
              data={data}
              tools={tools}
              onChange={(k, config) => edit({ ...flow, trigger: { kind: k, config } })}
            />
          ) : !selStep ? (
            <div className="flex h-full flex-col items-center justify-center gap-1.5 px-6 text-center">
              <MousePointerClick className="h-4 w-4 text-muted-foreground/60" strokeWidth={1.8} />
              <p className="text-[13px] text-foreground">Nothing selected</p>
              <p className="text-[12px] text-muted-foreground">Click the trigger or a step to set it up.</p>
            </div>
          ) : (
            <PreviewContext.Provider value={preview}>
            <StepPanel
              step={selStep}
              flow={flow}
              vars={withSources([...varsAt(flow, selIndex), ...hubspotVarGroups(kind, hsFields)], kind, triggerTools)}
              triggerKind={kind}
              lockedBy={lockedBy}
              models={models}
              mailboxes={mailboxes}
              index={selIndex}
              set={patch => setStep(selStep.id, patch)}
              onRemove={() => removeStep(selStep.id)}
            />
            </PreviewContext.Provider>
          )}

        </div>
        )}
      </div>
      )}
    </div>
  );
}
