import { DONE_STAGES, isTerminalStage } from '../pipeline.js';
import type { FunnelHop } from '../services/funnelTimeline.js';
import { WIN_FEATURES, DEFAULT_WIN_COEFFS } from '../services/winModel.js';

// Fitting the forecast's win model (layer 3) on a workspace's own closed deals — GET-754
// slice 8: Cloud-only. Applying the model (adjustWinProbability, the hand-set default
// coefficients, the encoders) stays public in services/winModel.ts, so the open-source
// forecast runs on the defaults. Pure — no DB, no clock; the worker's fit job gathers the data.

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const logit = (p: number) => Math.log(p / (1 - p));
const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));

// ─── training rows from a reconstructed ladder ───────────────────────────────

export interface WinTrainingRow {
  stage: string;
  /** ISO — when the account entered this rung (the freeze point for its features). */
  enteredAt: string;
  /** 1 = the deal eventually won, 0 = it hit a losing terminal. */
  label: 0 | 1;
  /** ISO — when the deal resolved. Drives the time-ordered holdout split. */
  resolvedAt: string;
}

/** Max weekly panel rows per rung — bounds volume on a deal that sat somewhere for a year. */
export const PANEL_WEEKS_CAP = 8;

/**
 * The (deal, week) training panel from one closed deal's ladder: a snapshot row at rung
 * entry and then every 7 days the deal REMAINED at that rung, all carrying the deal's
 * final outcome. This is the plan's discrete-time panel, applied to a binary target:
 * each row asks "given the deal was open here, at this age, did it eventually win".
 *
 * Why a panel and not a single row at rung entry: at entry, age-in-stage is zero by
 * definition — a feature that is constant in training cannot be fitted, yet varies on
 * every live deal being scored. Weekly rows give stall its variance honestly: a row at
 * entry+14d only exists because the deal genuinely was still sitting there 14 days in,
 * which is exactly the condition a live deal satisfies when it gets scored.
 *
 * KNOWN BIAS, accepted and bounded: rows near the end of a winner's run look "hot" (the
 * closing flurry) and rows near the end of a loser's look quiet — proximity to the
 * outcome leaks a little into late rows on both sides. The prior-centered L2, the sign
 * constraints and the holdout gate bound what that can do; the alternative (only staked
 * live predictions, plan item 13) replaces this reconstruction entirely once enough
 * accumulate.
 *
 * A still-open ladder yields NOTHING: a yes/no classifier needs an actual yes or no, and
 * labelling the unresolved would be guessing twice. (Different from the timing curves,
 * where "still open" is real censored information — a deliberate asymmetry.)
 */
export function trainingRowsFromLadder(hops: FunnelHop[]): WinTrainingRow[] {
  if (!hops?.length) return [];
  const WEEK = 7 * 86_400_000;
  // A win ANYWHERE in the ladder is a win, resolved at the win — precedence over the last
  // hop, matching timeToWinRows. The trap this avoids: 'churned' is terminal and only
  // reachable FROM closed_won, so a former customer's ladder ends [..., closed_won,
  // churned]. Keying off the last hop alone would label every genuinely WON deal of a
  // workspace with churn history as a loss — training the closer's own winning patterns
  // with negative gradient. Churn is a retention fact; the deal itself was won.
  const wonHop = hops.find(h => h.stage === 'closed_won');
  const last = hops[hops.length - 1];
  let label: 0 | 1;
  let resolvedHop: FunnelHop;
  if (wonHop) { label = 1; resolvedHop = wonHop; }
  else if (isTerminalStage(last.stage)) { label = 0; resolvedHop = last; }
  else return [];   // still open — no answer yet
  const endMs = Date.parse(resolvedHop.at);
  if (!Number.isFinite(endMs)) return [];

  const out: WinTrainingRow[] = [];
  for (let i = 0; i < hops.length; i++) {
    const h = hops[i];
    if (DONE_STAGES.has(h.stage) || isTerminalStage(h.stage)) continue;
    const start = Date.parse(h.at);
    if (!Number.isFinite(start)) continue;
    // The rung's occupancy ends at the next hop (or at resolution for the final rung).
    const next = i + 1 < hops.length ? Date.parse(hops[i + 1].at) : endMs;
    const rungEnd = Number.isFinite(next) ? Math.min(next, endMs) : endMs;
    for (let w = 0; w < PANEL_WEEKS_CAP; w++) {
      const t = start + w * WEEK;
      if (t >= rungEnd && w > 0) break;   // entry row always emits; weekly rows only while open
      out.push({
        stage: h.stage,
        enteredAt: new Date(t).toISOString(),
        label,
        resolvedAt: resolvedHop.at,
      });
      if (t >= rungEnd) break;
    }
  }
  return out;
}

