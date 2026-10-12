import { STAGE_RANK, DONE_STAGES, isTerminalStage, stageRank } from '../pipeline.js';
import { targetStageFor, transitionAt } from '../db/pipelineStage.js';

// Funnel timeline — rebuild an account's stage LADDER from its interaction history.
//
// WHY THIS EXISTS. The `pipeline_stage` observations are a lossy record of the funnel:
//   • Everything written before the occurredAt fix carries the instant it was written,
//     not the instant the account moved, so historical rows have no usable timing.
//   • Backfilled activity is written with skipStageAdvance (contactHistoryEnricher), so
//     no transition row is produced at ingest at all — by design, to avoid a stage
//     read+write per row on a bulk import.
//   • stageDerivation then derives only the CURRENT rung (its rules are a precedence
//     chain of early returns), so an account that climbed four rungs over six months
//     gets one observation at the top rung. A snapshot, not a ladder.
//
// The INTERACTIONS, however, have always been right: logActivity stamps observed_at from
// the provider's own event time, independent of the order rows were written in. So the
// ladder is recoverable by replaying the interactions in chronological order — no
// backfill, no writes, nothing mutated. This is a pure read-side derivation.
//
// The activity → stage mapping is imported from pipelineStage (targetStageFor), NOT
// re-implemented, so the reconstructed funnel is by construction the same funnel the
// live product runs.

export interface FunnelHop {
  stage: string;
  at: string;        // ISO — when the account entered this rung
  rank: number;
}

export interface TimelineActivity {
  property?: string | null;   // 'interaction.meeting_held' — or a bare type
  type?: string | null;
  observed_at?: string | null;
  raw?: Record<string, unknown> | null;
}

const bareType = (a: TimelineActivity): string =>
  String(a.type || a.property || '').replace(/^interaction\./, '');

// Reply signal and direction live on `raw` under a couple of spellings, matching what
// pipelineStageHook reads off the activity context.
const signalOf = (a: TimelineActivity): string | undefined => {
  const r = a.raw || {};
  return (r.provider_signal ?? r.reply_signal) as string | undefined;
};
const outboundOf = (a: TimelineActivity): boolean | undefined => {
  const v = (a.raw || {}).is_outbound;
  return typeof v === 'boolean' ? v : undefined;
};

/**
 * Replay interactions chronologically and emit one hop per genuine rung ADVANCE.
 *
 * Mirrors the live engine's semantics exactly:
 *   • advance-only — a later low-rung touch never demotes an account
 *   • a terminal exit (won/lost/disqualified/churned) closes the ladder; nothing after it
 *     counts, because the deal is over
 *   • timestamps are clamped to `now` (a booking's observed_at is the meeting's START,
 *     which can be in the future — see transitionAt)
 *
 * Returns hops ascending by time. An account with no qualifying activity returns [].
 */
export function reconstructLadder(
  activities: TimelineActivity[],
  opts: { now?: number } = {},
): FunnelHop[] {
  const now = opts.now ?? Date.now();

  // Map first, THEN sort. Sorting on the clamped transition time (not the raw
  // observed_at) keeps a future-dated booking in its true position in the sequence
  // instead of parking it at the end of the account's history.
  const mapped: Array<{ stage: string; at: string }> = [];
  for (const a of activities || []) {
    if (!a?.observed_at) continue;
    const stage = targetStageFor(bareType(a), {
      isOutbound: outboundOf(a),
      replySignal: signalOf(a),
    });
    if (!stage) continue;
    mapped.push({ stage, at: transitionAt(a.observed_at, now) });
  }

  mapped.sort((x, y) => (x.at < y.at ? -1 : x.at > y.at ? 1 : stageRank(x.stage) - stageRank(y.stage)));

  const hops: FunnelHop[] = [];
  let topRank = -1;
  for (const m of mapped) {
    const rank = STAGE_RANK[m.stage] ?? 0;
    if (isTerminalStage(m.stage)) {
      // The exit itself is a hop; everything after it is noise on a dead deal.
      hops.push({ stage: m.stage, at: m.at, rank });
      break;
    }
    if (rank <= topRank) continue;   // advance-only
    topRank = rank;
    hops.push({ stage: m.stage, at: m.at, rank });
  }
  return hops;
}

