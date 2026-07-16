import React, { useState, useEffect, useMemo, useCallback } from "react";
import { useParams, useNavigate, useLocation } from "react-router-dom";
import { ArrowLeft, Trash2, Search, Download, FileText, ChevronRight } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { relTime } from "@/components/mind/shared";
import { Company, healthColor, stageColor, ActivityIcon, mapContact, buildCompanies, STAGE_ORDER } from "@/components/mind/entities";
import { useColumnWidths, ColResizer } from "@/components/mind/resizableColumns";
import { PageHeader } from "@/components/ui/page-header";

const apiUrl = import.meta.env.VITE_API_URL ?? "";
const PAGE_SIZE = 100;

// Default widths for the resizable columns. The elastic "Top Contacts" column
// is flex-1 and not listed here — it absorbs the leftover space. Persisted per
// user in localStorage; see useColumnWidths.
const CO_COL_DEFAULTS: Record<string, number> = {
  name: 190, domain: 100, topContacts: 150, icp: 46, intent: 92, industry: 84, location: 104,
  lastActivity: 116, contacts: 72, stage: 92,
};

// Intent band → pill classes (account = max-of-people). Mirrors People/Lists.
const INTENT_TAG: Record<string, string> = {
  "Red-hot": "bg-red-100 text-red-700 dark:bg-red-950/50 dark:text-red-400",
  Hot:       "bg-orange-100 text-orange-700 dark:bg-orange-950/50 dark:text-orange-400",
  Warm:      "bg-amber-100 text-amber-700 dark:bg-amber-950/50 dark:text-amber-400",
  Aware:     "bg-sky-100 text-sky-700 dark:bg-sky-950/50 dark:text-sky-400",
  Dormant:   "bg-zinc-100 text-zinc-500 dark:bg-zinc-800/60 dark:text-zinc-500",
};

type CoTab = "overview" | "activity" | "facts" | "signals" | "notes";
type CoSort = { col: string | null; dir: "asc"|"desc" };

type Stakeholder = {
  id: string; name: string; title: string|null; seniority: string|null;
  department: string|null; pipeline_stage: string; deal_health_score: number|null;
  icp_score: number|null; last_activity_at: string|null; signal_count: number;
};
type GraphEdge = {
  subject_id: string; subject_label: string|null; relationship: string;
  object_id: string; object_label: string|null; confidence: number|null;
};
type Claim = {
  property: string; value: unknown; confidence: number; epistemic_class: string;
  freshness: string; observation_count: number; last_observed_at: string|null;
};
type IcpFit = { score: number; fit: boolean|null; reason: string|null; scored_at: string; outcome_score: number|null };
type CompanyDetail = {
  company: Record<string, any>;
  icp: IcpFit | null;
  stakeholders: Stakeholder[];
  edges: GraphEdge[];
  activity: any[];
  facts: Claim[];
  signals: any[];
  notes: any[];
};

// Freshness is the Mind's "how stale is this belief" axis — green when fresh,
// warming toward red as a claim ages past its decay window.
const freshColor = (f: string) =>
  f === "fresh" ? "#4ade80" : f === "aging" ? "#facc15" : f === "suspect" ? "#fb923c" : "#f87171";

// Same thresholds and colors as the People page ICP block, so the score reads
// identically wherever it appears.
const icpLabel = (s: number) => (s >= 75 ? "Strong fit" : s >= 50 ? "Potential fit" : "Weak fit");
const icpColor = (s: number) => (s >= 75 ? "#15803d" : s >= 50 ? "#b45309" : "#6b7280");

const prettyProp = (p: string) => p.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());

const claimValue = (v: unknown): string => {
  if (v == null) return "—";
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (Array.isArray(v)) return v.map(claimValue).join(", ");
  if (typeof v === "object") return Object.values(v as Record<string, unknown>).map(claimValue).join(", ");
  return String(v);
};

