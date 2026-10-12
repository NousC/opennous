// The Sales Pipeline's stage strip: which chips it shows, in which order.
//
// Extracted from AccountsList so the two rules that are easy to get wrong can be asserted
// directly rather than read off a screenshot.
//
// RULE 1 — labels are compared TRIMMED. HubSpot's own stage labels carry stray whitespace:
// a funnel can start at " Intake / Scoping" with a leading space and pass through
// "Quote Issued (Draft) " with a trailing one, while `adoptCrmStages` trimmed both on the way
// into `workspace_stages`. Comparing them raw meant the adopted ladder never matched its own
// stages, so the FIRST stage of the funnel ranked 1000 and sorted to the end of the strip.
//
// RULE 2 — a funnel shows the ends it funnels into. Closed Won and Closed Lost come from the
// full ladder, not the active one, and sit after every in-flight stage in the workspace's own
// order. Without this they would rank 1000 too, and land in count order among whatever CRM
// stages the workspace never adopted.

/** A stage as `/api/workspaces/:id/stages` reports it. */
export type WsStage = { key: string; label: string; canonical: string; sort_order: number; kind: string };

/** Only the fields the strip reads off a deal row. */
export type StageBearing = { stageLabel: string; stageColor: string };

export type StageChip = { label: string; color: string; n: number };

/** Whitespace- and case-insensitive label equality — see RULE 1. */
export const sameStageLabel = (a: string | null | undefined, b: string | null | undefined) =>
  String(a ?? "").trim().toLowerCase() === String(b ?? "").trim().toLowerCase();

/**
 * The order a chip is ranked in: the in-flight ladder, then the stages it ends in, then any
 * extra labels the caller wants ranked (the generic sales groups), then everything else.
 */
export function stageOrder(activeLadder: WsStage[], ladder: WsStage[], extras: string[] = []): string[] {
  const closers = ladder
    .filter(s => s.kind === "won" || s.kind === "lost")
    .sort((a, b) => a.sort_order - b.sort_order)
    .map(s => s.label);
  return [...activeLadder.map(s => s.label), ...closers, ...extras];
}

/**
 * One chip per distinct stage, counted, in ladder order.
 *
 * Rows are grouped by their TRIMMED label, so " Intake / Scoping" and "Intake / Scoping"
 * are one chip of 40 rather than two that each look like a different stage. The first row seen
 * for a group supplies the colour and the printed spelling.
 */
export function buildStageChips(
  rows: StageBearing[],
  activeLadder: WsStage[],
  ladder: WsStage[],
  extras: string[] = [],
): StageChip[] {
  const counts = new Map<string, StageChip>();
  for (const r of rows) {
    const label = String(r.stageLabel ?? "").trim();
    const key = label.toLowerCase();
    const cur = counts.get(key);
    counts.set(key, { label: cur?.label ?? label, color: cur?.color ?? r.stageColor, n: (cur?.n ?? 0) + 1 });
  }
  const order = stageOrder(activeLadder, ladder, extras);
  const rank = (l: string) => {
    const i = order.findIndex(o => sameStageLabel(o, l));
    return i < 0 ? 1000 : i;
  };
  // Unranked stages fall to the end together, biggest first — a stage the ladder does not name
  // is still worth seeing, just not worth placing.
  return [...counts.values()].sort((a, b) => rank(a.label) - rank(b.label) || b.n - a.n);
}
