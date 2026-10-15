// Settings > Workspace > Agent activity (GET-898; renamed and trimmed in GET-900): when, how
// often and about what the workspace's agents and scripts called the API and MCP. Admins only
// (the rail hides it from members and the API answers them 403). Reads:
//   GET /api/usage/activity?window=       header stats and activity over time (one SQL
//                                          aggregate); its by_route / by_key / by_client fill the
//                                          list's filter menus, they are not shown as tables
//   GET /api/usage/activity/calls?…       the activity list, newest first, filtered, cursor-paged
// Both read api_request_log (one row per API-key call, GET-623). Never shows an IP or a secret: a
// key is its name. Every request mints its own session token (activityGet + freshAccessToken), so
// switching the window after the tab sat idle does not send a rotated-out token (GET-900).
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { freshAccessToken } from "@/lib/freshToken";
import { cn } from "@/lib/utils";
import { when } from "@/lib/format";
import { SettingsGroup, fieldCls } from "@/components/settings/SettingsKit";
import { SegmentedControl } from "@/components/ui/view-tabs";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { niceScale, useWidth } from "@/components/charts";
import {
  ACTIVITY_WINDOWS, HttpError, UNKNOWN_CLIENT, aboutHref, aboutLabel, activityGet, bucketLabel, callsQuery,
  clientLabel, errorNote, isError, isSignedOut, keyLabel, latencyNote, ms, pct, splitNote, surfaceLabel,
  type Activity, type ActivityWindow, type About, type CallFilters, type CallsPage, type Surface,
} from "@/lib/apiActivity";

const apiUrl = import.meta.env.VITE_API_URL ?? "";

function getJson<T>(path: string, workspaceId: string): Promise<T> {
  const sep = path.includes("?") ? "&" : "?";
  return activityGet<T>(`${apiUrl}${path}${sep}workspaceId=${encodeURIComponent(workspaceId)}`, freshAccessToken);
}

// A 4xx will not fix itself on a retry; a 5xx or a dropped connection might.
const retry = (n: number, err: unknown) => !(err instanceof HttpError && err.status >= 400 && err.status < 500) && !(err instanceof HttpError && err.code === "activity_unavailable") && n < 2;

const ALL = "all";
const muted = "text-muted-foreground/70";
const th = "px-2 py-1.5 text-left text-[11px] font-medium text-muted-foreground/60";
const td = "px-2 py-1.5 text-[12.5px] align-middle";

export function ApiActivity() {
  const { session, userData } = useAuth();
  const signedIn = !!session;
  const ws = userData?.workspace?.id ?? "";
  const [range, setRange] = useState<ActivityWindow>("7d");
  const [filters, setFilters] = useState<CallFilters>({});
  const [search, setSearch] = useState("");

  const activity = useQuery({
    queryKey: ["api-activity", ws, range],
    enabled: signedIn && !!ws,
    staleTime: 30_000,
    retry,
    queryFn: () => getJson<Activity>(`/api/usage/activity?window=${range}`, ws),
  });
  const a = activity.data;
  const unavailable = activity.error instanceof HttpError && activity.error.code === "activity_unavailable";
  const forbidden = activity.error instanceof HttpError && activity.error.status === 403;

  const setFilter = (patch: CallFilters) => setFilters((f) => ({ ...f, ...patch }));

  if (forbidden) {
    return <SettingsGroup><p className={cn("px-2 py-2 text-[13px]", muted)}>Only workspace owners and admins can see agent activity.</p></SettingsGroup>;
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex justify-end">
        <SegmentedControl aria-label="Window" options={ACTIVITY_WINDOWS} value={range} onChange={(v) => setRange(v as ActivityWindow)} />
      </div>

      {unavailable && (
        <SettingsGroup>
          <p className={cn("px-2 py-2 text-[12.5px]", muted)}>
            The summary needs a database update that has not been applied yet. The activity list below still works.
          </p>
        </SettingsGroup>
      )}
      {activity.error && !unavailable && (
        <SettingsGroup>
          <LoadError what="the activity" error={activity.error} retrying={activity.isFetching} onRetry={() => activity.refetch()} />
        </SettingsGroup>
      )}

      {!unavailable && <Header a={a} loading={activity.isLoading} />}

      {a && a.totals.calls > 0 && (
        <SettingsGroup title="Activity over time" action={<Legend />}>
          <CallsChart series={a.series} hourly={a.bucket === "hour"} />
        </SettingsGroup>
      )}

      <CallList
        signedIn={signedIn} ws={ws} range={range} filters={filters} setFilter={setFilter}
        search={search} setSearch={setSearch}
        routes={a?.by_route ?? []} keys={a?.by_key ?? []} clients={a?.by_client ?? []}
        onClear={() => { setFilters({}); setSearch(""); }}
      />
    </div>
  );
}

