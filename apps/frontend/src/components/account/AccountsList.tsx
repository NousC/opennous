import { useState, useMemo, useRef, useEffect } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Search, X, MoreHorizontal, Check, MapPin, Network } from "lucide-react";
import { FilterMenu } from "@/components/ui/filter-menu";
import { PageToolbar } from "@/components/ui/page-top-bar";
import { ViewTabs } from "@/components/ui/view-tabs";
import { OwnerFilter, UNASSIGNED, avatarTint, initialsOf, type Person } from "@/components/ui/owner-filter";
import { DataTable, type Column } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { Button } from "@/components/ui/button";
import { AccountTile, OwnerAvatar } from "@/components/pipeline/DealBits";
import { RecordPreview } from "@/components/record/RecordPreview";
import { RowMenu } from "@/components/RowMenu";
import { accountPath, dealPath as recordDealPath, recordNavState, uniquePaths } from "@/components/record/listOrder";
import { money, when } from "@/lib/format";
import { cn } from "@/lib/utils";
import { LocationFilter } from "@/components/LocationFilter";
import { useInApiShell } from "@/components/shell/ApiTopBar";
import { ToolbarFilter } from "@/components/ui/toolbar-filter";
import { useResolvedAvatar } from "@/components/EntityAvatar";
import { useAuth } from "@/contexts/AuthContext";
import { usePlan } from "@/hooks/usePlan";
import { isApiTier } from "@/config/plans";
import { buildCompanies, stageColor, mapContact, type ContactInfo } from "@/components/mind/entities";
import { tierFromScore, TIER_UI, relTime } from "@/components/mind/shared";
import { stageLabel, normalizeStage } from "@/config/pipeline";
import {
  effectiveLifecycle, LIFECYCLE_STAGES, LIFECYCLE_LABEL, LIFECYCLE_COLOR,
  salesGroupOf, SALES_GROUPS, SALES_GROUP_LABEL, SALES_GROUP_COLOR, type LifecycleStage, type SalesGroup,
} from "@/config/lifecycle";
import { inPrimaryPipeline } from "@/components/deals/AccountDeals";
import { useDealPages } from "@/hooks/useDealPages";
import { buildStageChips, sameStageLabel, type WsStage as StripStage } from "@/lib/stageStrip";
import { faviconUrl } from "@/lib/externalImages";
import { signalTag, type LatestSignal } from "@/lib/signalTags";
import { cloud } from "@/lib/cloud";

// A stage the workspace defined for itself — pulled from their CRM on connect, or agreed
// with the agent in chat, and stored in workspace_stages.
type WsStage = StripStage;

// The palette a custom ladder is drawn in: a progression toward the close, so a stage's
// colour says where it sits rather than being decoration. Sampled across however many stages
// the team actually has, because a team with four is not a team with nine.
const LADDER_COLORS = ["#6366f1", "#7c6cf0", "#a06ae0", "#d97706", "#c78a1a", "#059669"];
const ladderColor = (i: number, n: number) =>
  LADDER_COLORS[n <= 1 ? 0 : Math.min(LADDER_COLORS.length - 1, Math.round((i / (n - 1)) * (LADDER_COLORS.length - 1)))];

// The stage shown in the column.
//
// When the workspace has defined its own ladder, that wins: an account sitting at
// "Qualified To Buy" in their HubSpot should read "Qualified To Buy" here, not our
// three-bucket collapse of it. The agent has been able to save that ladder for a while;
// nothing rendered it, so a team could sync their real stages and see none of them.
//
// With no custom ladder — most workspaces — this is exactly what it always was.
function stageDisplay(
  life: LifecycleStage | null,
  sub: SalesGroup | null,
  rawLabel: string,
  canonical: string | null | undefined,
  ladder: WsStage[],
  phaseLabel?: (key: string) => string | undefined,
): { label: string; color: string } {
  if (life === "sales_pipeline" && ladder.length) {
    const i = ladder.findIndex(s => s.canonical === String(canonical ?? "").toLowerCase());
    if (i >= 0) return { label: ladder[i].label, color: ladderColor(i, ladder.length) };
    // In the sales pipeline but at a stage their ladder doesn't name — show our label rather
    // than inventing one of theirs.
  }
  if (life === "sales_pipeline") {
    return sub ? { label: SALES_GROUP_LABEL[sub], color: SALES_GROUP_COLOR[sub] }
               : { label: LIFECYCLE_LABEL.sales_pipeline, color: LIFECYCLE_COLOR.sales_pipeline };
  }
  if (life) return { label: phaseLabel?.(life) ?? LIFECYCLE_LABEL[life], color: LIFECYCLE_COLOR[life] };
  return { label: rawLabel, color: "#94a3b8" };
}

const apiUrl = import.meta.env.VITE_API_URL ?? "";

// Reason tiers, ranked by how defensible the reason is rather than by any score (the engine is
// apps/api/src/lib/csHealth.mjs). Tier 1 is sufficient alone: a cancellation, their churn model,
// paying with nobody logged in, or the customer's own words (leaving, or asking for something).
// Tier 2 needs a second, independent reason. Tier 3 and 4 are context on a row, never the reason
// for it: the CRM's upgrade price, an undated extracted claim, silence.
const REASON_DOT: Record<number, string> = {
  1: "bg-rose-500",
  2: "bg-amber-500",
  3: "bg-muted-foreground/40",
  4: "bg-muted-foreground/25",
};
const DISMISS_LABEL: Record<string, string> = {
  accept: "Accept",
  snooze: "Not now",
  account: "Never here",
  product: "Not a product",
};

// Initial-avatars for the "People" column — contacts carry no photo, so we colour a
// circle deterministically from the name and drop the first letter in.
const initial = (name?: string | null) => (name?.trim()?.[0] ?? "?").toUpperCase();
// Compact money for the list column: $1.2M / $45k / $900.
const fmtMoney = (n: number) => {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 1_000) return `$${Math.round(n / 1_000)}k`;
  return `$${Math.round(n)}`;
};

// One stacked avatar — the real profile photo when we have one, a tinted initial circle when
// we don't (or when the photo URL fails to load). Same tints as the owner filter.
function PersonAvatar({ p, i, onClick }: { p: ContactInfo; i: number; onClick: () => void }) {
  const [broken, setBroken] = useState(false);
  // Their photo when the CRM has one, otherwise the face their email resolves to; the initials
  // are the last resort, not the only option.
  const resolved = useResolvedAvatar({ kind: "person", email: p.email, photoUrl: p.photo });
  const showImg = !!resolved && !broken;
  return (
    <RecordPreview kind="person" name={p.name} title={p.title} lastActivityAt={p.lastActivityAt}>
    <button
      type="button"
      aria-label={p.name ?? undefined}
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      className={cn(
        "relative flex size-5 items-center justify-center overflow-hidden rounded-full text-[8.5px] font-semibold shadow-[0_0_0_2px_hsl(var(--card))] transition-transform duration-fast hover:-translate-y-0.5",
        !showImg && avatarTint(p.name ?? p.id),
      )}
      style={{ marginLeft: i === 0 ? 0 : -5, zIndex: 10 - i }}
    >
      {showImg
        ? <img src={resolved!} alt="" referrerPolicy="no-referrer" onError={() => setBroken(true)} className="h-full w-full object-cover" />
        : (initialsOf(p.name ?? "") || initial(p.name))}
    </button>
    </RecordPreview>
  );
}

function PeopleStack({ contacts, total, onOpenPerson }: { contacts: ContactInfo[]; total: number; onOpenPerson: (id: string) => void }) {
  const shown = contacts.slice(0, 3);
  const extra = Math.max(0, total - shown.length);
  if (shown.length === 0) return <span className="text-muted-foreground">—</span>;
  return (
    <div className="flex items-center">
      {shown.map((p, i) => <PersonAvatar key={p.id} p={p} i={i} onClick={() => onOpenPerson(p.id)} />)}
      {extra > 0 && (
        <span className="relative flex size-5 items-center justify-center rounded-full bg-muted text-[8.5px] font-semibold text-ink-2 shadow-[0_0_0_2px_hsl(var(--card))]" style={{ marginLeft: -5 }}>
          +{extra}
        </span>
      )}
    </div>
  );
}

// ICP fit as a number and a 44px bar; below the profile's floor the bar goes grey.
function IcpScore({ score }: { score: number | null | undefined }) {
  if (score == null || Number.isNaN(Number(score))) {
    return <span className="inline-flex items-center gap-2"><span className="w-5 text-muted-foreground/50">—</span><span className="h-1 w-11 rounded-full bg-hairline" /></span>;
  }
  const v = Math.max(0, Math.min(100, Math.round(Number(score))));
  return (
    <span className="inline-flex items-center gap-2">
      <span className="w-5">{v}</span>
      <span className="h-1 w-11 overflow-hidden rounded-full bg-hairline">
        <span className={cn("block h-1 rounded-full", v >= 50 ? "bg-foreground/70" : "bg-muted-foreground/40")} style={{ width: `${v}%` }} />
      </span>
    </span>
  );
}

// The tier in words. The ICP column beside it already draws the score as a bar, so no second mark.
function TierMark({ score }: { score: number | null | undefined }) {
  const t = tierFromScore(score);
  if (!t) return <span className="text-[12px] text-muted-foreground/60">Not scored</span>;
  return (
    <span title={TIER_UI[t].play} className={cn("text-[12.5px]", t === "not_icp" ? "text-muted-foreground/60" : "text-ink-2")}>
      {TIER_UI[t].label}
    </span>
  );
}

