import { trackProductEvent } from "@/lib/posthog";
import React, { useState, useEffect, useMemo, useCallback, Suspense } from "react";
import { useParams, useNavigate, useLocation } from "react-router-dom";
import { ArrowLeft, Trash2, Search, Download, FileText, ChevronRight, UserCheck } from "lucide-react";
import { toast } from "@/components/ui/sonner";
import { useAuth } from "@/contexts/AuthContext";
import { relTime } from "@/components/mind/shared";
import { Company, healthColor, stageColor, ActivityIcon, mapContact, buildCompanies } from "@/components/mind/entities";
// Stages come from the one funnel definition — rank and label, never a local list.
import { stageLabel, stageRank } from "@/config/pipeline";
import { useColumnWidths, ColResizer } from "@/components/mind/resizableColumns";
import { PageHeader } from "@/components/ui/page-header";
import { useTabs } from "@/contexts/TabsContext";
import { useQueryClient, useInfiniteQuery } from "@tanstack/react-query";
import { useApiTopBar } from "@/components/shell/apiTopBarContext";
import { preloadable } from "@/lib/preloadable";
import { faviconUrl } from "@/lib/externalImages";

// The account record: every plan on Cloud renders it, the API plan included (GET-784), and so does
// self-host (GET-947). Lazy, so the accounts list doesn't carry it.
const CompanyDetailView = preloadable(() => import("@/components/CompanyDetailView"));

const apiUrl = import.meta.env.VITE_API_URL ?? "";
// How many accounts one "Load more" brings in. The API caps a read at 500; 200 keeps the first
// paint quick on a 9,000-account workspace.
const ACCOUNT_LOAD_SIZE = 200;

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
  // Client axis (won accounts, out of the buying funnel)
  Expansion:  "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-400",
  Active:     "bg-green-100 text-green-700 dark:bg-green-950/50 dark:text-green-400",
  "At-risk":  "bg-rose-100 text-rose-700 dark:bg-rose-950/50 dark:text-rose-400",
};

type CoTab = "overview" | "activity" | "facts" | "signals" | "notes";
type CoSort = { col: string | null; dir: "asc"|"desc" };

