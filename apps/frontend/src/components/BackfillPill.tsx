// The backfill, in the corner of every page (GET-517). It runs on the server, so a person can click
// away, sign out, come back tomorrow — the pill says how far it has got wherever they are:
//
//   waiting for a yes   "Backfill ready · review"     → where the estimate card is
//   running             "Reading your history · 38%"  → a thin bar; hover for what has been read
//   just finished       "History in"                  for 30 minutes after it finishes
//
// Nothing to show before a tool connects, or a day after it is done.
import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Check, History } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

const apiUrl = import.meta.env.VITE_API_URL ?? "";

type Preview = {
  state: "none" | "awaiting_confirmation" | "over_allowance" | "needs_support" | "running" | "done";
  window_days?: number | null;
  finished_at?: string | null;
  progress?: { finished: number; total: number; pct: number; read: number | null };
};

export function BackfillPill({ collapsed = false, reviewHref }: { collapsed?: boolean; reviewHref: string }) {
  const { session, userData } = useAuth();
  const navigate = useNavigate();
  const token = session?.access_token ?? "";
  const workspaceId = userData?.workspace?.id ?? "";
  const [p, setP] = useState<Preview | null>(null);

  const load = useCallback(() => {
    if (!token || !workspaceId) return;
    fetch(`${apiUrl}/api/backfill/preview?workspaceId=${encodeURIComponent(workspaceId)}`, { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => (r.ok ? r.json() : null)).then(setP).catch(() => {});
  }, [token, workspaceId]);

  // Every 15 seconds while it runs, every minute otherwise — the pill is the live view of it.
  useEffect(() => {
    load();
    const t = setInterval(load, p?.state === "running" ? 15_000 : 60_000);
    return () => clearInterval(t);
  }, [load, p?.state]);

  if (!p || p.state === "none") return null;
  // "History in" is a moment, not a fixture: gone 30 minutes after this person's backfill finished (GET-571).
  if (p.state === "done" && (!p.finished_at || Date.now() - Date.parse(p.finished_at) > 30 * 60_000)) return null;

  const waiting = p.state === "awaiting_confirmation" || p.state === "over_allowance" || p.state === "needs_support";
  const pct = Math.max(2, Math.min(100, p.progress?.pct ?? 0));
  const label = waiting ? "Backfill ready · review"
    : p.state === "running" ? `Reading your history · ${p.progress?.pct ?? 0}%`
    : "History in";
  const detail = p.state === "running"
    ? `${(p.progress?.read ?? 0).toLocaleString("en-US")} conversations read so far, from the last ${p.window_days === 30 ? "30 days" : "3 months"}. It keeps running if you leave.`
    : waiting ? "See what we found and start it." : "Your history has been read.";
  const go = () => { if (waiting) navigate(reviewHref); };

  const body = collapsed ? (
    <button onClick={go} aria-label={label} className="relative mx-auto flex h-8 w-8 items-center justify-center rounded-lg text-gray-500 hover:bg-gray-200/50 dark:text-white/50">
      {p.state === "done" ? <Check className="h-[15px] w-[15px]" /> : <History className="h-[15px] w-[15px]" />}
      {(waiting || p.state === "running") && <span className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-amber-500" />}
    </button>
  ) : (
    <button onClick={go} className="w-full rounded-lg border border-gray-200/80 bg-white/50 px-2.5 py-2 text-left transition-colors hover:bg-white dark:border-white/[0.08] dark:bg-white/[0.03]">
      <span className="flex items-center gap-1.5 text-[12px] font-medium text-foreground/80">
        {p.state === "done" ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : <History className="h-3.5 w-3.5 text-muted-foreground" />}
        <span className="truncate">{label}</span>
      </span>
      {p.state === "running" && (
        <span className="mt-1.5 block h-1 overflow-hidden rounded-full bg-muted">
          <span className="block h-full rounded-full bg-foreground/70 transition-all duration-700" style={{ width: `${pct}%` }} />
        </span>
      )}
    </button>
  );

  return (
    <Tooltip delayDuration={200}>
      <TooltipTrigger asChild>{body}</TooltipTrigger>
      <TooltipContent side="right" sideOffset={8} className="max-w-[240px] text-[12px]">{detail}</TooltipContent>
    </Tooltip>
  );
}