/** A load failure: what failed, the status and code in a muted line, a retry, and on a 401 the way back in. */
function LoadError({ what, error, retrying, onRetry }: { what: string; error: unknown; retrying: boolean; onRetry: () => void }) {
  const { signOut } = useAuth();
  return (
    <div role="alert" className="flex flex-wrap items-center justify-between gap-2 px-2 py-2">
      <div className="min-w-0">
        <p className="text-[12.5px] text-risk">Could not load {what}.</p>
        <p className={cn("mt-0.5 font-mono text-[11px]", muted)}>{errorNote(error)}</p>
      </div>
      <div className="flex items-center gap-1.5">
        {isSignedOut(error) && <Button variant="ghost" size="sm" onClick={() => { void signOut(); }}>Sign in again</Button>}
        <Button variant="outline" size="sm" disabled={retrying} onClick={onRetry}>{retrying ? "Retrying…" : "Retry"}</Button>
      </div>
    </div>
  );
}

function Header({ a, loading }: { a: Activity | undefined; loading: boolean }) {
  const t = a?.totals;
  const cells = [
    { label: "Activity", value: t ? t.calls.toLocaleString() : "—", note: t ? splitNote(t) : "" },
    { label: "Error rate", value: t ? pct(t.error_rate) : "—", note: t ? `${t.errors.toLocaleString()} ${t.errors === 1 ? "error" : "errors"}` : "", risk: !!t && t.errors > 0 },
    { label: "Latency p50", value: t ? ms(t.p50_ms) : "—", note: latencyNote(t) },
    { label: "Keys", value: t ? t.keys.toLocaleString() : "—", note: t ? `${t.clients.toLocaleString()} ${t.clients === 1 ? "client" : "clients"}` : "" },
  ];
  return (
    <div className={cn("grid grid-cols-2 overflow-hidden rounded-2xl border border-border/70 bg-card sm:grid-cols-4", loading && "opacity-60")}>
      {cells.map((c, i) => (
        <div key={c.label} className={cn("min-w-0 px-4 py-3.5", i % 2 === 1 && "border-l border-hairline", i >= 2 && "border-t border-hairline sm:border-t-0", i === 2 && "sm:border-l")}>
          <div className="truncate text-[11px] font-medium text-muted-foreground/55">{c.label}</div>
          <div className={cn("mt-1.5 text-[22px] font-semibold leading-none tabular-nums tracking-tight", c.risk ? "text-risk" : "text-foreground")}>{c.value}</div>
          <div className="mt-1.5 truncate text-[11.5px] text-muted-foreground/60">{c.note || " "}</div>
        </div>
      ))}
    </div>
  );
}

const MCP_FILL = "hsl(var(--foreground) / 0.78)";
const REST_FILL = "hsl(var(--foreground) / 0.28)";

function Legend() {
  return (
    <span className={cn("flex items-center gap-3 text-[11px]", muted)}>
      <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-[2px]" style={{ background: MCP_FILL }} />MCP</span>
      <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-[2px]" style={{ background: REST_FILL }} />REST</span>
    </span>
  );
}

