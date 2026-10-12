// A deal stage's group and colour (interface refresh, GET-608): the four groups the Pipeline reads
// in — Lead, Qualification, Negotiation & follow-ups, Closed — keyed off the stage's canonical
// kind in the workspace's ladder, so a CRM's own stage names ("Contract Out (Draft)") land in the
// right group without a list of names here.
import { sameStageLabel, type WsStage } from "@/lib/stageStrip";

export type StageGroup = { key: "lead" | "qualification" | "negotiation" | "won" | "lost" | "open"; label: string; color: string };

export const STAGE_GROUPS: Record<StageGroup["key"], StageGroup> = {
  lead: { key: "lead", label: "Lead", color: "#8C96C4" },
  qualification: { key: "qualification", label: "Qualification", color: "#C08A3E" },
  negotiation: { key: "negotiation", label: "Negotiation & follow-ups", color: "#4F8F6A" },
  won: { key: "won", label: "Closed won", color: "#2E7A4E" },
  lost: { key: "lost", label: "Closed lost", color: "#B0412E" },
  open: { key: "open", label: "Open", color: "#8A8984" },
};

const BY_CANONICAL: Record<string, StageGroup["key"]> = {
  identified: "lead", lead: "lead", discovery: "lead", aware: "lead", connected: "lead",
  meeting_booked: "qualification", demo: "qualification", qualification: "qualification", interested: "qualification", evaluating: "qualification",
  negotiation: "negotiation", proposal: "negotiation", committed: "negotiation", onboarding: "negotiation",
  closed_won: "won", client: "won", closed_lost: "lost",
};

/** The group a stage belongs to. Status wins for a closed deal; an unknown stage reads "Open". */
export function stageGroup(status: string | null | undefined, stage: string | null | undefined, ladder?: WsStage[] | null): StageGroup {
  if (status === "won") return STAGE_GROUPS.won;
  if (status === "lost") return STAGE_GROUPS.lost;
  const hit = (ladder ?? []).find((s) => sameStageLabel(s.label, stage) || s.key === stage);
  const key = BY_CANONICAL[String(hit?.canonical ?? stage ?? "").toLowerCase()];
  return STAGE_GROUPS[key ?? "open"];
}

/**
 * How far along the ladder's open stages a deal is, as filled segments out of `of` (5 by
 * default). A closed deal fills the track; a stage the ladder does not name fills none.
 */
export function stageProgress(status: string | null | undefined, stage: string | null | undefined, ladder?: WsStage[] | null, of = 5): number {
  if (status === "won" || status === "lost") return of;
  const active = (ladder ?? []).filter((s) => s.kind === "active");
  const i = active.findIndex((s) => sameStageLabel(s.label, stage) || s.key === stage);
  if (i < 0 || !active.length) return 0;
  return Math.max(1, Math.round(((i + 1) / active.length) * of));
}
