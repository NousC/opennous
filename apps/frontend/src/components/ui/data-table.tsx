import * as React from "react";

import { cn } from "@/lib/utils";
import { SkeletonRows } from "@/components/ui/skeleton";
import { useHotkey } from "@/lib/hotkeys";

/**
 * The one table of the interface refresh (GET-594). Accounts, Pipeline's list, Customers,
 * Tasks, Reporting and Insights all render through it, so header height, row height,
 * hairlines, hover, grouping and totals look the same everywhere.
 *
 *  - Columns render their own cells; numbers should set `align: "right"` (cells are
 *    tabular-nums already).
 *  - `groups` draws a label row per group (stage, due bucket) with an optional count and total
 *    in `meta`, the way the ⌘K palette labels its groups: small light text, no grey band
 *    (GET-658). Pass `rows` instead for a flat table.
 *  - Quiet by default (GET-658): header labels 11.5px in the light muted tone, hairline row
 *    dividers only, no fills but the hover band.
 *  - A column's `footer` fills a totals row at the bottom.
 *  - Wide tables scroll sideways inside the table's own box, never the page.
 */
export interface Column<T> {
  key: string;
  header: React.ReactNode;
  cell: (row: T) => React.ReactNode;
  align?: "left" | "right";
  /** CSS width, e.g. "26%" or "36px". */
  width?: string;
  className?: string;
  footer?: React.ReactNode;
}

export interface RowGroup<T> {
  key: string;
  label: React.ReactNode;
  /** e.g. "8 · $612,500" */
  meta?: React.ReactNode;
  /** Tailwind bg class for the dot before the label. */
  swatch?: string;
  rows: T[];
}

export type Density = "compact" | "default" | "relaxed";
const rowHeight: Record<Density, string> = { compact: "h-[42px]", default: "h-12", relaxed: "h-[58px]" };

export interface DataTableProps<T> {
  columns: Column<T>[];
  rows?: T[];
  groups?: RowGroup<T>[];
  rowKey: (row: T) => string;
  onRowClick?: (row: T) => void;
  /** Marks the row as the current one (keyboard cursor, open in a side panel). */
  activeKey?: string;
  loading?: boolean;
  empty?: React.ReactNode;
  density?: Density;
  /** Below this width the table scrolls sideways inside its box. */
  minWidth?: number;
  /**
   * Keyboard first (GET-601): J / K move a cursor over the rows, Enter opens the row
   * (onRowClick), E marks it done (onRowDone). Only the most recently mounted table listens.
   */
  keyboard?: boolean;
  onRowDone?: (row: T) => void;
  className?: string;
  "aria-label"?: string;
}

export function DataTable<T>({
  columns,
  rows,
  groups,
  rowKey,
  onRowClick,
  activeKey,
  loading,
  empty,
  density = "compact",
  minWidth = 960,
  className,
  keyboard = false,
  onRowDone,
  ...aria
}: DataTableProps<T>) {
  const sections: RowGroup<T>[] = groups ?? [{ key: "_", label: null, rows: rows ?? [] }];
  const flat = sections.flatMap((s) => s.rows);
  const box = React.useRef<HTMLDivElement>(null);
  const [cursor, setCursor] = React.useState<string | null>(null);
  const current = activeKey ?? cursor;
  const move = (step: number) => {
    if (!flat.length) return;
    const i = flat.findIndex((r) => rowKey(r) === current);
    const next = flat[Math.min(flat.length - 1, Math.max(0, i < 0 ? 0 : i + step))];
    const k = rowKey(next);
    setCursor(k);
    box.current?.querySelector(`[data-row="${CSS.escape(k)}"]`)?.scrollIntoView({ block: "nearest" });
  };
  const at = () => flat.find((r) => rowKey(r) === current);
  useHotkey("j", () => move(1), keyboard);
  useHotkey("k", () => move(-1), keyboard);
  useHotkey("enter", () => { const r = at(); if (r && onRowClick) onRowClick(r); }, keyboard && !!onRowClick);
  useHotkey("e", () => { const r = at(); if (r && onRowDone) onRowDone(r); }, keyboard && !!onRowDone);
  const total = sections.reduce((n, s) => n + s.rows.length, 0);
  const hasFooter = columns.some((c) => c.footer !== undefined);
  const pad = (i: number) => (i === 0 ? "pl-5 pr-3" : "px-3");

  if (loading) return <SkeletonRows rows={4} className={className} />;
  if (total === 0 && empty) return <div className={className}>{empty}</div>;

  return (
    <div ref={box} className={cn("overflow-x-auto", className)}>
      <table className="w-full border-collapse text-[13px]" style={{ minWidth }} aria-label={aria["aria-label"]}>
        <thead>
          <tr>
            {columns.map((c, i) => (
              <th
                key={c.key}
                scope="col"
                style={c.width ? { width: c.width } : undefined}
                className={cn(
                  "h-[34px] whitespace-nowrap border-b border-hairline bg-card text-[11.5px] font-normal text-muted-foreground/70",
                  pad(i),
                  c.align === "right" ? "text-right" : "text-left",
                )}
              >
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sections.map((s) => (
            <React.Fragment key={s.key}>
              {groups && (
                <tr>
                  <td colSpan={columns.length} className="h-10 pb-1.5 pl-5 pt-4 align-bottom text-[12px] font-medium text-muted-foreground/80">
                    <span className="inline-flex items-center gap-2">
                      {s.swatch && <span className={cn("size-1.5 rounded-full", s.swatch)} />}
                      {s.label}
                      {s.meta && <span className="ml-0.5 font-normal tabular-nums text-muted-foreground/60">{s.meta}</span>}
                    </span>
                  </td>
                </tr>
              )}
              {s.rows.map((row) => {
                const k = rowKey(row);
                return (
                  <tr
                    key={k}
                    data-row={k}
                    data-active={current === k || undefined}
                    tabIndex={onRowClick ? 0 : undefined}
                    onClick={onRowClick ? () => onRowClick(row) : undefined}
                    onKeyDown={onRowClick ? (e) => e.key === "Enter" && onRowClick(row) : undefined}
                    className={cn(
                      "group transition-colors duration-fast hover:bg-hover data-[active]:bg-hover",
                      onRowClick && "cursor-pointer",
                    )}
                  >
                    {columns.map((c, i) => (
                      <td
                        key={c.key}
                        className={cn(
                          rowHeight[density],
                          "border-b border-hairline tabular-nums",
                          density === "relaxed" ? "py-3 align-top" : "whitespace-nowrap",
                          pad(i),
                          c.align === "right" && "text-right",
                          c.className,
                        )}
                      >
                        {c.cell(row)}
                      </td>
                    ))}
                  </tr>
                );
              })}
            </React.Fragment>
          ))}
        </tbody>
        {hasFooter && (
          <tfoot>
            <tr>
              {columns.map((c, i) => (
                <td
                  key={c.key}
                  className={cn("h-10 tabular-nums", pad(i), c.align === "right" ? "text-right" : "text-[11.5px] text-muted-foreground/70")}
                >
                  {c.footer}
                </td>
              ))}
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}
