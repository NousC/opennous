import * as React from "react";
import { Columns3, List } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * Tabs, chips and toggles of the interface refresh (GET-594). Three shapes, one look:
 *  - ViewTabs: a page's views ("Open deals 19", "Active this week 12") — soft fill on the
 *    active one, the count in grey, an optional colour square.
 *  - FilterChips: round chips for a filter inside a view (stages, Customers buckets).
 *  - SegmentedControl: two to four mutually exclusive options (Open / Done, Board / List).
 */

export interface ViewOption<V extends string = string> {
  value: V;
  label: React.ReactNode;
  count?: number;
  /** A Tailwind background class for the small square/dot before the label, e.g. "bg-positive". */
  swatch?: string;
  icon?: React.ReactNode;
}

interface ChoiceProps<V extends string> {
  options: ViewOption<V>[];
  value: V;
  onChange: (value: V) => void;
  className?: string;
  "aria-label"?: string;
}

const count = (n?: number) =>
  n === undefined ? null : <span className="font-normal tabular-nums text-muted-foreground">{n}</span>;

export function ViewTabs<V extends string>({ options, value, onChange, className, ...aria }: ChoiceProps<V>) {
  return (
    <div role="tablist" aria-label={aria["aria-label"]} className={cn("flex flex-wrap gap-0.5", className)}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="tab"
            aria-selected={on}
            onClick={() => onChange(o.value)}
            className={cn(
              "inline-flex h-7 items-center gap-[7px] whitespace-nowrap rounded-[7px] px-2.5 text-[12.5px] font-medium transition-colors duration-fast",
              on
                ? "bg-muted text-foreground shadow-[inset_0_0_0_1px_hsl(var(--border))]"
                : "text-ink-2 hover:bg-hover hover:text-foreground",
            )}
          >
            {o.swatch && <span className={cn("size-2 rounded-[2.5px]", o.swatch)} />}
            {o.icon}
            {o.label}
            {count(o.count)}
          </button>
        );
      })}
    </div>
  );
}

export function FilterChips<V extends string>({ options, value, onChange, className, ...aria }: ChoiceProps<V>) {
  return (
    <div role="radiogroup" aria-label={aria["aria-label"]} className={cn("flex flex-wrap gap-1.5", className)}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onChange(o.value)}
            className={cn(
              "inline-flex h-[26px] items-center gap-1.5 whitespace-nowrap rounded-full border bg-card px-2.5 text-xs transition-colors duration-fast",
              on
                ? "border-foreground text-foreground shadow-[inset_0_0_0_0.5px_hsl(var(--foreground))]"
                : "border-border text-ink-2 hover:text-foreground",
            )}
          >
            {o.swatch && <span className={cn("size-1.5 rounded-full", o.swatch)} />}
            {o.label}
            {count(o.count)}
          </button>
        );
      })}
    </div>
  );
}

export function SegmentedControl<V extends string>({ options, value, onChange, className, ...aria }: ChoiceProps<V>) {
  return (
    <div role="radiogroup" aria-label={aria["aria-label"]} className={cn("inline-flex rounded-lg bg-muted p-0.5", className)}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onChange(o.value)}
            className={cn(
              "inline-flex h-6 items-center gap-[5px] whitespace-nowrap rounded-md px-2.5 text-xs transition-colors duration-fast [&_svg]:size-[13px]",
              on ? "bg-card font-medium text-foreground shadow-[0_1px_2px_rgba(20,20,18,0.08)]" : "text-ink-2 hover:text-foreground",
            )}
          >
            {o.icon}
            {o.label}
            {count(o.count)}
          </button>
        );
      })}
    </div>
  );
}

export type Layout = "board" | "list";

/** Board / List, the same everywhere it appears (Pipeline, Tasks). */
export function ViewToggle({ value, onChange, className }: { value: Layout; onChange: (v: Layout) => void; className?: string }) {
  return (
    <SegmentedControl<Layout>
      aria-label="Layout"
      className={className}
      value={value}
      onChange={onChange}
      options={[
        { value: "board", label: "Board", icon: <Columns3 /> },
        { value: "list", label: "List", icon: <List /> },
      ]}
    />
  );
}