// ─── fitting ─────────────────────────────────────────────────────────────────

export interface WinFitRow {
  /** Encoded (centered) feature values. */
  x: Record<string, number>;
  /** Stage-based P(win) at this row's stage — the fixed offset. */
  pStage: number;
  label: 0 | 1;
  resolvedAt: string;
  /**
   * The deal (account) this row came from. Drives the win count for the unfreeze gate and
   * keeps the holdout split at DEAL granularity. Without it, both fall back to resolvedAt
   * identity — which collapses when close dates are date-only (a CRM import resolves many
   * deals at the same midnight), undercounting wins and bisecting deals across the split.
   */
  dealId?: string;
}

export interface WinFitResult {
  coefficients: Record<string, number>;
  basis: 'default' | 'fitted';
  trainingWins: number;
  trainingLosses: number;
  trainingRows: number;
  beatsBaseline: boolean;
  holdout: { rows: number; modelLogLoss: number; baselineLogLoss: number } | null;
  /** Which feature keys the schedule allowed to move. */
  unfrozen: string[];
}

/**
 * The unfreeze schedule — the guardrail against a 12-win workspace confidently learning
 * noise. Counted in distinct WINS, not rows: one deal yields several rung-rows, and
 * correlated rows must not masquerade as independent evidence.
 *
 *   under 20 wins    everything pinned to the hand-set defaults
 *   20 to 49 wins    tier-1 only: age_ratio, days_quiet, intent, icp_fit
 *   50 and up        everything free
 */
export function unfrozenKeys(wins: number): string[] {
  if (wins < 20) return [];
  if (wins < 50) return WIN_FEATURES.filter(f => f.tier === 1).map(f => f.key);
  return WIN_FEATURES.map(f => f.key);
}

const rowLogLoss = (p: number, y: 0 | 1) => {
  const q = clamp(p, 1e-6, 1 - 1e-6);
  return -(y * Math.log(q) + (1 - y) * Math.log(1 - q));
};

/**
 * Fit the offset-logistic coefficients on labelled rows.
 *
 *   minimise  sum NLL( sigmoid(logit(pStage) + beta.x), label )  +  lambda * ||beta - beta0||^2
 *
 * - PRIOR-CENTERED L2: shrinkage pulls toward the hand-set defaults beta0, not toward
 *   zero, so thin data degrades gracefully into the product's stated default behaviour.
 * - SIGN-CONSTRAINED by projection each step: a "competitor present" coefficient cannot
 *   go positive no matter what a small sample suggests.
 * - UNFREEZE SCHEDULE: pinned keys keep beta0 exactly.
 * - DETERMINISTIC: full-batch gradient descent, fixed iterations, no randomness — same
 *   rows in, same model out, always.
 * - TIME-ORDERED HOLDOUT, never random k-fold: the newest 25% of rows by resolution date
 *   are held out, and the fitted model must beat the stage-only baseline (beta = 0 — pure
 *   layer 1) on log-loss there, or it reports beatsBaseline=false and the caller keeps
 *   the defaults. Forecasting is extrapolation into the future; validating on a random
 *   shuffle would let the model peek at the era it claims to predict.
 */
