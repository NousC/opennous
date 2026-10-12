// The funnel — ONE definition, imported everywhere.
//
// Before this module the stage list was hand-copied into ~20 places across all
// four apps in seven versions that disagreed with each other. That is not a
// tidiness problem: a stage missing from one copy gets treated as "not a real
// sales stage" and the account silently vanishes from queries, attention and
// reporting (see getProductUserEntityIds in db/relationship.ts). Every list of
// stages anywhere must now come from here.
//
// The ladder is role-agnostic: it describes the state of the DEAL, never who
// owns it. One card = one company = one active deal.

/**
 * The active ladder, lowest → highest. Order IS the rank — a stage's position
 * in this array is its rank, and advancement is rank-gated (never a downgrade).
 *
 *  identified     nothing has happened yet — the default for every new contact
 *  connected      the lead did SOMETHING: accepted a connection, replied at all,
 *                 opened, visited, downloaded. Any lead-side activity lands here.
 *  interested     they replied POSITIVELY. Real interest, not "wrong person".
 *  meeting_booked a meeting is on the calendar. This is the SDR→AE handoff line
 *                 when a team has both, and the SDR's credited outcome.
 *  discovery      a call happened. Every first meeting lands here.
 *  demo           the transcript says it was a demo (see call-type detection).
 *  negotiation    terms. Proposal is folded in here, not a separate stage.
 *  closed_won     signed.
 */
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

/**
 * Exits from the ladder. These never decay and the stage worker never
 * auto-advances out of one — only an explicit re-engagement revives them.
 *
 *  closed_lost   we lost the deal.
 *  disqualified  never a fit, or they told us to stop. NOT a lost deal — this is
 *                the negative signal the ICP model learns from, so it must stay
 *                distinguishable from closed_lost.
 *  churned       a former customer who left. Only reachable from closed_won.
 */
export const TERMINAL_STAGES = ['closed_lost', 'disqualified', 'churned'] as const;

/** Every valid stage. Anything not in here is rejected on write. */
export const ALL_PIPELINE_STAGES = [...PIPELINE_LADDER, ...TERMINAL_STAGES] as const;

export type PipelineLadderStage = (typeof PIPELINE_LADDER)[number];
export type TerminalStage = (typeof TERMINAL_STAGES)[number];
export type Stage = (typeof ALL_PIPELINE_STAGES)[number];

/**
 * Rank for the advance-only gate. Terminals sit ABOVE the ladder so a routine
 * ladder signal can never step onto — or out of — a terminal stage; terminal
 * transitions and reactivation are handled explicitly, not by rank.
 * closed_lost and disqualified share a rank: neither outranks the other.
 */
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

/** Display names. The UI must not invent its own — a stage renamed here renames everywhere. */
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

/** Still in play — on the board, not yet decided. Excludes closed_won and every terminal. */
export const OPEN_STAGES: ReadonlySet<string> = new Set(
  PIPELINE_LADDER.filter(s => s !== 'closed_won'),
);

/** Off the ladder — closed_won plus the three exits. Nothing auto-advances out of these. */
export const DONE_STAGES: ReadonlySet<string> = new Set<string>(['closed_won', ...TERMINAL_STAGES]);

const TERMINAL_SET: ReadonlySet<string> = new Set<string>(TERMINAL_STAGES);
const ALL_SET: ReadonlySet<string> = new Set<string>(ALL_PIPELINE_STAGES);

/**
 * Stages that existed before this funnel, mapped to their replacement.
 *
 * `evaluating` is the awkward one and it is NOT a straight rename. It was a
 * catch-all that swallowed meetings, pricing-page visits, trial starts and sent
 * proposals alike. Mapping all of it to `discovery` would invent calls that
 * never happened, so the default here is the conservative `interested` and the
 * migration upgrades an account to meeting_booked/discovery only when its own
 * history actually shows a meeting. See resolveLegacyEvaluating().
 */
export const LEGACY_STAGE_MAP: Record<string, Stage> = {
  aware: 'identified',        // opens and visits are not a funnel position
  evaluating: 'interested',   // conservative default — see resolveLegacyEvaluating
  proposal: 'negotiation',    // folded in
  client: 'closed_won',       // renamed
  lost: 'closed_lost',        // renamed
  onboarding: 'closed_won',   // never a real stage; post-sale lives inside closed_won
};

