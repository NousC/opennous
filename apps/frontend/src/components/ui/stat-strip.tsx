import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * A row of headline numbers in one bordered strip, cells split by hairlines (GET-594).
 * `compact` is Home's slim strip (17px figures, the note beside the number); the default
 * is the page strip on Customers, Tasks, Reporting and Insights (20px, note underneath).
 */
export type StatTone = "default" | "positive" | "warning" | "risk";

export interface Stat {
  label: React.ReactNode;
  value: React.ReactNode;
  note?: React.ReactNode;
  /** A small signed change shown next to the value, e.g. "+1" or "+3.1%". */
  delta?: { value: React.ReactNode; tone?: StatTone };
  tone?: StatTone;
}

const toneText: Record<StatTone, string> = {
  default: "text-foreground",
  positive: "text-positive",
  warning: "text-warning",
  risk: "text-risk",
};

export function StatStrip({ stats, compact = false, className }: { stats: Stat[]; compact?: boolean; className?: string }) {
  return (
    <section
      className={cn("grid overflow-hidden rounded-2xl border border-border/70 bg-card", className)}
      style={{ gridTemplateColumns: `repeat(${stats.length}, minmax(0, 1fr))` }}
    >
      {stats.map((s, i) => (
        <div
          key={i}
          className={cn(
            "flex min-w-0 flex-col",
            i > 0 && "border-l border-hairline",
            compact ? "gap-0.5 px-3.5 py-2.5" : "gap-1 px-[18px] pb-4 pt-3.5",
          )}
        >
          <span className={cn("truncate text-muted-foreground/80", compact ? "text-[11.5px]" : "text-xs")}>{s.label}</span>
          <span className="flex items-baseline gap-1.5">
            <span
              className={cn(
                "font-semibold tabular-nums",
                compact ? "text-[17px] tracking-[-0.015em]" : "text-xl tracking-[-0.02em]",
                toneText[s.tone ?? "default"],
              )}
            >
              {s.value}
            </span>
            {s.delta && (
              <span className={cn("text-[11.5px] font-medium tabular-nums", toneText[s.delta.tone ?? "positive"])}>
                {s.delta.value}
              </span>
            )}
            {compact && s.note && <span className="truncate text-[11.5px] tabular-nums text-muted-foreground/70">{s.note}</span>}
          </span>
          {!compact && s.note && <span className="truncate text-xs tabular-nums text-muted-foreground">{s.note}</span>}
        </div>
      ))}
    </section>
  );
}
