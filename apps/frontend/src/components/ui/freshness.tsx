import { cn } from "@/lib/utils";
import { day, time, toDate, when } from "@/lib/format";
import { useNow } from "@/hooks/useNow";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/**
 * "Updated 2h ago" on anything Nous computed or synced (standard 6, GET-595): health scores,
 * insights, priorities, the CRM sync. It ticks on its own, shows the exact time and source on
 * hover, and turns amber once the data is older than `staleAfterMs`, because stale data shown
 * as current is what breaks trust.
 */
export interface FreshnessProps {
  at: string | number | Date | null | undefined;
  /** "Updated", "Synced", "Scored"… */
  verb?: string;
  /** Where it came from, for the tooltip: "HubSpot", "your calls". */
  source?: string;
  staleAfterMs?: number;
  className?: string;
}

export function Freshness({ at, verb = "Updated", source, staleAfterMs, className }: FreshnessProps) {
  const now = useNow();
  const t = toDate(at);
  if (!t) return null;
  const stale = staleAfterMs !== undefined && now - t.getTime() > staleAfterMs;
  const exact = `${day(t, now)}, ${time(t)}${source ? ` · from ${source}` : ""}`;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={cn("inline-flex items-center gap-1.5 text-xs", stale ? "text-warning" : "text-muted-foreground", className)}>
          {stale && <span aria-hidden className="size-1.5 rounded-full bg-warning-dot" />}
          {verb} {when(t, now)}
        </span>
      </TooltipTrigger>
      <TooltipContent>{exact}</TooltipContent>
    </Tooltip>
  );
}