/** Stacked bars, MCP on REST, per hour (24h) or day. The app's chart primitives (components/charts). */
function CallsChart({ series, hourly }: { series: Activity["series"]; hourly: boolean }) {
  const [hover, setHover] = useState<number | null>(null);
  const [box, boxW] = useWidth<HTMLDivElement>();
  const W = Math.max(boxW || 480, 280), H = 170;
  const PAD_L = 34, PAD_R = 8, PAD_B = 22, PAD_T = 10;
  const { top, ticks } = niceScale(Math.max(1, ...series.map((d) => d.calls)));
  const innerW = W - PAD_L - PAD_R;
  const stepX = innerW / Math.max(series.length, 1);
  const cx = (i: number) => PAD_L + i * stepX + stepX / 2;
  const y = (v: number) => PAD_T + (1 - v / top) * (H - PAD_T - PAD_B);
  const barW = Math.max(2, Math.min(stepX - 2, 20));
  const labelEvery = Math.max(1, Math.ceil(series.length / Math.max(2, Math.floor(innerW / 56))));
  const h = hover !== null ? series[hover] : null;
  return (
    <div className="relative w-full px-1 pb-1" ref={box}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} role="img" aria-label="Activity over time">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={PAD_L} x2={W - PAD_R} y1={y(t)} y2={y(t)} className="stroke-border" strokeWidth={1} strokeDasharray={t === 0 ? "0" : "2 4"} strokeOpacity={t === 0 ? 1 : 0.6} />
            <text x={PAD_L - 6} y={y(t) + 3} textAnchor="end" className="fill-muted-foreground/70 text-[9px] tabular-nums">{t}</text>
          </g>
        ))}
        {series.map((d, i) => {
          const dim = hover === null || hover === i ? 1 : 0.45;
          return (
            <g key={d.bucket} opacity={dim}>
              {d.rest > 0 && <rect x={cx(i) - barW / 2} y={y(d.rest)} width={barW} height={Math.max(H - PAD_B - y(d.rest), 1.5)} rx={2} fill={REST_FILL} />}
              {d.mcp > 0 && <rect x={cx(i) - barW / 2} y={y(d.rest + d.mcp)} width={barW} height={Math.max(y(d.rest) - y(d.rest + d.mcp), 1.5)} rx={2} fill={MCP_FILL} />}
            </g>
          );
        })}
        {series.map((d, i) => (
          <rect key={`hit-${d.bucket}`} x={PAD_L + i * stepX} y={0} width={stepX} height={H} fill="transparent"
            onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)} />
        ))}
        {series.map((d, i) => {
          const last = i === series.length - 1;
          if (i % labelEvery !== 0 && !last) return null;
          if (!last && series.length - 1 - i < labelEvery / 2) return null;
          return (
            <text key={`l-${d.bucket}`} x={cx(i)} y={H - PAD_B + 13} textAnchor={last ? "end" : i === 0 ? "start" : "middle"} className="fill-muted-foreground/70 text-[9px]">
              {bucketLabel(d.bucket, hourly)}
            </text>
          );
        })}
      </svg>
      {h && (
        <div className="pointer-events-none absolute right-1 top-0 rounded-lg border border-border bg-background px-3 py-2 shadow-md">
          <p className="mb-1 text-[11px] font-medium text-foreground">{bucketLabel(h.bucket, hourly)}{hourly ? " UTC" : ""}</p>
          <p className="text-[11px] tabular-nums text-muted-foreground">{h.calls.toLocaleString()} calls · {h.mcp.toLocaleString()} MCP · {h.rest.toLocaleString()} REST</p>
          {h.errors > 0 && <p className="text-[11px] tabular-nums text-risk">{h.errors.toLocaleString()} {h.errors === 1 ? "error" : "errors"}</p>}
        </div>
      )}
    </div>
  );
}

