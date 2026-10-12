import { PIPELINE_LADDER } from '../pipeline.js';
import { survivalAt, type SurvivalStep } from './funnelTimeline.js';

// Forecast, layer 1 — base-rate weighted pipeline. This file is the per-deal half (P(win) and
// timing, which the deal outlook uses too); the roll-up into a revenue forecast is Nous Cloud's
// (cloud/forecast.ts, GET-843).
//
// A forecast is two probabilities multiplied, and they come from different data:
//
//   contribution = amount × P(win | stage) × P(closes by the period end)
//
//   P(win)          — will this ever close?  From the stage-to-stage conversion chain.
//   P(close by T)   — will it close by the 31st?  From how long deals actually take.
//
// Most tools collapse these into one "probability" field and lose the second, which is why
// they can tell you a deal is 60% likely but not whether the money lands this quarter.
// Keeping them apart is the point.
//
// Layer 1 involves NO model and NO training. It is arithmetic over the workspace's own base
// rates, which means every number is explainable down to the deal: "$180k is these 12
// accounts, and here is each one's share". That is deliberate — a forecast a rep does not
// believe is a forecast nobody uses.
//
// Pure. No DB, no clock beyond what is passed in.

// ─── P(win): the smoothed conversion chain ───────────────────────────────────

/**
 * Prior conversion rate for each rung, used when a workspace has too little history for its
 * own numbers to mean anything.
 *
 * These are JUDGEMENT CALLS, not measurements — plausible mid-market B2B rates, and they are
 * meant to be overwritten. A stage with real volume barely feels them; a stage with four
 * deals leans on them almost entirely, which is the intended behaviour. stageRatesBasis()
 * reports how much of the answer is still prior rather than data.
 */
export const DEFAULT_STAGE_PRIORS: Record<string, number> = {
  identified:     0.25,   // → connected
  connected:      0.30,   // → interested
  interested:     0.40,   // → meeting_booked
  meeting_booked: 0.75,   // → discovery (most booked meetings do happen)
  discovery:      0.55,   // → demo
  demo:           0.45,   // → negotiation
  negotiation:    0.60,   // → closed_won
};

/**
 * How much evidence the prior is worth, in deals.
 *
 * The smoothed rate is a Beta posterior: (wins + α) / (trials + α + β), with α and β set so
 * the prior carries this much weight. At 12, a stage with 200 deals sits essentially on its
 * empirical rate while a stage with 4 stays near the prior. Raw ratios over a handful of
 * deals are noise, and a forecast that jumps because one deal moved is one nobody trusts.
 */
export const PRIOR_STRENGTH = 12;

export interface StageConversion {
  from: string;
  to: string;
  reached_from: number;
  reached_to: number;
}

export interface ConversionRate {
  from: string;
  to: string;
  /** Smoothed rate — what the forecast uses. */
  rate: number;
  /** Unsmoothed, for display. null when nothing reached this rung. */
  observed: number | null;
  sample: number;
  /** 0 = entirely the workspace's own data, 1 = entirely prior. */
  priorWeight: number;
}

/** Beta-posterior mean: the empirical rate pulled toward `prior` by `strength` deals' worth. */
export function smoothRate(
  reachedNext: number,
  reachedStage: number,
  prior: number,
  strength: number = PRIOR_STRENGTH,
): number {
  const trials = Math.max(0, reachedStage);
  const wins = Math.max(0, Math.min(reachedNext, trials));
  const alpha = prior * strength;
  const beta = (1 - prior) * strength;
  return (wins + alpha) / (trials + alpha + beta);
}

/** Smooth every rung of the ladder. Rungs with no data come back as the bare prior. */
export function buildConversionRates(
  conversions: StageConversion[],
  opts: { priors?: Record<string, number>; strength?: number } = {},
): ConversionRate[] {
  const priors = opts.priors ?? DEFAULT_STAGE_PRIORS;
  const strength = opts.strength ?? PRIOR_STRENGTH;
  const byFrom = new Map((conversions || []).map(c => [c.from, c]));

  const out: ConversionRate[] = [];
  for (let i = 0; i < PIPELINE_LADDER.length - 1; i++) {
    const from = PIPELINE_LADDER[i], to = PIPELINE_LADDER[i + 1];
    const c = byFrom.get(from);
    const trials = Math.max(0, c?.reached_from ?? 0);
    const wins = Math.max(0, Math.min(c?.reached_to ?? 0, trials));
    const prior = priors[from] ?? 0.5;
    out.push({
      from, to,
      rate: smoothRate(wins, trials, prior, strength),
      observed: trials > 0 ? wins / trials : null,
      sample: trials,
      // Share of the posterior still coming from the prior rather than from data.
      priorWeight: strength / (trials + strength),
    });
  }
  return out;
}

