import { useCallback, useEffect, useMemo, useState } from "react";
import { GetStartedButton } from "@/pages/GetStarted";
import { InstanceSetupCard } from "@/components/settings/InstanceSetupCard";
import { BackfillProgressButton } from "@/components/BackfillProgressButton";
import { usePlan } from "@/hooks/usePlan";
import { isApiTier } from "@/config/plans";
import { Check, Filter, RefreshCw } from "lucide-react";
import { format } from "date-fns";
import { useAuth } from "@/contexts/AuthContext";
import { freshAccessToken } from "@/lib/freshToken";
import { ApiHomeStats } from "@/components/home/ApiHomeStats";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ApiTopBarFilter, useApiTopBar, useInApiShell } from "@/components/shell/ApiTopBar";
import { cn } from "@/lib/utils";
import { num } from "@/lib/format";
import { toolLogo } from "@/lib/toolLogo";
import { ListTile } from "@/components/ui/list";
import { PageToolbar } from "@/components/ui/page-top-bar";

const apiUrl = import.meta.env.VITE_API_URL ?? "";

// Activity = the raw operational stream, as a columnar ledger: Time · Source · Call ·
// Detail · Status. What actually happened — a Fireflies webhook received, a LinkedIn
// message sent, a sync, an enrichment. The full workspace op log (webhooks/syncs aren't
// owner-stamped, so the member-scoped feed would hide exactly what you want to see).
/** One conversation we read, and what it billed. `estimated` marks a meeting whose provider
 *  gave us no length, so it bills at the measured median rather than a number we invented. */
type Conversation = {
  id: string; kind: string; label: string; source: string; when: string;
  minutes: number | null; estimated: boolean; credits: number; summary: string | null;
  /** What happened to it. An email thread carries the reader's own record: read (and found
   *  something), read with nothing new, skipped by a rule (`reason` says which), or waiting for
   *  the next run. A call or meeting is read when it produced a claim, else unknown (null). */
  status: "failed" | "read" | "nothing_new" | "skipped" | "waiting" | null;
  reason?: string | null;
  /** Messages in an email thread — one row, one credit, however many there are. */
  messages?: number | null;
  read_at?: string | null;
};

const STATUS_OPTIONS: [string, string][] = [
  ["read", "Read"], ["nothing_new", "Nothing new"], ["skipped", "Skipped"], ["waiting", "Waiting"], ["failed", "Failed"],
];
const STATUS_TEXT: Record<string, string> = { read: "Read", nothing_new: "Nothing new", waiting: "Waiting", failed: "Failed" };

const SOURCE_LABEL: Record<string, string> = {
  linkedin: "LinkedIn", gmail: "Gmail", smtp: "Email", fireflies: "Fireflies", stripe: "Stripe",
  calendly: "Calendly", cal_com: "Cal.com", rb2b: "RB2B", signalbase: "Signalbase", apollo: "Apollo",
  prospeo: "Prospeo", heyreach: "HeyReach", instantly: "Instantly", unipile: "Unipile", hubspot: "HubSpot",
  slack: "Slack", composio: "Composio", attio: "Attio", stage_derivation: "Pipeline", mcp: "Agent",
  sdk: "Agent", agent: "Agent", api: "API", web: "App",
};
const prettySource = (s: string) => SOURCE_LABEL[(s ?? "").toLowerCase()] ?? (s ? s[0].toUpperCase() + s.slice(1) : "System");

// Windows the log is worth asking for. 30 is the default, so it does not count as a filter.
const WINDOWS: [string, number | null][] = [
  ["Last 7 days", 7], ["Last 30 days", 30], ["Last 60 days", 60], ["Last 90 days", 90], ["All time", null],
];

function Row({ label }: { label: string }) {
  return <div className="px-2 pb-1 pt-2 text-[11px] font-medium text-muted-foreground">{label}</div>;
}

function Opt({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} className="flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-left text-[13px] text-foreground transition-colors duration-fast hover:bg-hover">
      <span className="truncate">{children}</span>
      {on && <Check className="h-3.5 w-3.5 flex-shrink-0 text-foreground" />}
    </button>
  );
}