function SurfaceTag({ s }: { s: Surface }) {
  return <span className={cn("flex-shrink-0 rounded px-1 py-px text-[9.5px] font-medium", s === "mcp" ? "bg-foreground/10 text-foreground/80" : "bg-muted text-muted-foreground/80")}>{surfaceLabel(s)}</span>;
}

function AboutCell({ about, target }: { about: About; target: string | null }) {
  const href = aboutHref(about);
  const label = aboutLabel(about, target);
  if (href) return <Link to={href} className="block truncate text-foreground underline-offset-2 hover:underline" title={target ?? undefined}>{label}</Link>;
  return <span className={cn("block truncate", about?.name ? "text-foreground" : "font-mono text-[11.5px] text-muted-foreground/80")} title={target ?? undefined}>{label}</span>;
}

function CallList({ signedIn, ws, range, filters, setFilter, search, setSearch, routes, keys, clients, onClear }: {
  signedIn: boolean; ws: string; range: ActivityWindow; filters: CallFilters; setFilter: (p: CallFilters) => void;
  search: string; setSearch: (s: string) => void;
  routes: Activity["by_route"]; keys: Activity["by_key"]; clients: Activity["by_client"]; onClear: () => void;
}) {
  // The search applies on Enter or blur, not per keystroke.
  const [applied, setApplied] = useState(search);
  const f = { ...filters, q: applied };
  const calls = useInfiniteQuery({
    queryKey: ["api-activity-calls", ws, range, f],
    enabled: signedIn && !!ws,
    retry,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => getJson<CallsPage>(`/api/usage/activity/calls?${callsQuery(range, f, pageParam)}`, ws),
    getNextPageParam: (last) => last.next_before ?? undefined,
  });
  const rows = calls.data?.pages.flatMap((p) => p.calls) ?? [];
  // The menus list what the window holds (the summary's top routes, keys and clients), plus the
  // current choice when the window no longer has it.
  const routeOptions = useMemo(() => {
    const names = [...new Set(routes.map((r) => r.route))];
    if (filters.route && !names.includes(filters.route)) names.unshift(filters.route);
    return names;
  }, [routes, filters.route]);
  const keyOptions = useMemo(() => {
    const list = keys.map((k) => ({ id: k.api_key_id, label: keyLabel(k.name, k.api_key_id) + (k.revoked ? " (revoked)" : "") }));
    if (filters.key && !list.some((k) => k.id === filters.key)) list.unshift({ id: filters.key, label: keyLabel(null, filters.key) });
    return list;
  }, [keys, filters.key]);
  const clientOptions = useMemo(() => {
    const list = clients.map((c) => ({ id: c.client || UNKNOWN_CLIENT, label: clientLabel(c.client) }));
    if (filters.client && !list.some((c) => c.id === filters.client)) {
      list.unshift({ id: filters.client, label: filters.client === UNKNOWN_CLIENT ? clientLabel(null) : filters.client });
    }
    return list;
  }, [clients, filters.client]);
  const filtered = !!(filters.surface || filters.route || filters.status || filters.key || filters.client || applied);
  const trigger = "h-8 w-auto min-w-[110px] gap-1.5 rounded-lg border-border/70 bg-card text-[12.5px]";

  return (
    <SettingsGroup title="Activity" action={filtered ? <button type="button" onClick={() => { onClear(); setApplied(""); }} className={cn("text-[11.5px] hover:text-foreground", muted)}>Clear filters</button> : undefined}>
      <div className="flex flex-wrap items-center gap-2 px-2 pb-2 pt-1">
        <Select value={filters.surface ?? ALL} onValueChange={(v) => setFilter({ surface: v === ALL ? null : (v as Surface) })}>
          <SelectTrigger aria-label="Surface" className={trigger}><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value={ALL}>MCP and REST</SelectItem><SelectItem value="mcp">MCP</SelectItem><SelectItem value="rest">REST</SelectItem></SelectContent>
        </Select>
        <Select value={filters.route ?? ALL} onValueChange={(v) => setFilter({ route: v === ALL ? null : v })}>
          <SelectTrigger aria-label="Tool or route" className={cn(trigger, "max-w-[220px]")}><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Every tool and route</SelectItem>
            {routeOptions.map((r) => <SelectItem key={r} value={r}><span className="font-mono text-[12px]">{r}</span></SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={filters.status ?? ALL} onValueChange={(v) => setFilter({ status: v === ALL ? null : (v as "ok" | "error") })}>
          <SelectTrigger aria-label="Status" className={trigger}><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value={ALL}>Any status</SelectItem><SelectItem value="ok">OK</SelectItem><SelectItem value="error">Errors</SelectItem></SelectContent>
        </Select>
        <Select value={filters.key ?? ALL} onValueChange={(v) => setFilter({ key: v === ALL ? null : v })}>
          <SelectTrigger aria-label="Key" className={cn(trigger, "max-w-[200px]")}><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Every key</SelectItem>
            {keyOptions.map((k) => <SelectItem key={k.id} value={k.id}>{k.label}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={filters.client ?? ALL} onValueChange={(v) => setFilter({ client: v === ALL ? null : v })}>
          <SelectTrigger aria-label="Client" className={cn(trigger, "max-w-[200px]")}><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Every client</SelectItem>
            {clientOptions.map((c) => <SelectItem key={c.id} value={c.id}>{c.label}</SelectItem>)}
          </SelectContent>
        </Select>
        <input
          type="search" value={search} placeholder="Search what it was about" aria-label="Search what the call was about"
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") setApplied(search.trim()); }}
          onBlur={() => setApplied(search.trim())}
          className={cn(fieldCls, "sm:w-[220px]")}
        />
      </div>

      {calls.error && <LoadError what="the activity list" error={calls.error} retrying={calls.isFetching} onRetry={() => calls.refetch()} />}
      {calls.isLoading && <p className={cn("px-2 py-2 text-[13px]", muted)}>Loading…</p>}
      {!calls.isLoading && !calls.error && rows.length === 0 && (
        <p className={cn("px-2 py-3 text-[12.5px]", muted)}>
          {filtered ? "Nothing matches these filters in this window." : "No API or MCP activity in this window. It shows up here a few seconds after it happens."}
        </p>
      )}
      {rows.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px]">
            <thead>
              <tr>
                <th className={th}>Time</th><th className={th}>Tool or route</th><th className={th}>About</th>
                <th className={cn(th, "text-right")}>Status</th><th className={cn(th, "text-right")}>Latency</th>
                <th className={th}>Key</th><th className={th}>Client</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.id} className="hover:bg-hover">
                  <td className={cn(td, "whitespace-nowrap", muted)} title={new Date(c.at).toLocaleString()}>{when(c.at)}</td>
                  <td className={cn(td, "max-w-[220px]")}>
                    <span className="flex min-w-0 items-center gap-1.5"><SurfaceTag s={c.surface} /><span className="truncate font-mono text-[12px]">{c.route}</span></span>
                  </td>
                  <td className={cn(td, "max-w-[200px]")}><AboutCell about={c.about} target={c.target} /></td>
                  <td className={cn(td, "text-right tabular-nums", isError(c.status) ? "text-risk" : muted)}>{c.status}</td>
                  <td className={cn(td, "whitespace-nowrap text-right tabular-nums", muted)}>{ms(c.latency_ms)}</td>
                  <td className={cn(td, "max-w-[160px] truncate")}>{keyLabel(c.key.name, c.key.id)}</td>
                  <td className={cn(td, "max-w-[160px] truncate", muted)} title={c.client ?? undefined}>{clientLabel(c.client)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {calls.hasNextPage && (
        <div className="flex justify-center px-2 py-2">
          <Button variant="ghost" size="sm" disabled={calls.isFetchingNextPage} onClick={() => calls.fetchNextPage()}>
            {calls.isFetchingNextPage ? "Loading…" : "Load more"}
          </Button>
        </div>
      )}
    </SettingsGroup>
  );
}
