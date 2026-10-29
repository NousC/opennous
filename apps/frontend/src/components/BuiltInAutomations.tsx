// Automations — the list (GET-523).
//
// Each row draws its own flow before it says anything: the tool it runs on, the agent, where it
// goes. You read what an automation does from its marks and its name; the sentence and every
// setting are one click away in the editor, which is a page of its own (/workflows/:id)
// because a flow needs the height a dialog does not have.
//
// New opens the jobs as templates, plus a blank one. Picking one lands you in the editor with
// the flow already drawn and the step that still needs you selected — filling in gaps, not
// building from nothing.
import { trackProductEvent } from "@/lib/posthog";
import { useCallback, useEffect, useRef, useState } from "react";
import { STRIP_FOLD, TableBox } from "@/components/reports/parts";
import { ListTile } from "@/components/ui/list";
import { runColumns } from "@/components/automationRunColumns";
import { useNavigate } from "react-router-dom";
import {
  CalendarDays, CircleDot, Clock, Hand, Handshake, Info, Loader2, Lock, Plus, Radar, Webhook, Zap,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { DataTable, type Column } from "@/components/ui/data-table";
import { FilterMenu, type FilterGroup } from "@/components/ui/filter-menu";
import { ToolbarFilter } from "@/components/ui/toolbar-filter";
import { EmptyState } from "@/components/ui/empty-state";
import { PageToolbar } from "@/components/ui/page-top-bar";
import { SkeletonRows } from "@/components/ui/skeleton";
import { StatStrip } from "@/components/ui/stat-strip";
import { ViewTabs } from "@/components/ui/view-tabs";
import { num, when as whenAgo } from "@/lib/format";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useAuth } from "@/contexts/AuthContext";
import { AutomationApprovals, useApprovals } from "@/components/AutomationApprovals";
import { AutomationRunDetail } from "@/components/AutomationRunDetail";
import { usePlan } from "@/hooks/usePlan";
import { OPEN_PRIORITIES } from "@/components/shell/PrioritiesButton";
import { isApiTier } from "@/config/plans";
import { cn } from "@/lib/utils";
import { Switch } from "@/components/ui/switch";
import { AiMark, ModelMark, StepMark, ToolLogo, TriggerMark } from "@/components/AutomationMarks";
import { TEMPLATES, type TemplateTool } from "@/lib/templates";
import { flowFromRow, sentence, stepTitle, triggerDef, type Flow, type Step } from "@/lib/flows";
import {
  automationsFetch, marksFor, toolKindFor,
  type Automation, type Payload, type Run, type Tool,
} from "@/lib/automations";

// History's columns and status words — Activity's table, so the two logs read alike.
const RUN_TEXT: Record<string, string> = { ok: "Done", error: "Failed", running: "Running", awaiting_approval: "Needs approval", rejected: "Skipped" };

const SIGNALS = new Set(["health_changed", "champion_quiet", "committee_joined", "icp_tier_changed", "expansion_signal", "promise_overdue", "account_signal"]);

/** The trigger's own mark in the chain: its tools (the CRM pair on a deal trigger), the account
 *  signals mark, Google's, or a plain glyph. */
function TriggerTiny({ when, tools }: { when: string; tools: { slug: string; label: string }[] }) {
  const logo = (t: { slug: string; label: string }, i = 0) => (
    <ToolLogo key={t.slug} tool={t}
      className={cn("h-[14px] w-[14px] rounded-[4px] ring-1 ring-background", i > 0 && "-ml-1")} textClassName="text-[7px] font-semibold" />
  );
  if (tools.length) return <span className="flex flex-shrink-0 items-center">{tools.slice(0, 2).map(logo)}</span>;
  if (SIGNALS.has(when)) return <Radar className="h-[12px] w-[12px] flex-shrink-0 text-muted-foreground" />;
  if (when.startsWith("deal_")) return <Handshake className="h-[12px] w-[12px] flex-shrink-0 text-muted-foreground" />;
  if (["email_received", "reply_owed", "thread_quiet"].includes(when)) return logo({ slug: "gmail", label: "Gmail" });
  if (when === "before_meeting") return logo({ slug: "gcal", label: "Google Calendar" });
  if (when === "posthog_event") return logo({ slug: "posthog", label: "PostHog" });
  const Icon = when === "clock" ? Clock : when === "webhook_in" ? Webhook : when === "manual" ? Hand : null;
  return Icon ? <Icon className="h-[12px] w-[12px] flex-shrink-0 text-muted-foreground" /> : null;
}

