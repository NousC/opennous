// The tier bars and the ICP score, as the people list and the API plan's account record show them.
// They lived in the API plan's own accounts list, which went when both plans got one list (GET-784).
import { cn } from "@/lib/utils";
import type { Tier } from "./apiAccountModel";

export function TierBars({ tier, className }: { tier: Tier | null; className?: string }) {
  const lit = tier ? 4 - tier : 0;
  return (
    <span aria-hidden className={cn("inline-flex h-[11px] items-end gap-[2px]", className)}>
      {[5, 8, 11].map((h, i) => (
        <i key={h} className={cn("block w-[3px] rounded-[1px]", i < lit ? "bg-foreground" : "bg-border")} style={{ height: h }} />
      ))}
    </span>
  );
}

/** The score and a thin bar, as the board draws it. */
export function IcpScore({ score }: { score: number | null }) {
  if (score == null) return <span className="text-muted-foreground">—</span>;
  const pct = Math.max(0, Math.min(100, Math.round(score)));
  return (
    <span className="inline-flex items-center gap-2">
      <span className="w-5 font-medium tabular-nums">{Math.round(score)}</span>
      <span className="inline-block h-1 w-11 overflow-hidden rounded-sm bg-muted">
        <span className="block h-1 rounded-sm bg-foreground" style={{ width: `${pct}%` }} />
      </span>
    </span>
  );
}