export default function Activity(_props: { mine?: boolean } = {}) {
  const { plan } = usePlan();
  const apiTier = isApiTier(plan);
  const { session, userData } = useAuth();
  const token = session?.access_token;
  const workspaceId = userData?.workspace?.id ?? "";
  const [convos, setConvos] = useState<Conversation[] | null>(null);
  const [loading, setLoading] = useState(false);
  // The window is a SERVER filter — it changes what we ask for. Sources and status are CLIENT
  // filters over what came back, because the log is already capped at 200 rows and re-fetching
  // to hide a row nobody wants is a round trip for nothing.
  const [days, setDays] = useState<number | null>(30);
  const [sources, setSources] = useState<Set<string>>(new Set());
  // Which statuses to show; empty means all.
  const [statuses, setStatuses] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    if (!workspaceId) return;
    setLoading(true);
    try {
      const t = (await freshAccessToken()) ?? token;
      const window = days == null ? "all" : String(days);
      const c = await fetch(`${apiUrl}/api/activity-stats/conversations?workspaceId=${workspaceId}&days=${window}&limit=200`, { headers: { Authorization: `Bearer ${t}` } });
      const cd = c.ok ? await c.json() : { items: [] };
      setConvos(Array.isArray(cd.items) ? cd.items : []);
    } catch { setConvos([]); } finally { setLoading(false); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, days]);

  useEffect(() => { load(); }, [load]);

  // The sources actually present, so the menu never offers a filter that returns nothing.
  const presentSources = useMemo(() => {
    const seen = new Map<string, string>();
    for (const c of convos ?? []) {
      const key = (c.source ?? "").toLowerCase();
      if (key && !seen.has(key)) seen.set(key, prettySource(c.source));
    }
    return [...seen.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [convos]);

  const shownConvos = useMemo(() => (convos ?? []).filter((c) => {
    if (sources.size && !sources.has((c.source ?? "").toLowerCase())) return false;
    if (statuses.size && !statuses.has(c.status ?? "unknown")) return false;
    return true;
  }), [convos, sources, statuses]);
  const creditTotal = shownConvos.reduce((n, c) => n + c.credits, 0);

  const activeCount = sources.size + statuses.size + (days === 30 ? 0 : 1);
  const toggleStatus = (key: string) => setStatuses((prev) => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });
  const toggleSource = (key: string) => setSources((prev) => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });
  const clearAll = () => { setDays(30); setSources(new Set()); setStatuses(new Set()); };

  // The API plan's shared top bar (GET-621) carries the title, Get started, the filter and the
  // refresh; the page keeps only the backfill progress under it.
  const inShell = useInApiShell();
  useApiTopBar({ onRefresh: load, refreshing: loading });
  const filterContent = (
    <>
      <Row label="Window" />
      {WINDOWS.map(([label, value]) => (
        <Opt key={label} on={days === value} onClick={() => setDays(value)}>{label}</Opt>
      ))}
      {presentSources.length > 0 && (
        <>
          <Row label="Source" />
          {presentSources.map(([key, label]) => (
            <Opt key={key} on={sources.has(key)} onClick={() => toggleSource(key)}>{label}</Opt>
          ))}
        </>
      )}
      <Row label="Status" />
      {STATUS_OPTIONS.map(([key, label]) => (
        <Opt key={key} on={statuses.has(key)} onClick={() => toggleStatus(key)}>{label}</Opt>
      ))}
      {!!activeCount && (
        <button
          onClick={clearAll}
          className="mt-1 flex w-full items-center rounded-lg px-2 py-1.5 text-[13px] text-muted-foreground transition-colors duration-fast hover:bg-hover hover:text-foreground"
        >
          Clear filters
        </button>
      )}
    </>
  );

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {inShell ? (
        <>
          <ApiTopBarFilter active={activeCount} className="max-h-[70vh] overflow-y-auto p-1">{filterContent}</ApiTopBarFilter>
          <div className="flex flex-shrink-0 items-center justify-end gap-2 px-5 pt-4 empty:hidden">
            <BackfillProgressButton />
          </div>
        </>
      ) : (
      // No h1: the app's top bar names the page. What the API plan's bar carries — the filter
      // and the refresh — sits in the page's own toolbar here (GET-660).
      <PageToolbar className="flex-shrink-0 justify-end px-4 sm:px-5">
        {/* Onboarding, until it is done (GET-517): the API plan has no agent to walk them through it. */}
        {apiTier && <BackfillProgressButton />}
        {apiTier && <GetStartedButton />}
        <Popover>
          <PopoverTrigger asChild>
            <button
              title="Filter"
              aria-label={activeCount ? `Filter, ${activeCount} on` : "Filter"}
              className={cn(
                "inline-flex h-7 min-w-7 items-center justify-center gap-1 rounded-lg border border-border bg-card px-1.5 shadow-[0_1px_0_rgba(20,20,18,0.04)] transition-colors duration-fast hover:bg-hover hover:text-foreground",
                activeCount ? "text-foreground" : "text-ink-2",
              )}
            >
              <Filter className="h-3.5 w-3.5" strokeWidth={1.8} />
              {!!activeCount && <span className="text-[11px] font-medium tabular-nums">{activeCount}</span>}
            </button>
          </PopoverTrigger>
          <PopoverContent align="end" className="max-h-[70vh] w-60 overflow-y-auto p-1">{filterContent}</PopoverContent>
        </Popover>
        <button onClick={load} title="Refresh" aria-label="Refresh" className="inline-flex h-7 w-7 items-center justify-center rounded-lg border border-border bg-card text-ink-2 shadow-[0_1px_0_rgba(20,20,18,0.04)] transition-colors duration-fast hover:bg-hover hover:text-foreground">
          <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} strokeWidth={1.8} />
        </button>
      </PageToolbar>
      )}

      <InstanceSetupCard />

      {/* What we connected to and what we read, above the ledger: on the API plan this page is
          the home page and that is the first question it has to answer. The same cards on every
          plan (GET-660); the read counts the Workspace header had ride along as a fourth. */}
      <ApiHomeStats readDays={days} />

      {/* ONE table on every plan (polish pass, GET-657): what we read, and what each read cost —
          the API plan's ledger, which is the refreshed one. */}
      <ApiLedger rows={shownConvos} loading={convos === null} empty={convos !== null && convos.length === 0} days={days} creditTotal={creditTotal} />
    </div>
  );
}