// A deal as the Sales Pipeline and Handoff chips list it (GET-267). A CRM deal, or — for an
// account with none — the account's own implied deal (id "account"), the same one its deal page
// opens. So every account in play shows exactly once per deal, never as a blended company row.
type WorkspaceDeal = {
  id: string; company_id: string; company_name: string | null; company_domain: string | null;
  name: string; stage: string | null; status: "open" | "won" | "lost"; value: number | null;
  currency: string | null; close_date: string | null; roster_ids: string[]; roster_count: number;
  roster_people?: { id: string; name: string; photo: string | null; email?: string | null }[];
  owner_name?: string | null;
  // The pipeline the deal is in: the display name (trimmed by the API) and the CRM's own id.
  pipeline?: string | null; pipeline_id?: string | null;
  // The conversation about THIS deal, which the API has always sent and this file ignored.
  last_activity_at?: string | null;
  // Why this open deal looks dead, from the API (GET-352). Evidence, never a status: the rep
  // reads it and closes the deal in HubSpot, and the status returns through the sync.
  verdict?: DealVerdict | null;
};
type DealSignal = { kind: string; text: string; detail: string | null; days: number | null; at: string | null };
type DealVerdict = { headline: DealSignal; signals: DealSignal[]; count: number };
type DealRow = {
  key: string; dealId: string; companyId: string; companyName: string; companyDomain: string | null;
  name: string; implied: boolean; stageLabel: string; stageColor: string;
  value: number | null; closeDate: string | null; people: ContactInfo[]; peopleTotal: number; lastActivityAt: string | null;
  owners: string[];
  verdict: DealVerdict | null;
  // Which pipeline the deal is in. A deal outside the primary one is marked, never hidden.
  pipeline: string | null; pipelineId: string | null; isPrimaryPipeline: boolean;
};
const WON_COLOR = "#059669";
// Lost is history, not an alarm: a muted slate so a strip that now ends in "Closed Lost 4,197"
// does not read as four thousand things on fire.
const LOST_COLOR = "#94a3b8";
const NO_DEALS: WorkspaceDeal[] = [];

/** A pipeline the viewer works, as /api/crm-pipelines reports it. `name` is null until the
 *  projection carries the CRM's display name, so the button falls back to the pipeline's id. */
type PipelineOption = { id: string; name: string | null; deals: number; open_deals: number; is_primary: boolean };
const NO_PIPELINES: PipelineOption[] = [];

// Newest activity first, never-touched last.
//
// Every list on this page answers "what should I look at", and the answer is the same everywhere:
// the thing that moved most recently. The pipeline used to sort by soonest close date, which put a
// deal that closed in April 2022 and has never been touched at the very top — technically "most
// overdue", in practice a four-year-old row above deals worked yesterday. Handoff sorted by won
// date for the same reason and with the same result.
//
// Overdue is not lost by this: the dead-deal verdict badge says "close date passed over 4 years
// ago" on the row itself, which is a better place for it than an ordering nobody can see.
const byRecentActivity = <T extends { lastActivityAt: string | null }>(a: T, b: T) =>
  (b.lastActivityAt ?? "").localeCompare(a.lastActivityAt ?? "");
const NO_COMPANIES: any[] = [];
const NO_CONTACTS: ContactInfo[] = [];

/** A search that reaches the server waits for the typing to stop. */
function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return settled;
}
const shortDay = (iso: string | null) => {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: d.getFullYear() === new Date().getFullYear() ? undefined : "numeric" });
};

