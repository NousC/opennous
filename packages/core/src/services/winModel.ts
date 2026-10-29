import { STAGE_RANK } from '../pipeline.js';

// Forecast, layer 3 — calibrated win probability.
//
// Layers 1 and 2 left P(win) resting on ONE fact: the stage. Two deals at negotiation get
// the same 60% even when one is talking to the economic buyer with budget confirmed and no
// objections, and the other is single-threaded on a manager with a live pricing objection
// and a competitor in the room. Every one of those distinguishing facts already lives in
// the graph as claims; this layer is what finally reads them.
//
// ARCHITECTURE: an ODDS OFFSET on the layer-1 stage probability, not a replacement.
//
//     logit(P3) = logit(P_stage) + sum(beta_i * x_i)
//
// Stage stays the backbone (with its Beta-smoothed honesty intact), the features push the
// odds up or down around it, and with every feature at its neutral value P3 equals P_stage
// exactly. That mirrors how intent adjusts the timing half (pCloseBase -> pClose), keeps
// stage out of the feature list (no double-counting), and makes the adjustment auditable
// per deal: pWinBase vs pWin.
//
// THE SAME HONESTY PATTERN AS EVERYTHING ELSE IN THIS FORECAST: the default coefficients
// are hand-set conservative nudges (like DEFAULT_STAGE_PRIORS and DEFAULT_INTENT_HAZARD),
// clearly labelled basis='default', and a workspace's own closed deals replace them via
// fitWinModel once there are enough to fit against — under an unfreeze schedule, so a model
// with 12 wins cannot confidently learn noise. Fitting (fitWinModel, the training panel) is
// in src/icp/winModelFit.ts (open source since 2026-10-29); until a fit is saved the forecast runs
// on the defaults here.
//
// Pure — no DB, no clock. Data gathering lives in the worker fit job and in forecastRun.

// ─── the feature vector ──────────────────────────────────────────────────────

export interface WinFeatureDef {
  key: string;
  /** Turn the raw account value into a CENTERED number: 0 must mean "neutral / unknown". */
  encode: (raw: Record<string, unknown>) => number;
  /** Allowed sign of the coefficient. Fitting projects onto this. */
  sign: 'pos' | 'neg' | 'free';
  /** Hand-set default coefficient (log-odds units). Small on purpose. */
  defaultCoeff: number;
  /** Unfreeze tier: 1 unfreezes at 20 wins, 2 at 50. */
  tier: 1 | 2;
}

// null/undefined/'' are UNKNOWN, never zero: Number(null) is 0, and a missing ICP score read
// as 0 encoded as the worst possible fit, while a missing stage median read as "brand new".
const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

