import { useState, useEffect, useCallback, useMemo } from "react";
import { Activity, RefreshCw, ChevronDown } from "lucide-react";
import { format, isToday, isYesterday, startOfDay } from "date-fns";
import { useAuth } from "@/contexts/AuthContext";
import { MetricStrip } from "@/components/MetricStrip";
import { PageHeader } from "@/components/ui/page-header";
import { systemLogOpName, agentOpName, OP_COLORS } from "@/lib/operationName";
import { freshAccessToken } from "@/lib/freshToken";

const apiUrl = import.meta.env.VITE_API_URL ?? "";

// ─── Types ──────────────────────────────────────────────────────────────────

interface LiveOp {
  id: string;
  ts: string;
  name: string;
  color: string;
  detail: string;
  source: "system" | "agent" | "mcp" | "sdk" | "api";
  /** Raw event_type from the op log — used to flag the billed (retrieval) ops. */
  eventType?: string;
}

type Range = "all" | "1d" | "7d" | "30d";

/** Workspace-scoped headline counts from /api/workspace/system-log/stats. */
type OpStats = { allTime: number; inRange: number; failed: number; system: number; agent: number };

const RANGE_DAYS: Record<Range, number | null> = { all: null, "1d": 1, "7d": 7, "30d": 30 };
const RANGE_LABEL: Record<Range, string> = { all: "All", "1d": "1d", "7d": "7d", "30d": "30d" };

// ─── Helpers ────────────────────────────────────────────────────────────────

function dayLabel(date: Date) {
  if (isToday(date))     return "TODAY";
  if (isYesterday(date)) return "YESTERDAY";
  return format(date, "MMM d, yyyy").toUpperCase();
}

function groupByDay(ops: LiveOp[]) {
  const map = new Map<string, LiveOp[]>();
  for (const op of ops) {
    const d = new Date(op.ts);
    if (isNaN(d.getTime())) continue;
    const key = startOfDay(d).toISOString();
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(op);
  }
  return [...map.entries()].map(([, grpOps]) => ({ label: dayLabel(new Date(grpOps[0].ts)), ops: grpOps }));
}

// An op "failed" when its name or detail signals an error/failure.
function isFailedOp(op: LiveOp) {
  const hay = `${op.name} ${op.detail}`.toLowerCase();
  return /\b(fail|failed|error|errored|denied|rejected|exception|invalid|unauthorized)\b/.test(hay);
}

// ─── Page ───────────────────────────────────────────────────────────────────

