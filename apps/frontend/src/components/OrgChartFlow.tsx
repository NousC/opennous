import { useMemo, useState, useCallback } from "react";
import ReactFlow, { Background, Controls, Handle, Position, MarkerType, type Node, type Edge, type NodeProps, type Connection } from "reactflow";
import "reactflow/dist/style.css";
import dagre from "dagre";
import { Plus } from "lucide-react";
import { relTime } from "@/components/mind/shared";
import { useAuth } from "@/contexts/AuthContext";
import { cn } from "@/lib/utils";

const apiUrl = import.meta.env.VITE_API_URL ?? "";
const ADD_INPUT = "h-8 rounded-lg border border-border bg-background px-2.5 text-[12.5px] text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-ring";

// The org chart as a real React Flow graph: dagre-laid tree, custom stakeholder nodes,
// reporting edges styled by confidence (solid = Confirmed, dashed = Likely) and clickable
// for their evidence. Read-only for now (Phase 4a); editing lands next.
type Stakeholder = {
  id: string; name: string; title: string | null; seniority: string | null;
  photo_url: string | null; last_activity_at: string | null;
  sentiment?: "supporter" | "detractor" | "neutral" | null; role?: string | null;
  /** Where the role came from: something said on the record, or only the job title. */
  role_basis?: "evidence" | "title" | null;
  /** Seniority read from the title (readTitle in core); drives the rows of the chart. */
  tier?: "executive" | "leadership" | "manager" | "staff" | null;
};
const TIERS = ["executive", "leadership", "manager", "staff", "unknown"] as const;
type EdgeRow = { subject_id: string; relationship: string; object_id: string | null; object_label: string | null; confidence?: number | null; source_memory_id?: string | null; source?: string | null; metadata?: any };

const SENT_UI: Record<string, { label: string; bg: string; text: string; dot: string }> = {
  supporter: { label: "Supporter", bg: "bg-emerald-500/10", text: "text-emerald-600 dark:text-emerald-400", dot: "#22c55e" },
  detractor: { label: "Detractor", bg: "bg-red-500/10", text: "text-red-600 dark:text-red-400", dot: "#ef4444" },
  neutral: { label: "Neutral", bg: "bg-muted", text: "text-muted-foreground", dot: "#9ca3af" },
};
const ROLE_LABEL: Record<string, string> = {
  champion: "Champion", economic_buyer: "Economic buyer", decision_maker: "Decision maker",
  blocker: "Blocker", technical: "Technical", contact: "",
};
const KEY_ROLES = [
  { key: "decision_maker", label: "Decision maker" },
  { key: "economic_buyer", label: "Economic buyer" },
  { key: "champion", label: "Champion" },
];
const NODE_W = 250, NODE_H = 132;

function StakeholderNode({ data }: NodeProps<{ s: Stakeholder; onOpen: (id: string) => void }>) {
  const s = data.s;
  // No stance on record is unknown, not "Neutral": only badge what something said.
  const sent = s.sentiment ? (SENT_UI[s.sentiment] ?? null) : null;
  const fromTitle = s.role_basis === "title";
  const roleLabel = ROLE_LABEL[s.role ?? "contact"] ?? "";
  const initials = (s.name || "?").split(/\s+/).map(w => w[0]).filter(Boolean).slice(0, 2).join("").toUpperCase();
  return (
    <div style={{ width: NODE_W }} className="rounded-2xl border border-border/70 bg-card overflow-hidden">
      <Handle type="target" position={Position.Top} className="!h-1.5 !w-1.5 !border-0 !bg-border" />
      <button onClick={() => data.onOpen(s.id)} className="flex w-full items-center gap-2.5 px-3.5 pt-3 pb-1.5 text-left">
        {s.photo_url
          ? <img src={s.photo_url} alt="" className="h-8 w-8 flex-shrink-0 rounded-full object-cover" />
          : <span className="h-8 w-8 flex-shrink-0 rounded-full bg-muted flex items-center justify-center text-[11px] font-medium text-muted-foreground/70">{initials}</span>}
        <div className="min-w-0">
          <div className="text-[13px] font-medium text-foreground leading-tight truncate">{s.name}</div>
          {s.title && <div className="text-[11.5px] text-muted-foreground/70 truncate mt-0.5">{s.title}</div>}
        </div>
      </button>
      <div className="px-3.5 pb-3 pt-1 space-y-1">
        <div className="flex flex-wrap items-center gap-1.5">
          {roleLabel && (
            <span title={fromTitle ? "From their job title. Nothing on record confirms it yet." : undefined}
              className={cn("inline-flex items-center rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground/80", fromTitle ? "border border-dashed border-border" : "shadow-[inset_0_0_0_1px_hsl(var(--border)/0.7)]")}>
              {roleLabel}{fromTitle && <span className="ml-1 font-normal text-muted-foreground/60">· by title</span>}
            </span>
          )}
          {sent && <span className={cn("inline-flex items-center px-0.5 py-0.5 text-[11px]", sent.text)}>{sent.label}</span>}
        </div>
        {s.last_activity_at && <div className="text-[11px] text-muted-foreground/50">Last touched {relTime(s.last_activity_at)}</div>}
      </div>
      <Handle type="source" position={Position.Bottom} className="!h-1.5 !w-1.5 !border-0 !bg-border" />
    </div>
  );
}
/**
 * A decision role nobody on record holds yet (GET-800): "the CEO has the final say", said on a call,
 * with no person attached. Drawn as a dashed node in its title's row so the gap is on the chart.
 */