/**
 * Days spent in each rung, derived from a reconstructed ladder.
 *
 * `openAt` (default now) closes the FINAL, still-open occupancy — the account is sitting
 * in that rung right now and has been since it arrived. That row is the censored one: it
 * is marked `censored: true` because the true duration is "at least this long", not
 * "exactly this long". The existing /v2/pipeline/intelligence median simply omits these,
 * which is what biases its cycle times low — the deals that are stuck the longest are
 * exactly the ones still sitting there, and dropping them throws away the slow tail.
 *
 * Emitting them (flagged) rather than dropping them is what lets the survival layer treat
 * them properly instead of pretending they do not exist.
 */
export function stageOccupancies(
  hops: FunnelHop[],
  opts: { now?: number } = {},
): Array<{ stage: string; days: number; censored: boolean }> {
  const now = opts.now ?? Date.now();
  const out: Array<{ stage: string; days: number; censored: boolean }> = [];
  for (let i = 0; i < hops.length; i++) {
    const start = Date.parse(hops[i].at);
    if (!Number.isFinite(start)) continue;
    const isLast = i === hops.length - 1;
    // A closed stage is not an occupancy. DONE_STAGES, not isTerminalStage: `closed_won`
    // is the TOP RUNG of the ladder here, not a terminal (TERMINAL_STAGES is only the
    // losing exits), so checking terminality alone would count time "spent in closed_won"
    // as funnel time. Nothing is spent in a closed deal either way.
    if (DONE_STAGES.has(hops[i].stage)) continue;
    const end = isLast ? now : Date.parse(hops[i + 1].at);
    if (!Number.isFinite(end)) continue;
    out.push({
      stage: hops[i].stage,
      days: Math.max(0, (end - start) / 86_400_000),
      censored: isLast,
    });
  }
  return out;
}

/**
 * Median time-in-stage that accounts for deals still sitting there (Kaplan-Meier).
 *
 * The problem this solves. A plain median over "how long did accounts spend at negotiation"
 * can only see the ones that LEFT, because a deal still sitting there has no end date yet.
 * But the deals that sit longest are exactly the ones still sitting. Dropping them throws
 * away the slow tail and the median comes back too low, which is precisely the bias in
 * /v2/pipeline/intelligence today. Counting their time-so-far as if it were final is not a
 * fix either, since those are lower bounds, not durations.
 *
 * Kaplan-Meier is the standard handling: a still-open deal contributes to the population
 * "at risk" up to today and then leaves the sample without counting as an exit. Each real
 * exit shrinks the survival curve by the share of those still at risk; the median is where
 * that curve first drops to half.
 *
 * Returns null when the curve never reaches half, which happens when most deals are still
 * open. That is the honest answer for a young pipeline: "more than half are still running,
 * so we cannot name a median yet". A number invented there would be pure fiction.
 */
export interface SurvivalStep {
  /** Days since entering the state. */
  t: number;
  /** Share still un-exited just AFTER this time. */
  survival: number;
}

/**
 * The Kaplan-Meier survival curve for a set of durations, some of them still running.
 *
 * `censored: true` means "still going at `days`" — a lower bound, not a duration. Those rows
 * count toward the population at risk up to their time and then leave without being recorded
 * as an exit, which is the whole point: the slow cases stop being invisible without being
 * counted as though they had finished.
 *
 * Returned as steps, oldest first. survivalAt() reads it.
 */