/** A template's tools as a row of marks. A recorder or CRM shows what this workspace has
 *  connected when it has one, so the template reads as yours. */
function TemplateTools({ tools, connected, byDefault = false }: { byDefault?: boolean; tools: TemplateTool[]; connected: { meeting: { slug: string; label: string }[]; crm: { slug: string; label: string }[] } }) {
  return (
    <span className="flex items-center gap-1">
      {tools.map((t, i) => {
        let node: React.ReactNode;
        if ("glyph" in t) {
          node = t.glyph === "agent" ? (byDefault ? <ModelMark model="opennous" /> : <AiMark />)
            : t.glyph === "email" ? <StepMark type="email" />
            : <TriggerMark when={t.glyph === "clock" ? "clock" : "health_changed"} />;
        } else {
          const swap = t.slug === "granola" ? connected.meeting[0] : t.slug === "hubspot" ? connected.crm[0] : null;
          const tool = swap ?? t;
          node = <ToolLogo tool={tool} className="h-[22px] w-[22px] rounded-[6px] border border-border/60" textClassName="text-[9px] font-semibold" />;
        }
        return (
          <span key={i} title={t.label} className="flex items-center gap-1">
            {i > 0 && <span className="text-[11px] text-muted-foreground/35">→</span>}
            {node}
          </span>
        );
      })}
    </span>
  );
}

// The history filter's windows — Activity's, so the two logs filter alike.
const WINDOWS: [string, number | null][] = [
  ["Last 7 days", 7], ["Last 30 days", 30], ["Last 60 days", 60], ["Last 90 days", 90], ["All time", null],
];

/** A row of the list: one of yours, or one OpenNous runs for every workspace. */
type WorkflowRow =
  | { key: string; kind: "own"; a: Automation; flow: Flow; marks: { slug: string; label: string }[] }
  | { key: string; kind: "default"; t: (typeof TEMPLATES)[number]; flow: Flow; shownFlow: Flow; marks: { slug: string; label: string }[] };

/**
 * What an automation is, on hover over the ⓘ: one line of what it does, then the trigger and
 * each step with its mark, in order. A default says it is ours in a quiet last line.
 */
function AboutAutomation({ flow, does, today, byDefault = false, tools }: {
  flow: Flow; does?: string; today?: string; byDefault?: boolean; tools: { slug: string; label: string }[];
}) {
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hover = (on: boolean) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setOpen(on), on ? 120 : 160);
  };
  const where = (st: Step) =>
    st.type === "email" ? (st.config.to ? `to ${st.config.to}` : null)
    : st.type === "slack" ? (st.config.channel ?? null)
    : st.type === "gmail" ? "as a draft"
    : null;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          onClick={e => { e.stopPropagation(); setOpen(o => !o); }}
          onMouseEnter={() => hover(true)}
          onMouseLeave={() => hover(false)}
          aria-label="What this does"
          className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md text-muted-foreground/50 transition-colors hover:text-foreground"
        >
          <Info className="h-3.5 w-3.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={6}
        onMouseEnter={() => hover(true)}
        onMouseLeave={() => hover(false)}
        onClick={e => e.stopPropagation()}
        onOpenAutoFocus={e => e.preventDefault()}
        className="w-[300px] rounded-[12px] p-3"
      >
        <p className="text-[12.5px] leading-snug text-foreground">{does ?? sentence(flow, tools[0]?.label ?? null)}</p>
        <ol className="mt-2.5 space-y-1.5">
          <li className="flex items-center gap-2 text-[12px] text-foreground/80">
            <TriggerMark when={flow.trigger.kind} tools={tools} />
            <span className="truncate">{triggerDef(flow.trigger.kind)?.label ?? "Pick a trigger"}</span>
          </li>
          {flow.steps.map(st => (
            <li key={st.id} className="flex items-center gap-2 text-[12px] text-foreground/80">
              <StepMark type={st.type} model={st.config.model} />
              <span className="truncate">{stepTitle(st)}{where(st) && <span className="text-muted-foreground"> · {where(st)}</span>}</span>
            </li>
          ))}
        </ol>
        {(byDefault || today) && (
          <p className="mt-2.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
            {byDefault && <Lock className="h-3 w-3" />}
            {byDefault ? "Run by OpenNous" : null}{byDefault && today ? " · " : null}{today ? `today it ${today}` : null}
          </p>
        )}
      </PopoverContent>
    </Popover>
  );
}