// Accounts — the companies list, the sibling of the People list, plus the two deal views an
// account travels through: Sales Pipeline (its open deals) and Handoff (its won deals). The
// chips are the same chips as before; only what the second and third show changed (GET-267).
type AccountsView = "accounts" | "sales_pipeline" | "handoff" | "customer_success";
export default function AccountsList({ onOpen, only, defaultView = "accounts" }: {
  /** `order`: the record paths as the list shows them, for the record's previous / next (GET-650). */
  onOpen: (companyId: string, name?: string, order?: string[]) => void;
  /** Restrict the view chips (the redesign gives Pipeline and Customers their own pages). */
  only?: AccountsView[];
  defaultView?: AccountsView;
}) {
  const navigate = useNavigate();
  // A deal opens as its page only on the workspace plans on Cloud; elsewhere its account (GET-1008).
  const dealPages = useDealPages();
  const { session, userData } = useAuth();
  const token = session?.access_token;
  const workspaceId = (userData as { workspace?: { id?: string } })?.workspace?.id ?? "";
  const auth = token ? { Authorization: `Bearer ${token}` } : undefined;

  const queryClient = useQueryClient();
  const [q, setQ] = useState("");
  // The chip lives in the URL, so Back from a deal returns to the Sales Pipeline, not Accounts.
  const [params, setParams] = useSearchParams();
  // The API plan sells the graph and the pipeline on it, not the lifecycle after the sale:
  // Handoff and Customer success are the operated surfaces, and on API they were two chips
  // reading 0 next to the two that matter.
  const { plan } = usePlan();
  const api = isApiTier(plan);
  const planViews: AccountsView[] = api ? ["accounts", "sales_pipeline"] : ["accounts", "sales_pipeline", "handoff", "customer_success"];
  const VIEWS: string[] = only ? planViews.filter((v) => only.includes(v)) : planViews;
  const home: AccountsView = VIEWS.includes(defaultView) ? defaultView : (VIEWS[0] as AccountsView) ?? "accounts";
  // A URL naming a view this page does not have falls back to its default rather than
  // rendering a tab with no chip to leave it by.
  const view = (VIEWS.includes(params.get("view") ?? "") ? params.get("view") : home) as AccountsView;
  const setView = (v: string) => { const next = new URLSearchParams(params); if (v === home) next.delete("view"); else next.set("view", v); next.delete("pipeline"); setParams(next, { replace: true }); setSubFilter("all"); };
  const [subFilter, setSubFilter] = useState<string>("all");
  // Which pipeline is on screen. In the URL like the view, because a stage strip only makes sense
  // against one funnel and coming back from a deal to the wrong one is disorienting. Changing it
  // clears the stage, since the stages themselves are different.
  //
  // The DEFAULT is resolved further down, once the deals payload has named the workspace's own
  // pipeline — see `pipelineId`. There is no "all pipelines" choice any more: stages do not
  // survive being mixed between funnels (one workspace's seven share almost no stage names), so a
  // combined strip could only ever rank every chip at 1000 and print them in count order.
  const setPipelineId = (id: string) => {
    const next = new URLSearchParams(params);
    if (id === "all") next.delete("pipeline"); else next.set("pipeline", id);
    setParams(next, { replace: true }); setSubFilter("all");
  };

  // Accounts arrive a page at a time, with the workspace's real total beside them, and the
  // search runs on the server (GET-290). Reading every account used to stop at PostgREST's
  // silent 1,000 — a client workspace of 9,108 showed a thousand and hid the rest.
  const PAGE = 200;
  const [pages, setPages] = useState(1);

  // Which market this list is showing. Remembered per workspace, so a reload keeps the filter the
  // user set — "undefined" means "not chosen here yet", and the server then applies the workspace's
  // own focus (e.g. one country). An explicit "all" is a choice and is remembered like any other.
  const countryKey = `nous.accounts.country.${workspaceId}`;
  const [country, setCountry] = useState<string | undefined>(() => {
    try { return localStorage.getItem(countryKey) ?? undefined; } catch { return undefined; }
  });
  // Switching workspace switches the remembered filter with it — one market per workspace.
  useEffect(() => {
    try { setCountry(localStorage.getItem(countryKey) ?? undefined); } catch { setCountry(undefined); }
  }, [countryKey]);
  const chooseCountry = (v: string) => {
    setCountry(v);
    setPages(1);
    try { localStorage.setItem(countryKey, v); } catch { /* a filter that forgets is still a filter */ }
  };
  const debouncedQ = useDebounced(q, 300);
  useEffect(() => { setPages(1); }, [debouncedQ]);

  // Owner (GET-605). "Assigned to me" is the server's own "mine" (it maps the viewer to their CRM
  // owner). Everyone sends no scope, exactly as before. A person, Unassigned or several narrow the
  // loaded accounts here by the account owner's name.
  const myName = ((userData as { user?: { name?: string | null } } | null)?.user?.name ?? "").trim();
  const meId = myName || "__me";
  const [owners, setOwnersState] = useState<string[]>([]);
  const mineOnly = owners.length === 1 && owners[0] === meId;
  const setOwners = (ids: string[]) => { setOwnersState(ids); setPages(1); };

  // A Workspace-layer scope (cloud.accounts.scope, GET-873): only the accounts of the object the URL
  // names, resolved by the server. A chip in the toolbar names it and clears it; the market and owner
  // filters do not apply on top of it.
  const accountScope = cloud.accounts?.scope;
  const scopeId = accountScope ? params.get(accountScope.param) ?? "" : "";
  const clearScope = () => { if (!accountScope) return; const next = new URLSearchParams(params); next.delete(accountScope.param); setParams(next, { replace: true }); setPages(1); };
  // Network accounts (someone we know, not a deal) are hidden by default; the filter can show them (GET-1019).
  // Remembered per workspace, like the market (GET-1020).
  const networkKey = `nous.accounts.network.${workspaceId}`;
  const [showNetwork, setShowNetworkState] = useState<boolean>(() => {
    try { return localStorage.getItem(networkKey) === "show"; } catch { return false; }
  });
  useEffect(() => {
    try { setShowNetworkState(localStorage.getItem(networkKey) === "show"); } catch { setShowNetworkState(false); }
  }, [networkKey]);
  const setShowNetwork = (on: boolean) => {
    setShowNetworkState(on);
    try { if (on) localStorage.setItem(networkKey, "show"); else localStorage.removeItem(networkKey); } catch { /* a filter that forgets is still a filter */ }
  };
  const { data: companiesPage, isPending: loadingCo } = useQuery<{ companies: any[]; total: number; applied: string | null; countries: { country: string; accounts: number }[]; scope: { id: string; name: string } | null }>({
    queryKey: ["companies-list", workspaceId, debouncedQ, pages, country ?? "__ws_default__", mineOnly ? "mine" : "all", scopeId, showNetwork ? "network" : ""],
    enabled: !!token && !!workspaceId,
    placeholderData: (prev) => prev,
    queryFn: async () => {
      const url = `${apiUrl}/api/companies/list?workspaceId=${workspaceId}&limit=${PAGE * pages}`
        + (debouncedQ ? `&q=${encodeURIComponent(debouncedQ)}` : "")
        + (showNetwork ? "&network=show" : "")
        + (scopeId && accountScope ? `&${accountScope.param}=${encodeURIComponent(scopeId)}` : (mineOnly ? "&scope=mine" : "") + (country ? `&country=${encodeURIComponent(country)}` : ""));
      const r = await fetch(url, { headers: auth });
      const d = r.ok ? await r.json() : {};
      return {
        companies: Array.isArray(d.companies) ? d.companies : [],
        total: Number(d.total) || 0,
        applied: (d.country ?? null) as string | null,
        countries: (Array.isArray(d.countries) ? d.countries : []) as { country: string; accounts: number }[],
        scope: accountScope && d[accountScope.field] && typeof d[accountScope.field] === "object" ? d[accountScope.field] as { id: string; name: string } : null,
      };
    },
  });
  const rawCompanies = companiesPage?.companies ?? NO_COMPANIES;
  const accountOverview = useQuery<{ accounts: { id: string; deal_count: number; latest_signal: LatestSignal | null; is_personal?: boolean }[] }>({
    queryKey: ['account-overview', workspaceId, rawCompanies.map(c => c.id)],
    // Deals and the latest signal per account: the API plan's table, and the Workspace table since GET-864.
    enabled: !!token && rawCompanies.length > 0,
    queryFn: async () => {
      const accounts = [];
      for (let i = 0; i < rawCompanies.length; i += 200) {
        const res = await fetch(`${apiUrl}/api/account-overview?workspaceId=${encodeURIComponent(workspaceId)}`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: rawCompanies.slice(i, i + 200).map(c => c.id) }) });
        if (!res.ok) throw new Error('Could not load account signals.');
        accounts.push(...(await res.json()).accounts);
      }
      return { accounts };
    },
  });
  const overviewById = new Map((accountOverview.data?.accounts ?? []).map(a => [a.id, a]));
  // Someone we know, not a deal (GET-1016): tagged, and no deals, pipeline or signal shown.
  const isPersonal = (id: string) => overviewById.get(id)?.is_personal === true;
  const accountsTotal = companiesPage?.total ?? 0;
  // What the server actually filtered by, so the control shows the truth on first load — before the
  // user has chosen anything, that is the workspace's own focus.
  const appliedCountry = companiesPage?.applied ?? null;
  const countryOptions = companiesPage?.countries ?? [];
  const hasMore = rawCompanies.length < accountsTotal;
  const contacts: ContactInfo[] = NO_CONTACTS;
  // Every CRM deal in the workspace (all outcomes, split below), each with the pipeline it is in,
  // plus the CRM's id for the workspace's primary pipeline (null = unknown, so nothing is marked).
  // Empty for a workspace with no CRM deals, which then lists its accounts' implied deals.
  const { data: dealsData, isPending: loadingDeals } = useQuery<{ deals: WorkspaceDeal[]; primary_pipeline_ref: string | null; customers: number | null }>({
    queryKey: ["workspace-deals", workspaceId, country ?? "__ws_default__"],
    enabled: !!token && !!workspaceId,
    staleTime: 60_000,
    queryFn: async () => {
      const r = await fetch(`${apiUrl}/api/companies/deals?workspaceId=${workspaceId}&status=all`
        + (country ? `&country=${encodeURIComponent(country)}` : ""), { headers: auth });
      const d = r.ok ? await r.json() : {};
      return {
        deals: Array.isArray(d.deals) ? d.deals : [],
        primary_pipeline_ref: typeof d.primary_pipeline_ref === "string" && d.primary_pipeline_ref ? d.primary_pipeline_ref : null,
        // The Customer success tab's count, so it is not blank until you open the tab.
        customers: typeof d.counts?.customers === "number" ? d.counts.customers : null,
      };
    },
  });
  const crmDeals = dealsData?.deals ?? NO_DEALS;

  // The pipelines this viewer actually works, derived from the deals they own — nobody configures
  // it. A rep with deals in four sees four buttons; a CS rep with only expansion deals sees one.
  // `names_ready` is false until the projection carries the pipeline's display name, and a
  // pipeline then labels itself with its CRM id, which for HubSpot's primary is "default".
  const { data: pipelineData } = useQuery<{ pipelines: PipelineOption[]; names_ready: boolean }>({
    queryKey: ["crm-pipelines", workspaceId],
    enabled: !!token && !!workspaceId,
    staleTime: 300_000,
    queryFn: async () => {
      const r = await fetch(`${apiUrl}/api/crm-pipelines?workspaceId=${workspaceId}`, { headers: auth });
      if (!r.ok) return { pipelines: [], names_ready: false };
      return r.json();
    },
  });
  const pipelineOptions = pipelineData?.pipelines ?? NO_PIPELINES;
  const primaryPipelineRef = dealsData?.primary_pipeline_ref ?? null;

  // The pipeline on screen, defaulting to the workspace's own rather than to a mixed view.
  //
  // "all" is still the value while the deals payload is in flight, deliberately: it is the only
  // state in which the board shows everything, and it lasts exactly as long as there is nothing
  // to show. Selecting a pipeline before its id is known would render an empty table.
  const pipelineId = params.get("pipeline")
    ?? primaryPipelineRef
    ?? pipelineOptions.find(p => p.is_primary)?.id
    ?? "all";

  // The workspace's own LIFECYCLE phase names (a team can rename or invent one), for the
  // Accounts table's Stage column.
  const { data: phases = [] } = useQuery<{ key: string; label: string; sort_order: number; owner_dept: string }[]>({
    queryKey: ["workspace-pipelines", workspaceId],
    enabled: !!token && !!workspaceId,
    queryFn: async () => {
      const r = await fetch(`${apiUrl}/api/lifecycle/pipelines?workspaceId=${workspaceId}`, { headers: auth });
      const d = r.ok ? await r.json() : {};
      return Array.isArray(d.pipelines) ? d.pipelines : [];
    },
  });
  const phaseLabelOf = (key: string) => phases.find((p) => p.key === key)?.label;

  // The workspace's own stage ladder. Empty for a workspace that never set one, and every
  // path below falls back to the canonical defaults in that case, so nothing changes for them.
  const { data: ladder = [] } = useQuery<WsStage[]>({
    queryKey: ["workspace-stages", workspaceId, pipelineId],
    enabled: !!token && !!workspaceId,
    queryFn: async () => {
      const r = await fetch(`${apiUrl}/api/workspaces/${workspaceId}/stages`
        + (pipelineId !== "all" ? `?pipelineId=${encodeURIComponent(pipelineId)}` : ""), { headers: auth });
      const d = r.ok ? await r.json() : {};
      return Array.isArray(d.stages) ? d.stages : [];
    },
  });
  const activeLadder = useMemo(
    () => ladder.filter(s => s.kind === "active").sort((a, b) => a.sort_order - b.sort_order),
    [ladder],
  );

  // The lifecycle override stage per company (from the list endpoint); null = derive from sales.
  const overrideById = useMemo(
    () => new Map<string, string | null>((rawCompanies as any[]).map((r) => [r.id, r.lifecycle_stage ?? null])),
    [rawCompanies]
  );
  const companies = useMemo(() => buildCompanies(rawCompanies, contacts), [rawCompanies, contacts]);
  const withLifecycle = useMemo(() => companies.map((c) => ({
    ...c,
    life: effectiveLifecycle(c.stage, overrideById.get(c.id)),
    sub: salesGroupOf(c.stage),
  })), [companies, overrideById]);

  const matches = (text: string) => !q || text.toLowerCase().includes(q.toLowerCase());

  // What the CRM says about each account beyond the substrate: whether it is a customer, what it
  // pays a month, and who owns it. All three are newer fields on /list, so an older server sends
  // none of them and every control that reads them stays out of the way.
  const metaById = useMemo(() => new Map<string, { status: string | null; mrr: number | null; owner: string | null }>(
    (rawCompanies as any[]).map((r) => [r.id, {
      status: typeof r.customer_status === "string" ? r.customer_status : null,
      mrr: r.mrr == null || Number.isNaN(Number(r.mrr)) ? null : Number(r.mrr),
      owner: typeof r.owner_name === "string" && r.owner_name.trim() ? r.owner_name.trim() : null,
    }]),
  ), [rawCompanies]);
  const hasCustomerStatus = useMemo(() => (rawCompanies as any[]).some((r) => r && "customer_status" in r), [rawCompanies]);
  // A cancelled account counts as a customer, marked "Cancelled": it was one, it has an MRR
  // history and a CS owner, and working it as a fresh prospect would be the wrong conversation.
  const isCustomer = (id: string) => {
    const s = metaById.get(id)?.status;
    return s === "client" || s === "cancelled";
  };
  // All / Prospects / Customers. In the URL like the view, so Back from an account keeps it.
  type Segment = "all" | "prospects" | "customers";
  const segment: Segment = !api && hasCustomerStatus && (params.get("type") === "prospects" || params.get("type") === "customers")
    ? (params.get("type") as Segment) : "all";
  const setSegment = (s: Segment) => {
    const next = new URLSearchParams(params);
    if (s === "all") next.delete("type"); else next.set("type", s);
    setParams(next, { replace: true });
  };

  // The owner menu: the account owners on the accounts loaded so far, with how many each owns.
  // Kept from the last unscoped page, so "Assigned to me" does not empty the menu of everyone else.
  const [ownerCounts, setOwnerCounts] = useState<{ people: [string, number][]; unassigned: number }>({ people: [], unassigned: 0 });
  useEffect(() => {
    if (mineOnly || !companiesPage) return;
    const m = new Map<string, number>();
    let unassigned = 0;
    for (const r of rawCompanies as { owner_name?: unknown }[]) {
      const o = typeof r.owner_name === "string" ? r.owner_name.trim() : "";
      if (!o) unassigned++; else m.set(o, (m.get(o) ?? 0) + 1);
    }
    setOwnerCounts({ people: [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])), unassigned });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companiesPage, mineOnly]);
  const ownerPeople = useMemo<Person[]>(() => {
    const mine = ownerCounts.people.find(([n]) => n.toLowerCase() === myName.toLowerCase());
    return [
      { id: meId, name: myName || "Me", count: mine?.[1] },
      ...ownerCounts.people.filter(([n]) => n.toLowerCase() !== myName.toLowerCase()).map(([name, count]) => ({ id: name, name, count })),
    ];
  }, [ownerCounts, myName, meId]);
  const ownerMatch = (owner: string | null) => {
    if (owners.length === 0) return true;
    if (!owner) return owners.includes(UNASSIGNED);
    return owners.includes(owner) || (owners.includes(meId) && !!myName && owner.toLowerCase() === myName.toLowerCase());
  };

  // ── Accounts ──
  const accountRows = useMemo(() => withLifecycle
    // The server already matched name and domain for this page; filtering again would only
    // hide rows it deliberately returned (a match on a field the client cannot see).
    .filter(c => (debouncedQ ? true : matches(`${c.name} ${c.domain ?? ""}`)))
    .filter(c => segment === "all" || (segment === "customers") === isCustomer(c.id))
    .filter(c => mineOnly || ownerMatch(metaById.get(c.id)?.owner ?? null))
    .sort((a, b) => (b.lastActivityAt ?? "").localeCompare(a.lastActivityAt ?? "")),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [withLifecycle, q, segment, metaById, owners, mineOnly]);
  // The segment counts are over the accounts loaded so far (the list arrives a page at a time and
  // the server does not count by status), so a page with more to load says so with a "+".
  const segmentCounts = useMemo(() => {
    let customers = 0;
    for (const c of withLifecycle) if (isCustomer(c.id)) customers++;
    return { all: accountsTotal || withLifecycle.length, customers, prospects: withLifecycle.length - customers };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [withLifecycle, metaById, accountsTotal]);

  // ── Deals ──
  const contactById = useMemo(() => new Map(contacts.map(c => [c.id, c])), [contacts]);
  const companyById = useMemo(() => new Map(withLifecycle.map(c => [c.id, c])), [withLifecycle]);
  const accountsWithCrmDeals = useMemo(() => new Set(crmDeals.map(d => d.company_id)), [crmDeals]);

  // Trimmed, case-insensitive label equality — see stageStrip.ts for why HubSpot's own labels
  // make this necessary. Used for the colour lookup here and for the chip/table filter below.
  const sameLabel = sameStageLabel;
  const crmStageColor = (label: string | null) => {
    const i = activeLadder.findIndex(s => sameLabel(s.label, label));
    return i >= 0 ? ladderColor(i, activeLadder.length) : LIFECYCLE_COLOR.sales_pipeline;
  };
  const fromCrm = (d: WorkspaceDeal): DealRow => {
    const co = companyById.get(d.company_id);
    const people = (d.roster_people?.length
      ? d.roster_people.map(p => ({ id: p.id, name: p.name, photo: p.photo }) as unknown as ContactInfo)
      : d.roster_ids.map(id => contactById.get(id)).filter(Boolean)) as ContactInfo[];
    return {
      key: d.id, dealId: d.id, companyId: d.company_id, companyName: d.company_name ?? co?.name ?? "—",
      companyDomain: d.company_domain ?? co?.domain ?? null, name: d.name, implied: false,
      stageLabel: d.status === "won" ? (d.stage || "Closed Won")
        : d.status === "lost" ? (d.stage || "Closed Lost")
        : (d.stage || "Open"),
      stageColor: d.status === "won" ? WON_COLOR
        : d.status === "lost" ? LOST_COLOR
        : crmStageColor(d.stage),
      // The deal's own last activity first. Reading it off the company was why the pipeline's
      // Last activity column was almost entirely blank: `co` is the loaded ACCOUNTS page, so a
      // deal whose account was not in it had nothing to fall back to. most open deals on a large
      // workspace carry their own date — it was in the payload the whole time.
      value: d.value, closeDate: d.close_date, people, peopleTotal: d.roster_count,
      lastActivityAt: d.last_activity_at ?? co?.lastActivityAt ?? null,
      owners: d.owner_name ? [d.owner_name] : [],
      verdict: d.verdict ?? null,
      // Only a deal we KNOW sits outside the primary pipeline gets marked; unknown reads as primary.
      pipeline: d.pipeline?.trim() || null, pipelineId: d.pipeline_id ?? null,
      isPrimaryPipeline: inPrimaryPipeline(d.pipeline_id, primaryPipelineRef),
    };
  };
  const fromAccount = (c: (typeof withLifecycle)[number], won: boolean): DealRow => {
    const sd = won ? { label: "Closed Won", color: WON_COLOR } : stageDisplay("sales_pipeline", c.sub, stageLabel(c.stage), c.stage, activeLadder);
    return {
      key: `account:${c.id}`, dealId: "account", companyId: c.id, companyName: c.name, companyDomain: c.domain ?? null,
      name: `${c.name} deal`, implied: true, stageLabel: sd.label, stageColor: sd.color,
      value: c.dealValue, closeDate: null, people: c.contacts ?? [], peopleTotal: c.contactCount ?? (c.contacts?.length ?? 0),
      lastActivityAt: c.lastActivityAt,
      // An implied deal is an account with no CRM deal behind it. There is no close date to pass
      // and no deal record to correct in HubSpot, so it carries no dead-deal verdict.
      verdict: null,
      // The account's own deal is owned by everyone who owns the account.
      owners: [...new Set((c.contacts ?? []).flatMap(p => (p.ownerMembers ?? []).map(m => m.name)).filter(Boolean) as string[])],
      // The account's own deal is in no CRM pipeline, so there is nothing to mark it against.
      pipeline: null, pipelineId: null, isPrimaryPipeline: true,
    };
  };

  const pipelineRows = useMemo<DealRow[]>(() => {
    const crm = crmDeals.filter(d => d.status === "open").map(fromCrm);
    const implied = withLifecycle.filter(c => c.life === "sales_pipeline" && !accountsWithCrmDeals.has(c.id)).map(c => fromAccount(c, false));
    // Most recently worked first, then the soonest close among deals that tie.
    return [...crm, ...implied].sort((a, b) =>
      byRecentActivity(a, b)
      || (a.closeDate ? 0 : 1) - (b.closeDate ? 0 : 1)
      || String(a.closeDate ?? "").localeCompare(String(b.closeDate ?? "")));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [crmDeals, primaryPipelineRef, withLifecycle, accountsWithCrmDeals, contactById, activeLadder]);

  // What the Sales Pipeline VIEW shows: the funnel plus the two outcomes it ends in. A funnel
  // without its ends is not a funnel — Closed Won and Closed Lost are where almost all of a mature
  // workspace's primary-pipeline deals sit, and without them the strip undercounted the pipeline.
  //
  // `pipelineRows` deliberately stays OPEN-ONLY above, because it also feeds `pipelineByCompany`,
  // the Accounts table's money column. That column is what is still in flight against an account;
  // folding a won or a lost deal into it would print history as pipeline.
  //
  // The age window is the API's, not ours: /api/companies/deals reads with `windowed: true`, so
  // open and won arrive at any age and losses only from the last 12 months. These chips cannot
  // show 2023's losses even though the rows are still in the database.
  const pipelineViewRows = useMemo<DealRow[]>(() => {
    const closed = crmDeals.filter(d => d.status === "won" || d.status === "lost")
      .map(fromCrm)
      // Most recently closed first — for a decided deal the close date is the useful clock, not
      // the last time someone happened to touch the account.
      .sort((a, b) => String(b.closeDate ?? "").localeCompare(String(a.closeDate ?? "")) || byRecentActivity(a, b));
    return [...pipelineRows, ...closed];
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pipelineRows, crmDeals, primaryPipelineRef, contactById, activeLadder]);

  const handoffRows = useMemo<DealRow[]>(() => {
    const crm = crmDeals.filter(d => d.status === "won").map(fromCrm);
    const implied = withLifecycle.filter(c => normalizeStage(c.stage) === "closed_won" && !accountsWithCrmDeals.has(c.id)).map(c => fromAccount(c, true));
    // Most recently worked first, then most recently won among deals that tie.
    return [...crm, ...implied].sort((a, b) =>
      byRecentActivity(a, b) || String(b.closeDate ?? "").localeCompare(String(a.closeDate ?? "")));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [crmDeals, primaryPipelineRef, withLifecycle, accountsWithCrmDeals, contactById]);

  // One pipeline at a time. Unfiltered `pipelineRows` still feeds the Accounts table, because an
  // account's open value is everything in flight against it, not one funnel's share.
  const scopedPipelineRows = useMemo(
    () => (pipelineId === "all" ? pipelineViewRows : pipelineViewRows.filter(r => (r.pipelineId ?? "") === pipelineId)),
    [pipelineViewRows, pipelineId]);

  // How many deals each pipeline button stands for, counted off the SAME rows the stage strip
  // below reads. /api/crm-pipelines returns its own totals, but they are not country-filtered and
  // the board is: that is why the button read "Sales Pipeline 208" above stages summing to 206.
  // A button and the strip it opens must not disagree.
  const dealsByPipeline = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of pipelineViewRows) {
      const k = r.pipelineId ?? "";
      m.set(k, (m.get(k) ?? 0) + 1);
    }
    return m;
  }, [pipelineViewRows]);

  // The Pipeline tab's stage row: the stages its deals actually sit at, in the order the
  // workspace's ladder (or our three groups) puts them, then any CRM stage the ladder doesn't name.
  const stageChips = useMemo(
    () => buildStageChips(scopedPipelineRows, activeLadder, ladder, SALES_GROUPS.map(g => SALES_GROUP_LABEL[g])),
    [scopedPipelineRows, activeLadder, ladder],
  );

  // Per account: its open deals and what they add up to — the Accounts table's money (GET-268).
  const pipelineByCompany = useMemo(() => {
    const m = new Map<string, { count: number; value: number }>();
    for (const r of pipelineRows) {
      const cur = m.get(r.companyId) ?? { count: 0, value: 0 };
      m.set(r.companyId, { count: cur.count + 1, value: cur.value + (r.value ?? 0) });
    }
    return m;
  }, [pipelineRows]);

  // Per account: what it has WON, so the table shows the whole picture — what is still in play
  // beside what the account has actually paid us (GET-278). Same won deals the Handoff chip lists.
  const wonByCompany = useMemo(() => {
    const m = new Map<string, { count: number; value: number }>();
    for (const r of handoffRows) {
      const cur = m.get(r.companyId) ?? { count: 0, value: 0 };
      m.set(r.companyId, { count: cur.count + 1, value: cur.value + (r.value ?? 0) });
    }
    return m;
  }, [handoffRows]);

  const dealRows = (view === "handoff" ? handoffRows : scopedPipelineRows)
    .filter(r => matches(`${r.name} ${r.companyName} ${r.companyDomain ?? ""}`))
    // Trimmed, to match the chip it came from — the strip groups by trimmed label, so filtering
    // on the raw one would select a chip and empty the table.
    .filter(r => view !== "sales_pipeline" || subFilter === "all" || sameLabel(r.stageLabel, subFilter));

  // Row actions. Lifecycle handoffs are automatic now, so the kebab is for the manual
  // calls the model can't make: is this a client, a personal contact, or not a real
  // account at all (delete). Optimistic, then reconcile.
  const post = (companyId: string, path: string, body?: unknown) =>
    fetch(`${apiUrl}/api/companies/${companyId}/${path}?workspaceId=${workspaceId}`, {
      method: "POST", headers: { ...(auth ?? {}), "Content-Type": "application/json" },
      body: JSON.stringify(body ?? {}),
    }).catch(() => {});
  const markClient = async (companyId: string) => {
    await post(companyId, "mark-client");
    queryClient.invalidateQueries({ queryKey: ["companies-list", workspaceId] });
  };
  const markPersonal = async (companyId: string) => {
    await post(companyId, "personal", { personal: true });
    queryClient.invalidateQueries({ queryKey: ["companies-list", workspaceId] });
    queryClient.invalidateQueries({ queryKey: ["account-overview", workspaceId] });
  };
  const deleteCompany = async (companyId: string) => {
    queryClient.setQueryData(["companies-list", workspaceId], (prev: any[] = []) => prev.filter((c) => c.id !== companyId));
    await fetch(`${apiUrl}/api/companies/${companyId}?workspaceId=${workspaceId}`, { method: "DELETE", headers: auth }).catch(() => {});
  };

  const HdrCell = ({ label, w }: { label: string; w: number }) => (
    <span className="flex-shrink-0 truncate text-[12px] font-medium text-muted-foreground/70" style={{ width: w }}>{label}</span>
  );

  // One chip for every strip that sits under the view tabs — pipeline stages and customer-success
  // states are the same control over different words, so they are the same pixels.
  const stripChip = (on: boolean) =>
    `flex-shrink-0 rounded-md px-2.5 py-1 text-[11.5px] font-medium transition-colors ${
      on ? "bg-muted text-foreground" : "text-muted-foreground/70 hover:text-foreground"}`;

  // Customer success: who is paying, who can be sold more, who we are losing. Fetched only when
  // the tab is open — it reads the whole customer cohort, so it must never slow the tabs beside it.
  type CsReason = {
    tier: number; kind: string; text: string; detail: string | null; evidence: string;
    productKey?: string;
    // Present when the reason came out of a conversation: the customer's own words, when they
    // said them, and how. The quote IS the feature — a rep opens the row holding the sentence.
    quote?: string; at?: string; via?: string | null; product?: string | null;
    // Set when a dated quote contradicts the CRM's own upgrade field. Shown, never hidden.
    conflict?: string | null;
  };
  type CsAccount = {
    companyId: string; name: string | null; domain: string | null; industry: string | null;
    peopleCount: number; openDeals: number; wonValue: number | null;
    lastActivityAt: string | null; daysQuiet: number | null;
    status: string | null; mrr: number | null; tier: string | null; csOwner: string | null;
    activeUsers: number | null; totalUsers: number | null; lastUsedAt: string | null;
    products: string[]; upgradeValue: number | null; upgradeStage: string | null;
    riskReasons: CsReason[]; expansionReasons: CsReason[]; saidCount: number;
  };
  type CsPayload = {
    accounts: CsAccount[]; expansionIds: string[]; atRiskIds: string[]; churned: CsAccount[];
    counts: { active: number; expansion: number; atRisk: number; churned: number };
    totals: { mrr: number; expansionValue: number; atRiskMrr: number; churnedMrr: number };
    healthReady: boolean;
    minedReady?: boolean;
    fromConversation?: { expansion: number; atRisk: number; suppressed: number };
  };
  const { data: csData, isPending: loadingCs } = useQuery<CsPayload>({
    queryKey: ["cs-accounts", workspaceId],
    enabled: !!token && !!workspaceId && view === "customer_success",
    queryFn: async () => {
      const r = await fetch(`${apiUrl}/api/customer-success/accounts?workspaceId=${workspaceId}`, { headers: auth });
      if (!r.ok) throw new Error("cs_accounts");
      return r.json();
    },
  });

  // The three questions, in the order a CS lead asks them: who is paying, who can we sell more
  // to, who are we losing. "Active" is no longer a STATE an account is in — every row on this tab
  // is an active customer, and the other two buttons are the ones that carry a reason.
  type CsBucket = "active" | "expansion" | "at_risk";
  const [csBucket, setCsBucket] = useState<CsBucket>("active");
  const expansionSet = useMemo(() => new Set(csData?.expansionIds ?? []), [csData]);
  const riskSet = useMemo(() => new Set(csData?.atRiskIds ?? []), [csData]);

  // An account is routinely in two buckets at once — worth saving AND worth selling to — so the
  // buttons are filters over one list, never three lists that have to agree with each other.
  const csRows = useMemo(() => {
    const all = csData?.accounts ?? [];
    const inBucket = (a: CsAccount) =>
      csBucket === "active" ? true
      : csBucket === "expansion" ? expansionSet.has(a.companyId)
      : riskSet.has(a.companyId);
    const rows = all.filter(a => matches(`${a.name ?? ""} ${a.domain ?? ""}`)).filter(inBucket);
    // Sorted by the reason that put them in the bucket — the strongest reason first — so the top
    // of the list is always the call to make next. Money breaks the tie, because a $2,000 account
    // and a $60 account with the same reason are not the same morning.
    const reasonsOf = (a: CsAccount) => csBucket === "expansion" ? a.expansionReasons : a.riskReasons;
    if (csBucket === "active") return rows.slice().sort((x, y) => (y.mrr ?? 0) - (x.mrr ?? 0));
    return rows.slice().sort((x, y) =>
      (reasonsOf(x)[0]?.tier ?? 9) - (reasonsOf(y)[0]?.tier ?? 9)
      || (csBucket === "expansion" ? (y.upgradeValue ?? 0) - (x.upgradeValue ?? 0) : (y.mrr ?? 0) - (x.mrr ?? 0)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [csData, q, csBucket, expansionSet, riskSet]);

  const CS_BUCKETS: { key: CsBucket; label: string; count: (c: CsPayload | undefined) => number | null }[] = [
    { key: "active",    label: "Active customers",       count: c => c?.counts.active ?? null },
    { key: "expansion", label: "Expansion opportunities", count: c => c?.counts.expansion ?? null },
    { key: "at_risk",   label: "At risk",                 count: c => c?.counts.atRisk ?? null },
  ];

  // Saying no. Scoped per product, so turning down one suggestion never silences the others —
  // and "product" turns it off for the whole workspace, which is how a catalogue entry that is
  // really a setup fee gets killed once instead of topping every account's list.
  const dismiss = useMutation({
    mutationFn: async (v: { companyId: string; productKey: string; verdict: string }) => {
      const r = await fetch(`${apiUrl}/api/customer-success/dismiss`, {
        method: "POST",
        headers: { ...(auth ?? {}), "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId, ...v }),
      });
      if (!r.ok) throw new Error("dismiss_failed");
      return r.json();
    },
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["cs-accounts", workspaceId] }); },
  });

  // The same chips as before, in the same style; Sales Pipeline and Handoff now list deals.
  const filterChips: { key: string; label: string; color?: string; count: number | null }[] = [
    { key: "accounts", label: "Accounts", count: accountsTotal || withLifecycle.length },
    { key: "sales_pipeline", label: phaseLabelOf("sales_pipeline") ?? "Pipeline", color: LIFECYCLE_COLOR.sales_pipeline, count: scopedPipelineRows.length },
    { key: "handoff", label: phaseLabelOf("handoff") ?? LIFECYCLE_LABEL.handoff, color: LIFECYCLE_COLOR.handoff, count: handoffRows.length },
    // The count comes from the deals payload, which is always loaded; the tab's own (expensive)
    // payload stays lazy. Once it HAS been opened its filtered length wins, so the number agrees
    // with the rows on screen when a search or state filter is on.
    { key: "customer_success", label: "Customer success", color: LIFECYCLE_COLOR.active_customer,
      count: csData ? csRows.length : (dealsData?.customers ?? null) },
  ].filter((c) => VIEWS.includes(c.key));
  const openDeal = (r: DealRow) => {
    if (!dealPages) {
      const path = accountPath(r.companyId);
      navigate(path, { state: recordNavState(uniquePaths(dealRows.map((x) => accountPath(x.companyId))), path) });
      return;
    }
    const path = recordDealPath(r.companyId, r.dealId);
    navigate(path, { state: recordNavState(uniquePaths(dealRows.map((x) => recordDealPath(x.companyId, x.dealId))), path) });
  };

  type AccountRow = (typeof accountRows)[number];
  const dash = <span className="text-muted-foreground/50">—</span>;
  // Rows are a plain page of the list (not a filter over it) only with no segment and no person.
  const plainPage = segment === "all" && (owners.length === 0 || mineOnly);
  const workspaceAccountColumns: Column<AccountRow>[] = [
    {
      key: "company", header: "Company", width: "24%",
      cell: (c) => {
        const meta = metaById.get(c.id);
        return (
          <RecordPreview kind="account" companyId={c.id}>
          <span className="flex w-fit min-w-0 max-w-[360px] items-center gap-2.5">
            <AccountTile name={c.name} domain={c.domain ?? null} />
            {/* The palette's row: the name at 13px regular, what it is in the quiet tone on the same line. */}
            <span className="flex min-w-0 items-baseline gap-2">
              <span className="truncate text-foreground">{c.name}</span>
              {isPersonal(c.id) && (
                <span title="Someone you know, not a deal" className="flex-shrink-0 text-[11.5px] text-ink-2">Network</span>
              )}
              {segment === "all" && meta?.status === "client" && (
                <span className="flex-shrink-0 text-[11.5px] text-ink-2">Customer</span>
              )}
              {meta?.status === "cancelled" && (
                <span title="A customer who cancelled" className="flex-shrink-0 text-[11.5px] text-muted-foreground/70">Cancelled</span>
              )}
              {c.domain && <span className="min-w-0 truncate text-[11.5px] text-muted-foreground/60">{c.domain}</span>}
            </span>
          </span>
          </RecordPreview>
        );
      },
    },
    {
      key: "people", header: "People",
      cell: (c) => <PeopleStack contacts={c.contacts ?? []} total={c.contactCount ?? (c.contacts?.length ?? 0)} onOpenPerson={(id) => navigate(`/contacts/${id}`)} />,
    },
    { key: "icp", header: "ICP", cell: (c) => <IcpScore score={c.icpScore} /> },
    { key: "tier", header: "Tier", cell: (c) => <TierMark score={c.icpScore} /> },
    {
      key: "open", header: "Open deals", align: "right",
      cell: (c) => { const pl = pipelineByCompany.get(c.id); return pl?.count ? pl.count.toLocaleString() : dash; },
    },
    {
      key: "pipeline", header: "Pipeline", align: "right",
      cell: (c) => { const pl = pipelineByCompany.get(c.id); return pl && pl.value > 0 && !isPersonal(c.id) ? money(pl.value) : dash; },
    },
    {
      key: "won", header: "Closed revenue", align: "right",
      cell: (c) => {
        const won = wonByCompany.get(c.id);
        return won && won.value > 0
          ? <span title={`${won.count} won deal${won.count === 1 ? "" : "s"}`}>{money(won.value)}</span>
          : won?.count ? <span className="text-muted-foreground/70">{won.count} won</span> : dash;
      },
    },
    // MRR is a customer's number; a prospect has none to show.
    ...(segment !== "prospects" ? [{
      key: "mrr", header: "MRR", align: "right" as const,
      cell: (c: AccountRow) => { const m = metaById.get(c.id)?.mrr; return m != null && m > 0 ? money(m) : dash; },
    }] : []),
    {
      key: "owner", header: "Owner",
      cell: (c) => {
        const o = metaById.get(c.id)?.owner;
        return o ? <span className="flex min-w-0 max-w-[150px] items-center gap-2" title={o}><OwnerAvatar name={o} /><span className="truncate text-ink-2">{o}</span></span> : dash;
      },
    },
    {
      key: "activity", header: "Last activity",
      cell: (c) => c.lastActivityAt ? <span className="text-[12px] text-muted-foreground/70">{when(c.lastActivityAt)}</span> : dash,
    },
    {
      key: "menu", header: <span className="sr-only">Actions</span>, width: "44px", className: "pl-0 pr-3",
      cell: (c) => <RowMenu onMarkClient={() => markClient(c.id)} onMarkPersonal={() => markPersonal(c.id)} onDelete={() => deleteCompany(c.id)} />,
    },
  ];

  const col = (key: string) => workspaceAccountColumns.find(c => c.key === key)!;
  const dealsColumn: Column<AccountRow> = { key: 'deals', header: 'Deals', cell: c => {
    const total = overviewById.get(c.id)?.deal_count;
    if (total === undefined) return accountOverview.error ? 'Unavailable' : accountOverview.isLoading ? '…' : dash;
    if (isPersonal(c.id)) return dash;
    // Workspace shows how many are still open beside the total; the API plan, the total alone.
    const open = api ? 0 : (pipelineByCompany.get(c.id)?.count ?? 0);
    return total ? <span className="tabular-nums">{total}{open ? <span className="text-muted-foreground"> · {open} open</span> : null}</span> : dash;
  } };
  // The latest signal (GET-894): a tinted pill for the kind, then what was said; the full line on hover.
  const signalColumn: Column<AccountRow> = { key: 'signal', header: 'Latest signal', cell: c => {
    const signal = overviewById.get(c.id)?.latest_signal;
    if (!signal) return accountOverview.error ? <span className="text-[11px] text-risk">Unavailable</span> : accountOverview.isLoading ? '…' : dash;
    const tag = signalTag(signal);
    return <span className="flex max-w-[340px] items-center gap-1.5 text-[12px]" title={tag.tooltip}>
      <span className={`shrink-0 whitespace-nowrap rounded-full px-1.5 py-px text-[11px] font-medium ${tag.className}`}>{tag.label}</span>
      {tag.text && <span className="min-w-0 truncate text-ink-2">{tag.text}</span>}
    </span>;
  } };
  const accountColumns: Column<AccountRow>[] = api ? [
    col('company'), { ...col('people'), header: 'Contacts' }, dealsColumn, signalColumn,
    { ...col('activity'), header: 'Last activity' }, col('icp'),
  ] : [
    // Workspace (GET-864): the API plan's columns plus what sales works from, Pipeline and Owner.
    // Tier is the ICP bar's colour already; Closed revenue and MRR belong to the Customers tab.
    col('company'), { ...col('people'), header: 'Contacts' }, dealsColumn, signalColumn,
    col('pipeline'), col('owner'), col('activity'), col('icp'),
    ...(segment === 'customers' ? [col('won'), col('mrr')] : []),
    col('menu'),
  ];

  const segmentOptions = ([["all", "All"], ["prospects", "Prospects"], ["customers", "Customers"]] as const).map(([k, label]) => {
    const n = segmentCounts[k];
    const more = k !== "all" && hasMore;
    // Counted over the accounts loaded so far, so a page with more to load says so with a "+".
    return more
      ? { value: k, label: <>{label}<span className="font-normal tabular-nums text-muted-foreground" title="Counted over the accounts loaded so far">{n.toLocaleString()}+</span></> }
      : { value: k, label, count: n };
  });
  const hasStrip = (view === "sales_pipeline" && (pipelineOptions.length > 1 || stageChips.length > 0)) || view === "customer_success";

  // The API plan's shared top bar (GET-621) carries the title; the network and location filters
  // sit behind the Filter button in this page's toolbar, next to the search.
  const inShell = useInApiShell();

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background">
      <PageToolbar>
        {/* One view is not a choice: on the workspace plan this page is the account list alone,
            so the view tabs only appear when there is a second view to switch to. */}
        {filterChips.length > 1 && (
          <ViewTabs aria-label="Account views" value={view} onChange={(v) => setView(v)}
            options={filterChips.map((f) => ({ value: f.key, label: f.label, count: f.count ?? undefined }))} />
        )}
        {filterChips.length > 1 && view === "accounts" && hasCustomerStatus && <span aria-hidden className="mx-1 hidden h-4 w-px bg-border sm:block" />}
        {/* Prospect or customer, from the CRM's own customer status. Hidden until the server
            sends that status, because a filter that sorts everything into one bucket lies. */}
        {!api && view === "accounts" && hasCustomerStatus && (
          <ViewTabs<Segment> aria-label="Account type" value={segment} onChange={setSegment} options={segmentOptions} />
        )}
        {scopeId && accountScope && (
          <span className="inline-flex h-7 max-w-[260px] items-center gap-1 rounded-lg border border-border bg-card pl-2.5 pr-1 text-[12px] text-foreground">
            <span className="truncate" title={accountScope.title}>{accountScope.chip(companiesPage?.scope?.name ?? "…")}</span>
            <button type="button" onClick={clearScope} aria-label={accountScope.clearLabel} className="flex-shrink-0 rounded p-0.5 text-muted-foreground hover:bg-hover hover:text-foreground">
              <X className="size-3.5" />
            </button>
          </span>
        )}
        <div className="hidden flex-1 sm:block" />
        <label className="inline-flex h-7 w-full items-center gap-[7px] rounded-lg border border-border bg-card px-[9px] text-muted-foreground focus-within:border-foreground/30 sm:w-[200px]">
          <Search className="size-3.5 flex-shrink-0" />
          <input value={q} onChange={e => setQ(e.target.value)}
            placeholder={view === "accounts" ? "Search accounts" : view === "customer_success" ? "Search customers" : "Search deals"}
            aria-label={view === "accounts" ? "Search accounts" : view === "customer_success" ? "Search customers" : "Search deals"}
            className="h-full w-full min-w-0 bg-transparent text-[12.5px] text-foreground outline-none placeholder:text-muted-foreground" />
          {q && (
            <button type="button" onClick={() => setQ("")} aria-label="Clear search" className="flex-shrink-0 hover:text-foreground">
              <X className="size-3.5" />
            </button>
          )}
        </label>
        {inShell && !scopeId && (
          <ToolbarFilter active={(appliedCountry ? 1 : 0) + (showNetwork ? 0 : 1)} className="w-[290px]">
            <FilterMenu groups={[
              {
                key: "network", label: "Network", icon: Network, defaultValue: "shown",
                options: [{ value: "hidden", label: "Hidden" }, { value: "shown", label: "Shown" }],
                selected: [showNetwork ? "shown" : "hidden"],
                onChange: ([v]) => { setShowNetwork(v === "shown"); setPages(1); },
              },
              {
                key: "location", label: "Location", icon: MapPin, defaultValue: "all",
                options: countryOptions.length ? [{ value: "all", label: "All locations" }, ...countryOptions.map((o) => ({ value: o.country, label: o.country, count: o.accounts }))] : [],
                selected: [appliedCountry ?? "all"],
                onChange: ([v]) => chooseCountry(v),
              },
            ]} />
          </ToolbarFilter>
        )}
        {view === "accounts" && !scopeId && (
          <OwnerFilter people={ownerPeople} meId={meId} value={owners} onChange={setOwners}
            unassignedCount={ownerCounts.unassigned || undefined} />
        )}
        {/* Which market. Accounts, the pipeline tabs and the counts all follow it, and it
            survives a reload. The focus country also keeps accounts whose country the CRM never
            recorded — they are unrecorded, not foreign. */}
        {!inShell && !scopeId && (
          <select value={showNetwork ? "show" : "hide"} onChange={e => { setShowNetwork(e.target.value === "show"); setPages(1); }} aria-label="Network accounts"
            className="h-7 rounded-lg border border-border bg-card px-2 text-[12.5px] font-medium text-foreground">
            <option value="hide">Network hidden</option>
            <option value="show">Network shown</option>
          </select>
        )}
        {!inShell && !scopeId && <LocationFilter quiet applied={appliedCountry} options={countryOptions} onChange={chooseCountry} />}
      </PageToolbar>

      {hasStrip && (
      <div className="flex-shrink-0 px-4 pt-2.5">
        {/* Which pipeline. Only when there is a choice to make: one pipeline needs no selector,
            and a workspace with no CRM has none at all. */}
        {view === "sales_pipeline" && pipelineOptions.length > 1 && (
          <div className="flex items-center gap-1.5 overflow-x-auto pb-2 pl-0.5">
            {pipelineOptions.map((p) => (
              <button key={p.id} onClick={() => setPipelineId(p.id)} className={stripChip(pipelineId === p.id)}
                title={p.is_primary ? "The workspace's own pipeline" : undefined}>
                {(p.name ?? p.id).trim()}
                {/* Counted off the rows on screen, so the button agrees with its own strip. */}
                <span className="tabular-nums text-muted-foreground/50"> {dealsByPipeline.get(p.id) ?? 0}</span>
              </button>
            ))}
          </div>
        )}

        {/* The stages its deals sit at, in their CRM's words — for the pipeline on screen. */}
        {view === "sales_pipeline" && stageChips.length > 0 && (
          <div className="flex items-center gap-1.5 overflow-x-auto pb-2 pl-0.5">
            {/* No "all stages" chip: the strip IS the filter, so a selected stage toggles off
                rather than needing a separate button to mean "no filter". */}
            {stageChips.map((st) => (
              <button key={st.label}
                onClick={() => setSubFilter(sameLabel(subFilter, st.label) ? "all" : st.label)}
                className={stripChip(sameLabel(subFilter, st.label))}>
                {st.label} <span className="tabular-nums text-muted-foreground/50">{st.n}</span>
              </button>
            ))}
          </div>
        )}

        {/* Customer success reads exactly like the pipeline: one strip in the same place the
            stages sit. Three buttons, three questions — and the money each one is worth on the
            right, because "42 at risk" and "42 at risk worth $31,000 a month" are different
            sentences and only one of them gets a meeting booked. */}
        {view === "customer_success" && (
          <div className="flex items-center gap-1.5 overflow-x-auto pb-2 pl-0.5">
            {CS_BUCKETS.map(b => (
              <button key={b.key} onClick={() => setCsBucket(b.key)} className={stripChip(csBucket === b.key)}>
                {b.label} <span className="tabular-nums text-muted-foreground/50">{b.count(csData) ?? "—"}</span>
              </button>
            ))}
            <div className="ml-auto flex flex-shrink-0 items-center gap-3 pl-3 text-[11.5px] text-muted-foreground/60">
              {csData && (
                <span className="tabular-nums">
                  {csBucket === "expansion"
                    ? `${fmtMoney(csData.totals.expansionValue)}/mo CRM-priced upside on these`
                    : csBucket === "at_risk"
                    ? `${fmtMoney(csData.totals.atRiskMrr)}/mo at risk`
                    : `${fmtMoney(csData.totals.mrr)}/mo recurring`}
                </span>
              )}
              {/* Where the numbers come from. A CS lead will ask, and the honest answer changes
                  what they trust: before the health sync has run we are guessing from deals. */}
              {csData && !csData.healthReady && (
                <span className="rounded bg-amber-500/10 px-1.5 py-0.5 text-amber-600">from deals only</span>
              )}
              {/* What reading the conversations actually bought. Without this the page looks the
                  same as any CRM view; with it, a number says how many of these rows exist only
                  because somebody's call got read. */}
              {csData?.minedReady && csData.fromConversation && csBucket !== "active" && (
                <span className="rounded bg-muted px-1.5 py-0.5 tabular-nums">
                  {csBucket === "expansion" ? csData.fromConversation.expansion : csData.fromConversation.atRisk} from conversations
                </span>
              )}
            </div>
          </div>
        )}
      </div>
      )}

      {view === "accounts" ? (
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
        <DataTable
          aria-label="Accounts"
          columns={accountColumns}
          rows={accountRows}
          rowKey={(c) => c.id}
          onRowClick={(c) => onOpen(c.id, c.name, uniquePaths(accountRows.map((x) => accountPath(x.id))))}
          keyboard
          minWidth={segment === "customers" ? 1120 : 980}
          loading={loadingCo && companies.length === 0}
          empty={
            <EmptyState className="mx-4 mt-4"
              title={segment === "customers" ? (hasMore ? "No customers among the accounts loaded so far." : "No customers.")
                : segment === "prospects" ? (hasMore ? "No prospects among the accounts loaded so far." : "No prospects.")
                : debouncedQ ? "No accounts match." : "No active accounts yet."}
              body={segment === "all" && !debouncedQ ? "An account shows here once it has a deal or is in a conversation with you. Search finds every account." : undefined} />
          }
        />
        {accountRows.length > 0 && (
          <div className="flex items-center justify-between gap-3 px-5 py-3">
            {/* Under a segment or a person the loaded count is the honest one: the rows shown are
                a filter over the accounts loaded, not a page of the segment. */}
            <span className="text-[11.5px] tabular-nums text-muted-foreground/70">
              Showing {(plainPage ? accountRows.length : rawCompanies.length).toLocaleString()} of {accountsTotal.toLocaleString()}{plainPage ? "" : " accounts"}
            </span>
            {hasMore && <Button variant="outline" size="sm" onClick={() => setPages(p => p + 1)}>Load more</Button>}
          </div>
        )}
      </div>
      ) : (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col px-4 pb-6 pt-2.5">
        {/* The table scrolls sideways inside this box when the window is narrower than its
            columns; the page itself never does. */}
        <div className="min-h-0 flex-1 overflow-auto rounded-xl border border-border bg-card">
          {view === "customer_success" ? (
          <div className="min-w-[960px]">
            {/* One table for all three buckets. The columns that change are the last two: the
                reason, and the number that reason is worth. Everything else about a customer is
                the same fact whichever question you came here to ask. */}
            <div className="sticky top-0 z-20 flex items-center border-b border-border/60 bg-card px-4 py-2.5">
              <span className="min-w-0 flex-1 truncate pr-3 text-[12px] font-medium text-muted-foreground/70">Customer</span>
              <HdrCell label="MRR" w={90} />
              <HdrCell label="Users" w={80} />
              <HdrCell label="CS owner" w={110} />
              <HdrCell label={csBucket === "expansion" ? "Why now — the opening" : csBucket === "at_risk" ? "Why now — the risk" : "Products"} w={300} />
              <HdrCell label={csBucket === "expansion" ? "CRM upside" : "Last contact"} w={110} />
            </div>

            {loadingCs && <div className="py-12 text-center text-[13px] text-muted-foreground/70">Loading…</div>}

            {!loadingCs && csRows.length === 0 && (
              <div className="py-12 text-center text-[13px] text-muted-foreground/70">
                {csBucket === "active"
                  ? "No customers yet. An account appears here once your CRM marks it a customer."
                  : csBucket === "expansion"
                  ? "No expansion openings. One appears when a customer asks for something they do not have yet, on a call or in an email."
                  : "Nobody is flagged at risk. A customer appears here when they say they are leaving, a churn flag opens, nobody is logging in, or two warning signs line up."}
              </div>
            )}

            {!loadingCs && csRows.map(a => {
              const reasons = csBucket === "expansion" ? a.expansionReasons : a.riskReasons;
              const top = reasons[0];
              // Seats bought versus seats used. The gap IS the story on this page: an account
              // paying for twelve and logging in with none is the clearest save in the list.
              const users = a.activeUsers == null ? null : `${a.activeUsers}${a.totalUsers ? `/${a.totalUsers}` : ""}`;
              const dead = a.activeUsers === 0 && (a.mrr ?? 0) > 0;
              return (
                <div key={a.companyId} role="button" tabIndex={0} onClick={() => onOpen(a.companyId, a.name ?? undefined, uniquePaths(csRows.map((x) => accountPath(x.companyId))))}
                  className="group flex w-full cursor-pointer items-center border-b border-border/45 px-4 py-3 text-left transition-colors last:border-0 hover:bg-muted/40">
                  <div className="flex min-w-0 flex-1 items-center gap-2 pr-3">
                    {faviconUrl(a.domain)
                      ? <img src={faviconUrl(a.domain)!} alt="" className="h-5 w-5 flex-shrink-0 rounded object-contain bg-white border border-border/60" />
                      : <span className="h-5 w-5 flex-shrink-0 rounded bg-muted flex items-center justify-center text-[10px] font-semibold text-muted-foreground/70">{(a.name ?? "?").charAt(0).toUpperCase()}</span>}
                    <div className="min-w-0">
                      <RecordPreview kind="account" companyId={a.companyId}>
                        <div className="w-fit max-w-full truncate text-[13px] font-medium text-foreground">{a.name ?? "—"}</div>
                      </RecordPreview>
                      <div className="truncate text-[12px] text-muted-foreground/70">{[a.tier, a.industry].filter(Boolean).join(" · ") || a.domain || ""}</div>
                    </div>
                  </div>
                  <div className="flex-shrink-0 pr-2 text-[13px] tabular-nums" style={{ width: 90 }}>
                    {a.mrr ? <span className="font-medium text-foreground/90">{fmtMoney(a.mrr)}</span> : <span className="text-muted-foreground/40">—</span>}
                  </div>
                  <div className={`flex-shrink-0 pr-2 text-[13px] tabular-nums ${dead ? "font-medium text-amber-600" : "text-muted-foreground"}`} style={{ width: 80 }}>
                    {users ?? <span className="text-muted-foreground/40">—</span>}
                  </div>
                  <div className="flex-shrink-0 truncate pr-2 text-[12px] text-muted-foreground" style={{ width: 110 }}>
                    {a.csOwner ?? <span className="text-muted-foreground/40">unassigned</span>}
                  </div>
                  {/* The reason, and where it came from. A rep who cannot tell a CRM field from
                      something a customer said on a call cannot judge how hard to lean on it. */}
                  <div className="flex-shrink-0 pr-3" style={{ width: 300 }}>
                    {csBucket === "active" ? (
                      <span className="truncate text-[12px] text-muted-foreground/70">
                        {a.products.length ? a.products.slice(0, 3).join(", ") : "not itemised"}
                      </span>
                    ) : !top ? (
                      <span className="text-[12px] text-muted-foreground/50">—</span>
                    ) : (
                      <div>
                        <div className="flex items-start gap-1.5">
                          <span className={`mt-[3px] h-1.5 w-1.5 flex-shrink-0 rounded-full ${REASON_DOT[top.tier] ?? "bg-muted-foreground/40"}`} />
                          <span className="text-[12px] leading-snug text-foreground">{top.text}</span>
                        </div>
                        {/* The customer's own sentence. This is the row's whole reason to exist:
                            a rep opens the call with it rather than with a score, and can check
                            it against the CRM in one click. Italic and quoted so it is never
                            mistaken for something we concluded. */}
                        {top.quote ? (
                          <div className="pl-3">
                            <div className="line-clamp-2 text-[11px] italic leading-snug text-muted-foreground">“{top.quote}”</div>
                            <div className="flex items-center gap-1.5 pt-0.5">
                              <span className="text-[10px] text-muted-foreground/60">
                                {[top.via, top.at ? relTime(top.at) : null].filter(Boolean).join(" · ")}
                              </span>
                              {/* The CRM and the customer disagree. Say so — this is the most
                                  useful row on the page, not an inconsistency to smooth over. */}
                              {top.conflict && (
                                <span className="flex-shrink-0 rounded bg-amber-500/10 px-1 text-[10px] text-amber-600">{top.conflict}</span>
                              )}
                            </div>
                          </div>
                        ) : (
                          <div className="flex items-center gap-1.5 pl-3">
                            {top.detail && <span className="truncate text-[11px] text-muted-foreground/70">{top.detail}</span>}
                            {top.evidence === "said" && (
                              <span className="flex-shrink-0 rounded bg-muted px-1 text-[10px] text-muted-foreground/80">on a call</span>
                            )}
                          </div>
                        )}
                        {reasons.length > 1 && (
                          <div className="pl-3 text-[11px] text-muted-foreground/50">+{reasons.length - 1} more</div>
                        )}
                      </div>
                    )}
                  </div>
                  <div className="flex-shrink-0 pr-2 text-[13px] tabular-nums" style={{ width: 110 }}>
                    {csBucket === "expansion"
                      ? (a.upgradeValue ? <span className="text-muted-foreground">{fmtMoney(a.upgradeValue)}/mo</span> : <span className="text-muted-foreground/40">—</span>)
                      : <span className={a.daysQuiet == null || a.daysQuiet > 90 ? "text-foreground" : "text-muted-foreground"}>{relTime(a.lastActivityAt)}</span>}
                  </div>
                </div>
              );
            })}
          </div>
          ) : (
          <div className="min-w-[1120px]">
            <div className="sticky top-0 z-20 flex items-center border-b border-border/60 bg-card px-4 py-2.5">
              <span className="min-w-0 flex-1 truncate pr-3 text-[12px] font-medium text-muted-foreground/70">Deal</span>
              <HdrCell label="Account" w={200} />
              <HdrCell label="People" w={110} />
              <HdrCell label="Owner" w={130} />
              <HdrCell label="Value" w={100} />
              <HdrCell label="Stage" w={170} />
              <HdrCell label={view === "handoff" ? "Won" : "Close date"} w={100} />
              <HdrCell label="Last activity" w={110} />
            </div>
            {(loadingCo || loadingDeals) && dealRows.length === 0 && <div className="py-12 text-center text-[13px] text-muted-foreground/70">Loading…</div>}
            {dealRows.map(r => {
              const overdue = view === "sales_pipeline" && !!r.closeDate && Date.parse(r.closeDate) < Date.now();
              return (
                <div key={r.key} role="button" tabIndex={0} onClick={() => openDeal(r)}
                  className="group flex w-full cursor-pointer items-center border-b border-border/45 px-4 py-3 text-left transition-colors last:border-0 hover:bg-muted/40">
                  <div className="flex min-w-0 flex-1 items-center gap-2 pr-3">
                    <RecordPreview kind="deal" companyId={r.companyId} dealId={r.dealId}>
                      <span className="min-w-0 truncate text-[13px] font-medium text-foreground">{r.name}</span>
                    </RecordPreview>
                    {/* A deal from another pipeline says which one. Deals in the primary pipeline stay quiet. */}
                    {!r.isPrimaryPipeline && r.pipeline && (
                      <span className="flex-shrink-0 rounded border border-border/60 bg-muted/40 px-1.5 py-px text-[10.5px] font-medium text-muted-foreground/70" title={`${r.pipeline} pipeline`}>
                        {r.pipeline}
                      </span>
                    )}
                    {/* Why this open deal looks dead. Evidence, not a verdict: HubSpot still says
                        open, and we never overwrite that — the tooltip carries the reasoning so a
                        rep can decide and close it in their CRM. On a real workspace more than half
                        the open deals have a close date that has already passed. */}
                    {r.verdict && (
                      <span
                        className="flex-shrink-0 rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-px text-[10.5px] font-medium text-amber-700 dark:text-amber-400"
                        title={r.verdict.signals.map(s => [s.text, s.detail].filter(Boolean).join(' — ')).join('\n')}>
                        {r.verdict.headline.text}
                        {r.verdict.count > 1 && <span className="ml-1 opacity-60">+{r.verdict.count - 1}</span>}
                      </span>
                    )}
                  </div>
                  <div className="flex-shrink-0 pr-3 flex items-center gap-2 min-w-0" style={{ width: 200 }}>
                    {faviconUrl(r.companyDomain)
                      ? <img src={faviconUrl(r.companyDomain)!} alt="" className="h-5 w-5 flex-shrink-0 rounded object-contain bg-white border border-border/60" />
                      : <span className="h-5 w-5 flex-shrink-0 rounded bg-muted flex items-center justify-center text-[10px] font-semibold text-muted-foreground/70">{r.companyName.charAt(0).toUpperCase()}</span>}
                    <RecordPreview kind="account" companyId={r.companyId}>
                      <span className="truncate text-[13px] text-foreground/85">{r.companyName}</span>
                    </RecordPreview>
                  </div>
                  <div className="flex-shrink-0 pr-2" style={{ width: 110 }}>
                    <PeopleStack contacts={r.people} total={r.peopleTotal} onOpenPerson={(id) => navigate(`/contacts/${id}`)} />
                  </div>
                  <div className="flex-shrink-0 truncate pr-2 text-[13px] text-foreground/80" style={{ width: 130 }} title={r.owners.join(", ")}>
                    {r.owners.length ? `${r.owners[0]}${r.owners.length > 1 ? ` +${r.owners.length - 1}` : ""}` : <span className="text-muted-foreground/40">—</span>}
                  </div>
                  <div className="flex-shrink-0 pr-2 text-[13px] tabular-nums" style={{ width: 100 }}>
                    {r.value != null && r.value > 0
                      ? <span className="font-medium text-foreground/90">{fmtMoney(r.value)}</span>
                      : <span className="text-muted-foreground/40">—</span>}
                  </div>
                  <div className="flex-shrink-0 truncate pr-2 text-[13px] font-medium" style={{ width: 170, color: r.stageColor }}>{r.stageLabel}</div>
                  <div className={`flex-shrink-0 pr-2 text-[13px] tabular-nums ${overdue ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground"}`} style={{ width: 100 }}>
                    {shortDay(r.closeDate) ?? "—"}
                  </div>
                  <div className="flex-shrink-0 pr-2 text-[13px] text-muted-foreground" style={{ width: 110 }}>{relTime(r.lastActivityAt)}</div>
                </div>
              );
            })}
            {!(loadingCo || loadingDeals) && dealRows.length === 0 && (
              <div className="py-12 text-center text-[13px] text-muted-foreground/70">{view === "handoff" ? "No won deals yet." : "No open deals."}</div>
            )}
          </div>
          )}
        </div>
      </div>
      )}
    </div>
  );
}