export type OrgPlaceholder = { key: string; title: string | null; role: string; status: string; tier?: string | null; quote?: string | null };
const PH_STATUS: Record<string, string> = { engaged: "Engaged", not_engaged: "Not engaged", not_contacted: "Not contacted", blocking: "Blocking" };

function PlaceholderNode({ data }: NodeProps<{ p: OrgPlaceholder }>) {
  const p = data.p;
  return (
    <div style={{ width: NODE_W }} title={p.quote ? `“${p.quote}”` : undefined}
      className="rounded-2xl border border-dashed border-border bg-background overflow-hidden">
      <Handle type="target" position={Position.Top} className="!h-1.5 !w-1.5 !border-0 !bg-border" />
      <div className="flex w-full items-center gap-2.5 px-3.5 pt-3 pb-1.5">
        <span className="h-8 w-8 flex-shrink-0 rounded-full border border-dashed border-border" />
        <div className="min-w-0">
          <div className="text-[13px] font-medium text-foreground/80 leading-tight truncate">{p.title || "Unnamed role"}</div>
          <div className="text-[11.5px] text-muted-foreground/70 truncate mt-0.5">Not yet named</div>
        </div>
      </div>
      <div className="px-3.5 pb-3 pt-1 flex flex-wrap items-center gap-1.5">
        {ROLE_LABEL[p.role] && <span className="inline-flex items-center rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground/80 shadow-[inset_0_0_0_1px_hsl(var(--border)/0.7)]">{ROLE_LABEL[p.role]}</span>}
        <span className="text-[11px] text-muted-foreground/70">{PH_STATUS[p.status] ?? ""}</span>
      </div>
      <Handle type="source" position={Position.Bottom} className="!h-1.5 !w-1.5 !border-0 !bg-border" />
    </div>
  );
}
const nodeTypes = { stakeholder: StakeholderNode, placeholder: PlaceholderNode };
const NO_PLACEHOLDERS: OrgPlaceholder[] = [];

function CommitteeCoverage({ stakeholders }: { stakeholders: Stakeholder[] }) {
  if (!stakeholders.length) return null;
  const now = Date.now();
  const isCold = (s: Stakeholder) => !s.last_activity_at || (now - new Date(s.last_activity_at).getTime()) / 86400000 > 30;
  const byRole = (r: string) => stakeholders.filter(s => (s.role ?? "contact") === r);
  const engaged = stakeholders.filter(s => !isCold(s)).length;
  const covered = KEY_ROLES.filter(r => byRole(r.key).length).length;
  const blockers = byRole("blocker");
  const gaps = KEY_ROLES.filter(r => !byRole(r.key).length);
  const coldKey = KEY_ROLES.flatMap(r => byRole(r.key)).filter(isCold);
  return (
    <div className="mb-4 rounded-xl border border-border bg-card p-4">
      <div className="mb-3 flex items-baseline justify-between">
        <h3 className="text-[13px] font-semibold text-foreground">Buying committee coverage</h3>
        <span className="text-[12px] tabular-nums text-muted-foreground">{covered}/{KEY_ROLES.length} key roles · {engaged}/{stakeholders.length} engaged</span>
      </div>
      <div className="flex flex-wrap gap-2">
        {KEY_ROLES.map(r => {
          const people = byRole(r.key);
          const person = people.find(p => !isCold(p)) || people[0];
          const has = people.length > 0;
          const cold = has && !people.some(p => !isCold(p));
          const dot = !has ? "#9ca3af" : cold ? "#f59e0b" : "#22c55e";
          return (
            <span key={r.key} className={cn("inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 text-[12px]", has ? "border-border bg-background" : "border-dashed border-border")}>
              <span className="h-2 w-2 flex-shrink-0 rounded-full" style={{ background: dot }} />
              <span className="font-medium text-foreground">{r.label}</span>
              <span className="text-muted-foreground">· {has ? `${person?.name}${cold ? " (cold)" : ""}` : "Not identified"}</span>
            </span>
          );
        })}
      </div>
      {(gaps.length > 0 || blockers.length > 0 || coldKey.length > 0) && (
        <div className="mt-3 flex flex-col gap-1 text-[11.5px] leading-relaxed">
          {gaps.length > 0 && <span className="text-muted-foreground"><span className="font-medium text-foreground">Gap:</span> no {gaps.map(g => g.label.toLowerCase()).join(", ")} on this account yet.</span>}
          {coldKey.length > 0 && <span className="text-amber-600 dark:text-amber-400"><span className="font-medium">Re-engage:</span> {coldKey.map(s => s.name).join(", ")} — no touch in 30d+.</span>}
          {blockers.length > 0 && <span className="text-red-600 dark:text-red-400"><span className="font-medium">Risk:</span> {blockers.map(b => b.name).join(", ")} blocking.</span>}
        </div>
      )}
    </div>
  );
}

