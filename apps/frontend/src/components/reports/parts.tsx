// The pieces every Reports section shares: its header (title, a line of context, a way through to
// the page the number comes from), the box a table sits in, and the failed state.
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";

export function SectionHead({ title, meta, link, children, inset }: {
  title: string; meta?: ReactNode; link?: { label: string; onClick: () => void }; children?: ReactNode;
  /** Drawn inside a TableBox card, like Home's "Coming up" (GET-658, round 2). */
  inset?: boolean;
}) {
  return (
    <div className={cn("flex min-w-0 flex-wrap items-baseline gap-2", inset && "px-2 pb-1 pt-1.5")}>
      <h2 className="section-title">{title}</h2>
      {meta && <span className="min-w-0 truncate text-[12px] tabular-nums text-muted-foreground/60">{meta}</span>}
      <span className="flex-1" />
      {children}
      {link && (
        <button type="button" onClick={link.onClick}
          className="whitespace-nowrap text-[12px] text-muted-foreground/70 transition-colors duration-fast hover:text-foreground">
          {link.label}
        </button>
      )}
    </div>
  );
}

/** The card a section's table sits in: the ⌘K palette's card (ui/list ListCard) with the table
 *  inset and quiet — small light column labels, no lines between rows, a rounded hover band. */
export function TableBox({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn(
      "overflow-hidden rounded-2xl border border-border/70 bg-card p-2",
      "[&_th]:h-8 [&_th]:border-b-0 [&_th]:text-[11.5px] [&_th]:font-normal [&_th]:text-muted-foreground/70",
      "[&_td]:border-b-0 [&_th:first-child]:pl-2 [&_td:first-child]:pl-2",
      "[&_tbody_td]:h-10 [&_tbody_td:first-child]:rounded-l-lg [&_tbody_td:last-child]:rounded-r-lg",
      className,
    )}>
      {children}
    </div>
  );
}

/** A section whose read failed says so; an empty state here would read as "nothing to worry about". */
export function FailNote({ what, onRetry }: { what: string; onRetry: () => void }) {
  return (
    <EmptyState bordered={false} title={`Couldn't load ${what}.`}
      action={<Button size="sm" variant="outline" onClick={onRetry}>Retry</Button>} />
  );
}

/** A number we do not have. Not a zero: the CRM does not record it, or the read failed. */
export const Dash = () => <span className="text-muted-foreground/50">—</span>;

/**
 * StatStrip draws one column per stat; on a phone four columns are too tight, so the strip
 * folds into two rows of two there.
 */
export const STRIP_FOLD =
  "max-sm:![grid-template-columns:repeat(2,minmax(0,1fr))] max-sm:[&>div:nth-child(2n+1)]:border-l-0 max-sm:[&>div:nth-child(n+3)]:border-t max-sm:[&>div]:border-hairline";

/** A share of the whole as a short bar, the canvas's 72px meter. */
export function Meter({ pct, className }: { pct: number; className?: string }) {
  return (
    <span className={cn("inline-block h-1 w-[72px] overflow-hidden rounded-sm bg-muted align-middle", className)}>
      {pct > 0 && <span className="block h-1 rounded-sm bg-foreground" style={{ width: `${Math.max(3, Math.min(100, pct))}%` }} />}
    </span>
  );
}