export function fitWinModel(
  rows: WinFitRow[],
  opts: { lambda?: number; iterations?: number; learningRate?: number } = {},
): WinFitResult {
  const clean = (rows || []).filter(r =>
    r && r.x && (r.label === 0 || r.label === 1) &&
    Number.isFinite(r.pStage) && r.pStage > 0 && r.pStage < 1);

  // Distinct DEALS, not rows: one deal contributes several correlated panel rows, and
  // correlated rows must not masquerade as independent evidence. dealId is the identity;
  // resolvedAt is the fallback for callers that did not pass one (imperfect when close
  // dates are date-only, which is exactly why callers should pass dealId).
  const dealKey = (r: WinFitRow) => r.dealId ?? r.resolvedAt;
  const winDeals = new Set(clean.filter(r => r.label === 1).map(dealKey));
  const lossDeals = new Set(clean.filter(r => r.label === 0).map(dealKey));
  const wins = winDeals.size, losses = lossDeals.size;

  const base: WinFitResult = {
    coefficients: { ...DEFAULT_WIN_COEFFS },
    basis: 'default',
    trainingWins: wins, trainingLosses: losses, trainingRows: clean.length,
    beatsBaseline: false, holdout: null, unfrozen: [],
  };
  const free = unfrozenKeys(wins);
  // Nothing unfrozen, or no contrast to learn from — the defaults ARE the model.
  if (free.length === 0 || wins === 0 || losses === 0) return base;

  // Time-ordered split at DEAL granularity: hold out the newest ~25% of deals, whole.
  // Splitting at a row index would bisect a deal across the boundary, putting rows with
  // the same label and near-identical features on both sides — a leak that makes the
  // beats-baseline exam easier than a true out-of-time test. Deals ordered by resolution
  // date (dealId as tiebreaker for determinism on same-day closes).
  const dealOrder = [...new Set(clean.map(dealKey))].sort((a, b) => {
    const ra = clean.find(r => dealKey(r) === a)!.resolvedAt;
    const rb = clean.find(r => dealKey(r) === b)!.resolvedAt;
    return ra < rb ? -1 : ra > rb ? 1 : a < b ? -1 : 1;
  });
  const holdDealN = Math.max(2, Math.floor(dealOrder.length * 0.25));
  const holdDeals = new Set(dealOrder.slice(dealOrder.length - holdDealN));
  const train = clean.filter(r => !holdDeals.has(dealKey(r)));
  const hold = clean.filter(r => holdDeals.has(dealKey(r)));
  if (train.length < 8 || hold.length < 3) return base;

  const lambda0 = opts.lambda ?? 0.5;
  // The prior's pull FADES with evidence, matching the Beta smoothing everywhere else in
  // this forecast: with mean-NLL the data gradient does not grow with n, so a fixed
  // penalty would let the hand-set defaults hold their ground against 400 deals as
  // stubbornly as against 40. Scale it as "the prior is worth ~20 deals": full strength
  // up to 20 closed deals, halved at 40, a tenth at 200.
  const lambda = lambda0 * Math.min(1, 20 / Math.max(1, wins + losses));
  const iters = opts.iterations ?? 500;
  const lr = opts.learningRate ?? 0.05;
  const beta: Record<string, number> = { ...DEFAULT_WIN_COEFFS };
  const signOf = new Map(WIN_FEATURES.map(f => [f.key, f.sign]));

  // Same wide clamp as adjustWinProbability — training offsets must see the same numbers
  // serving does, and 0.01 would distort every identified-stage row (true pStage ~0.003).
  const offset = (r: WinFitRow) => logit(clamp(r.pStage, 1e-4, 1 - 1e-4));
  const dot = (b: Record<string, number>, x: Record<string, number>) => {
    let z = 0;
    for (const f of WIN_FEATURES) z += (b[f.key] ?? 0) * (x[f.key] ?? 0);
    return z;
  };

  for (let it = 0; it < iters; it++) {
    const grad: Record<string, number> = {};
    for (const k of free) grad[k] = 0;
    for (const r of train) {
      const p = sigmoid(offset(r) + dot(beta, r.x));
      const err = p - r.label;
      for (const k of free) grad[k] += err * (r.x[k] ?? 0);
    }
    for (const k of free) {
      const g = grad[k] / train.length + 2 * lambda * (beta[k] - DEFAULT_WIN_COEFFS[k]);
      beta[k] -= lr * g;
      const sign = signOf.get(k);
      if (sign === 'pos' && beta[k] < 0) beta[k] = 0;
      if (sign === 'neg' && beta[k] > 0) beta[k] = 0;
    }
  }

  // Holdout: fitted vs stage-only (beta = 0 — pure layer 1, the honest baseline).
  let mLL = 0, bLL = 0;
  for (const r of hold) {
    mLL += rowLogLoss(sigmoid(offset(r) + dot(beta, r.x)), r.label);
    bLL += rowLogLoss(sigmoid(offset(r)), r.label);
  }
  mLL /= hold.length; bLL /= hold.length;

  return {
    coefficients: beta,
    basis: 'fitted',
    trainingWins: wins, trainingLosses: losses, trainingRows: clean.length,
    beatsBaseline: mLL < bLL,
    holdout: { rows: hold.length, modelLogLoss: +mLL.toFixed(4), baselineLogLoss: +bLL.toFixed(4) },
    unfrozen: free,
  };
}