/**
 * An account's stage: its furthest-along LIVE person, by rank; only when every person has exited
 * does it fall back to the exits. Terminal exits rank above the whole ladder, so a plain max would
 * let one churned contact bury an account that still has someone in negotiation.
 *
 * ONE rule, read by the Accounts board and the account page (apps/frontend/src/config/pipeline.ts
 * mirrors it — the frontend cannot import core) and used by planAccountStage to write it (GET-263).
 * Null when the account has no staged person.
 */
export function accountStage(personStages: ReadonlyArray<unknown>): Stage | null {
  // A person with no stage yet is a live lead (identified), not an exit.
  const all = personStages.map(normalizeStage);
  const live = all.filter(s => !TERMINAL_SET.has(s ?? 'identified'));
  return (live.length ? live : all).reduce<Stage | null>((best, s) => (!s ? best : best === null || STAGE_RANK[s] > STAGE_RANK[best] ? s : best), null);
}

/**
 * Which people to move so the account reads `target` afterwards. Pure: callers apply the writes.
 *
 *   exit (closed_lost/disqualified/churned)  every live person exits
 *   open stage                               everyone further along steps back to it; if nobody is
 *                                            then at it, the primary (first) person moves to it
 *
 * closed_won is not planned here: "everyone at the company converts" already has one path
 * (markCompanyClient), and a second would drift from it. `people` is ordered primary first.
 */
export function planAccountStage(
  people: ReadonlyArray<{ id: string; pipeline_stage: unknown }>,
  target: Stage,
): Array<{ id: string; from: Stage | null; to: Stage }> {
  const withStage = people.map(p => ({ id: p.id, stage: normalizeStage(p.pipeline_stage) }));
  const moves = new Map<string, { id: string; from: Stage | null; to: Stage }>();
  if (TERMINAL_SET.has(target)) {
    for (const p of withStage) if (!p.stage || !TERMINAL_SET.has(p.stage)) moves.set(p.id, { id: p.id, from: p.stage, to: target });
    return [...moves.values()];
  }
  const live = withStage.filter(p => !p.stage || !TERMINAL_SET.has(p.stage));
  for (const p of live) {
    if (p.stage && STAGE_RANK[p.stage] > STAGE_RANK[target]) moves.set(p.id, { id: p.id, from: p.stage, to: target });
  }
  const someoneAt = live.some(p => moves.has(p.id) || p.stage === target);
  if (!someoneAt) {
    const primary = live[0] ?? withStage[0];
    if (primary) moves.set(primary.id, { id: primary.id, from: primary.stage, to: target });
  }
  return [...moves.values()];
}

/** True if `v` is a stage in the current funnel. */
export function isPipelineStage(v: unknown): v is Stage {
  return typeof v === 'string' && ALL_SET.has(v);
}

/** True if `v` is one of the three exits. */
export function isTerminalStage(v: unknown): boolean {
  return typeof v === 'string' && TERMINAL_SET.has(v);
}

/**
 * Coerce anything — a current stage, a legacy stage, a CRM string, null — into a
 * valid stage. Returns null when it cannot be resolved, so callers can decide
 * between rejecting the write and falling back to the default.
 */
export function normalizeStage(v: unknown): Stage | null {
  if (typeof v !== 'string') return null;
  const s = v.trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (ALL_SET.has(s)) return s as Stage;
  return LEGACY_STAGE_MAP[s] ?? null;
}

/** Rank of a stage, resolving legacy names. Unknown → 0 (the floor, `identified`). */
export function stageRank(v: unknown): number {
  const s = normalizeStage(v);
  return s ? STAGE_RANK[s] : 0;
}

/**
 * Where a legacy `evaluating` account really belongs, given what actually
 * happened on it. The one place the migration and any back-compat read agree.
 *
 *   a call was held        → discovery
 *   a meeting is booked    → meeting_booked
 *   neither (pricing view,
 *   trial, proposal sent)  → interested
 */
export function resolveLegacyEvaluating(
  history: { hasMeetingHeld: boolean; hasMeetingBooked: boolean },
): Stage {
  if (history.hasMeetingHeld) return 'discovery';
  if (history.hasMeetingBooked) return 'meeting_booked';
  return 'interested';
}

/** The default stage for a contact that has none. Every new record starts here. */
export const DEFAULT_STAGE: Stage = 'identified';
