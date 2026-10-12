// The search palette's list language, for every list that lives in a card (GET-658).
//
// The reference for "premium" is the ⌘K palette: one quiet card, rows inset from its edge with
// a soft rounded hover band and no lines between them, small light group labels ("Today"), a 24px
// logo or icon tile, the title at 13px regular with its context in a lighter tone on the same line,
// and actions that only appear on hover. Home, the record cards, Priorities and the side panels all
// draw their lists with these pieces so they read as one product.
import * as React from "react";
import { cn } from "@/lib/utils";

/** The card: hairline border, 16px radius, no shadow, rows inset by 8px. */
export const ListCard = React.forwardRef<HTMLElement, React.HTMLAttributes<HTMLElement>>(
  ({ className, ...props }, ref) => (
    <section ref={ref} className={cn("rounded-2xl border border-border/70 bg-card p-2", className)} {...props} />
  ),
);
ListCard.displayName = "ListCard";

/** Title, a quiet count, and an optional right-hand link or control. */
export function ListHeader({ title, count, right, className }: {
  title: React.ReactNode; count?: number | null; right?: React.ReactNode; className?: string;
}) {
  return (
    <div className={cn("flex items-baseline gap-2 px-2 pb-1 pt-1.5", className)}>
      <h2 className="section-title">{title}</h2>
      {count != null && <span className="text-[12px] tabular-nums text-muted-foreground/60">{count}</span>}
      {right && <><span className="flex-1" />{right}</>}
    </div>
  );
}

/** A group label inside the card, the way the palette draws "Go to". */
export function ListGroup({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn("px-2 pb-1 pt-2.5 text-[11px] font-medium text-muted-foreground/60", className)}>{children}</div>;
}

/** Empty, loading-failed or "all caught up" line inside the card. */
export function ListEmpty({ children, className }: { children: React.ReactNode; className?: string }) {
  return <p className={cn("px-2 py-2 text-[13px] text-muted-foreground/70", className)}>{children}</p>;
}

/** The 24px tile a row leads with: a logo, an avatar or one quiet icon. */
export function ListTile({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <span className={cn("flex h-6 w-6 flex-shrink-0 items-center justify-center overflow-hidden rounded-md bg-card text-muted-foreground/70 shadow-[inset_0_0_0_1px_hsl(var(--border)/0.6)]", className)}>
      {children}
    </span>
  );
}

/** Title at 13px regular, its context on the same line in the quiet tone. */
export function ListText({ title, sub, className, titleClassName }: {
  title: React.ReactNode; sub?: React.ReactNode; className?: string;
  /** Extra classes for the title, e.g. "flex-shrink-0" so a long context line truncates first. */
  titleClassName?: string;
}) {
  return (
    <span className={cn("flex min-w-0 flex-1 items-baseline gap-2", className)}>
      <span className={cn("truncate text-[13px] text-foreground", titleClassName)}>{title}</span>
      {sub && <span className="min-w-0 truncate text-[11.5px] text-muted-foreground/70">{sub}</span>}
    </span>
  );
}

/** Right-hand meta: a time, a due date, a count. */
export function ListMeta({ children, className }: { children: React.ReactNode; className?: string }) {
  return <span className={cn("flex-shrink-0 text-right text-[12px] tabular-nums text-muted-foreground/70", className)}>{children}</span>;
}

/** Row action that appears on hover or keyboard focus, never a button on every row. */
export const ListAction = React.forwardRef<HTMLButtonElement, React.ButtonHTMLAttributes<HTMLButtonElement>>(
  ({ className, ...props }, ref) => (
    <button ref={ref} type="button"
      className={cn("flex-shrink-0 rounded-md px-2 py-0.5 text-[12px] text-ink-2 opacity-0 transition-opacity duration-fast hover:bg-card hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100", className)}
      {...props} />
  ),
);
ListAction.displayName = "ListAction";

/** One row: inset, rounded hover band, no divider. Renders a div, or a button when `onClick` is set. */
export const listRowClass = "group flex min-h-10 w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors duration-fast hover:bg-hover";
export function ListRow({ className, children, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn(listRowClass, className)} {...props}>{children}</div>;
}