export function kaplanMeierCurve(
  rows: Array<{ days: number; censored: boolean }>,
): SurvivalStep[] {
  const clean = (rows || []).filter(r => r && Number.isFinite(r.days) && r.days >= 0);
  if (!clean.length) return [];

  // Ascending by time. On a tie the exit is processed before the still-running one, the usual
  // convention: something running exactly as long as another that finished was still at risk.
  const sorted = [...clean].sort(
    (a, b) => a.days - b.days || (a.censored ? 1 : 0) - (b.censored ? 1 : 0),
  );

  const steps: SurvivalStep[] = [];
  let atRisk = sorted.length;
  let survival = 1;
  let i = 0;
  while (i < sorted.length && atRisk > 0) {
    const t = sorted[i].days;
    let exits = 0, stillRunning = 0;
    while (i < sorted.length && sorted[i].days === t) {
      if (sorted[i].censored) stillRunning++; else exits++;
      i++;
    }
    if (exits > 0) {
      survival *= 1 - exits / atRisk;
      steps.push({ t, survival });
    }
    atRisk -= exits + stillRunning;
  }
  return steps;
}

/** Share still un-exited at `t` days. 1 before the first exit; flat after the last step. */
export function survivalAt(curve: SurvivalStep[], t: number): number {
  if (!curve.length || !Number.isFinite(t) || t < 0) return 1;
  let s = 1;
  for (const step of curve) {
    if (step.t > t) break;
    s = step.survival;
  }
  return s;
}

/**
 * Median time to exit, accounting for cases still running.
 *
 * Returns null when the curve never reaches half, which happens when most cases are still
 * going. That is the honest answer for a young pipeline: "more than half are still running,
 * so we cannot name a median yet". A number invented there would be pure fiction.
 */
export function kaplanMeierMedian(
  rows: Array<{ days: number; censored: boolean }>,
): number | null {
  for (const step of kaplanMeierCurve(rows)) {
    if (step.survival <= 0.5) return Math.round(step.t);
  }
  return null;
}

/**
 * Time from entering each rung to the WIN, for one account's ladder.
 *
 * This is the timing half of the forecast, and it is a different question from
 * stageOccupancies. That one asks "how long do accounts sit at negotiation". This one asks
 * "once an account reaches negotiation, how long until the money lands" — which is what
 * "will it close by the 31st" actually needs.
 *
 * Three cases, and the last one is the one people get wrong:
 *   • the account WON      → a real duration, from entering the rung to the win
 *   • still open           → censored at today. It has taken at least this long.
 *   • LOST / disqualified  → censored at the exit, NOT dropped and NOT counted as a win.
 *
 * Treating a loss as censored says "this deal stopped being observable then", which makes
 * the curve read as "how long winners take". That is exactly right here, because P(win) is
 * computed separately from the conversion chain and multiplied in. Dropping losses entirely
 * would instead throw away the information that they were in the running for a while.
 */
export function timeToWinRows(
  hops: FunnelHop[],
  opts: { now?: number } = {},
): Array<{ stage: string; days: number; censored: boolean }> {
  const now = opts.now ?? Date.now();
  if (!hops?.length) return [];

  const wonHop = hops.find(h => h.stage === 'closed_won');
  const exitHop = hops.find(h => isTerminalStage(h.stage));
  // Whichever ends the account's run: a win is an event, an exit or "still going" is not.
  const endMs = wonHop ? Date.parse(wonHop.at)
    : exitHop ? Date.parse(exitHop.at)
    : now;
  const isEvent = Boolean(wonHop);
  if (!Number.isFinite(endMs)) return [];

  const out: Array<{ stage: string; days: number; censored: boolean }> = [];
  for (const h of hops) {
    // A closed rung is an endpoint, not somewhere you wait to close FROM.
    if (DONE_STAGES.has(h.stage) || isTerminalStage(h.stage)) continue;
    const start = Date.parse(h.at);
    if (!Number.isFinite(start) || start > endMs) continue;
    out.push({
      stage: h.stage,
      days: Math.max(0, (endMs - start) / 86_400_000),
      censored: !isEvent,
    });
  }
  return out;
}