export default function Companies({ embedded = false, leadingTab = null }: { embedded?: boolean; leadingTab?: React.ReactNode } = {}) {
  const { session, userData } = useAuth();
  const token = session?.access_token ?? "";
  const workspaceId = userData?.workspace?.id ?? "";
  const { id } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  // Back from a company detail: if we got here by navigating (e.g. clicked the
  // company link on a person record inside a lead list), go BACK to that origin
  // so the lead-list / person context is preserved. Only fall back to the
  // accounts companies list when there's no history to return to (direct load).
  const goBackFromDetail = () => {
    if (location.key !== "default") navigate(-1);
    else { setDetail(null); setCoTab("overview"); }
  };

  const [companies, setCompanies] = useState<Company[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!token || !workspaceId) return;
    try {
      const headers = { Authorization: `Bearer ${token}` };
      const [coRes, ctRes] = await Promise.all([
        fetch(`${apiUrl}/api/companies/list?workspaceId=${workspaceId}`, { headers }),
        fetch(`${apiUrl}/api/contacts?workspaceId=${workspaceId}&limit=2000`, { headers }),
      ]);
      const coData = coRes.ok ? await coRes.json() : {};
      const ctData = ctRes.ok ? await ctRes.json() : {};
      const contacts = (ctData.contacts ?? []).map(mapContact);
      setCompanies(buildCompanies(coData.companies ?? [], contacts));
    } catch { /* silent */ }
    finally { setLoading(false); }
  }, [token, workspaceId]);

  useEffect(() => { load(); }, [load]);

  const [q, setQ] = useState("");
  // Companies expand to the people inside them. This is what an account record IS: a
  // company with its humans attached. The old People/Companies tab split hid the very
  // relationship — a person WORKS AT a company — that makes this a graph and not two
  // spreadsheets.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggleRow = (id: string) => setExpanded(prev => {
    const n = new Set(prev);
    n.has(id) ? n.delete(id) : n.add(id);
    return n;
  });
  const detail = useMemo<Company | null>(
    () => id ? companies.find(c => c.id === id) ?? null : null,
    [id, companies]
  );
  const setDetail = (c: Company | null) => navigate(c ? `/companies/${c.id}` : "/accounts?tab=companies");
  const [coTab, setCoTab] = useState<CoTab>("overview");
  const [cd, setCd] = useState<CompanyDetail | null>(null);
  const [coLoading, setCoLoading] = useState(false);
  const [coEditField, setCoEditField] = useState<string | null>(null);
  const [coEditValue, setCoEditValue] = useState("");
  const [coSaving, setCoSaving] = useState(false);
  const [coLocalOverrides, setCoLocalOverrides] = useState<Record<string, string | null>>({});
  const [coSort, setCoSort] = useState<CoSort>({ col:"lastActivity", dir:"desc" });
  const [page, setPage] = useState(0);
  const { widths, startResize } = useColumnWidths("nous.companies.colWidths.v2", CO_COL_DEFAULTS);
  const colW = (c: string) => widths[c] ?? CO_COL_DEFAULTS[c];
  // Total content width (columns + 28px delete col + px-4 row padding) so the
  // table scrolls horizontally instead of squeezing columns to a fixed width.
  const CO_COL_KEYS = ["name","stage","topContacts","icp","intent","industry","location","lastActivity","contacts"];
  const ROW_MIN = CO_COL_KEYS.reduce((s,k)=>s+colW(k),0) + 28 + 32;

  const deleteCompany = async (cid: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setCompanies(prev => prev.filter(c => c.id !== cid));
    fetch(`${apiUrl}/api/companies/${cid}?workspaceId=${workspaceId}`, {
      method: 'DELETE', headers: { Authorization: `Bearer ${token}` },
    }).catch(() => {});
  };

  useEffect(() => {
    if (!id) return;
    setCd(null); setCoLoading(true); setCoLocalOverrides({});
    fetch(`${apiUrl}/api/companies/${id}/detail?workspaceId=${workspaceId}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(r => r.ok ? r.json() : null)
      .then(d => setCd(d))
      .catch(() => setCd(null))
      .finally(() => setCoLoading(false));
  }, [id, workspaceId, token]);

  const patchCompany = async (key: string, value: string) => {
    if (!detail) return;
    setCoSaving(true);
    try {
      await fetch(`${apiUrl}/api/companies/${detail.id}`, {
        method: "PATCH",
        headers: { "Content-Type":"application/json", Authorization:`Bearer ${token}` },
        body: JSON.stringify({ [key]: value || null }),
      });
      setCoLocalOverrides(prev => ({ ...prev, [key]: value || null }));
    } catch { /* silent */ }
    finally { setCoSaving(false); setCoEditField(null); }
  };

  const getCoVal = (key: string, fallback: string|null|undefined) =>
    key in coLocalOverrides ? coLocalOverrides[key] : (fallback ?? null);

  // Three-state cycle, same as the People table: off → firstDir → opposite → off.
  const cycleSort = (col: string, firstDir: "asc"|"desc" = "asc") => {
    setPage(0);
    setCoSort(prev => {
      if (prev.col !== col) return { col, dir: firstDir };
      if (prev.dir === firstDir) return { col, dir: firstDir === "asc" ? "desc" : "asc" };
      return { col: null, dir: "asc" };
    });
  };

  const filtered = [...companies].filter(co =>
    !q || co.name.toLowerCase().includes(q.toLowerCase()) ||
    (co.domain??"").toLowerCase().includes(q.toLowerCase()) ||
    (co.industry??"").toLowerCase().includes(q.toLowerCase())
  );
  const stageRank = (s: string|null) => (s ? STAGE_ORDER.indexOf(s) : -1);
  // Default order (no explicit sort applied) = most recent interaction first.
  const sortedList = coSort.col === null
    ? [...filtered].sort((a,b) => (b.lastActivityAt??"").localeCompare(a.lastActivityAt??""))
    : [...filtered].sort((a,b) => {
    let av: any, bv: any;
    if (coSort.col==="name")            { av=a.name; bv=b.name; }
    else if (coSort.col==="lastActivity"){ av=a.lastActivityAt??""; bv=b.lastActivityAt??""; }
    else if (coSort.col==="industry")   { av=a.industry??""; bv=b.industry??""; }
    else if (coSort.col==="location")   { av=a.location??""; bv=b.location??""; }
    else if (coSort.col==="contacts")   { av=a.contactCount; bv=b.contactCount; }
    else if (coSort.col==="icp")        { av=a.icpScore??-1; bv=b.icpScore??-1; }
    else if (coSort.col==="stage")      { av=stageRank(a.stage); bv=stageRank(b.stage); }
    else                                 { av=0; bv=0; }
    if (av<bv) return coSort.dir==="asc"?-1:1;
    if (av>bv) return coSort.dir==="asc"?1:-1;
    return 0;
  });
  const totalPages = Math.ceil(sortedList.length / PAGE_SIZE);
  const pageRows = sortedList.slice(page*PAGE_SIZE, (page+1)*PAGE_SIZE);

  // Sortable + resizable header cell. The relative wrapper anchors the drag
  // handle to the cell's right edge; widthKey ties the width to the persisted
  // store (defaults to the sort column name).
  const SortHdr = ({ col, label, widthKey, className, firstDir="asc", sticky=false }: { col:string; label:string; widthKey?:string; className?:string; firstDir?:"asc"|"desc"; sticky?:boolean }) => {
    const wk = widthKey ?? col;
    return (
      <div className={`relative flex items-center flex-shrink-0 overflow-hidden ${sticky ? "sticky left-0 z-30 bg-muted/50" : ""}`} style={{width: colW(wk)}}>
        <button onClick={()=>cycleSort(col, firstDir)}
          className={`w-full min-w-0 text-[11px] font-semibold uppercase tracking-wide flex items-center gap-0.5 hover:text-foreground/80 transition-colors ${coSort.col===col?"text-foreground/80":"text-muted-foreground/70"} ${className??""}`}>
          <span className="truncate min-w-0">{label}</span>{coSort.col===col&&<span className="text-[8px] flex-shrink-0">{coSort.dir==="asc"?"▲":"▼"}</span>}
        </button>
        <ColResizer onMouseDown={e=>startResize(wk, e)} />
      </div>
    );
  };

  // Static (non-sortable) but still resizable header cell.
  const PlainHdr = ({ label, widthKey, className }: { label:string; widthKey:string; className?:string }) => (
    <div className="relative flex items-center flex-shrink-0 overflow-hidden" style={{width: colW(widthKey)}}>
      <span className={`w-full min-w-0 truncate text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/70 ${className??""}`}>{label}</span>
      <ColResizer onMouseDown={e=>startResize(widthKey, e)} />
    </div>
  );

  const handleExport = () => {
    const headers = ["Company","Domain","Industry","Location","Employees","Contacts","Stage","ICP"];
    const rows = companies.map(co => [
      co.name, co.domain??"", co.industry??"", co.location??"",
      co.employeeCount!=null?String(co.employeeCount):"", String(co.contactCount ?? 0),
      co.stage??"", co.icpScore!=null?String(co.icpScore):""
    ]);
    const csv = [headers,...rows].map(r=>r.map(v=>`"${String(v).replace(/"/g,'""')}"`).join(",")).join("\n");
    const url = URL.createObjectURL(new Blob([csv],{type:"text/csv"}));
    const a = document.createElement("a"); a.href=url; a.download="companies.csv"; a.click();
    URL.revokeObjectURL(url);
  };

  // Detail mode is keyed off the route id — show the record or a brief loader,
  // never the list, so the table doesn't flash before the detail appears.
  if (id) {
    if (!detail) return <div className="h-full flex items-center justify-center text-[13px] text-muted-foreground/70 bg-background">Loading…</div>;
    // Intel = what we LEARNED about the company (research, conversations, what they
    // do) — NOT enrichment/firmographic fields (those live in the sidebar) and NOT
    // signals (the Signals tab). Filter the raw claims down to real intel.
    const intelHidden = (prop: string) => {
      const p = (prop || "").toLowerCase();
      return p.startsWith("signal.") || p.startsWith("apollo") || p.startsWith("hubspot")
        || p.startsWith("salesforce") || p.startsWith("enrichment") || p.startsWith("enriched")
        || p.endsWith("_id") || p.endsWith("_raw")
        || ["domain","name","industry","employee_count","employees","company_size","size_band",
            "country","city","state","location","revenue","revenue_range","annual_revenue",
            "founded_year","website","linkedin","linkedin_url","logo","photo_url","tech_stack",
            "technologies","last_activity_at"].includes(p);
    };
    const intelFacts = (cd?.facts ?? []).filter(f => !intelHidden(f.property));
    const CO_TABS: { id: CoTab; label: string; count?: number }[] = [
      { id:"overview",  label:"Overview"                          },
      { id:"activity",  label:"Activity",  count:cd?.activity.length ?? 0 },
      { id:"signals",   label:"Signals",   count:cd?.signals?.length ?? 0  },
      { id:"notes",     label:"Notes",     count:cd?.notes?.length ?? 0    },
      { id:"facts",     label:"Intel",     count:intelFacts.length        },
    ];
    // who-relates-to-whom, keyed by the person the edge starts from
    const relsBySubject: Record<string, GraphEdge[]> = {};
    for (const e of cd?.edges ?? []) (relsBySubject[e.subject_id] ??= []).push(e);
    return (
      <div className="flex flex-col h-full bg-background">
        {/* Header — full width, so the sidebar starts below it (matches People) */}
        <div className="flex-shrink-0 px-8 pt-7 pb-0">
          <div className="flex items-center gap-3 mb-3">
                <button onClick={goBackFromDetail}
                  className="inline-flex items-center justify-center h-8 w-8 rounded-lg border border-border text-muted-foreground hover:bg-muted/50 hover:text-foreground transition-colors">
                  <ArrowLeft className="h-4 w-4" />
                </button>
                <h1 className="text-[20px] font-semibold tracking-tight text-foreground">{getCoVal("name",detail.name)??detail.name}</h1>
                {detail.domain && <span className="text-[13px] text-muted-foreground/70">{detail.domain}</span>}
              </div>
              <div className="flex gap-6 border-b border-border overflow-x-auto">
                {CO_TABS.map(t => (
                  <button key={t.id} onClick={() => setCoTab(t.id)}
                    className={`flex items-center gap-1.5 pb-2.5 text-[13px] font-medium transition-colors flex-shrink-0 ${
                      coTab===t.id ? "text-foreground border-b-2 border-foreground -mb-px" : "text-muted-foreground/70 hover:text-foreground/80"
                    }`}>
                    {t.label}
                    {t.count !== undefined && <span className={`text-[11px] ${coTab===t.id?"text-muted-foreground/70":"text-muted-foreground/50"}`}>{t.count}</span>}
                  </button>
                ))}
              </div>
            </div>
        {/* Row: scrollable content + sidebar, both starting below the header */}
        <div className="flex flex-1 min-h-0 overflow-hidden">
            <div className="flex-1 overflow-y-auto px-8 py-5">
              {coLoading ? (
                <div className="text-[13px] text-muted-foreground/70 text-center py-12">Loading…</div>
              ) : coTab === "overview" ? (
                <div className="space-y-6">
                  {/* Account signal strip — the headline read on the account */}
                  <div className="grid grid-cols-3 gap-3">
                    {[
                      { label:"ICP Fit", node:
                        cd?.icp?.score!=null
                          ? <span className="text-[18px] font-semibold tabular-nums" style={{color:icpColor(cd.icp.score)}}>{cd.icp.score}<span className="text-[12px] font-normal text-muted-foreground/70">/100</span></span>
                          : <span className="text-[18px] font-semibold text-muted-foreground/50">—</span> },
                      { label:"Contacts", node:
                        <span className="text-[18px] font-semibold tabular-nums text-foreground">{cd?.stakeholders.length ?? detail.contactCount}</span> },
                      { label:"Last Activity", node:
                        <span className="text-[13px] font-medium text-foreground/80">{detail.lastActivityAt?relTime(detail.lastActivityAt):"—"}</span> },
                    ].map(s => (
                      <div key={s.label} className="rounded-xl border border-border px-3.5 py-3">
                        <div className="text-[11px] font-medium text-muted-foreground/70 mb-1.5">{s.label}</div>
                        {s.node}
                      </div>
                    ))}
                  </div>
                  {cd?.icp?.score!=null && (
                    <div className="text-[12px] text-muted-foreground/80 -mt-3">
                      <span style={{color:icpColor(cd.icp.score)}}>{icpLabel(cd.icp.score)}</span>
                      {cd.icp.reason && <span className="text-muted-foreground/70"> · {cd.icp.reason}</span>}
                    </div>
                  )}

                  {/* Stakeholder map — every person at the account, ranked by deal
                      health, with how they relate to each other */}
                  <div>
                    <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/70 mb-3">
                      Stakeholders ({cd?.stakeholders.length ?? 0})
                    </div>
                    {(cd?.stakeholders.length ?? 0) === 0 ? (
                      <p className="text-[13px] text-muted-foreground/70 text-center py-12">No contacts yet</p>
                    ) : (
                      <div className="rounded-xl border border-border overflow-hidden">
                        {cd!.stakeholders.map(c => {
                          const rels = relsBySubject[c.id] ?? [];
                          return (
                            <div key={c.id} className="px-4 py-3 border-b border-border/60 last:border-0 hover:bg-muted/40 transition-colors cursor-pointer"
                              onClick={() => navigate(`/people/${c.id}`)}>
                              <div className="flex items-center gap-3">
                                <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{backgroundColor:healthColor(c.deal_health_score)}} />
                                <div className="flex-1 min-w-0">
                                  <div className="text-[13px] font-medium text-foreground truncate">{c.name}</div>
                                  {c.title && <div className="text-[12px] text-muted-foreground/70 truncate">{c.title}</div>}
                                </div>
                                {c.seniority && <span className="text-[11px] text-muted-foreground/60 flex-shrink-0 capitalize">{c.seniority.replace(/_/g," ")}</span>}
                                <span className="text-[12px] flex-shrink-0 w-20 text-right" style={{color:stageColor(c.pipeline_stage)}}>{c.pipeline_stage}</span>
                                {c.icp_score!=null
                                  ? <span className="text-[12px] tabular-nums flex-shrink-0 w-9 text-right" style={{color:icpColor(c.icp_score)}}>{c.icp_score}</span>
                                  : <span className="w-9 flex-shrink-0" />}
                                <span className="text-[12px] text-muted-foreground/60 flex-shrink-0 w-20 text-right tabular-nums">{c.signal_count} signals</span>
                                <span className="text-[12px] text-muted-foreground/70 flex-shrink-0 w-16 text-right">{c.last_activity_at?relTime(c.last_activity_at):"—"}</span>
                              </div>
                              {rels.length > 0 && (
                                <div className="mt-1.5 pl-[18px] flex flex-wrap gap-x-3 gap-y-0.5">
                                  {rels.map((e,i) => (
                                    <span key={i} className="text-[11px] text-muted-foreground/60">
                                      {e.relationship.replace(/_/g," ")} <span className="text-foreground/70">{e.object_label ?? "—"}</span>
                                    </span>
                                  ))}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </div>
              ) : coTab === "activity" ? (
                (cd?.activity.length ?? 0) === 0
                  ? <p className="text-[13px] text-muted-foreground/70 text-center py-12">No activity yet</p>
                  : <div className="divide-y divide-border/60">
                      {cd!.activity.slice(0,50).map((a:any, i:number) => {
                        const body = a.subtitle || a.raw_data?.text || a.raw_data?.body || null;
                        return (
                          <div key={a.id ?? i} className="py-3">
                            <div className="flex items-center gap-2.5 mb-1">
                              <ActivityIcon source={a.source} type={a.activity_type||""} />
                              <span className="text-[12px] text-muted-foreground flex-1 truncate">{a.activity_type?.replace(/_/g," ").toLowerCase()}</span>
                              <span className="text-[12px] text-muted-foreground/70 flex-shrink-0">{a.contactName}</span>
                              <span className="text-[12px] text-muted-foreground/70 tabular-nums flex-shrink-0">{relTime(a.created_at||a.occurred_at)}</span>
                            </div>
                            {body && <p className="text-[13px] text-foreground/80 leading-relaxed pl-[26px]">{body}</p>}
                          </div>
                        );
                      })}
                    </div>
              ) : coTab === "signals" ? (
                (cd?.signals?.length ?? 0) === 0
                  ? <p className="text-[13px] text-muted-foreground/70 text-center py-12">No signals yet — run signal-scan on this account</p>
                  : <div className="divide-y divide-border/60">
                      {cd!.signals.map((s: any) => {
                        const col = s.score == null ? "#6b7280" : s.score >= 8 ? "#15803d" : s.score >= 5 ? "#b45309" : "#6b7280";
                        return (
                          <div key={s.signal_class} className="py-3">
                            <div className="flex items-baseline gap-2 mb-1">
                              <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/70 capitalize">{s.signal_class}</span>
                              {s.score != null && <span className="text-[12px] font-semibold tabular-nums" style={{ color: col }}>{s.score}/10</span>}
                              {s.updated_at && <span className="text-[12px] text-muted-foreground/70 ml-auto">{relTime(s.updated_at)}</span>}
                            </div>
                            <p className="text-[13px] text-foreground/80 leading-relaxed">{s.detected}{s.implies ? ` — ${s.implies}` : ""}</p>
                            {s.angle && <p className="text-[12px] text-muted-foreground italic mt-1">Angle: {s.angle}</p>}
                          </div>
                        );
                      })}
                    </div>
              ) : coTab === "notes" ? (
                (cd?.notes?.length ?? 0) === 0
                  ? <p className="text-[13px] text-muted-foreground/70 text-center py-12">No notes yet — run signal-scan to save a signal brief on this account</p>
                  : <div className="divide-y divide-border/60">
                      {cd!.notes.map((m: any) => {
                        const when = m.metadata?.date || m.created_at;
                        return (
                          <div key={m.id} onClick={() => window.open(`/note/${m.id}`, "_blank")}
                            title="Open note in a new tab"
                            className="py-3 flex items-center gap-2.5 cursor-pointer hover:bg-muted/30 -mx-2 px-2 rounded-md transition-colors">
                            <FileText className="h-4 w-4 text-muted-foreground/70 flex-shrink-0" />
                            <div className="flex-1 min-w-0">
                              <div className="flex items-baseline gap-2">
                                <span className="text-[13px] font-medium text-foreground/85 truncate">{m.metadata?.title || m.category || "Note"}</span>
                                <span className="text-[12px] text-muted-foreground/70 ml-auto flex-shrink-0">{relTime(when)}</span>
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
              ) : (
                intelFacts.length === 0
                  ? <p className="text-[13px] text-muted-foreground/70 text-center py-12">No intel yet</p>
                  : <div className="divide-y divide-border/60">
                      {intelFacts.map((f, i) => (
                        <div key={f.property ?? i} className="py-3">
                          <div className="flex items-baseline gap-2 mb-1">
                            <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/70">{prettyProp(f.property)}</span>
                            <span className="inline-flex items-center gap-1 ml-auto flex-shrink-0">
                              <span className="w-1.5 h-1.5 rounded-full" style={{backgroundColor:freshColor(f.freshness)}} />
                              <span className="text-[11px] text-muted-foreground/60 capitalize">{f.freshness}</span>
                            </span>
                          </div>
                          <p className="text-[13px] text-foreground/90 leading-relaxed">{claimValue(f.value)}</p>
                          <div className="mt-1 flex flex-wrap items-center gap-x-3 text-[11px] text-muted-foreground/55">
                            <span>{Math.round((f.confidence ?? 0)*100)}% confidence</span>
                            <span className="capitalize">{f.epistemic_class}</span>
                            {f.observation_count > 0 && <span>seen {f.observation_count}×</span>}
                            {f.last_observed_at && <span>last {relTime(f.last_observed_at)}</span>}
                          </div>
                        </div>
                      ))}
                    </div>
              )}
            </div>
            {/* Right sidebar — editable */}
            <div className="w-64 flex-shrink-0 border-l border-border px-5 py-5 overflow-y-auto">
            <div className="flex items-center justify-between mb-4">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/70">Record Details</span>
              {coSaving && <span className="text-[11px] text-muted-foreground/70">saving…</span>}
            </div>
            {/* ICP score — read-only, computed by the Scorecard (matches People) */}
            {(() => {
              const sc = cd?.icp?.score ?? null;
              return (
                <div className="mb-4 pb-3.5 border-b border-border/60">
                  <div className="text-[11px] font-medium text-muted-foreground/70 mb-1">ICP Score</div>
                  {sc == null ? (
                    <div className="text-[13px] text-muted-foreground/50 italic">Not scored yet</div>
                  ) : (
                    <div className="flex items-baseline gap-2">
                      <span className="text-[22px] font-semibold tabular-nums leading-none" style={{ color: icpColor(sc) }}>{sc}</span>
                      <span className="text-[12px] text-muted-foreground/70">/ 100 · {icpLabel(sc)}</span>
                    </div>
                  )}
                </div>
              );
            })()}
            <div className="space-y-3.5">
              {([
                { label:"Name",          key:"name",           val: getCoVal("name", detail.name) },
                { label:"Domain",        key:"domain",         val: getCoVal("domain", detail.domain) },
                { label:"Industry",      key:"industry",       val: getCoVal("industry", detail.industry) },
                { label:"Employees",     key:"employee_count", val: getCoVal("employee_count", detail.employeeCount!=null?String(detail.employeeCount):null), type:"number" },
                { label:"Location",      key:"location",       val: getCoVal("location", detail.location) },
                { label:"Revenue Range", key:"revenue_range",  val: getCoVal("revenue_range", detail.revenueRange) },
                { label:"Tech Stack",    key:"_ro_tech",       val: cd?.company?.tech_stack ? claimValue(cd.company.tech_stack) : null },
                { label:"Contacts",      key:"_ro_contacts",   val: String(cd?.stakeholders.length ?? detail.contactCount) },
                { label:"Last Activity", key:"_ro_last",       val: detail.lastActivityAt?relTime(detail.lastActivityAt):null },
              ] as { label:string; key:string; val:string|null; type?:string }[]).map(({ label, key, val, type }) => {
                const isReadOnly = key.startsWith("_ro_");
                const isEditing = coEditField===key;
                return (
                  <div key={key}>
                    <div className="text-[11px] font-medium text-muted-foreground/70 mb-1">{label}</div>
                    {isReadOnly ? (
                      <div className={`text-[13px] leading-snug break-words ${val?"text-foreground/80":"text-muted-foreground/50 italic"}`}>{val??"—"}</div>
                    ) : isEditing ? (
                      <input type={type==="number"?"number":"text"} value={coEditValue} autoFocus
                        onChange={e=>setCoEditValue(e.target.value)}
                        onBlur={()=>patchCompany(key,coEditValue)}
                        onKeyDown={e=>{if(e.key==="Enter")patchCompany(key,coEditValue);if(e.key==="Escape")setCoEditField(null);}}
                        className="w-full rounded-md border border-border bg-background text-[13px] text-foreground px-2 py-1 outline-none focus:border-foreground/40"/>
                    ) : (
                      <div onClick={()=>{setCoEditField(key);setCoEditValue(val??"");}}
                        className={`text-[13px] leading-snug break-words cursor-pointer rounded-md px-1.5 -mx-1.5 py-1 transition-colors hover:bg-muted/50 ${val?"text-foreground/80":"text-muted-foreground/50 italic"}`}>
                        {val??"—"}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col bg-background">
      <div className="px-8 pt-7 flex-shrink-0">
        <PageHeader
          title={embedded ? "Accounts" : "Companies"}
          actions={
            <button onClick={handleExport}
              className="inline-flex items-center gap-1.5 h-9 px-3.5 rounded-lg bg-background border border-border text-foreground/80 text-[13px] font-semibold hover:bg-muted/50 transition-colors">
              <Download className="h-3.5 w-3.5" /> Export
            </button>
          }
        />

        {/* Toolbar */}
        <div className="flex items-center justify-between gap-3 mb-4">
          <div className="flex items-center gap-2 flex-1 min-w-0">
            {leadingTab}
            <div className="relative w-full max-w-xs">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground/70 pointer-events-none" />
              <input value={q} onChange={e=>{setQ(e.target.value);setPage(0);}} placeholder="Search companies…" autoFocus
                className="h-9 w-full rounded-lg border border-border bg-background pl-9 pr-3 text-[13px] text-foreground placeholder:text-muted-foreground/70 focus:border-foreground/40 outline-none" />
            </div>
          </div>
          <span className="text-[12px] text-muted-foreground/70 flex-shrink-0 tabular-nums">{filtered.length} of {companies.length}</span>
        </div>
      </div>

      {/* Table — full-bleed, fills to the right and bottom (left padding kept) */}
      <div className="flex-1 min-h-0 pl-8 flex flex-col">
        <div className="flex-1 min-h-0 border-t border-l border-border overflow-auto">
          <div style={{ minWidth: ROW_MIN }}>
          {/* Table header — sticky top; Company frozen left */}
          <div className="flex items-center px-4 py-2.5 bg-muted/50 border-b border-border sticky top-0 z-20">
            <SortHdr col="name"         label="Company" sticky />
            <SortHdr col="stage"        label="Stage"     firstDir="desc" />
            <PlainHdr label="Top Contacts" widthKey="topContacts" />
            <SortHdr col="icp"          label="ICP"       firstDir="desc" />
            <PlainHdr label="Intent" widthKey="intent" />
            <SortHdr col="industry"     label="Industry" />
            <SortHdr col="location"     label="Location" />
            <SortHdr col="lastActivity" label="Last Interaction" firstDir="desc" />
            <SortHdr col="contacts"     label="Contacts"  firstDir="desc" />
            {/* Trailing filler — grows only on wide screens, shrinks to 0 (then the
                grid scrolls) so it never steals width from a column being resized. */}
            <div className="flex-1 min-w-0" />
            <span className="flex-shrink-0" style={{width:28}} />
          </div>
          {/* Rows */}
          {loading && companies.length === 0 && <div className="text-[13px] text-muted-foreground/70 text-center py-12">Loading…</div>}
          {pageRows.map(co => {
            const topContacts = co.contacts.slice(0,3).map(c=>c.name.split(" ")[0]).join(", ");
            const open = expanded.has(co.id);
            return (
            <React.Fragment key={co.id}>
            <div className="flex items-center px-4 py-3 border-b border-border/60 hover:bg-muted/50 transition-colors group">
              <div className="flex items-center flex-shrink-0 min-w-0 pr-3 sticky left-0 z-10 bg-background group-hover:bg-muted/50" style={{width:colW("name")}}>
                {/* The chevron is its own hit target: expanding an account and OPENING it
                    are different intents, and conflating them means you can never look at
                    the people without losing the row you were on. */}
                <button
                  onClick={(e) => { e.stopPropagation(); toggleRow(co.id); }}
                  disabled={!co.contactCount}
                  title={co.contactCount ? (open ? "Collapse" : `Show ${co.contactCount} ${co.contactCount === 1 ? "person" : "people"}`) : "No people yet"}
                  className="flex-shrink-0 p-0.5 mr-1 -ml-1 rounded text-muted-foreground/40 hover:text-foreground hover:bg-accent disabled:opacity-0 transition-colors"
                >
                  <ChevronRight className={`h-3.5 w-3.5 transition-transform duration-150 ${open ? "rotate-90" : ""}`} strokeWidth={2} />
                </button>
                <button onClick={() => setDetail(co)} className="text-left min-w-0 flex-1">
                  <div className="text-[13px] font-medium text-foreground truncate">{co.name}</div>
                  {co.domain && <div className="text-[12px] text-muted-foreground/70 truncate">{co.domain}</div>}
                </button>
              </div>
              <span className="text-[13px] flex-shrink-0 truncate pr-2" style={{width:colW("stage"),color:co.stage?stageColor(co.stage):""}}>{co.stage??"—"}</span>
              <button onClick={()=>setDetail(co)} className="text-[13px] text-muted-foreground flex-shrink-0 truncate pr-2 text-left" style={{width:colW("topContacts")}}>{topContacts||"—"}</button>
              <span className="text-[13px] flex-shrink-0 tabular-nums" style={{width:colW("icp"),color:co.icpScore!=null?icpColor(co.icpScore):""}}>
                {co.icpScore!=null?co.icpScore:"—"}
              </span>
              <span className="flex-shrink-0" style={{width:colW("intent")}}>
                {co.intentBand && co.intentBand !== "Dormant"
                  ? <span className={`text-[11px] font-medium px-1.5 py-0.5 rounded ${INTENT_TAG[co.intentBand] ?? INTENT_TAG.Dormant}`}>{co.intentBand}</span>
                  : <span className="text-muted-foreground/50 text-[12px]">—</span>}
              </span>
              <span className="text-[13px] text-muted-foreground flex-shrink-0 truncate pr-2" style={{width:colW("industry")}}>{co.industry??"—"}</span>
              <span className="text-[13px] text-muted-foreground flex-shrink-0 truncate pr-2" style={{width:colW("location")}}>{co.location??"—"}</span>
              <span className="text-[13px] text-muted-foreground flex-shrink-0 pr-2 truncate" style={{width:colW("lastActivity")}}>{relTime(co.lastActivityAt)}</span>
              <span className="text-[13px] text-foreground/80 flex-shrink-0 tabular-nums" style={{width:colW("contacts")}}>{co.contactCount}</span>
              <div className="flex-1 min-w-0" />
              <button onClick={e=>deleteCompany(co.id,e)}
                className="opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0 flex justify-end text-muted-foreground/50 hover:text-red-500" style={{width:28}}>
                <Trash2 className="h-3.5 w-3.5"/>
              </button>
            </div>

            {/* The people inside the account. Indented under it, because that is the
                relationship: they work here. Clicking one opens the person, not the
                company. */}
            {open && co.contacts.map(pn => (
              <div key={pn.id}
                   className="flex items-center px-4 py-2 border-b border-border/60 bg-muted/20 hover:bg-muted/50 transition-colors group/p">
                <button
                  onClick={() => navigate(`/people/${pn.id}`)}
                  className="flex-shrink-0 text-left min-w-0 pr-3 pl-6 sticky left-0 z-10 bg-muted/20 group-hover/p:bg-muted/50"
                  style={{width:colW("name")}}
                >
                  <div className="text-[13px] text-foreground/85 truncate">{pn.name}</div>
                  {pn.title && <div className="text-[12px] text-muted-foreground/60 truncate">{pn.title}</div>}
                </button>
                <span className="text-[13px] flex-shrink-0 truncate pr-2" style={{width:colW("stage"),color:pn.pipelineStage?stageColor(pn.pipelineStage):""}}>{pn.pipelineStage??"—"}</span>
                <span className="text-[12px] text-muted-foreground/50 flex-shrink-0 truncate pr-2" style={{width:colW("topContacts")}}>{pn.email ?? "—"}</span>
                <span className="text-[13px] flex-shrink-0 tabular-nums" style={{width:colW("icp"),color:pn.icpScore!=null?icpColor(pn.icpScore):""}}>
                  {pn.icpScore!=null?pn.icpScore:"—"}
                </span>
                <span className="flex-shrink-0" style={{width:colW("intent")}} />
                <span className="flex-shrink-0" style={{width:colW("industry")}} />
                <span className="flex-shrink-0" style={{width:colW("location")}} />
                <span className="text-[13px] text-muted-foreground/70 flex-shrink-0 pr-2 truncate" style={{width:colW("lastActivity")}}>{relTime(pn.lastActivityAt)}</span>
                <span className="flex-shrink-0" style={{width:colW("contacts")}} />
                <div className="flex-1 min-w-0" />
                <span className="flex-shrink-0" style={{width:28}} />
              </div>
            ))}
            </React.Fragment>
            );
          })}
          {!loading && pageRows.length===0 && <div className="text-[13px] text-muted-foreground/70 text-center py-12">No results</div>}
          </div>
          </div>
        </div>

        {/* Pagination footer — always shown, matching the People page so the
            50-per-page cap and the next control read identically everywhere
            (including the embedded Accounts view). */}
        <div className="flex items-center justify-between px-8 py-2.5 border-t border-border flex-shrink-0">
          <span className="text-[12px] text-muted-foreground/70 tabular-nums">page {page+1} of {Math.max(1,totalPages)} · {sortedList.length} companies</span>
          <div className="flex items-center gap-2">
            <button onClick={()=>setPage(p=>Math.max(0,p-1))} disabled={page===0}
              className="inline-flex items-center gap-1.5 h-9 px-3.5 rounded-lg bg-background border border-border text-foreground/80 text-[13px] font-semibold hover:bg-muted/50 transition-colors disabled:opacity-30">Prev</button>
            <button onClick={()=>setPage(p=>Math.min(totalPages-1,p+1))} disabled={page>=totalPages-1}
              className="inline-flex items-center gap-1.5 h-9 px-3.5 rounded-lg bg-background border border-border text-foreground/80 text-[13px] font-semibold hover:bg-muted/50 transition-colors disabled:opacity-30">Next</button>
          </div>
        </div>
    </div>
  );
}
