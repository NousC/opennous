// One clear way to show a change to a record (standard 7, GET-617, interface refresh).
//
// Whether Nous proposes a change and waits for you (ChangeApproval) or already made one you can
// reverse (ActionCard), it reads the same: what changes and on which record, the old value
// struck through, the new value, where it came from, and the one or two buttons that decide it.
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function ChangeRow({ icon, tone = "neutral", title, record, from, to, reason, error, actions, className }: {
  icon: ReactNode;
  tone?: "neutral" | "warning";
  title: ReactNode;
  /** The record it changes, e.g. "Platform annual". */
  record?: ReactNode;
  from?: ReactNode;
  to?: ReactNode;
  /** Why, or where it came from: "from Theo on today's call". */
  reason?: ReactNode;
  error?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  const hasValues = from !== undefined || to !== undefined;
  return (
    <div className={cn("flex items-center gap-3 rounded-xl border border-border bg-card px-3.5 py-3", className)}>
      <span className={cn(
        "inline-flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-lg [&_svg]:h-3.5 [&_svg]:w-3.5",
        tone === "warning" ? "bg-warning-dot/15 text-warning" : "bg-muted text-ink-2",
      )}>
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-medium text-foreground">{title}</p>
        {(record || hasValues || reason) && (
          <p className="text-[12px] leading-[1.5] text-muted-foreground tabular-nums">
            {record && <span>{record}</span>}
            {record && (hasValues || reason) && <span> · </span>}
            {hasValues && (
              <>
                {/* The previous value first: it's the one the reader may want back. */}
                <s className="text-muted-foreground/70">{from ?? "nothing"}</s>
                <span className="mx-1">→</span>
                <span className="font-medium text-foreground">{to ?? "nothing"}</span>
              </>
            )}
            {hasValues && reason && <span> · </span>}
            {reason}
          </p>
        )}
        {error && <p className="mt-1 text-[12px] text-risk">{error}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-1.5">{actions}</div>}
    </div>
  );
}