export default function Ops() {
  const { session, userData } = useAuth();
  const token = session?.access_token ?? "";
  const workspaceId = userData?.workspace?.id ?? "";

  const [ops, setOps]                 = useState<LiveOp[]>([]);
  const [stats, setStats]             = useState<OpStats | null>(null);
  const [loading, setLoading]         = useState(true);
  const [range, setRange]             = useState<Range>("7d");

  const loadOps = useCallback(async () => {
    if (!workspaceId || !token) return;
    try {
      const fresh = await freshAccessToken();
      if (!fresh) return;
      const statsDays = RANGE_DAYS[range] ?? "all";
      const [sysRes, agentRes, statsRes] = await Promise.all([
        fetch(`${apiUrl}/api/workspace/system-log?workspace_id=${workspaceId}&days=30&limit=200&offset=0`, { headers: { Authorization: `Bearer ${fresh}` } }),
        fetch(`${apiUrl}/api/requests/log?workspace_id=${workspaceId}&days=30&limit=200&offset=0`, { headers: { Authorization: `Bearer ${fresh}` } }),
        fetch(`${apiUrl}/api/workspace/system-log/stats?workspace_id=${workspaceId}&days=${statsDays}`, { headers: { Authorization: `Bearer ${fresh}` } }),
      ]);
      const sysData   = sysRes.ok   ? await sysRes.json()   : { events: [] };
      const agentData = agentRes.ok ? await agentRes.json() : { requests: [] };
      const sysOps: LiveOp[] = (sysData.events ?? []).map((e: any) => {
        const op = systemLogOpName(e.source, e.event_type, e.metadata);
        // Any caller-facing surface (MCP, SDK, named agent, raw API client)
        // counts as an Agent op for the System/Agent tally. Everything else
        // (Attio sync, LinkedIn webhook, Gmail poller…) stays as system.
        const isAgentSource = ["mcp", "sdk", "agent", "api"].includes(e.source);
        return {
          id: e.id, ts: e.occurred_at,
          name: op.name, color: OP_COLORS[op.color],
          detail: e.summary || e.source,
          source: isAgentSource ? (e.source as LiveOp["source"]) : "system" as const,
          eventType: e.event_type,
        };
      });
      const agentOps: LiveOp[] = (agentData.requests ?? []).map((r: any) => {
        const op = agentOpName(r.op_type, r.entity_type);
        return { id: r.id, ts: r.created_at, name: op.name, color: OP_COLORS[op.color], detail: r.entity_type, source: "agent" as const };
      });
      const merged = [...sysOps, ...agentOps]
        .filter(op => op.ts && !isNaN(new Date(op.ts).getTime()))
        .sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime());
      const seen = new Set<string>();
      const dedup = merged.filter(o => { if (seen.has(o.id)) return false; seen.add(o.id); return true; });
      setOps(dedup);
      // Headline counts come from Postgres, scoped to THIS workspace. The feed
      // above is paginated, so counting it client-side would undercount.
      setStats(statsRes.ok ? await statsRes.json() : null);
    } catch { /* silent */ }
    finally { setLoading(false); }
  }, [workspaceId, token, range]);

  useEffect(() => {
    loadOps();
    const iv = setInterval(loadOps, 15_000);
    return () => clearInterval(iv);
  }, [loadOps]);

  // Range-filtered ops, computed client-side.
  const rangeOps = useMemo(() => {
    const days = RANGE_DAYS[range];
    const cutoff = days == null ? null : Date.now() - days * 24 * 60 * 60 * 1000;
    return ops.filter(op => {
      if (cutoff != null && new Date(op.ts).getTime() < cutoff) return false;
      return true;
    });
  }, [ops, range]);

  const groups = groupByDay(rangeOps);

  // What's going on in the BUSINESS, not in the machine.
  //
  // These used to be "total ops / failed ops / system vs agent" — numbers that
  // describe the software. Nobody opens this page to find out how many HTTP calls
  // succeeded; they open it to find out whether anything is happening. So they now
  // come from the graph: who we talked to, who talked back, what got booked.
  // Nous's own usage lives on Adoption, deliberately not here.
  const [biz, setBiz] = useState<{
    conversations: number; replies: number; reply_rate: number;
    meetings_held: number; meetings_booked: number; people_touched: number;
  } | null>(null);

  useEffect(() => {
    if (!workspaceId) return;
    const days = RANGE_DAYS[range] ?? "all";
    freshAccessToken().then(tok => {
      if (!tok) return;
      fetch(`${apiUrl}/api/activity-stats?workspaceId=${workspaceId}&days=${days}`, {
        headers: { Authorization: `Bearer ${tok}` },
      })
        .then(r => (r.ok ? r.json() : null))
        .then(d => { if (d) setBiz(d); })
        .catch(() => {});
    });
  }, [workspaceId, range]);

  const metrics = [
    { label: "Conversations", value: biz?.conversations ?? 0 },
    { label: "Replies",       value: biz?.replies ?? 0 },
    { label: "Meetings held", value: biz?.meetings_held ?? 0 },
    { label: "People",        value: biz?.people_touched ?? 0 },
  ];

  return (
    <div className="h-full overflow-y-auto bg-background">
      <div className="px-8 py-7">
        <PageHeader
          title="Activities"
        />

        {/* ── What's going on ──
            One strip, the same one the ICP page uses. See MetricStrip. */}
        <MetricStrip
          className="mb-5"
          metrics={metrics.map(s => ({
            label: s.label,
            value: typeof s.value === "number" ? s.value.toLocaleString() : s.value,
          }))}
        />

        {/* ── Date-range toggle ── */}
        <div className="mb-4 flex items-center justify-between gap-3">
          <span className="flex items-center gap-2 text-[12px] font-semibold tracking-wide text-muted-foreground">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
            LIVE OP LOG
          </span>
          <div className="inline-flex items-center rounded-lg border border-border bg-background p-0.5">
            {(["all", "1d", "7d", "30d"] as Range[]).map(r => (
              <button
                key={r}
                onClick={() => setRange(r)}
                className={`px-3 py-1 rounded-md text-[12px] font-semibold transition-colors ${
                  range === r
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground"
                }`}>
                {RANGE_LABEL[r]}
              </button>
            ))}
          </div>
        </div>

        {/* ── Op log ── */}
        {loading ? (
          <div className="space-y-px rounded-xl overflow-hidden border border-border">
            {[...Array(6)].map((_, i) => <div key={i} className="h-11 bg-muted/50 animate-pulse" />)}
          </div>
        ) : groups.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border py-12 text-center">
            <Activity className="h-7 w-7 text-muted-foreground/50 mx-auto mb-3" strokeWidth={1.5} />
            <p className="text-[13px] font-medium text-foreground/80 mb-1">No operations in this range</p>
            <p className="text-[12px] text-muted-foreground/70">Connect an integration or widen the date range to see activity.</p>
          </div>
        ) : (
          <div className="rounded-xl border border-border overflow-hidden">
            {groups.map(group => (
              <div key={group.label}>
                <div className="flex items-center gap-3 px-4 py-2 border-b border-border/60 bg-muted/50">
                  <span className="text-[11px] font-semibold tracking-widest text-muted-foreground">{group.label}</span>
                  <span className="text-[11px] text-muted-foreground/70 tabular-nums">{group.ops.length} ops</span>
                </div>
                {group.ops.map(op => (
                  <div key={op.id}
                    className="flex items-baseline gap-4 px-4 py-2.5 border-b border-border/60 last:border-0 hover:bg-accent transition-colors group">
                    <span className="text-[11px] text-muted-foreground/70 w-24 flex-shrink-0 tabular-nums font-mono">
                      {format(new Date(op.ts), "HH:mm:ss")}
                    </span>
                    <span className="text-[12px] w-56 flex-shrink-0 truncate font-mono" style={{ color: op.color }}>
                      {op.name}
                    </span>
                    <span className="text-[12px] text-muted-foreground group-hover:text-foreground flex-1 truncate transition-colors">
                      {op.detail}
                    </span>
                    <span className={`text-[10px] px-1.5 py-0.5 rounded flex-shrink-0 ${
                      op.source === "mcp" || op.source === "agent"
                        ? "text-emerald-700 bg-emerald-50"
                        : op.source === "sdk"
                          ? "text-violet-700 bg-violet-50"
                          : op.source === "api"
                            ? "text-sky-700 bg-sky-50"
                            : "text-blue-700 bg-blue-50"
                    }`}>
                      {op.source}
                    </span>
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}

        {!loading && groups.length > 0 && (
          <div className="flex items-center justify-center gap-1.5 py-4 text-[11px] text-muted-foreground/70">
            <RefreshCw className="h-3 w-3" /> Auto-refreshes every 15s
          </div>
        )}
      </div>
    </div>
  );
}