type Stakeholder = {
  id: string; name: string; title: string|null; seniority: string|null;
  department: string|null; pipeline_stage: string; deal_health_score: number|null;
  deal_value: number|null; photo_url: string|null;
  icp_score: number|null; last_activity_at: string|null; signal_count: number;
  sentiment?: "supporter"|"detractor"|"neutral"|null;
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
  const { openTab } = useTabs();
  // Fetch the record's chunk while its data loads, so it renders without a loading frame.
  // A failed fetch is logged; the record renders its own "failed to load" in place.
  useEffect(() => {
    CompanyDetailView.preload().catch(() => { /* reported where the record renders */ });
  }, []);
  // Back from a company detail: if we got here by navigating (e.g. clicked the
  // company link on a person record inside a lead list), go BACK to that origin
  // so the lead-list / person context is preserved. Only fall back to the
  // accounts companies list when there's no history to return to (direct load).
  const goBackFromDetail = () => {
    if (location.key !== "default") navigate(-1);
    else { setDetail(null); setCoTab("overview"); }
  };

  // The market this list is showing. null until the first page answers, then the workspace's own
  // focus (a workspace can open on its home market) unless the user picks another country or "all" (GET-310).
  const [country, setCountry] = useState<string | null | undefined>(undefined);

  // Accounts arrive a page at a time, newest activity first, with "Load more" — the list used to
  // fetch one page of 200 and slice it into client-side pages, so an account outside the first 200
  // could not be reached at all. The second fetch here pulled 2,000 contacts that buildCompanies
  // discards whenever the list carries its own roll-ups, which it now always does.
  const accountsQuery = useInfiniteQuery({
    queryKey: ["companies-list", workspaceId, country ?? "__default__"],
    initialPageParam: 0,
    queryFn: async ({ pageParam }) => {
      const params = new URLSearchParams({ workspaceId, limit: String(ACCOUNT_LOAD_SIZE), offset: String(pageParam) });
      if (country !== undefined) params.set("country", country ?? "all");
      const res = await fetch(`${apiUrl}/api/companies/list?${params}`, { headers: { Authorization: `Bearer ${token}` } });
      const d = res.ok ? await res.json() : {};
      return {
        rows: buildCompanies(d.companies ?? [], []),
        total: typeof d.total === "number" ? d.total : null,
        country: (d.country ?? null) as string | null,
        focusCountry: (d.focus_country ?? null) as string | null,
        countries: (d.countries ?? []) as { country: string; accounts: number }[],
      };
    },
    getNextPageParam: (last, pages) => {
      const loaded = pages.reduce((n, p) => n + p.rows.length, 0);
      if (last.total != null) return loaded < last.total ? loaded : undefined;
      return last.rows.length === ACCOUNT_LOAD_SIZE ? loaded : undefined;
    },
    enabled: !!token && !!workspaceId,
  });
  const companies = useMemo(() => accountsQuery.data?.pages.flatMap(p => p.rows) ?? [], [accountsQuery.data]);
  const loading = accountsQuery.isPending;
  const load = accountsQuery.refetch;
  const meta = accountsQuery.data?.pages[0];
  const totalAccounts = meta?.total ?? null;
  // What the server actually applied, so the control shows the truth even before the user touches it.
  const appliedCountry = meta?.country ?? null;
  const countryOptions = meta?.countries ?? [];

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
  const setDetail = (c: Company | null) => navigate(c ? `/accounts/${c.id}` : "/accounts");
  const [coTab, setCoTab] = useState<CoTab>("overview");
  const [cd, setCd] = useState<CompanyDetail | null>(null);
  const [coLoading, setCoLoading] = useState(false);
  const [cdError, setCdError] = useState<string | null>(null);
  const [coEditField, setCoEditField] = useState<string | null>(null);
  const [coEditValue, setCoEditValue] = useState("");
  const [coSaving, setCoSaving] = useState(false);
  const [coLocalOverrides, setCoLocalOverrides] = useState<Record<string, string | null>>({});
  const queryClient = useQueryClient();
  const [coSort, setCoSort] = useState<CoSort>({ col:"lastActivity", dir:"desc" });
  const [page, setPage] = useState(0);
  const { widths, startResize } = useColumnWidths("nous.companies.colWidths.v2", CO_COL_DEFAULTS);
  const colW = (c: string) => widths[c] ?? CO_COL_DEFAULTS[c];
  // Total content width (columns + 28px delete col + px-4 row padding) so the
  // table scrolls horizontally instead of squeezing columns to a fixed width.
  const CO_COL_KEYS = ["name","stage","topContacts","icp","intent","industry","location","lastActivity","contacts"];
  const ROW_MIN = CO_COL_KEYS.reduce((s,k)=>s+colW(k),0) + 28 + 32;

  // Name the workspace tab after the company, not a generic "Company" — openTab
  // refreshes the title of the tab the router already opened for this path.
  const tabName = cd?.company?.name || detail?.name || null;
  useEffect(() => {
    if (id && tabName) openTab(location.pathname, tabName);
  }, [id, tabName, location.pathname, openTab]);

  // Drop the row from every loaded page, then let the delete land.
  const dropLoadedAccount = (cid: string) =>
    queryClient.setQueriesData<{ pages: { rows: Company[] }[] } | undefined>(
      { queryKey: ["companies-list", workspaceId] },
      (prev: any) => prev ? { ...prev, pages: prev.pages.map((pg: any) => ({ ...pg, rows: pg.rows.filter((c: Company) => c.id !== cid) })) } : prev);

  const deleteCompany = async (cid: string, e: React.MouseEvent) => {
    e.stopPropagation();
    dropLoadedAccount(cid);
    fetch(`${apiUrl}/api/companies/${cid}?workspaceId=${workspaceId}`, {
      method: 'DELETE', headers: { Authorization: `Bearer ${token}` },
    }).catch(() => {});
  };

  const markClient = async (cid: string, name: string, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      const res = await fetch(`${apiUrl}/api/companies/${cid}/mark-client`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) toast.success(`${name || "Company"} marked as client — everyone at it converted`);
      else toast.error("Could not mark as client");
    } catch { toast.error("Could not mark as client"); }
  };

  // Keyed on token PRESENCE, not value: the JWT rotates every ~60s and this effect
  // clears the detail (`setCd(null); setCoLoading(true)`), so keying on the value made
  // the company detail blank to a spinner every minute. It re-runs on id/workspace
  // change (reading the current fresh token from closure) but never on a bare rotation.
  const hasToken = !!token;
  useEffect(() => {
    if (!id || !hasToken) return;
    trackProductEvent('account_record_opened', { workspace_id: workspaceId ?? null });
    setCd(null); setCoLoading(true); setCoLocalOverrides({}); setCdError(null);
    // A failed detail used to leave the page on "Loading…" forever: the fetch swallowed the status,
    // set cd to null, and the render has no branch for "we tried and it did not work". On an
    // account whose detail takes the API past its statement budget that is indistinguishable from
    // a slow network, and the only way to find out was to read server logs.
    fetch(`${apiUrl}/api/companies/${id}/detail?workspaceId=${workspaceId}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(async r => {
        if (!r.ok) throw new Error(r.status === 504 || r.status === 408 ? 'This account took too long to load.' : `The server returned ${r.status}.`);
        return r.json();
      })
      .then(d => setCd(d))
      .catch(e => { setCd(null); setCdError(e?.message || 'Could not load this account.'); })
      .finally(() => setCoLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, workspaceId, hasToken]);

  // Re-pull the account detail in place (no spinner blank) after an in-view edit like
  // adding a stakeholder to the org chart.
  const refreshDetail = async () => {
    if (!id || !token) return;
    try {
      setCdError(null);
      const r = await fetch(`${apiUrl}/api/companies/${id}/detail?workspaceId=${workspaceId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (r.ok) setCd(await r.json());
      else setCdError(`The server returned ${r.status}.`);
    } catch { setCdError('Could not load this account.'); }
  };

  // The API plan's top bar (GET-621): Accounts / <this account>, refreshed in place.
  const barName: string | null = id ? ((cd as { company?: { name?: string } } | null)?.company?.name ?? (location.state as { accountName?: string } | null)?.accountName ?? detail?.name ?? null) : null;
  useApiTopBar({ title: barName, onRefresh: id ? refreshDetail : undefined, enabled: !embedded && !!id });

  const patchCompany = async (key: string, value: string) => {
    const coId = id ?? detail?.id;
    if (!coId) return;
    setCoSaving(true);
    try {
      const r = await fetch(`${apiUrl}/api/companies/${coId}`, {
        method: "PATCH",
        headers: { "Content-Type":"application/json", Authorization:`Bearer ${token}` },
        body: JSON.stringify({ [key]: value || null }),
      });
      // A failed save used to show the new value anyway, then lose it on reload.
      if (!r.ok) {
        const body = await r.json().catch(() => null);
        toast.error(body?.message || "Couldn't save that change");
        return;
      }
      setCoLocalOverrides(prev => ({ ...prev, [key]: value || null }));
      // The account stage is written to its people (GET-263): re-read them so the stage, the
      // board and the deal card all show what the people now say.
      if (key === "pipeline_stage") {
        await refreshDetail();
        setCoLocalOverrides(prev => { const next = { ...prev }; delete next.pipeline_stage; return next; });
        queryClient.invalidateQueries({ queryKey: ["contacts", workspaceId] });
        queryClient.invalidateQueries({ queryKey: ["account-deals", workspaceId, coId] });
      }
      // Firmographics (esp. domain → logo) show on the board too — refresh its caches.
      queryClient.invalidateQueries({ queryKey: ["companies-list", workspaceId] });
    } catch { /* silent */ }
    finally { setCoSaving(false); setCoEditField(null); }
  };

  const getCoVal = (key: string, fallback: string|null|undefined) =>
    key in coLocalOverrides ? coLocalOverrides[key] : (fallback ?? null);

  // The deal value is a CONTACT-level field (the board takes the largest across a
  // company's people). Editing it on the company record writes to the primary
  // stakeholder — the highest deal-health contact, which the detail lists first — then
  // invalidates the board's caches so the new amount shows there too.
  const setDealValue = async (value: number | null) => {
    const primary = cd?.stakeholders?.[0];
    if (!primary) return;
    setCoSaving(true);
    try {
      await fetch(`${apiUrl}/api/contacts/${primary.id}`, {
        method: "PATCH",
        headers: { "Content-Type":"application/json", Authorization:`Bearer ${token}` },
        body: JSON.stringify({ dealValue: value }),
      });
      // Optimistic: reflect it on the primary stakeholder right away.
      setCd(prev => prev ? {
        ...prev,
        stakeholders: prev.stakeholders.map((s, i) => i === 0 ? { ...s, deal_value: value } : s),
      } : prev);
      queryClient.invalidateQueries({ queryKey: ["contacts", workspaceId] });
      queryClient.invalidateQueries({ queryKey: ["companies-list", workspaceId] });
    } catch { /* silent */ }
    finally { setCoSaving(false); }
  };

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
  // Rank via the shared stageRank, which resolves legacy names first. Looking the
  // stage up in a list of current names would score every un-migrated row -1 and
  // dump it at the bottom of the sort. No stage at all still sorts below everything.
  const rankOf = (s: string|null) => (s ? stageRank(s) : -1);
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
    else if (coSort.col==="stage")      { av=rankOf(a.stage); bv=rankOf(b.stage); }
    else                                 { av=0; bv=0; }
    if (av<bv) return coSort.dir==="asc"?-1:1;
    if (av>bv) return coSort.dir==="asc"?1:-1;
    return 0;
  });
  const pageRows = sortedList;

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
      co.stage?stageLabel(co.stage):"", co.icpScore!=null?String(co.icpScore):""
    ]);
    const csv = [headers,...rows].map(r=>r.map(v=>`"${String(v).replace(/"/g,'""')}"`).join(",")).join("\n");
    const url = URL.createObjectURL(new Blob([csv],{type:"text/csv"}));
    const a = document.createElement("a"); a.href=url; a.download="companies.csv"; a.click();
    URL.revokeObjectURL(url);
  };

  // Detail mode is keyed off the route id — show the record or a brief loader,
  // never the list, so the table doesn't flash before the detail appears.
  if (id) {
    if (!cd) {
      const instantName = (location.state as any)?.accountName ?? detail?.name ?? "Account";
      const instantDomain = detail?.domain ?? null;
      return (
        <div className="flex h-full flex-col bg-background lg:flex-row">
          <div className="flex-shrink-0 border-b border-hairline px-5 py-5 lg:w-[320px] lg:border-b-0 lg:border-r">
            <div className="flex items-center gap-3">
              {faviconUrl(instantDomain)
                ? <img src={faviconUrl(instantDomain)!} alt="" className="h-9 w-9 rounded-md object-contain bg-white border border-border" />
                : <div className="h-9 w-9 rounded-md bg-muted flex items-center justify-center text-[15px] font-semibold text-muted-foreground">{instantName.charAt(0).toUpperCase()}</div>}
              <h1 className="text-[18px] font-semibold tracking-[-0.015em] text-foreground truncate">{instantName}</h1>
            </div>
          </div>
          <div className="flex-1 flex flex-col items-center justify-center gap-3 px-6 text-center">
            {cdError ? (
              <>
                <p className="text-[13px] text-foreground/80">{cdError}</p>
                <p className="text-[12px] text-muted-foreground/70">The account is still here — this was the page failing to load it.</p>
                <div className="flex items-center gap-2">
                  <button onClick={refreshDetail}
                    className="h-9 px-3.5 rounded-lg border border-border bg-background text-[13px] font-semibold text-foreground/80 hover:bg-muted/50 transition-colors">
                    Try again
                  </button>
                  <button onClick={() => navigate('/accounts')}
                    className="h-9 px-3.5 rounded-lg text-[13px] font-semibold text-muted-foreground/80 hover:text-foreground transition-colors">
                    Back to accounts
                  </button>
                </div>
              </>
            ) : (
              <span className="text-[13px] text-muted-foreground/50">Loading…</span>
            )}
          </div>
        </div>
      );
    }
    return (
      <Suspense fallback={null}>
      <CompanyDetailView
        cd={cd as any}
        onOpenPerson={(pid) => navigate(`/people/${pid}`)}
        onPatch={patchCompany}
        onSetDealValue={setDealValue}
        getVal={getCoVal}
        saving={coSaving}
        onRefresh={refreshDetail}
      />
      </Suspense>
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
          {/* Market focus: a default, never a restriction. The count always names the market it
              counted, so "200 of 1,500 in Northland" can't be mistaken for the whole workspace. */}
          {countryOptions.length > 1 && (
            <select
              value={appliedCountry ?? "all"}
              onChange={e => { const v = e.target.value; setCountry(v === "all" ? null : v); setPage(0); }}
              className="h-9 rounded-lg border border-border bg-background px-2.5 text-[13px] text-foreground/80 flex-shrink-0 outline-none hover:bg-muted/50"
              title="Which market this list shows"
            >
              <option value="all">All countries</option>
              {countryOptions.map(c => (
                <option key={c.country} value={c.country}>{c.country} ({c.accounts.toLocaleString()})</option>
              ))}
            </select>
          )}
          <span className="text-[12px] text-muted-foreground/70 flex-shrink-0 tabular-nums">
            {filtered.length} of {(totalAccounts ?? companies.length).toLocaleString()}{appliedCountry ? ` in ${appliedCountry}` : ""}
          </span>
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
              <span className="text-[13px] flex-shrink-0 truncate pr-2" style={{width:colW("stage"),color:co.stage?stageColor(co.stage):""}}>{stageLabel(co.stage)}</span>
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
              <button onClick={e=>markClient(co.id, co.name, e)} title="Mark as client — everyone at the company converts"
                className="opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0 flex justify-end text-muted-foreground/50 hover:text-green-600" style={{width:28}}>
                <UserCheck className="h-3.5 w-3.5"/>
              </button>
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
                <span className="text-[13px] flex-shrink-0 truncate pr-2" style={{width:colW("stage"),color:pn.pipelineStage?stageColor(pn.pipelineStage):""}}>{stageLabel(pn.pipelineStage)}</span>
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

        {/* Footer — how much of the list is loaded, and a way to load the rest. One list, newest
            activity first: pages were client-side slices of a single fetch, so anything past the
            first 200 accounts could not be reached. */}
        <div className="flex items-center justify-between px-8 py-2.5 border-t border-border flex-shrink-0">
          <span className="text-[12px] text-muted-foreground/70 tabular-nums">
            {totalAccounts != null
              ? <>Showing <span className="font-semibold text-foreground/80">{companies.length.toLocaleString()}</span> of {totalAccounts.toLocaleString()} accounts{appliedCountry ? ` in ${appliedCountry}` : ""}</>
              : <>{companies.length.toLocaleString()} accounts</>}
          </span>
          {accountsQuery.hasNextPage && (
            <button onClick={() => accountsQuery.fetchNextPage()} disabled={accountsQuery.isFetchingNextPage}
              className="inline-flex items-center gap-1.5 h-9 px-3.5 rounded-lg bg-background border border-border text-foreground/80 text-[13px] font-semibold hover:bg-muted/50 transition-colors disabled:opacity-50">
              {accountsQuery.isFetchingNextPage ? "Loading…" : `Load ${Math.min(ACCOUNT_LOAD_SIZE, Math.max(0, (totalAccounts ?? Infinity) - companies.length)).toLocaleString()} more`}
            </button>
          )}
        </div>
    </div>
  );
}