/**
 * P(win) from each stage: the product of every remaining rung's conversion rate.
 *
 * An account at negotiation only has to clear one more rung; one at `identified` has to clear
 * all seven, so its probability is the product of all of them and is correspondingly small.
 * That compounding is the honest shape of a funnel.
 */
export function winProbabilityByStage(rates: ConversionRate[]): Record<string, number> {
  const out: Record<string, number> = { closed_won: 1 };
  let running = 1;
  // Walk backwards from the win so each stage multiplies in its own rung.
  for (let i = rates.length - 1; i >= 0; i--) {
    running *= rates[i].rate;
    out[rates[i].from] = running;
  }
  return out;
}

// ─── P(close by T): the timing half ──────────────────────────────────────────

/**
 * Probability of closing within `horizonDays`, given the deal has ALREADY sat at this stage
 * for `alreadyDays`.
 *
 * This is conditional survival, and the conditioning is the part that matters. A deal three
 * days into negotiation and one ninety days in are not the same deal, and asking the raw
 * curve would give them the same answer. What we want is: of the deals that were still open
 * at day 90, how many closed by day 120?
 *
 *     P(close by d+h | still open at d) = (S(d) − S(d+h)) / S(d)
 *
 * Returns null when the curve holds nothing — that is "we cannot say", which the caller must
 * carry through rather than papering over with a default.
 */
export function probCloseWithin(
  curve: SurvivalStep[],
  alreadyDays: number,
  horizonDays: number,
): number | null {
  if (!curve?.length) return null;
  if (!Number.isFinite(horizonDays) || horizonDays <= 0) return 0;
  const d = Number.isFinite(alreadyDays) && alreadyDays > 0 ? alreadyDays : 0;
  const sNow = survivalAt(curve, d);
  // Everything comparable has already closed; the curve can say nothing about this deal.
  if (sNow <= 0) return null;
  const sThen = survivalAt(curve, d + horizonDays);
  const p = (sNow - sThen) / sNow;
  return Math.min(1, Math.max(0, p));
}

// ─── one deal, one window: P(win) and P(closes within N days) ─────────────────
//
// The per-deal half of the forecast, which the deal outlook (forecastRun.ts) reads on its own:
// how likely a deal is to be won, and to be won inside a window. The revenue roll-up on top of
// it (amounts, the period total, the simulated band, the weekly snapshot) is Nous Cloud's
// (packages/core/src/cloud/forecast.ts, GET-843).

export interface ForecastDealInput {
  entityId: string;
  name?: string | null;
  /** Open pipeline value. Null means we have no amount for this account. */
  amount: number | null;
  stage: string;
  /** Days already spent at the current stage. */
  daysInStage: number;
  /** Where `amount` came from, carried through to the result for honesty. */
  amountBasis?: string;
  /** Current intent band. Modulates the TIMING half only — see DEFAULT_INTENT_HAZARD. */
  intentBand?: string | null;
  /**
   * Layer-3 override: a per-deal win probability that REPLACES the stage-only figure.
   * Computed upstream by adjustWinProbability (winModel.ts) from the account's own facts
   * — authority, objections, competitors, stall. When absent, the stage figure stands.
   */
  pWin?: number | null;
}

export interface DealTiming extends ForecastDealInput {
  /** Stage-only P(win) — kept so the layer-3 adjustment stays auditable per deal. */
  pWinBase: number;
  pWin: number;
  /** Timing probability BEFORE intent — kept so the adjustment is auditable. */
  pCloseBase: number | null;
  pClose: number | null;
  /** The intent multiplier applied. 1 = no effect or no band known. */
  intentMultiplier: number;
  /** Set when timing could not be judged, so the UI can say why. */
  caveat?: string;
}

/** How much the stage rates rest on priors rather than the workspace's own history. */
export type StageRatesBasis = 'prior' | 'blended' | 'learned';

export interface ForecastModel {
  rates: ConversionRate[];
  winByStage: Record<string, number>;
  /** Time-to-win curve per stage. */
  curvesByStage: Record<string, SurvivalStep[]>;
}

/**
 * Weight the prior share by how much each rung actually carries, then bucket it. A number
 * resting on assumptions must say so rather than presenting the same face as one built on
 * three hundred closed deals.
 *   'prior'   — mostly assumption. Show a wide band and say so.
 *   'blended' — real data, thin.
 *   'learned' — enough history to stand on its own.
 */
export function stageRatesBasis(rates: ConversionRate[]): StageRatesBasis {
  const avgPriorWeight = rates.length
    ? rates.reduce((s, r) => s + r.priorWeight, 0) / rates.length
    : 1;
  return avgPriorWeight > 0.6 ? 'prior' : avgPriorWeight > 0.25 ? 'blended' : 'learned';
}

/**
 * Every deal's P(win) and P(closes within `horizonDays`), in input order.
 *
 * When the timing curve cannot answer for a stage, `pClose` is null with a caveat attached.
 * Assuming it lands inside the window would be inventing the exact number this exists to
 * establish.
 */
