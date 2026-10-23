// The API plan Home's three stat cards (GET-628): calls today, credits this month, and the
// connected sources. Each reads a real endpoint and shows a dash when the read fails — no number
// on this row is one we did not count.
//
//   Calls today         GET /api/usage/by-key?days=1, summed over keys (api_request_log, GET-623).
//                       A member's by-key holds only their keys, so for them it reads "Your calls today".
//   Credits this month  GET /api/billing/state via useCredits, the sidebar meter's source
//   Sources             GET /api/activity-stats/read, the connected tools
//
// The MCP · REST split under Calls today is left out: by-key has no surface, and the per-key
// usage endpoint's by-route split covers 14 days, not today.

import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { useCredits } from "@/hooks/useCredits";
import { callsToday, callsTodayLabel, connectedSources, type ReadTools, type UsageByKey } from "@/lib/apiHome";
import { isWorkspaceAdmin } from "@/lib/roles";
import { num } from "@/lib/format";
import { cn } from "@/lib/utils";
import { usePlan } from "@/hooks/usePlan";
import { isApiTier } from "@/config/plans";

const apiUrl = import.meta.env.VITE_API_URL ?? "";

function useAuthedJson<T>(key: string, path: string, enabled = true) {
  const { session, userData } = useAuth();
  const token = session?.access_token ?? "";
  const workspaceId = userData?.workspace?.id ?? "";
  return useQuery<T | null>({
    queryKey: [key, workspaceId],
    queryFn: async () => {
      const sep = path.includes("?") ? "&" : "?";
      const r = await fetch(`${apiUrl}${path}${sep}workspaceId=${encodeURIComponent(workspaceId)}`, { headers: { Authorization: `Bearer ${token}` } });
      return r.ok ? ((await r.json()) as T) : null;
    },
    enabled: enabled && !!token && !!workspaceId,
    staleTime: 30_000,
  });
}

function Card({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-1.5 rounded-xl border border-hairline bg-card px-4 py-3.5", className)}>
      <span className="text-[12px] text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

const value = "text-[20px] font-medium tabular-nums tracking-[-0.02em] text-foreground";

type ReadCounts = { read?: { accounts_analysed?: number; meetings_transcribed?: number; email_threads_read?: number; slack_conversations_read?: number; calls_recorded?: number } } | null;

/**
 * `readDays` (Activity, GET-660) adds a fourth card: what reached a model in the ledger's window —
 * the counts the Workspace plan's Activity header used to carry. Accounts analysed is not a metric
 * the API plan has (GET-628), so it shows on the other plans only. Home passes nothing.
 */
export function ApiHomeStats({ readDays }: { readDays?: number | null } = {}) {
  const usage = useAuthedJson<UsageByKey>("usage-by-key-today", "/api/usage/by-key?days=1");
  const read = useAuthedJson<ReadTools>("activity-read-tools", "/api/activity-stats/read?days=1");
  const withReads = readDays !== undefined;
  const window = readDays == null ? "all" : String(readDays);
  const reads = useAuthedJson<ReadCounts>(`activity-read-counts-${window}`, `/api/activity-stats/read?days=${window}`, withReads);
  const credits = useCredits();
  const { userData } = useAuth();
  const { plan, selfHosted } = usePlan();
  // Self-hosted: no billing, so no credits card (GET-855). Reads carry the row instead.
  const showCredits = !selfHosted;
  const calls = callsToday(usage.data);
  const sources = connectedSources(read.data);
  const r = reads.data?.read;
  const readCounts = !withReads || !r ? [] : [
    { n: r.meetings_transcribed ?? 0, label: "meetings" },
    { n: r.email_threads_read ?? 0, label: "email threads" },
    { n: r.slack_conversations_read ?? 0, label: "Slack conversations" },
    { n: r.calls_recorded ?? 0, label: "calls" },
    ...(isApiTier(plan) ? [] : [{ n: r.accounts_analysed ?? 0, label: "accounts" }]),
  ].filter((c) => c.n > 0);
  const readTotal = readCounts.reduce((n, c) => n + c.n, 0);

  return (
    <div className={cn("grid flex-shrink-0 grid-cols-1 gap-3 px-4 pb-1 pt-4 sm:px-5", (withReads ? 1 : 0) + (showCredits ? 1 : 0) === 2 ? "sm:grid-cols-2 lg:grid-cols-4" : (withReads || showCredits) ? "sm:grid-cols-3" : "sm:grid-cols-2")}>
      <Card label={callsTodayLabel(isWorkspaceAdmin(userData))}>
        <span className={value}>{calls == null ? "—" : num(calls)}</span>
      </Card>
      {showCredits && <Card label="Credits this month">
        <span className={value}>
          {credits ? credits.used : "—"}
          {credits?.included && <span className="ml-1 text-[12px] font-normal tracking-normal text-muted-foreground">of {credits.included}</span>}
        </span>
        {credits?.included && (
          <span className="h-1 overflow-hidden rounded-sm bg-muted" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={credits.pct} aria-label="Credits used">
            <span className="block h-full rounded-sm bg-foreground" style={{ width: `${credits.pct}%` }} />
          </span>
        )}
      </Card>}
      <Card label="Sources">
        <span className={value}>{sources == null ? "—" : num(sources.length)}</span>
        {!!sources?.length && (
          <span className="flex flex-wrap gap-[3px]">
            {sources.map((s) => (
              <span key={s.name} title={s.label}
                className="inline-flex h-[18px] w-[18px] flex-none items-center justify-center rounded-[5px] border border-hairline bg-card">
                {s.logo
                  ? <img src={s.logo} alt={s.label} className="h-3 w-3 rounded-[3px]" />
                  : <span className="text-[9px] font-bold text-ink-2">{s.label.charAt(0).toUpperCase()}</span>}
              </span>
            ))}
          </span>
        )}
      </Card>
      {withReads && (
        <Card label={readDays == null ? "Read, all time" : `Read, last ${readDays} days`}>
          <span className={value}>{reads.data === undefined ? "—" : num(readTotal)}</span>
        </Card>
      )}
    </div>
  );
}