// Encoders center every feature at 0 = neutral. A MISSING value therefore encodes to 0 and
// contributes no push in either direction — for a linear model that IS the honest handling
// of unknown: it neither rewards nor punishes what we cannot see (unknown ≠ 0 evidence).
export const WIN_FEATURES: WinFeatureDef[] = [
  {
    // How stalled the deal is relative to its stage's typical dwell time. 0 = at the
    // median; a deal at 3x the median encodes 2. The plan's "relative stall" feature.
    key: 'age_ratio',
    encode: r => { const v = num(r.ageRatio); return v === null ? 0 : clamp(v, 0, 3) - 1; },
    sign: 'neg', defaultCoeff: -0.10, tier: 1,
  },
  {
    // Silence beyond a normal one-week gap, in months, capped. 0 for an active deal.
    key: 'days_quiet',
    encode: r => { const v = num(r.daysQuiet); return v === null ? 0 : clamp((v - 7) / 30, 0, 3); },
    sign: 'neg', defaultCoeff: -0.15, tier: 1,
  },
  {
    // rising +1 / steady or unknown 0 / cooling or cold -1 (the portfolio's trend labels).
    key: 'engagement_trend',
    encode: r => {
      const t = String(r.engagementTrend ?? '');
      return t === 'rising' ? 1 : (t === 'cooling' || t === 'cold') ? -1 : 0;
    },
    sign: 'pos', defaultCoeff: 0.10, tier: 2,
  },
  {
    key: 'icp_fit',
    encode: r => { const v = num(r.icpFit); return v === null ? 0 : clamp((v - 50) / 50, -1, 1); },
    sign: 'pos', defaultCoeff: 0.20, tier: 1,
  },
  {
    key: 'icp_pain',
    encode: r => { const v = num(r.icpPain); return v === null ? 0 : clamp((v - 50) / 50, -1, 1); },
    sign: 'pos', defaultCoeff: 0.10, tier: 2,
  },
  {
    key: 'icp_ability',
    encode: r => { const v = num(r.icpAbility); return v === null ? 0 : clamp((v - 50) / 50, -1, 1); },
    sign: 'pos', defaultCoeff: 0.10, tier: 2,
  },
  {
    // DEFAULT 0, deliberately: intent already moves the TIMING half (layer 2), and folding
    // the same evidence into P(win) by hand would double-count it. The sign constraint
    // lets a workspace's own data promote it once "hot deals also WIN more here" becomes
    // actually measurable — reconciling the design decision with the plan's feature list.
    key: 'intent',
    encode: r => { const v = num(r.intentScore); return v === null ? 0 : clamp((v - 35) / 65, -1, 1); },
    sign: 'pos', defaultCoeff: 0, tier: 1,
  },
  {
    // Extra engaged people beyond the first, halved and capped: 1 person -> 0, 5+ -> 2.
    key: 'stakeholders',
    encode: r => { const v = num(r.stakeholderCount); return v === null ? 0 : clamp(v - 1, 0, 4) / 2; },
    sign: 'pos', defaultCoeff: 0.08, tier: 2,
  },
  {
    key: 'single_threaded',
    encode: r => (r.singleThreaded === true ? 1 : 0),
    sign: 'neg', defaultCoeff: -0.10, tier: 2,
  },
  {
    // Count of OPEN objections, capped at 4. metadata.status 'open' — the same read as the
    // portfolio's open_objections.
    key: 'open_objections',
    encode: r => { const v = num(r.openObjections); return v === null ? 0 : clamp(v, 0, 4); },
    sign: 'neg', defaultCoeff: -0.12, tier: 2,
  },
  {
    key: 'competitor_present',
    encode: r => (r.competitorPresent === true ? 1 : 0),
    sign: 'neg', defaultCoeff: -0.15, tier: 2,
  },
  {
    key: 'inbound',
    encode: r => (r.inbound === true ? 1 : 0),
    sign: 'pos', defaultCoeff: 0.10, tier: 2,
  },
];

/** Bump when the vector's shape or encoders change — stored on win_models rows. */
export const WIN_FEATURE_VERSION = 'wf-1';

export const DEFAULT_WIN_COEFFS: Record<string, number> =
  Object.fromEntries(WIN_FEATURES.map(f => [f.key, f.defaultCoeff]));

export function encodeWinFeatures(raw: Record<string, unknown>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const f of WIN_FEATURES) out[f.key] = f.encode(raw || {});
  return out;
}

// ─── applying the model ──────────────────────────────────────────────────────

const logit = (p: number) => Math.log(p / (1 - p));
const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));

/**
 * Adjust the stage-based P(win) by the feature offset. With every feature at neutral (all
 * zeros) this returns pStage EXACTLY, for any coefficients — the invariant that makes the
 * layer safe to ship on defaults: an account we know nothing extra about is untouched.
 *
 * The total offset is clamped to +/-2 logits. A linear model fed an out-of-range account
 * must not be able to declare a 3% deal near-certain; the clamp bounds the damage of any
 * single bad feature or coefficient.
 */
export function adjustWinProbability(
  pStage: number,
  features: Record<string, number>,
  coeffs: Record<string, number>,
): number {
  if (!Number.isFinite(pStage)) return pStage;
  if (pStage <= 0) return 0;
  if (pStage >= 1) return 1;
  let z = 0;
  for (const f of WIN_FEATURES) {
    const x = features[f.key];
    const b = coeffs[f.key];
    if (Number.isFinite(x) && Number.isFinite(b)) z += b * x;
  }
  if (z === 0) return pStage;   // exact no-op on the neutral path
  z = clamp(z, -2, 2);
  // The clamp exists only to keep logit finite — it must sit BELOW the smallest real
  // stage probability. With default priors, P(win | identified) is ~0.0033: a floor at
  // 0.01 would triple every top-of-funnel deal's odds the moment ANY feature was
  // non-neutral, including purely negative evidence. 1e-4 is safely under the ladder.
  const p = sigmoid(logit(clamp(pStage, 1e-4, 1 - 1e-4)) + z);
  return clamp(p, 1e-4, 1 - 1e-4);
}