type SelEdge = { level: string; evidence: string | null; sourceId: string | null; label: string; childId: string; parentId: string; manual: boolean };

export default function OrgChartFlow({ stakeholders, edges, companyId, companyName, onOpenPerson, onRefresh, placeholders = NO_PLACEHOLDERS }: { stakeholders: Stakeholder[]; edges: EdgeRow[]; companyId: string; companyName?: string; onOpenPerson: (id: string) => void; onRefresh?: () => void; placeholders?: OrgPlaceholder[] }) {
  const { session, userData } = useAuth();
  const token = session?.access_token ?? "";
  const workspaceId = (userData as any)?.workspace?.id ?? "";
  const [selected, setSelected] = useState<SelEdge | null>(null);
  // Manual edits this session: child → managerId (or null = cleared). Applied over the
  // extracted edges; persisted to the server as sticky "manual/confirmed" reporting lines.
  const [overrides, setOverrides] = useState<Map<string, string | null>>(new Map());

  const setReportsTo = useCallback((subjectId: string, objectId: string | null) => {
    setOverrides(prev => new Map(prev).set(subjectId, objectId));
    setSelected(null);
    fetch(`${apiUrl}/api/companies/${companyId}/reports-to`, {
      method: "PUT", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ subject_id: subjectId, object_id: objectId }),
    }).catch(() => { /* optimistic; a refresh reconciles */ });
  }, [companyId, token, workspaceId]);

  // Add a known stakeholder to this account (name + email + title), linked to the company.
  const [adding, setAdding] = useState(false);
  const [addBusy, setAddBusy] = useState(false);
  const [addErr, setAddErr] = useState<string | null>(null);
  const [form, setForm] = useState({ firstName: "", lastName: "", email: "", jobTitle: "" });

  const submitAdd = useCallback(async () => {
    if (addBusy) return;
    if (!form.firstName.trim() || !form.email.trim()) { setAddErr("First name and email are required."); return; }
    setAddBusy(true); setAddErr(null);
    try {
      const r = await fetch(`${apiUrl}/api/contacts`, {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          workspaceId, email: form.email.trim(), firstName: form.firstName.trim(),
          lastName: form.lastName.trim() || undefined, jobTitle: form.jobTitle.trim() || undefined,
          company: companyName, company_id: companyId, source: "manual",
        }),
      });
      if (!r.ok) {
        const d = await r.json().catch(() => ({} as any));
        setAddErr(d.error === "contact_already_exists" ? "That email is already a contact." : d.error === "invalid_email_format" ? "Enter a valid email." : "Could not add — try again.");
        return;
      }
      setForm({ firstName: "", lastName: "", email: "", jobTitle: "" });
      setAdding(false);
      onRefresh?.();
    } catch { setAddErr("Could not add — try again."); }
    finally { setAddBusy(false); }
  }, [addBusy, form, token, workspaceId, companyId, companyName, onRefresh]);

  const { nodes, rfEdges } = useMemo(() => {
    const byId = new Map(stakeholders.map(s => [s.id, s]));
    // child → reporting line, from extracted edges (first wins), then apply manual overrides.
    const reportsMap = new Map<string, { parent: string; level: string; evidence: string | null; sourceId: string | null; manual: boolean }>();
    for (const e of edges || []) {
      if (e.relationship !== "REPORTS_TO" || !e.object_id) continue;
      if (e.subject_id === e.object_id || !byId.has(e.subject_id) || !byId.has(e.object_id)) continue;
      if (reportsMap.has(e.subject_id)) continue;
      reportsMap.set(e.subject_id, {
        parent: e.object_id,
        level: e.metadata?.confidence_level === "confirmed" || e.source === "manual" ? "confirmed" : "likely",
        evidence: e.metadata?.fact ?? null, sourceId: e.source_memory_id ?? null, manual: e.source === "manual",
      });
    }
    for (const [child, parent] of overrides) {
      if (parent === null || !byId.has(parent) || parent === child) reportsMap.delete(child);
      else reportsMap.set(child, { parent, level: "confirmed", evidence: "Set manually", sourceId: null, manual: true });
    }

    const g = new dagre.graphlib.Graph();
    g.setGraph({ rankdir: "TB", nodesep: 36, ranksep: 64 });
    g.setDefaultEdgeLabel(() => ({}));
    stakeholders.forEach(s => g.setNode(s.id, { width: NODE_W, height: NODE_H }));
    reportsMap.forEach((r, child) => byId.has(r.parent) && g.setEdge(r.parent, child));
    // Seniority rows. Most accounts have no known reporting lines, and without these every person
    // landed in one flat row. An invisible anchor per tier, chained top to bottom, pulls each
    // person with no known manager into their title's row; a known reporting line still wins.
    const anchor = (t: string) => `__tier:${t}`;
    // Only the tiers someone is in, so an account with no executive on record has no empty top row.
    const phId = (p: OrgPlaceholder) => `__role:${p.key}`;
    const tierOf = (t?: string | null) => ((TIERS as readonly string[]).includes(t ?? "") ? t as string : "unknown");
    placeholders.forEach(p => g.setNode(phId(p), { width: NODE_W, height: NODE_H }));
    const present = TIERS.filter(t => stakeholders.some(s => !reportsMap.has(s.id) && (s.tier ?? "unknown") === t) || placeholders.some(p => tierOf(p.tier) === t));
    present.forEach((t, i) => {
      g.setNode(anchor(t), { width: 1, height: 1 });
      if (i > 0) g.setEdge(anchor(present[i - 1]), anchor(t));
    });
    stakeholders.forEach(s => { if (!reportsMap.has(s.id)) g.setEdge(anchor(s.tier ?? "unknown"), s.id); });
    placeholders.forEach(p => g.setEdge(anchor(tierOf(p.tier)), phId(p)));
    dagre.layout(g);

    const nodes: Node[] = stakeholders.map(s => {
      const p = g.node(s.id);
      return { id: s.id, type: "stakeholder", position: { x: (p?.x ?? 0) - NODE_W / 2, y: (p?.y ?? 0) - NODE_H / 2 }, data: { s, onOpen: onOpenPerson } };
    });
    for (const ph of placeholders) {
      const p = g.node(phId(ph));
      nodes.push({ id: phId(ph), type: "placeholder", position: { x: (p?.x ?? 0) - NODE_W / 2, y: (p?.y ?? 0) - NODE_H / 2 }, data: { p: ph }, connectable: false });
    }
    const rfEdges: Edge[] = [...reportsMap.entries()].filter(([, r]) => byId.has(r.parent)).map(([child, r]) => ({
      id: `${r.parent}->${child}`, source: r.parent, target: child, type: "smoothstep",
      markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color: r.level === "confirmed" ? "#64748b" : "#94a3b8" },
      style: { stroke: r.level === "confirmed" ? "#64748b" : "#94a3b8", strokeWidth: r.level === "confirmed" ? 2 : 1.5, strokeDasharray: r.level === "confirmed" ? undefined : "5 4" },
      data: { level: r.level, evidence: r.evidence, sourceId: r.sourceId, manual: r.manual, childId: child, parentId: r.parent, label: `${byId.get(child)?.name} → ${byId.get(r.parent)?.name}` } as SelEdge,
    }));
    return { nodes, rfEdges };
  }, [stakeholders, edges, overrides, onOpenPerson, placeholders]);

  const onEdgeClick = useCallback((_: any, edge: Edge) => setSelected(edge.data as SelEdge), []);
  const onConnect = useCallback((c: Connection) => { if (c.source && c.target && c.source !== c.target) setReportsTo(c.target, c.source); }, [setReportsTo]);

  const addUI = (
    <div className="mb-3">
      <div className="flex items-center justify-end">
        {!adding && (
          <button onClick={() => { setAdding(true); setAddErr(null); }}
            className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-lg border border-border/70 bg-background text-[12.5px] text-foreground/80 hover:bg-hover transition-colors">
            <Plus className="h-3.5 w-3.5" /> Add person
          </button>
        )}
      </div>
      {adding && (
        <div className="mt-2 rounded-2xl border border-border/70 bg-card p-2.5" onKeyDown={e => { if (e.key === "Enter") submitAdd(); if (e.key === "Escape") { setAdding(false); setAddErr(null); } }}>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <input autoFocus value={form.firstName} onChange={e => setForm(f => ({ ...f, firstName: e.target.value }))} placeholder="First name" className={ADD_INPUT} />
            <input value={form.lastName} onChange={e => setForm(f => ({ ...f, lastName: e.target.value }))} placeholder="Last name" className={ADD_INPUT} />
            <input value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} placeholder="Email" className={ADD_INPUT} />
            <input value={form.jobTitle} onChange={e => setForm(f => ({ ...f, jobTitle: e.target.value }))} placeholder="Job title" className={ADD_INPUT} />
          </div>
          <div className="mt-2 flex items-center gap-2">
            <button disabled={addBusy} onClick={submitAdd}
              className="h-8 px-3 rounded-lg bg-foreground text-background text-[12.5px] font-semibold hover:opacity-90 disabled:opacity-50">
              {addBusy ? "Adding…" : "Add to account"}
            </button>
            <button onClick={() => { setAdding(false); setAddErr(null); }} className="h-8 px-3 rounded-lg text-[12.5px] text-muted-foreground hover:text-foreground">Cancel</button>
            {addErr && <span className="text-[12px] text-red-600 dark:text-red-400">{addErr}</span>}
            {!addErr && companyName && <span className="ml-auto text-[11.5px] text-muted-foreground/70">Adds to {companyName}</span>}
          </div>
        </div>
      )}
    </div>
  );

  if (!stakeholders.length && !placeholders.length) {
    return (
      <div className="min-w-0">
        {addUI}
        <p className="text-[13px] text-muted-foreground/70 text-center py-12">No stakeholders yet — add one above, or people appear here as they join the account.</p>
      </div>
    );
  }

  return (
    <div className="min-w-0">
      {addUI}
      <div className="relative h-[600px] rounded-2xl border border-border/70 bg-background">
        <ReactFlow nodes={nodes} edges={rfEdges} nodeTypes={nodeTypes} onEdgeClick={onEdgeClick} onConnect={onConnect}
          fitView fitViewOptions={{ padding: 0.2 }} minZoom={0.2} maxZoom={1.5} proOptions={{ hideAttribution: true }} nodesDraggable={false} nodesConnectable={true}>
          <Background gap={20} color="hsl(var(--border))" />
          <Controls showInteractive={false} />
        </ReactFlow>
        {selected && (
          <div className="absolute bottom-4 left-4 z-10 max-w-[340px] rounded-2xl border border-border/70 bg-popover p-3.5 shadow-modal">
            <div className="mb-1 flex items-center justify-between">
              <span className="text-[12px] font-medium text-foreground">{selected.label}</span>
              <span className={cn("text-[11px] font-medium", selected.level === "confirmed" ? "text-emerald-600 dark:text-emerald-400" : "text-amber-600 dark:text-amber-400")}>{selected.level === "confirmed" ? "Confirmed" : "Likely"}</span>
            </div>
            <p className="text-[12px] leading-relaxed text-muted-foreground">{selected.evidence ? <span className="italic">“{selected.evidence}”</span> : "No source quote captured."}</p>
            <div className="mt-2.5 flex items-center gap-3">
              {selected.sourceId && <a href={`/note/${selected.sourceId}`} target="_blank" rel="noreferrer" className="text-[11px] text-foreground/70 underline underline-offset-2 hover:text-foreground">View source</a>}
              {selected.level !== "confirmed" && (
                <button onClick={() => setReportsTo(selected.childId, selected.parentId)} className="text-[11px] font-medium text-emerald-600 dark:text-emerald-400 hover:underline">Confirm</button>
              )}
              <button onClick={() => setReportsTo(selected.childId, null)} className="text-[11px] text-red-600 dark:text-red-400 hover:underline">Remove</button>
              <button onClick={() => setSelected(null)} className="ml-auto text-[11px] text-muted-foreground hover:text-foreground">Close</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