const STATUS_TONE_API: Record<string, string> = {
  read: "text-ink-2",
  nothing_new: "text-muted-foreground/70",
  skipped: "text-muted-foreground/70",
  waiting: "text-warning",
  failed: "text-risk",
};

/** The API plan's ledger (GET-628): the same rows and columns, in the board's table. */
function ApiLedger({ rows, loading, empty, days, creditTotal }: {
  rows: Conversation[]; loading: boolean; empty: boolean; days: number | null; creditTotal: number;
}) {
  // The ⌘K palette's card (GET-658, round 2): small light column labels, rows inset with a
  // rounded hover band and no lines between, each source led by its tool's logo.
  const th = "h-8 whitespace-nowrap px-2 text-[11.5px] font-normal text-muted-foreground/70";
  const td = "h-10 whitespace-nowrap px-2 py-0 text-[13px] first:rounded-l-lg last:rounded-r-lg";
  return (
    <div className="min-h-0 flex-1 overflow-auto px-4 pb-5 pt-4 sm:px-5">
      <div className="overflow-hidden rounded-2xl border border-border/70 bg-card p-2">
        <Table className="min-w-[900px] text-[13px]">
          <TableHeader>
            <TableRow className="border-0 hover:bg-transparent">
              <TableHead className={cn(th, "w-[110px]")}>Time</TableHead>
              <TableHead className={cn(th, "w-[130px]")}>Source</TableHead>
              <TableHead className={th}>Read</TableHead>
              <TableHead className={th}>Detail</TableHead>
              <TableHead className={cn(th, "w-[70px] text-right")}>Credits</TableHead>
              <TableHead className={cn(th, "w-[110px] text-right")}>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((c) => (
              <TableRow key={c.id} className="border-0 hover:bg-hover">
                <TableCell className={cn(td, "text-[12px] tabular-nums text-muted-foreground/70")}>{format(new Date(c.when), "MMM d, HH:mm")}</TableCell>
                <TableCell className={td}>
                  <span className="flex items-center gap-2">
                    {toolLogo(c.source) && <ListTile><img src={toolLogo(c.source)!} alt="" className="h-3.5 w-3.5 object-contain" /></ListTile>}
                    {prettySource(c.source)}
                  </span>
                </TableCell>
                <TableCell className={cn(td, "max-w-[280px] truncate")}>
                  {c.label}
                  {c.minutes != null && <span className="text-[11.5px] text-muted-foreground/70"> · {c.minutes}m</span>}
                  {(c.messages ?? 0) > 1 && <span className="text-[11.5px] text-muted-foreground/70"> · {c.messages} emails</span>}
                </TableCell>
                <TableCell className={cn(td, "max-w-[360px] truncate text-[12px] text-muted-foreground/70")}>{c.summary ?? ""}</TableCell>
                <TableCell className={cn(td, "text-right tabular-nums")} title={c.estimated ? "No recorded length — billed at the median 30 minutes" : undefined}>
                  {c.credits}{c.estimated && <span className="text-muted-foreground">*</span>}
                </TableCell>
                <TableCell
                  className={cn(td, "text-right text-[12px]", c.status ? STATUS_TONE_API[c.status] : "text-muted-foreground")}
                  title={c.read_at ? `Read ${format(new Date(c.read_at), "MMM d, HH:mm")}` : c.status === "waiting" ? "Read at the next run (02:45 or 14:45 UTC)" : undefined}
                >
                  {c.status === "skipped" ? (c.reason ?? "Skipped") : c.status ? STATUS_TEXT[c.status] : "—"}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {loading && <div className="px-5 py-12 text-center text-[13px] text-muted-foreground/60">Loading…</div>}
        {!loading && rows.length === 0 && (
          <div className="px-5 py-12 text-center text-[13px] text-muted-foreground/60">
            {empty ? `Nothing read in ${days == null ? "any window" : `the last ${days} days`}.` : "Nothing matches these filters."}
          </div>
        )}
        {rows.length > 0 && (
          <div className="flex items-baseline justify-between gap-3 px-2 pb-1 pt-2.5 text-[12px]">
            <span className="text-muted-foreground/60">
              {num(rows.filter((c) => c.status === "read" || c.status === "nothing_new").length)} read of {num(rows.length)} conversations
              {rows.some((c) => c.estimated) && <span> · * billed at the median 30 minutes</span>}
            </span>
            <span className="tabular-nums text-foreground">{num(creditTotal)} credits</span>
          </div>
        )}
      </div>
    </div>
  );
}
