// The Pipeline page's deal model: the row /api/companies/deals sends, and the few rules every
// surface that lists deals has to agree on (what "quiet" means, what "at risk" means, which
// pipeline a deal belongs to). Kept apart from the components so the board, the list and the
// command palette cannot drift into three definitions of the same word.

import { sameStageLabel, type WsStage } from "@/lib/stageStrip";
import { day, isOverdue } from "@/lib/format";

export type DealScope = "mine" | "team";

export type DealSignal = { kind: string; text: string; detail: string | null; days: number | null; at: string | null };
export type DealVerdict = { headline: DealSignal; signals: DealSignal[]; count: number };

/** One deal as /api/companies/deals sends it. Every field the redesign added is optional, because
 *  an older server and the preview fixtures do not send them yet. */
export type PipelineDeal = {
  id: string;
  company_id: string;
  company_name: string | null;
  company_domain: string | null;
  name: string;
  stage: string | null;
  status: "open" | "won" | "lost";
  value: number | null;
  currency?: string | null;
  close_date: string | null;
  owner_name?: string | null;
  pipeline?: string | null;
  pipeline_id?: string | null;
  last_activity_at?: string | null;
  verdict?: DealVerdict | null;
  // Nous deal health (0-100) and the sentence behind it. Null until the backend computes one.
  health_score?: number | null;
  health_reason?: string | null;
};

export type DealsPayload = {
  deals: PipelineDeal[];
  primary_pipeline_ref: string | null;
  /** The market the server filtered by (null = every market). */
  country: string | null;
  /** "Me" was asked for and the viewer maps to no CRM owner, so the server sent nothing. */
  scopeUnmapped: boolean;
};

export type PipelineOption = { id: string; name: string | null; deals: number; open_deals: number; is_primary: boolean };

export type { WsStage };

const DAY = 86_400_000;

/** Whole days since an ISO time, or null when we do not know. */
export function daysSince(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((Date.now() - t) / DAY));
}

// Nine days is where the Home page's "deals at risk" draws the line too. A deal with no recorded
// activity at all has no number to print, so it never wears a "Quiet" chip; it is not counted as
// quiet either, because "we never saw it" and "it went silent" are different claims.
export const QUIET_DAYS = 9;
export const RISK_HEALTH = 50;

export const quietDays = (d: PipelineDeal): number | null => {
  if (d.status !== "open") return null;
  const n = daysSince(d.last_activity_at);
  return n != null && n >= QUIET_DAYS ? n : null;
};

export const isAtRisk = (d: PipelineDeal) =>
  d.status === "open" && (quietDays(d) != null || (d.health_score != null && d.health_score < RISK_HEALTH));

export const isActiveThisWeek = (d: PipelineDeal) => {
  if (d.status !== "open") return false;
  const n = daysSince(d.last_activity_at);
  return n != null && n <= 7;
};

/** The four saved views. Client-side presets over one deals list, not stored anywhere. */
export type PipelineViewId = "open" | "week" | "fu" | "risk";
export type PipelineView = {
  id: PipelineViewId;
  label: string;
  teamLabel?: string;
  /** A small dot that says where the view's signal comes from. */
  dot?: string;
  test: (d: PipelineDeal, followUps: Set<string>) => boolean;
};
export const PIPELINE_VIEWS: PipelineView[] = [
  { id: "open", label: "My open deals", teamLabel: "Open deals", test: (d) => d.status === "open" },
  { id: "week", label: "Active this week", test: (d) => isActiveThisWeek(d) },
  // A follow-up is drafted per account (the after-call flag), so a deal is "in" this view when
  // its account has one waiting. Open deals only, so the count agrees with the board's columns.
  { id: "fu", label: "Follow-ups", dot: "bg-orange-500", test: (d, fu) => d.status === "open" && fu.has(d.company_id) },
  { id: "risk", label: "At risk", dot: "bg-red-500", test: (d) => isAtRisk(d) },
];
export const isViewId = (v: string | null): v is PipelineViewId => PIPELINE_VIEWS.some((x) => x.id === v);

/**
 * The pipeline a deal sits in. A deal whose pipeline we never learned reads as the primary one,
 * the same rule `inPrimaryPipeline` uses for the badge, so it stays on the board instead of
 * vanishing from every pipeline at once.
 */
export const dealPipelineId = (d: PipelineDeal, primaryId: string | null) => d.pipeline_id || primaryId || null;

