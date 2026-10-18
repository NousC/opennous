import { crmName } from "@/lib/crm";
import { cn } from "@/lib/utils";
// The CRM's own customer health score, worn as the CRM's.
//
// Nous computes no customer health of its own (docs/customer-success.md). This number is the
// customer's ops team's score, read through the sync, so its tooltip names the CRM it came from.
// It must never be confused with Nous deal health on Pipeline.

// One scale for the number and its bar, so a 72 is never painted amber.
const band = (h: number) => (h >= 70 ? "positive" : h >= 40 ? "warning" : "risk");
const BAR = { positive: "bg-positive", warning: "bg-warning-dot", risk: "bg-risk" } as const;

export function CrmHealth({ h }: { h: number | null | undefined }) {
  if (h == null || !Number.isFinite(Number(h))) return <span className="text-muted-foreground/50">—</span>;
  const v = Math.max(0, Math.min(100, Math.round(Number(h))));
  const b = band(v);
  return (
    <span
      title={`${crmName()}'s health score. Nous reads it and never computes one.`}
      className="inline-flex cursor-help items-center gap-2"
    >
      <span className={cn("w-5 tabular-nums", b === "risk" ? "text-risk" : "text-foreground")}>{v}</span>
      <span className="inline-block h-1 w-11 overflow-hidden rounded-full bg-hairline">
        <span className={cn("block h-1 rounded-full", BAR[b])} style={{ width: `${v}%` }} />
      </span>
    </span>
  );
}

export function Trend({ v }: { v: number }) {
  if (v === 0) return <span className="text-muted-foreground">±0</span>;
  return (
    <span className={v > 0 ? "text-positive" : "text-risk"}>
      {v > 0 ? "▲" : "▼"} {Math.abs(v)}
    </span>
  );
}
