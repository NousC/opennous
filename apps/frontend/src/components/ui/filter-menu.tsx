// The filter popover's content, shared by every page with a Filter button (Home, Accounts, People).
//
// Two steps, the way Linear and Attio do it: first the filters, each with its icon and what it is
// set to now ("Last 30 days", "2 selected", "Any"); pick one and its options open in place, with a
// search once the list is long, a count beside each option, and a way back. One header carries
// "Clear all" while anything is on. Pages describe their filters; this draws them.
import * as React from "react";
import { Check, ChevronLeft, ChevronRight, Search, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export type FilterOption = { value: string; label: string; count?: number | null; dot?: string };

export type FilterGroup = {
  key: string;
  label: string;
  icon?: LucideIcon;
  options: FilterOption[];
  /** The values on. A single-choice group holds one. */
  selected: string[];
  /** Several at once (checkboxes) or one (a check). */
  multi?: boolean;
  /** A single-choice group's resting value: picking it is "not filtering", and it is not counted. */
  defaultValue?: string;
  onChange: (next: string[]) => void;
};

/** How many groups are narrowing the list. */
function activeFilterCount(groups: FilterGroup[]) {
  return groups.filter((g) => isOn(g)).length;
}

function isOn(g: FilterGroup) {
  if (g.multi) return g.selected.length > 0;
  return g.selected.length > 0 && g.selected[0] !== g.defaultValue;
}

function summary(g: FilterGroup) {
  if (g.multi) {
    if (!g.selected.length) return "Any";
    if (g.selected.length === 1) return g.options.find((o) => o.value === g.selected[0])?.label ?? "1 selected";
    return `${g.selected.length} selected`;
  }
  return g.options.find((o) => o.value === g.selected[0])?.label ?? "Any";
}

const SEARCH_FROM = 8;

export function FilterMenu({ groups, onClearAll }: { groups: FilterGroup[]; onClearAll?: () => void }) {
  const shown = groups.filter((g) => g.options.length > 0);
  const [openKey, setOpenKey] = React.useState<string | null>(shown.length === 1 ? shown[0].key : null);
  const [query, setQuery] = React.useState("");
  const open = shown.find((g) => g.key === openKey) ?? null;
  const active = activeFilterCount(shown);
  const clearAll = onClearAll ?? (() => shown.forEach((g) => g.onChange(g.multi ? [] : g.defaultValue ? [g.defaultValue] : [])));

  const header = (
    <div className="flex h-10 items-center gap-1 border-b border-hairline px-1.5">
      {open && shown.length > 1 ? (
        <button type="button" onClick={() => { setOpenKey(null); setQuery(""); }} aria-label="All filters"
          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors duration-fast hover:bg-hover hover:text-foreground">
          <ChevronLeft className="h-4 w-4" strokeWidth={1.8} />
        </button>
      ) : null}
      <span className={cn("min-w-0 flex-1 truncate text-[12.5px] font-medium text-foreground", !(open && shown.length > 1) && "pl-1.5")}>
        {open ? open.label : "Filter"}
      </span>
      {open && isOn(open) ? (
        <button type="button" onClick={() => open.onChange(open.multi ? [] : open.defaultValue ? [open.defaultValue] : [])}
          className="rounded-md px-2 py-1 text-[12px] text-muted-foreground transition-colors duration-fast hover:bg-hover hover:text-foreground">
          Reset
        </button>
      ) : !open && active > 0 ? (
        <button type="button" onClick={clearAll}
          className="rounded-md px-2 py-1 text-[12px] text-muted-foreground transition-colors duration-fast hover:bg-hover hover:text-foreground">
          Clear all
        </button>
      ) : null}
    </div>
  );

  if (!open) {
    return (
      <div className="w-full">
        {header}
        <div className="p-1">
          {shown.map((g) => {
            const Icon = g.icon;
            const on = isOn(g);
            return (
              <button key={g.key} type="button" onClick={() => setOpenKey(g.key)}
                className="group flex h-9 w-full items-center gap-2.5 rounded-lg px-2 text-left text-[13px] transition-colors duration-fast hover:bg-hover">
                {Icon && <Icon className="h-[15px] w-[15px] shrink-0 text-muted-foreground/80" strokeWidth={1.75} />}
                <span className="min-w-0 flex-1 truncate text-foreground/90">{g.label}</span>
                <span className={cn("max-w-[120px] truncate text-[12px]", on ? "rounded-md bg-muted px-1.5 py-0.5 font-medium text-foreground" : "text-muted-foreground/70")}>
                  {summary(g)}
                </span>
                <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/50 group-hover:text-muted-foreground" strokeWidth={1.8} />
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  const q = query.trim().toLowerCase();
  const options = q ? open.options.filter((o) => o.label.toLowerCase().includes(q)) : open.options;
  const pick = (value: string) => {
    if (!open.multi) return open.onChange([value]);
    open.onChange(open.selected.includes(value) ? open.selected.filter((v) => v !== value) : [...open.selected, value]);
  };

  return (
    <div className="w-full">
      {header}
      {open.options.length >= SEARCH_FROM && (
        <div className="border-b border-hairline p-1.5">
          <label className="flex h-8 items-center gap-2 rounded-md bg-hover px-2.5">
            <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70" strokeWidth={1.8} />
            <input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder={`Find ${open.label.toLowerCase()}`}
              className="min-w-0 flex-1 bg-transparent text-[13px] text-foreground outline-none placeholder:text-muted-foreground/70" />
          </label>
        </div>
      )}
      <div role="listbox" aria-label={open.label} aria-multiselectable={open.multi || undefined} className="max-h-[320px] overflow-y-auto p-1">
        {options.map((o) => {
          const on = open.selected.includes(o.value);
          return (
            <button key={o.value} type="button" role="option" aria-selected={on} onClick={() => pick(o.value)}
              className={cn("flex h-8 w-full items-center gap-2.5 rounded-lg px-2 text-left text-[13px] transition-colors duration-fast hover:bg-hover")}>
              {open.multi ? (
                <span aria-hidden className={cn("flex h-[14px] w-[14px] shrink-0 items-center justify-center rounded-[4px] border transition-colors",
                  on ? "border-foreground bg-foreground text-background" : "border-input")}>
                  {on && <Check className="h-2.5 w-2.5" strokeWidth={3} />}
                </span>
              ) : (
                <Check aria-hidden className={cn("h-3.5 w-3.5 shrink-0", on ? "text-foreground" : "opacity-0")} strokeWidth={2} />
              )}
              {o.dot && <span aria-hidden className={cn("h-1.5 w-1.5 shrink-0 rounded-full", o.dot)} />}
              <span className="min-w-0 flex-1 truncate text-foreground/90">{o.label}</span>
              {o.count != null && <span className="text-[12px] tabular-nums text-muted-foreground/70">{o.count.toLocaleString()}</span>}
            </button>
          );
        })}
        {options.length === 0 && <p className="px-2 py-2 text-[13px] text-muted-foreground/70">Nothing matches.</p>}
      </div>
    </div>
  );
}