export function scoreDealsWithin(
  deals: ForecastDealInput[],
  model: ForecastModel,
  opts: {
    horizonDays: number;
    /** Set false to compute the pre-intent figure — used to show what intent changed. */
    intentHazard?: boolean;
    /** Override the band -> multiplier table (a workspace's own fitted values, later). */
    intentTable?: Record<string, number>;
  },
): DealTiming[] {
  return (deals || []).map((d) => {
    const pWinBase = model.winByStage[d.stage] ?? 0;
    // Layer 3: a caller-supplied adjusted probability wins over the stage-only figure.
    // Both are reported, so "why is this deal at 31% when negotiation is 60%" is always
    // answerable from the response alone.
    const pWin = d.pWin != null && Number.isFinite(d.pWin)
      ? Math.min(1, Math.max(0, d.pWin))
      : pWinBase;
    const curve = model.curvesByStage[d.stage] ?? [];
    const pCloseBase = probCloseWithin(curve, d.daysInStage, opts.horizonDays);

    // Intent moves the TIMING half only, never P(win). Whether a deal will ever close is a
    // question about the account and the funnel; whether it closes THIS period is a question
    // about momentum, and that is what intent measures. Folding it into P(win) as well would
    // double-count the same evidence.
    const intentMultiplier = opts.intentHazard === false
      ? 1
      : intentMultiplierFor(d.intentBand, opts.intentTable);
    const pClose = applyIntentMultiplier(pCloseBase, intentMultiplier);
    const caveat = pClose === null ? 'not enough closed deals from this stage to judge timing' : undefined;
    return { ...d, pWinBase, pWin, pCloseBase, pClose, intentMultiplier, ...(caveat ? { caveat } : {}) };
  });
}

// ─── Layer 2a: intent as a hazard multiplier ─────────────────────────────────

/**
 * How much faster (or slower) a deal closes for its intent band.
 *
 * The intent score is already the right shape for this: it decays with a per-signal
 * half-life, saturates on repeats, and needs two distinct signals before it goes hot. That
 * is a hazard function in everything but name, and it is the one number that separates two
 * deals which look identical on paper — same stage, same amount, same age — where one had a
 * call last week and the other has been silent since June.
 *
 * These are DEFAULTS, deliberately, and they follow the same pattern as
 * DEFAULT_STAGE_PRIORS: a sensible starting assumption that a workspace's own data replaces
 * once it has enough closed deals to estimate the effect. Fitting a coefficient needs deals
 * that went hot and then closed, which a young workspace does not have — but waiting for
 * that would mean shipping nothing, and a defaulted multiplier is far closer to the truth
 * than the implicit 1.0 of ignoring intent entirely.
 *
 * Client-mode bands (Expansion / Active / At-risk) are included because the intent worker
 * switches vocabulary for existing customers; an unknown band falls back to 1.0 rather than
 * silently discounting the deal.
 */
export const DEFAULT_INTENT_HAZARD: Record<string, number> = {
  'Red-hot': 1.70,
  'Hot': 1.40,
  'Warm': 1.10,
  'Aware': 0.80,
  'Dormant': 0.50,
  // client mode
  'Expansion': 1.30,
  'Active': 1.00,
  'At-risk': 0.60,
};

/**
 * Apply an intent multiplier to a close probability, proportional-hazards style:
 *
 *     p' = 1 − (1 − p)^m
 *
 * Multiplying p directly would be wrong — a 0.8 probability times 1.7 is 1.36, which is not
 * a probability. Scaling the HAZARD instead keeps the result inside [0,1] by construction
 * for any positive multiplier, and behaves the way intuition expects at both ends: a deal
 * that was never closing this period stays there, and a near-certain one cannot exceed
 * certainty. m = 1 leaves p untouched.
 */
export function applyIntentMultiplier(p: number | null, multiplier: number): number | null {
  if (p === null || !Number.isFinite(p)) return null;
  if (!Number.isFinite(multiplier) || multiplier <= 0) return p;
  // Exact no-op at 1. Most accounts carry no intent band, so this is the common path, and
  // 1 - (1 - p)**1 is p only to within a float epsilon — no reason to perturb every
  // unscored deal by a rounding error.
  if (multiplier === 1) return p;
  if (p <= 0) return 0;
  if (p >= 1) return 1;
  return Math.min(1, Math.max(0, 1 - Math.pow(1 - p, multiplier)));
}

/** The multiplier for a band, defaulting to 1.0 (no effect) for anything unrecognised. */
export function intentMultiplierFor(
  band: string | null | undefined,
  table: Record<string, number> = DEFAULT_INTENT_HAZARD,
): number {
  if (!band) return 1;
  const m = table[band];
  return Number.isFinite(m) && m > 0 ? m : 1;
}