export type BoardColumn = { key: string; label: string; deals: PipelineDeal[]; total: number };

/**
 * One column per stage of the pipeline, in the pipeline's own order, then any stage its open deals
 * sit at that the ladder does not name (biggest first, the stage strip's rule).
 *
 * A pipeline we have not adopted gets the WORKSPACE's ladder back from /stages, whose labels then
 * match none of its deals. Drawing that ladder would print a row of empty columns from another
 * funnel, so a ladder that names none of the open deals is dropped.
 */
export function buildColumns(openDeals: PipelineDeal[], ladder: WsStage[], allOpenInPipeline: PipelineDeal[]): BoardColumn[] {
  const active = ladder.filter((s) => s.kind === "active").sort((a, b) => a.sort_order - b.sort_order);
  const ladderFits = allOpenInPipeline.length === 0
    ? active.length > 0
    : allOpenInPipeline.some((d) => active.some((s) => sameStageLabel(s.label, d.stage)));
  const cols: BoardColumn[] = (ladderFits ? active : []).map((s) => ({ key: `l:${s.key}`, label: s.label.trim(), deals: [], total: 0 }));
  const extras = new Map<string, BoardColumn>();
  // Stages that exist in the pipeline but hold nothing in this view still get a column, so the
  // funnel keeps its shape when a view narrows it.
  for (const d of allOpenInPipeline) {
    if (cols.some((c) => sameStageLabel(c.label, d.stage))) continue;
    const label = String(d.stage ?? "").trim() || "No stage";
    const k = label.toLowerCase();
    if (!extras.has(k)) extras.set(k, { key: `x:${k}`, label, deals: [], total: 0 });
  }
  const extraSize = new Map<string, number>();
  for (const d of allOpenInPipeline) {
    const k = (String(d.stage ?? "").trim() || "No stage").toLowerCase();
    if (extras.has(k)) extraSize.set(k, (extraSize.get(k) ?? 0) + 1);
  }
  const all = [...cols, ...[...extras.entries()].sort((a, b) => (extraSize.get(b[0]) ?? 0) - (extraSize.get(a[0]) ?? 0)).map(([, c]) => c)];
  for (const d of openDeals) {
    const label = String(d.stage ?? "").trim() || "No stage";
    const col = all.find((c) => sameStageLabel(c.label, label));
    if (!col) continue;
    col.deals.push(d);
    col.total += Number(d.value) || 0;
  }
  return all;
}

/** Most recently worked first; never-touched last. The same order every list in the app uses. */
export const byRecentActivity = (a: PipelineDeal, b: PipelineDeal) =>
  (b.last_activity_at ?? "").localeCompare(a.last_activity_at ?? "");

/** Most recently closed first, for the won and lost columns. */
export const byRecentClose = (a: PipelineDeal, b: PipelineDeal) =>
  String(b.close_date ?? "").localeCompare(String(a.close_date ?? "")) || byRecentActivity(a, b);

/**
 * The one flag a deal wears, when something about it matters: it went quiet, the CRM record needs
 * changing (the dead-deal verdict), its close date passed, or a follow-up is waiting. Most deals
 * wear none. Evidence, never a button: the rep changes the deal in the CRM.
 */
export type DealFlag = { tone: "risk" | "warning" | "neutral"; text: string; title: string };

export function dealFlag(d: PipelineDeal, followUp: boolean, long = false): DealFlag | null {
  if (d.status !== "open") return null;
  const quiet = quietDays(d);
  if (quiet != null) return { tone: "risk", text: `Quiet ${quiet} days`, title: `No conversation on this deal in ${quiet} days` };
  if (d.verdict?.headline) {
    const detail = d.verdict.signals.map((s) => [s.text, s.detail].filter(Boolean).join(": ")).join("\n");
    const text = long ? d.verdict.headline.text + (d.verdict.count > 1 ? ` +${d.verdict.count - 1}` : "") : "Deal change required";
    return { tone: "warning", text, title: `Deal change required. Update it in your CRM.\n${detail}` };
  }
  if (d.close_date && isOverdue(d.close_date)) {
    return { tone: "warning", text: "Past close date", title: `The close date (${day(d.close_date)}) has passed` };
  }
  if (followUp) return { tone: "neutral", text: "Follow-up ready", title: "A follow-up is drafted for this account and waiting for you" };
  return null;
}
