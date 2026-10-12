// The funnel, for the browser.
//
// MIRROR of packages/core/src/pipeline.ts. The frontend does not import
// @nous/core (it never touches the DB and has no build dependency on it), so the
// ladder is duplicated here exactly once — the same arrangement as
// config/plans.ts mirroring apps/api/src/lib/plans.mjs. The server is the source
// of truth; if these two ever disagree, core wins.
//
// Every stage list in the frontend must import from this file. Before it existed
// there were five different lists across the pages, and three of them carried a
// phantom `onboarding` column that no backend stage could ever fill.

export const PIPELINE_LADDER = [
  'identified',
  'connected',
  'interested',
  'meeting_booked',
  'discovery',
  'demo',
  'negotiation',
  'closed_won',
] as const;

export const TERMINAL_STAGES = ['closed_lost', 'disqualified', 'churned'] as const;

export const ALL_PIPELINE_STAGES = [...PIPELINE_LADDER, ...TERMINAL_STAGES] as const;

export type PipelineStage = (typeof ALL_PIPELINE_STAGES)[number];

export const STAGE_RANK: Record<string, number> = {
  identified: 0,
  connected: 1,
  interested: 2,
  meeting_booked: 3,
  discovery: 4,
  demo: 5,
  negotiation: 6,
  closed_won: 7,
  closed_lost: 8,
  disqualified: 8,
  churned: 9,
};

export const STAGE_LABEL: Record<string, string> = {
  identified: 'Identified',
  connected: 'Connected',
  interested: 'Interested',
  meeting_booked: 'Meeting Booked',
  discovery: 'Discovery',
  demo: 'Demo',
  negotiation: 'Negotiation',
  closed_won: 'Closed Won',
  closed_lost: 'Closed Lost',
  disqualified: 'Disqualified',
  churned: 'Churned',
};

/** The columns the accounts board draws, left → right. Terminals are off the
 *  board — they're decided, not in play. */
export const BOARD_STAGES = PIPELINE_LADDER;

/** Still in play. Excludes closed_won and every terminal. */
export const OPEN_STAGES: ReadonlySet<string> = new Set(
  PIPELINE_LADDER.filter(s => s !== 'closed_won'),
);

/** Decided — won or exited. */
export const DONE_STAGES: ReadonlySet<string> = new Set<string>([
  'closed_won',
  ...TERMINAL_STAGES,
]);

const ALL_SET: ReadonlySet<string> = new Set<string>(ALL_PIPELINE_STAGES);

/** Legacy stage names, mapped to their replacement. Kept so a record written
 *  before the funnel change still renders instead of showing a blank cell. */
export const LEGACY_STAGE_MAP: Record<string, PipelineStage> = {
  aware: 'identified',
  evaluating: 'interested',
  proposal: 'negotiation',
  client: 'closed_won',
  lost: 'closed_lost',
  onboarding: 'closed_won',
};

/** Coerce anything — current stage, legacy stage, null — into a valid stage. */
export function normalizeStage(v: unknown): PipelineStage | null {
  if (typeof v !== 'string') return null;
  const s = v.trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (ALL_SET.has(s)) return s as PipelineStage;
  return LEGACY_STAGE_MAP[s] ?? null;
}

/** Rank of a stage, resolving legacy names. Unknown → 0. */
export function stageRank(v: unknown): number {
  const s = normalizeStage(v);
  return s ? STAGE_RANK[s] : 0;
}

/** Display label, resolving legacy names. Falls back to the raw value so an
 *  unexpected stage is visible rather than silently blank. */
export function stageLabel(v: unknown): string {
  const s = normalizeStage(v);
  return s ? STAGE_LABEL[s] : (typeof v === 'string' && v ? v : '—');
}

export const DEFAULT_STAGE: PipelineStage = 'identified';

const TERMINAL_STAGE_SET = new Set<string>(TERMINAL_STAGES);
/**
 * An account's stage: its furthest-along live person; the exits only when everyone has exited.
 * Mirrors accountStage in packages/core/src/pipeline.ts (GET-263) — the board and the account
 * page both read this, and the API writes the account stage by the same rule.
 */
export function accountStageOf(personStages: ReadonlyArray<unknown>): PipelineStage | null {
  // A person with no stage yet is a live lead (identified), not an exit.
  const all = personStages.map(normalizeStage);
  const live = all.filter(s => !TERMINAL_STAGE_SET.has(s ?? DEFAULT_STAGE));
  return (live.length ? live : all).reduce<PipelineStage | null>((best, s) => (!s ? best : best === null || stageRank(s) > stageRank(best) ? s : best), null);
}
