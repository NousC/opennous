import { cn } from "@/lib/utils";

/**
 * The metric strip — one row of numbers, in one frame.
 *
 * Every page that opens with "here is the state of things" uses this, so that a
 * number means the same thing wherever you meet it. It began on the ICP page and
 * the rest of the app had drifted into a second dialect: separate floating cards,
 * a bigger number, a sentence of subtext under each. That reads as five objects
 * where there is one fact — and the gaps between the cards are louder than the
 * hairlines between the figures.
 *
 * The rules the design encodes:
 *
 *   One frame, hairline-divided. The metrics belong to each other; they are a
 *   single reading of the system, not five unrelated tiles.
 *
 *   The number leads, the label follows. The figure is what you came for, so it is
 *   set large and tabular (so digits line up across cells and columns don't dance
 *   when the data changes). The label is small, uppercase and recessive — it is
 *   there to be read once, not competed with.
 *
 *   No subtext. If a number needs a sentence, it is the wrong number.
 */
export type Metric = {
  label: string;
  value: string | number;
  /** Optional href — the cell becomes a link to wherever the number is explained. */
  href?: string;
};

export function MetricStrip({
  metrics,
  className,
}: {
  metrics: Metric[];
  className?: string;
}) {
  if (!metrics.length) return null;

  return (
    <div
      className={cn(
        "grid divide-x divide-border/60 rounded-xl border border-border overflow-hidden",
        // Wrap to a readable number of columns rather than crushing to a fixed
        // count: three across on a phone, the full row once there's room.
        "grid-cols-3",
        metrics.length >= 5 ? "sm:grid-cols-5" : metrics.length === 4 ? "sm:grid-cols-4" : "sm:grid-cols-3",
        className,
      )}
    >
      {metrics.map(m => (
        <div key={m.label} className="px-3 py-3">
          <div className="text-[20px] font-semibold tabular-nums text-foreground">{m.value}</div>
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground/55">{m.label}</div>
        </div>
      ))}
    </div>
  );
}