export function BuiltInAutomations({
  view = "automations", onView,
}: {
  view?: "automations" | "history" | "approvals";
  onView?: (v: "automations" | "history" | "approvals") => void;
} = {}) {
  const navigate = useNavigate();
  const { session, userData } = useAuth();
  const token = session?.access_token ?? "";
  const workspaceId = userData?.workspace?.id ?? "";
  // The API plan runs no defaults (no Priorities to land in, no drafting for it): every automation
  // there is one the workspace made, so the "Default" list is not shown.
  const { plan } = usePlan();
  const apiPlan = isApiTier(plan);
  const [data, setData] = useState<Payload | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Templates are CLOSED until you ask for them. Once you have five running, the thing you came
  // to do is not adding a sixth — but with none, the templates are the page.
  const [adding, setAdding] = useState(false);
  const [tools, setTools] = useState<{ meeting: Tool[]; crm: Tool[] }>({ meeting: [], crm: [] });

  useEffect(() => {
    if (!token || !workspaceId) return;
    let alive = true;
    (async () => {
      const res = await automationsFetch(`/tools?workspaceId=${workspaceId}`, token);
      const body = res.ok ? await res.json().catch(() => ({})) : {};
      if (alive) setTools({ meeting: body.meeting ?? [], crm: body.crm ?? [] });
    })();
    return () => { alive = false; };
  }, [token, workspaceId]);

  const load = useCallback(async () => {
    if (!token || !workspaceId) return;
    const res = await automationsFetch(`?workspaceId=${workspaceId}`, token);
    if (res.ok) setData(await res.json());
  }, [token, workspaceId]);
  useEffect(() => { void load(); }, [load]);

  const [runs, setRuns] = useState<Run[] | null>(null);
  const [stats, setStats] = useState<{ runs: number; reports: number; failed: number } | null>(null);
  // 30 days is the default, so it does not count as a filter.
  const [days, setDays] = useState<number | null>(30);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [statuses, setStatuses] = useState<Set<string>>(new Set());
  const activeCount = (days !== 30 ? 1 : 0) + picked.size + statuses.size;
  const pickedKey = [...picked].sort().join(",");
  const statusKey = [...statuses].sort().join(",");
  useEffect(() => {
    if (view !== "history" || !token || !workspaceId) return;
    let alive = true;
    setRuns(null);
    (async () => {
      const q = new URLSearchParams({ workspaceId });
      if (days != null) q.set("days", String(days));
      if (pickedKey) q.set("routines", pickedKey);
      if (statusKey) q.set("status", statusKey);
      const res = await automationsFetch(`/runs?${q}`, token);
      const body = res.ok ? await res.json().catch(() => ({})) : {};
      if (!alive) return;
      setRuns(Array.isArray(body.runs) ? body.runs : []);
      setStats(body.stats ?? null);
    })();
    return () => { alive = false; };
  }, [view, token, workspaceId, days, pickedKey, statusKey]);

  // The last 30 days of runs, for each automation's last result and its count. One read for the
  // whole list; the API returns the newest 200, so a busier month shows its counts as "200+".
  const [recent, setRecent] = useState<{ runs: Run[]; total: number } | null>(null);
  useEffect(() => {
    if (view !== "automations" || !token || !workspaceId) return;
    let alive = true;
    (async () => {
      const res = await automationsFetch(`/runs?${new URLSearchParams({ workspaceId, days: "30" })}`, token);
      const body = res.ok ? await res.json().catch(() => ({})) : {};
      if (alive) setRecent({ runs: Array.isArray(body.runs) ? body.runs : [], total: body.stats?.runs ?? 0 });
    })();
    return () => { alive = false; };
  }, [view, token, workspaceId]);

  const toggle = async (a: Automation) => {
    setBusy(a.id); setError(null);
    try {
      const res = await automationsFetch(`/${a.id}?workspaceId=${workspaceId}`, token, {
        method: "PATCH", body: JSON.stringify({ enabled: !a.enabled }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) setError(body.message ?? body.error ?? "Could not change that.");
      else {
        if (!a.enabled) trackProductEvent('automation_enabled', { built_in: true, workspace_id: workspaceId ?? null });
        await load();
      }
    } finally { setBusy(null); }
  };


  const enabledCount = data?.automations.filter((a) => a.enabled).length ?? 0;
  const approvals = useApprovals();
  // One run, step by step (GET-721), opened from a row of Run history.
  const [openRun, setOpenRun] = useState<string | null>(null);
  const historyFilter: FilterGroup[] = data ? [
    {
      key: "window", label: "Time", icon: CalendarDays, defaultValue: "30",
      options: WINDOWS.map(([label, value]) => ({ value: value == null ? "all" : String(value), label })),
      selected: [days == null ? "all" : String(days)],
      onChange: ([v]) => setDays(v === "all" ? null : Number(v)),
    },
    {
      key: "workflow", label: "Workflow", icon: Zap, multi: true,
      options: data.automations.map(a => ({ value: a.id, label: a.name })),
      selected: [...picked], onChange: (next) => setPicked(new Set(next)),
    },
    {
      key: "status", label: "Status", icon: CircleDot, multi: true,
      options: Object.entries(RUN_TEXT).map(([value, label]) => ({ value, label })),
      selected: [...statuses], onChange: (next) => setStatuses(new Set(next)),
    },
  ] : [];
  // The tabs, the filter and New sit on the right of the toolbar, where Accounts keeps its search
  // and filters; the top bar above carries no filter of its own (2026-10-28).
  const toolbar = (
    <PageToolbar>
      <span className="flex-1" />
      {/* How many of the plan's automations are in use. Unlimited plans say nothing; the
          defaults are ours and do not count. */}
      {data?.limit != null && view === "automations" && (
        <span title="Your workflows count toward your plan. The defaults don't."
          className={cn("text-xs tabular-nums", data.used >= data.limit ? "text-warning" : "text-muted-foreground")}>
          {data.used} of {data.limit} used
        </span>
      )}
      {onView && (
        <ViewTabs<"automations" | "history" | "approvals"> aria-label="Workflow views" value={view} onChange={onView}
          options={[
            { value: "automations", label: "Workflows", count: data ? data.automations.length : undefined },
            { value: "history", label: "Run history" },
            // What waits on you (GET-713), counted so it is seen before it is opened. The API plan's
            // only; on the Workspace plan the same reviews are in Priorities (GET-737).
            ...(apiPlan ? [{ value: "approvals" as const, label: "Approvals", count: approvals.items?.length || undefined }] : []),
          ]} />
      )}
      {view === "history" && data && (
        <ToolbarFilter active={activeCount} className="w-[290px]">
          <FilterMenu groups={historyFilter} onClearAll={() => { setDays(30); setPicked(new Set()); setStatuses(new Set()); }} />
        </ToolbarFilter>
      )}
      {view === "automations" && (
        <Button size="sm" onClick={() => setAdding(true)} aria-expanded={adding}>
          <Plus className="!size-[13px]" strokeWidth={2.2} />New workflow
        </Button>
      )}
    </PageToolbar>
  );

  if (!data) return (
    <div className="text-[13px]">
      {toolbar}
      <div className="px-4 pt-3"><SkeletonRows rows={4} /></div>
    </div>
  );

  const empty = data.automations.length === 0;
  // Each automation's last result and run count over the last 30 days, from one read.
  const truncated = !!recent && recent.total > recent.runs.length;
  const lastOf = new Map<string, Run>();
  const countOf = new Map<string, number>();
  for (const r of recent?.runs ?? []) {
    if (!r.routine_id) continue;
    if (!lastOf.has(r.routine_id)) lastOf.set(r.routine_id, r);
    countOf.set(r.routine_id, (countOf.get(r.routine_id) ?? 0) + 1);
  }
  const lastRun = (a: Automation) => {
    if (!a.enabled) return <span className="text-xs text-muted-foreground">Off</span>;
    const r = lastOf.get(a.id);
    const at = r?.started_at ?? a.last_run_at;
    const dot = (tone: string, text: string) => (
      <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs text-ink-2"><span className={cn("size-1.5 shrink-0 rounded-full", tone)} />{text}</span>
    );
    if (!at) return <span className="text-xs text-muted-foreground">Not run yet</span>;
    const rel = whenAgo(at).replace(/^Yesterday$/, "yesterday");
    if (r?.status === "error") return dot("bg-risk", `Failed ${rel}`);
    if (r?.status === "awaiting_approval") return dot("bg-warning-dot", "Needs approval");
    if (r?.status === "running" || r?.status === "waiting") return dot("bg-warning-dot", "Running");
    // A run that went fine is the normal case: plain text, no dot. Colour is for failed and waiting.
    return <span className="whitespace-nowrap text-xs text-ink-2">Ran {rel}</span>;
  };
  const runCount = (a: Automation) => {
    const n = countOf.get(a.id) ?? 0;
    if (!a.last_run_at && !n) return "Never run";
    if (!recent) return "";
    return `${num(n)}${truncated && n ? "+" : ""} ${n === 1 ? "run" : "runs"}`;
  };

  const ownRows: WorkflowRow[] = data.automations.map(a => ({
    key: a.id, kind: "own", a, flow: flowFromRow(a), marks: marksFor(a.when, a.tools, tools),
  }));
  // The API plan runs no defaults. A ROW PER TOOL a default runs on: with Fellow and RingCentral
  // both connected, the follow-up runs for each, so it is listed for each, never one row wearing
  // two logos.
  const defaultRows: WorkflowRow[] = apiPlan ? [] : TEMPLATES.filter(t => t.byDefault).flatMap(t => {
    const flow = t.flow();
    const kind = toolKindFor(flow.trigger.kind);
    const on = kind ? tools[kind] : [];
    const rows = on.length ? on.map(tool => ({ key: `${t.id}:${tool.slug}`, tool })) : [{ key: t.id, tool: null as Tool | null }];
    return rows.map(({ key, tool }) => ({
      key, kind: "default" as const, t, flow,
      marks: tool ? [tool] : marksFor(flow.trigger.kind, [], tools),
      shownFlow: tool ? { ...flow, trigger: { ...flow.trigger, config: { ...flow.trigger.config, tools: [tool.slug] } } } : flow,
    }));
  });
  const off = (r: WorkflowRow) => r.kind === "own" && !r.a.enabled;
  const workflowColumns: Column<WorkflowRow>[] = [
    { key: "name", header: "Workflow", cell: r => (
      <span className={cn("group/name flex min-w-0 items-center gap-2.5", off(r) && "opacity-60")}>
        <ListTile><TriggerTiny when={r.flow.trigger.kind} tools={r.marks} /></ListTile>
        <span className="truncate text-foreground">{r.kind === "own" ? r.a.name : r.t.name}</span>
        {r.kind === "own" && r.a.draft && <span className="shrink-0 text-xs text-warning">Unpublished</span>}
        {r.kind === "default" && <span title="Run by OpenNous, always on"><Lock className="h-3 w-3 shrink-0 text-muted-foreground/40" /></span>}
        <span className="opacity-0 transition-opacity group-hover/name:opacity-100 focus-within:opacity-100">
          {r.kind === "own"
            ? <AboutAutomation flow={r.flow} tools={r.marks} />
            : <AboutAutomation flow={r.shownFlow} does={r.t.does} today={r.t.today} byDefault tools={r.marks} />}
        </span>
      </span>
    ) },
    { key: "last", header: "Last run", width: "130px", cell: r => r.kind === "own" ? lastRun(r.a)
      : <span className="whitespace-nowrap text-xs text-ink-2">{r.t.today ? r.t.today.charAt(0).toUpperCase() + r.t.today.slice(1) : "On"}</span> },
    { key: "runs", header: "Runs", align: "right", width: "84px", cell: r => r.kind === "own" ? (
      // Straight to this workflow's runs.
      <button type="button" onClick={e => { e.stopPropagation(); navigate(`/workflows/${r.a.id}?tab=runs`); }}
        title="Runs in the last 30 days"
        className="text-[12px] tabular-nums text-muted-foreground/70 underline-offset-2 hover:text-foreground hover:underline">
        {runCount(r.a)}
      </button>
    ) : <span className="text-muted-foreground/40">—</span> },
    { key: "on", header: <span className="sr-only">On</span>, align: "right", width: "56px", cell: r => r.kind === "own" ? (
      <span className="inline-flex" onClick={e => e.stopPropagation()}>
        {busy === r.a.id
          ? <span className="flex h-[18px] w-[30px] items-center justify-center"><Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" /></span>
          : <Switch checked={r.a.enabled} onCheckedChange={() => void toggle(r.a)} aria-label={`${r.a.name}: ${r.a.enabled ? "on" : "off"}`}
              className="h-[18px] w-[30px] border-0 data-[state=unchecked]:bg-border [&>span]:size-3.5 [&>span]:translate-x-0.5 [&>span]:shadow-[0_1px_2px_rgba(0,0,0,.2)] [&>span]:data-[state=checked]:translate-x-[14px]" />}
      </span>
    ) : null },
  ];

  return (
    <div className="text-[13px]">
      {toolbar}
      {error && <p className="px-6 pt-4 text-[12.5px] text-foreground">{error}</p>}

      <AutomationRunDetail runId={openRun} onClose={() => setOpenRun(null)} onOpenApprovals={onView ? () => (apiPlan ? onView("approvals") : window.dispatchEvent(new CustomEvent(OPEN_PRIORITIES))) : undefined} />
      {view === "approvals" && apiPlan ? (
        <AutomationApprovals state={approvals} />
      ) : view === "history" ? (
        <div className="flex flex-col gap-4 px-6 pb-10 pt-[22px]">
          {/* Counted by the API over the window, not from the rows below. */}
          <StatStrip className={STRIP_FOLD} stats={[
            { label: "Runs", value: stats ? num(stats.runs) : "—", note: days == null ? "all time" : `last ${days} days` },
            { label: "Reports created", value: stats ? num(stats.reports) : "—" },
            { label: "Failed", value: stats ? num(stats.failed) : "—", tone: stats?.failed ? "risk" : undefined },
            { label: "Active", value: num(enabledCount), note: `of ${num(data.automations.length)} workflows` },
          ]} />
          {/* WHAT RAN: the same columns as Activity, so the two logs read alike. */}
          <TableBox>
            <DataTable aria-label="Run history" columns={runColumns(navigate, { automation: true })} rows={runs ?? []} rowKey={(r) => r.id}
              loading={runs === null} minWidth={760} onRowClick={(r) => setOpenRun(r.id)}
              empty={<EmptyState bordered={false} title={activeCount ? "Nothing matches these filters." : "Nothing has run yet."}
                body={activeCount ? undefined : "Runs show up here as your workflows fire."} />} />
          </TableBox>
        </div>
      ) : (
        <div>
          {/* NEW: a dialog over the page: pick a template and the editor opens with its flow
              drawn, or start from scratch. */}
          <Dialog open={adding} onOpenChange={setAdding}>
            <DialogContent className="max-w-[880px] gap-0 p-0">
              <DialogHeader className="border-b border-hairline px-6 py-4 text-left">
                <DialogTitle>New workflow</DialogTitle>
                <DialogDescription className="sr-only">Start from a template or from scratch.</DialogDescription>
              </DialogHeader>
              <div className="grid max-h-[65vh] grid-cols-1 gap-2 overflow-y-auto p-5 sm:grid-cols-2 lg:grid-cols-3">
                <button
                  onClick={() => navigate("/workflows/new")}
                  className="flex min-h-[112px] flex-col items-start justify-between rounded-xl border border-dashed border-border px-3.5 py-3 text-left transition-colors hover:border-foreground/40"
                >
                  <span className="flex items-center gap-1.5 text-[13px] font-medium text-foreground"><Plus className="h-3.5 w-3.5" /> Start from scratch</span>
                  <span className="text-[12px] leading-snug text-muted-foreground">Pick a trigger, then add the steps you want.</span>
                </button>
                {TEMPLATES.filter(t => !t.byDefault).map(t => (
                  <button
                    key={t.id}
                    onClick={() => navigate(`/workflows/new?template=${t.id}`)}
                    className="flex flex-col gap-2.5 rounded-xl border border-border bg-card px-3.5 py-3 text-left shadow-card transition-colors hover:border-foreground/25"
                  >
                    <span className="text-[13px] font-medium text-foreground">{t.name}</span>
                    <span className="text-[12px] leading-snug text-muted-foreground">{t.does}</span>
                    <TemplateTools tools={t.tools} connected={tools} />
                  </button>
                ))}
              </div>
            </DialogContent>
          </Dialog>

        </div>
      )}
      {view === "automations" && (
        // One table, Accounts' (2026-10-28): yours first, then what OpenNous runs for every
        // workspace, so the page is the whole answer to "what runs". A row of yours opens the
        // editor; a default is locked, you can see what it does, not change it.
        <div className="min-w-0">
          {empty && defaultRows.length > 0 && (
            <EmptyState bordered={false} className="mx-4 mt-4" title="Nothing of your own yet."
              action={<Button size="sm" variant="outline" onClick={() => navigate("/workflows/new")}><Plus className="!size-3.5" />Start blank</Button>} />
          )}
          <DataTable<WorkflowRow>
            aria-label="Workflows"
            columns={workflowColumns}
            {...(defaultRows.length ? {
              groups: [
                ...(ownRows.length ? [{ key: "own", label: "Yours", meta: num(ownRows.length), rows: ownRows }] : []),
                { key: "default", label: "Default", meta: num(defaultRows.length), rows: defaultRows },
              ],
            } : { rows: ownRows })}
            rowKey={r => r.key}
            onRowClick={r => { if (r.kind === "own") navigate(`/workflows/${r.a.id}`); }}
            keyboard
            minWidth={880}
            empty={
              <EmptyState className="mx-4 mt-4" title="Nothing of your own yet."
                action={<Button size="sm" variant="outline" onClick={() => navigate("/workflows/new")}><Plus className="!size-3.5" />Start blank</Button>} />
            }
          />
        </div>
      )}
    </div>
  );
}