export interface WinDriver {
  key: string;
  /** The encoded (centered) feature value. */
  x: number;
  /** The log-odds push: coefficient x value. */
  logit: number;
  /**
   * Percentage points of P(win) this fact is worth: P(win) as scored, minus P(win) with only
   * this fact set to neutral. Drivers do not sum exactly to pWin - pStage (the offset is
   * non-linear and clamped), but each one answers "what would change if this weren't true".
   */
  pts: number;
}

/**
 * The same number as adjustWinProbability, plus the reasons. Every non-neutral fact becomes a
 * driver, biggest move first — so "why is this deal at 48% when negotiation is 60%" is read
 * off the model itself rather than narrated after the fact.
 */
export function explainWinProbability(
  pStage: number,
  features: Record<string, number>,
  coeffs: Record<string, number>,
): { pWin: number; drivers: WinDriver[] } {
  const pWin = adjustWinProbability(pStage, features, coeffs);
  const drivers: WinDriver[] = [];
  for (const f of WIN_FEATURES) {
    const x = features[f.key];
    const b = coeffs[f.key];
    if (!Number.isFinite(x) || !Number.isFinite(b) || x === 0 || b === 0) continue;
    const without = adjustWinProbability(pStage, { ...features, [f.key]: 0 }, coeffs);
    drivers.push({ key: f.key, x, logit: b * x, pts: Math.round((pWin - without) * 1000) / 10 });
  }
  drivers.sort((a, b) => Math.abs(b.pts) - Math.abs(a.pts) || Math.abs(b.logit) - Math.abs(a.logit));
  return { pWin, drivers };
}

// ─── point-in-time helpers for feature assembly ──────────────────────────────

/** Days since the last interaction at or before `asOfMs`. null when none precede it. */
export function daysQuietAt(timestamps: string[], asOfMs: number): number | null {
  let last: number | null = null;
  for (const iso of timestamps || []) {
    const t = Date.parse(iso);
    if (!Number.isFinite(t) || t > asOfMs) continue;
    if (last === null || t > last) last = t;
  }
  return last === null ? null : Math.max(0, (asOfMs - last) / 86_400_000);
}

/**
 * rising / steady / cooling / cold at a moment: interactions in the 30 days before
 * `asOfMs` vs the 30 days before that. Same thresholds as the portfolio's trend.
 */
export function engagementTrendAt(timestamps: string[], asOfMs: number): string {
  const DAY = 86_400_000;
  let recent = 0, prior = 0;
  for (const iso of timestamps || []) {
    const t = Date.parse(iso);
    if (!Number.isFinite(t) || t > asOfMs) continue;
    if (t > asOfMs - 30 * DAY) recent++;
    else if (t > asOfMs - 60 * DAY) prior++;
  }
  if (recent === 0) return 'cold';
  if (prior === 0) return 'rising';
  if (recent > prior * 1.25) return 'rising';
  if (recent < prior * 0.75) return 'cooling';
  return 'steady';
}

/**
 * The latest value of a numeric point-in-time series at or before `asOf`. Used to read the
 * icp.* history observations. null when nothing precedes (encoders treat null as neutral).
 */
export function latestValueAt(
  series: Array<{ at: string; value: number }>,
  asOfIso: string,
): number | null {
  let best: { at: string; value: number } | null = null;
  for (const s of series || []) {
    if (!s || s.at > asOfIso || !Number.isFinite(s.value)) continue;
    if (!best || s.at > best.at) best = s;
  }
  return best ? best.value : null;
}

/** Rank helper the assembly jobs share. */
export function stageRankOf(stage: string): number {
  return STAGE_RANK[stage] ?? 0;
}
