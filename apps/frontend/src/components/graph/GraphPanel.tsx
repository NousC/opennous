// The panel on the right of /graph (GET-473): search, what to show, and the legend — the same for
// both tabs. Collapsed, it is one line.
import { useState, type ReactNode } from "react";
import { ChevronRight, Search, X } from "lucide-react";
import { cn } from "@/lib/utils";

export function GraphPanel({ search, setSearch, placeholder, children }: {
  search: string; setSearch: (v: string) => void; placeholder: string; children: ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(false);
  return (
    <aside className={cn(
      "absolute right-4 top-4 bottom-4 z-10 flex w-[248px] flex-col overflow-hidden",
      // The ⌘K palette's surface (GET-658, round 2): 16px radius, hairline, the modal lift.
      "rounded-2xl border border-border/70 bg-card/95 shadow-modal backdrop-blur-xl",
      collapsed && "bottom-auto",
    )}>
      <button onClick={() => setCollapsed((c) => !c)} className="flex flex-shrink-0 items-center gap-1 px-3.5 pb-1 pt-3">
        <span className="text-[13.5px] font-medium tracking-[-0.01em] text-foreground">Graph</span>
        <ChevronRight className={cn("h-3.5 w-3.5 text-muted-foreground/40 transition-transform", !collapsed && "rotate-90")} strokeWidth={1.75} />
      </button>
      {!collapsed && (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="px-3 pb-2 pt-2">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 h-[14px] w-[14px] -translate-y-1/2 text-muted-foreground/40" strokeWidth={1.75} />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={placeholder}
                className="w-full rounded-lg border border-border/70 bg-card py-1.5 pl-8 pr-7 text-[13px] text-foreground outline-none placeholder:text-muted-foreground/45 focus:border-foreground/25"
              />
              {search && (
                <button onClick={() => setSearch("")} className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground/40 hover:text-foreground">
                  <X className="h-3 w-3" strokeWidth={2} />
                </button>
              )}
            </div>
          </div>
          {children}
        </div>
      )}
    </aside>
  );
}

export function PanelSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="px-3 pb-3">
      <div className="px-0.5 pb-1 pt-2 text-[11px] font-medium text-muted-foreground/60">{title}</div>
      {children}
    </div>
  );
}

export function PanelToggle({ label, on, set }: { label: string; on: boolean; set: (v: boolean) => void }) {
  return (
    <button onClick={() => set(!on)} className="flex w-full items-center gap-2 py-[5px]">
      <span className={cn("relative h-[15px] w-[26px] flex-shrink-0 rounded-full transition-colors", on ? "bg-foreground" : "bg-muted-foreground/20")}>
        <span className={cn("absolute top-[2px] h-[11px] w-[11px] rounded-full bg-background transition-all", on ? "left-[13px]" : "left-[2px]")} />
      </span>
      <span className={cn("flex-1 text-left text-[13px]", on ? "text-foreground" : "text-muted-foreground/50")}>{label}</span>
    </button>
  );
}

export function PanelChoice<T extends string>({ options, value, set }: { options: { id: T; label: string }[]; value: T; set: (v: T) => void }) {
  return (
    <div className="space-y-[2px]">
      {options.map((o) => (
        <button
          key={o.id}
          onClick={() => set(o.id)}
          className={cn(
            "flex w-full items-center rounded-lg px-2 py-1.5 text-left text-[13px] transition-colors",
            value === o.id ? "bg-muted text-foreground" : "text-ink-2 hover:bg-muted/50 hover:text-foreground",
          )}
        >{o.label}</button>
      ))}
    </div>
  );
}

export type LegendItem = { label: string; color: string; shape?: "dot" | "square" | "ring" };
export function PanelLegend({ items }: { items: LegendItem[] }) {
  return (
    <PanelSection title="Legend">
      <div className="flex flex-col gap-1.5 text-[12px] text-muted-foreground/80">
        {items.map((it) => (
          <span key={it.label} className="flex items-center gap-2">
            <span
              className={cn("h-2 w-2 flex-shrink-0", it.shape === "square" ? "rounded-[2px]" : "rounded-full")}
              style={it.shape === "ring" ? { border: `1.2px solid ${it.color}` } : { background: it.color }}
            />
            {it.label}
          </span>
        ))}
      </div>
    </PanelSection>
  );
}
