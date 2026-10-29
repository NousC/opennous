import * as React from "react";
import { Filter } from "lucide-react";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

/**
 * A page's Filter button, in the page's own toolbar next to its search (2026-10-28). It used to
 * sit in the top bar beside Get started; the top bar now carries only what every page shares.
 * `children` is the popover's content; `active` is how many filters are on (shown on the button).
 */
export function ToolbarFilter({ active = 0, children, className }: { active?: number; children: React.ReactNode; className?: string }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          title="Filter"
          aria-label={active ? `Filter, ${active} on` : "Filter"}
          className={cn(
            "inline-flex h-7 min-w-7 shrink-0 items-center justify-center gap-1 rounded-lg border border-border bg-card px-1.5 shadow-[0_1px_0_rgba(20,20,18,0.04)] transition-colors duration-fast hover:bg-hover hover:text-foreground",
            active ? "text-foreground" : "text-ink-2",
          )}
        >
          <Filter className="h-3.5 w-3.5" strokeWidth={1.8} />
          {active > 0 && <span className="text-[11px] font-medium tabular-nums">{active}</span>}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className={cn("w-60 p-0", className)}>{children}</PopoverContent>
    </Popover>
  );
}
