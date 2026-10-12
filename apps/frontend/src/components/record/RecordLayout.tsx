// The record's two panes (interface refresh, GET-608): properties on the left, the work on the
// right. The account and the deal are drawn from these same pieces, so the two pages read alike.
//
//   RecordShell   — the left pane (320px, hairline on its right) and the right pane side by side
//                   from lg up, each scrolling on its own; stacked below lg, one scroll.
//   PaneSection   — one section of the left pane: the palette's small light group label, then rows.
//   PropRow       — a label/value row, the label 116px in the quiet grey.
//   PaneItem      — a 36px inset row in a left-pane list (a deal, a contact), hover band, no rules.
//   RecordTabs    — the right pane's underline tabs with counts, actions on the right.
//   (The shell also hosts the source dock, record/SourceLine.tsx, and the top bar's previous /
//   next, record/RecordNav.tsx.)
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { SourceDockHost } from "./SourceLine";
import { RecordNav } from "./RecordNav";

export function RecordShell({ left, children }: { left: ReactNode; children: ReactNode }) {
  return (
    // The source dock (GET-612) opens beside the whole record, so a quote and the page it backs
    // are on screen together.
    <SourceDockHost>
    {/* "3 of 19" in the top bar, when the record was opened from a list (GET-650). */}
    <RecordNav />
    {/* From lg up each pane scrolls on its own inside the viewport, so the record's properties
        stay in view while the work on the right scrolls (and the reverse). Stacked below lg, the
        page is one scroll. */}
    <div className="h-full overflow-y-auto overflow-x-hidden bg-background lg:overflow-hidden">
      <div className="flex min-h-full min-w-0 flex-col lg:h-full lg:min-h-0 lg:flex-row">
        <aside aria-label="Record details" className="w-full min-w-0 flex-shrink-0 border-b border-hairline pb-3 lg:h-full lg:w-[320px] lg:overflow-y-auto lg:overscroll-contain lg:border-b-0 lg:border-r">
          {left}
        </aside>
        <section className="flex min-w-0 flex-1 flex-col lg:h-full lg:overflow-y-auto lg:overscroll-contain">{children}</section>
      </div>
    </div>
    </SourceDockHost>
  );
}

export function PaneSection({ title, count, meta, children, className }: {
  title?: ReactNode;
  count?: number;
  /** Right-aligned, e.g. "1 closed · 1 won". */
  meta?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  // The palette's group: a small light label, then rows inset by 12px so their hover band has room.
  // No rule between sections; the space does it.
  return (
    <div className={cn("px-3 pb-3 pt-1", className)}>
      {title != null && (
        <div className="flex min-h-7 min-w-0 items-center gap-1.5 px-2 text-[11.5px] font-medium text-muted-foreground/60">
          <span className="truncate">{title}</span>
          {count != null && <span className="font-normal tabular-nums text-muted-foreground/50">{count}</span>}
          {meta != null && <span className="ml-auto flex-shrink-0 font-normal">{meta}</span>}
        </div>
      )}
      {children}
    </div>
  );
}

export function PropRow({ label, children, empty, labelWidth = 116 }: { label: ReactNode; children?: ReactNode; empty?: boolean; labelWidth?: number }) {
  return (
    <div className="grid min-h-8 items-baseline gap-2 px-2 py-[7px] text-[13px]" style={{ gridTemplateColumns: `${labelWidth}px minmax(0,1fr)` }}>
      <span className="truncate text-[12px] text-muted-foreground/70">{label}</span>
      <span className={cn("min-w-0 text-foreground [overflow-wrap:anywhere]", empty && "text-muted-foreground/40")}>{empty ? "—" : children}</span>
    </div>
  );
}

/** A left-pane list row, the palette's: inset, 36px, rounded hover band. A link when it does something. */
export function PaneItem({ children, onClick, title, className }: { children: ReactNode; onClick?: () => void; title?: string; className?: string }) {
  const cls = cn("flex h-9 min-w-0 items-center gap-2.5 rounded-lg px-2 text-[13px]", onClick && "group cursor-pointer transition-colors duration-fast hover:bg-hover", className);
  return onClick
    ? <div role="link" tabIndex={0} title={title} onClick={onClick} onKeyDown={(e) => { if (e.key === "Enter") onClick(); }} className={cn(cls, "focus-visible:bg-hover focus-visible:outline-none")}>{children}</div>
    : <div title={title} className={cls}>{children}</div>;
}

/** A quiet hairline tag: a tech in the stack. */
export function Pill({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn("inline-flex h-5 flex-shrink-0 items-center whitespace-nowrap rounded-md px-1.5 text-[11.5px] text-muted-foreground/80 shadow-[inset_0_0_0_1px_hsl(var(--border)/0.7)]", className)}>{children}</span>;
}

export type RecordTab<T extends string> = { id: T; label: string; count?: number };

export function RecordTabs<T extends string>({ tabs, value, onChange, actions, label = "Record tabs" }: {
  tabs: RecordTab<T>[];
  value: T;
  onChange: (id: T) => void;
  /** Share, the CRM link: the record's actions, at the right end of the tab row. */
  actions?: ReactNode;
  label?: string;
}) {
  return (
    // Sticky: the tabs stay put while the tab's content scrolls under them.
    <div className="sticky top-0 z-10 flex min-w-0 items-center gap-2 border-b border-hairline bg-background px-4 sm:px-7">
      {/* The bar scrolls inside itself on a narrow screen; the page never does. */}
      <nav role="tablist" aria-label={label} className="flex min-w-0 flex-1 items-end overflow-x-auto">
        {tabs.map((t) => {
          const on = t.id === value;
          return (
            <button key={t.id} type="button" role="tab" aria-selected={on} onClick={() => onChange(t.id)}
              className={cn("mr-5 inline-flex h-11 flex-shrink-0 items-center gap-1.5 whitespace-nowrap border-b-[1.5px] px-0.5 text-[13px] transition-colors duration-fast",
                on ? "border-foreground text-foreground" : "border-transparent text-muted-foreground/70 hover:text-foreground")}>
              {t.label}
              {t.count !== undefined && <span className="text-[12px] tabular-nums text-muted-foreground/50">{t.count}</span>}
            </button>
          );
        })}
      </nav>
      {actions && <div className="flex flex-shrink-0 items-center gap-1">{actions}</div>}
    </div>
  );
}

/** The right pane's body: the padding every tab shares. Full width since GET-79x: the record uses the whole pane. */
export function TabBody({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("w-full min-w-0 px-4 pb-10 pt-6 sm:px-7", className)}>{children}</div>;
}

/** ICP fit as three bars and the tier's name ("Tier 1"); "Not ICP" draws no filled bar. */
export function TierMark({ tier, label }: { tier: "tier_1" | "tier_2" | "tier_3" | "not_icp"; label: string }) {
  const filled = tier === "tier_1" ? 3 : tier === "tier_2" ? 2 : tier === "tier_3" ? 1 : 0;
  return (
    <span title="ICP fit" className="inline-flex flex-shrink-0 items-center gap-[5px] font-medium text-foreground">
      <span aria-hidden className="inline-flex h-2.5 items-end gap-0.5">
        {[4, 7, 10].map((h, i) => (
          <i key={h} className={cn("block w-[3px] rounded-[1px]", i < filled ? "bg-foreground" : "bg-border")} style={{ height: h }} />
        ))}
      </span>
      {label}
    </span>
  );
}
