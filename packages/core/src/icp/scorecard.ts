import type { ScorecardSignal, ScorecardSignalRule, ScoreLayer } from '../types.js';
import { SCORE_LAYERS } from '../types.js';
import { scoreTier, icpSignals, DEFAULT_TIER_THRESHOLDS, type IcpTier, type TierThresholds } from '../db/scorecard.js';

// The Scorecard's scorer — the learned ICP model's arithmetic (GET-754 slice 8). Cloud-only:
// the open-source build scores accounts with the workspace's own model (POST /v2/scores).
// The signal list it scores against, the tiers and the signal CRUD stay public in
// db/scorecard.ts. See docs/adaptive-lead-scoring.md.
// ── The scorer ────────────────────────────────────────────────────────────────

// Case and padding are not signal. Rules are authored lowercase ('head of sales'), while
// enrichment stores titles as people write them ('Head of Sales'), so an exact ===/includes
// comparison meant the role rules NEVER fired and every such lead fell to the 50 baseline —
// roughly a third of the people in one workspace, including a "Head of Sales" against a rule that lists
// "head of sales". Numbers, booleans and objects compare exactly as before.
const cmpKey = (v: unknown): unknown =>
  typeof v === 'string' ? v.trim().toLowerCase() : v;

// Evaluate one signal rule against a lead's feature snapshot.
function ruleFires(rule: ScorecardSignalRule | null | undefined, features: Record<string, unknown>): boolean {
  if (!rule || !rule.feature) return false;
  const v = features[rule.feature];
  switch (rule.op) {
    case 'exists': return v !== undefined && v !== null;
    case '==':     return cmpKey(v) === cmpKey(rule.value);
    case '!=':     return cmpKey(v) !== cmpKey(rule.value);
    case '>=':     return typeof v === 'number' && v >= (rule.value as number);
    case '<=':     return typeof v === 'number' && v <= (rule.value as number);
    case '>':      return typeof v === 'number' && v > (rule.value as number);
    case '<':      return typeof v === 'number' && v < (rule.value as number);
    case 'in':     return Array.isArray(rule.value) && rule.value.map(cmpKey).includes(cmpKey(v));
    case 'contains_any': {
      // Keyword/substring match against descriptive enrichment text (a string, or
      // an array like the company's `keywords`). Joined on newlines so a term
      // never matches across two separate array entries.
      if (!Array.isArray(rule.value)) return false;
      const hay = Array.isArray(v) ? v.join('\n') : (typeof v === 'string' ? v : '');
      if (!hay) return false;
      const h = hay.toLowerCase();
      return (rule.value as unknown[]).some(t => typeof t === 'string' && t !== '' && h.includes(t.toLowerCase()));
    }
    default:       return false;
  }
}

// The weight a rule contributes for a lead. Categorical rules are binary (full
// weight when they fire, else 0). A 'scaled' rule grades a 0–10 signal feature:
// it contributes weight × (score/10), gated by an optional floor (rule.value =
// the min score to count at all). This is what lets a strong signal outrank a
// weak one instead of both counting the same — the key to ranking inside a tier.
function ruleContribution(rule: ScorecardSignalRule | null | undefined, weight: number, features: Record<string, unknown>): number {
  if (!rule || !rule.feature) return 0;
  if (rule.op === 'scaled') {
    const raw = features[rule.feature];
    const n = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isFinite(n)) return 0;
    const floor = typeof rule.value === 'number' ? rule.value : 0;
    if (n < floor) return 0;
    return weight * Math.min(1, Math.max(0, n / 10));
  }
  return ruleFires(rule, features) ? weight : 0;
}

// A disqualified account is hard-capped here — unambiguously below the Not-ICP
// floor (tier_3 = 50) so an excluded account never lands in a worked tier no
// matter how strong its positive signals are. Kept low (not 0) so the score
// still reads as "scored, and excluded" rather than "never scored".
export const EXCLUDED_SCORE_CEILING = 15;

export interface ScoreResult {
  score: number;                                  // 0–100
  raw: number;                                    // summed weights, pre-rescale
  fired: { key: string; weight: number }[];       // the signals that fired (+ or −)
  excluded: { key: string }[];                    // disqualifying rules that fired
}

// Deterministic score: sum the weights of every active signal whose rule fires
// on the lead's features (inclusions add, exclusions subtract), squash to 0–100,
// then hard-cap if any disqualifier fired. Pure — no DB, no model call.
export function scoreLead(
  features: Record<string, unknown> | null | undefined,
  signals: ScorecardSignal[],
): ScoreResult {
  const f = features || {};
  const active = signals.filter(s => s.active);

  let raw = 0;
  const fired: { key: string; weight: number }[] = [];
  const excluded: { key: string }[] = [];
  for (const s of active) {
    const contrib = ruleContribution(s.rule, s.weight, f);
    // Fire on ANY non-zero contribution, not just positive ones — a negative
    // signal (learned loss-driver, or an authored exclusion) has to be able to
    // pull the score DOWN. The old `> 0` guard silently discarded every negative
    // weight, so no detractor — discovered or authored — ever did anything.
    if (contrib !== 0) {
      raw += contrib;
      // Report the rounded contribution so the reason reflects graded strength
      // (a half-strength signal shows as half its weight), not the nominal weight.
      fired.push({ key: s.key, weight: Math.round(contrib * 10) / 10 });
      // A disqualifier that fired marks the account "not a fit" outright.
      if (s.rule?.disqualify) excluded.push({ key: s.key });
    }
  }

  // Logistic squash of the raw weight sum → 0–100. Stable no matter how many
  // signals the catalog holds. The old approach rescaled `raw` against the SUM
  // of every signal's weight, but an account only ever fires a SUBSET (you can't
  // be both `bootstrapped` and `series_a`) — so each new signal inflated the
  // denominator and deflated every real account's score (the 92→6 collapse).
  // K=8 maps a single strong signal (±8) to ~73/27 and stacks from there; raw 0 → 50.
  let score = Math.round(100 / (1 + Math.exp(-raw / 8)));

  // Hard exclusion overrides the math: "who we are NOT" wins over any stack of
  // positive signals. A disqualified account is pinned below the Not-ICP floor.
  if (excluded.length) score = Math.min(score, EXCLUDED_SCORE_CEILING);

  return { score: Math.max(0, Math.min(100, score)), raw, fired, excluded };
}

// A short, stable fingerprint of the active scoring model — the set of active
// signals with their weights and rules. Two scorecards with the same
// fingerprint score identically, so a prediction stamped with an older
// fingerprint was scored under a now-superseded model and is a candidate for
// re-scoring when the model evolves. Deterministic; order-independent.
export function modelVersion(signals: ScorecardSignal[]): string {
  const active = signals
    .filter(s => s.active)
    .map(s => `${s.key}:${s.weight}:${s.rule?.feature ?? ''}:${s.rule?.op ?? ''}:${JSON.stringify(s.rule?.value ?? null)}:${s.rule?.disqualify ? 'x' : ''}`)
    .sort();
  let h = 5381;
  const str = `v${SCORER_VERSION}|` + active.join('|');
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0; // djb2
  return `sc_${h.toString(36)}`;
}

// The {score, fit, reason} a staked OR re-scored prediction carries — shared so
// the stake path and the re-score path produce identical shapes.
export function scoreToPrediction(
  features: Record<string, unknown>,
  signals: ScorecardSignal[],
  thresholds: TierThresholds = DEFAULT_TIER_THRESHOLDS,
): {
  score: number; fit: boolean; reason: string; fired: number; tier: IcpTier;
  /**
   * WHICH signals fired, and how hard — not just how many.
   *
   * `scoreLead` has always computed this and we have always thrown it away, keeping
   * only the count. That threw away the most valuable thing the scorer knows: the
   * link between an account and the drivers that scored it.
   *
   * With it persisted (predictions.fired_signals), the ICP model stops being a table
   * of weights and becomes a graph — accounts as nodes, signals as hubs, an edge
   * wherever a signal fired. Accounts that share win-drivers cluster, and that cluster
   * is the real ICP. Without it there is nothing to lay them out by, and any picture
   * you draw is decoration.
   */
  firedSignals: { key: string; weight: number }[];
} {
  // ICP is fit only (GET-689): timing and engagement rules are left to priority.
  const { score, fired, excluded } = scoreLead(features, icpSignals(signals));
  const fit = score >= thresholds.tier_2;
  const tier = scoreTier(score, thresholds)!;
  // An excluded account leads with WHY it's out — the exclusion is the headline,
  // not buried among the positives it also happened to fire.
  const reason = excluded.length
    ? `Excluded — not a fit: ${excluded.slice(0, 3).map(e => e.key).join(', ')}`
    : fired.length
      ? `Scorecard: ${fired.length} signal${fired.length === 1 ? '' : 's'} fired — ` +
        fired.slice(0, 4).map(f => f.key).join(', ')
      : 'Scorecard: no signals matched this profile';
  return { score, fit, reason, fired: fired.length, tier, firedSignals: fired };
}

// ── Layered scoring (Fit · Pain · Intent · Ability) ─────────────────────────────
//
// The evolution of the one flat score into four independent layers. Each layer is
// scored by scoreLead over ONLY that layer's signals, so the layers move
// independently. A layer with no fired signal is UNKNOWN (null), never 0 — unknown
// ≠ low, and we never report scoreLead's raw-0 → 50 as if we'd observed a neutral
// account. Priority is the geometric mean of the KNOWN layers: a multiplicative
// combination (one near-zero layer vetoes the account) normalized so having MORE
// resolved layers doesn't mechanically shrink the number. Unknown layers are
// excluded from the product, never zeroed — that is what makes this safe when an
// account is only partially observed. See product/icp-model-layered-redesign.md.

/**
 * Bumped when the scorer itself changes what a score means, so every open prediction is
 * re-scored under it (modelVersion folds it in). 2: ICP is fit only (GET-689).
 */
export const SCORER_VERSION = 2;

export interface LayerScore {
  score: number | null;                       // null = unknown (no signal fired here yet)
  known: boolean;
  fired: { key: string; weight: number }[];
  excluded: { key: string }[];
}

export interface LayeredScoreResult {
  priority: number | null;                    // 0–100, geometric mean of known layers; null if nothing known
  band: 'high' | 'medium' | 'low' | null;
  fit: boolean;                               // Fit known and ≥ 70 (back-compat convenience)
  layers: Record<ScoreLayer, LayerScore>;
  missing: ScoreLayer[];                      // layers with no evidence yet — the enrichment worklist
}

const PRIORITY_HIGH = 75;
const PRIORITY_MEDIUM = 50;

export function scoreByLayer(
  features: Record<string, unknown> | null | undefined,
  signals: ScorecardSignal[],
): LayeredScoreResult {
  const f = features || {};
  const active = signals.filter(s => s.active);

  const layers = {} as Record<ScoreLayer, LayerScore>;
  const knownFractions: number[] = [];
  const missing: ScoreLayer[] = [];

  for (const layer of SCORE_LAYERS) {
    const layerSignals = active.filter(s => (s.layer ?? 'fit') === layer);
    const res = scoreLead(f, layerSignals);
    // Known only when real evidence moved this layer: a signal fired, or a
    // disqualifier excluded it. Nothing fired → UNKNOWN (raw 0 would squash to 50,
    // which is exactly the "neutral we never observed" we must not report).
    const known = res.fired.length > 0 || res.excluded.length > 0;
    layers[layer] = {
      score: known ? res.score : null,
      known,
      fired: res.fired,
      excluded: res.excluded,
    };
    if (known) knownFractions.push(res.score / 100);
    else missing.push(layer);
  }

  let priority: number | null = null;
  if (knownFractions.length) {
    // Geometric mean via log-space, clamped off 0 so one excluded layer tanks but
    // doesn't hard-zero the whole account.
    const logSum = knownFractions.reduce((s, x) => s + Math.log(Math.max(x, 1e-6)), 0);
    priority = Math.round(Math.exp(logSum / knownFractions.length) * 100);
    priority = Math.max(0, Math.min(100, priority));
  }
  const band: LayeredScoreResult['band'] = priority == null ? null
    : priority >= PRIORITY_HIGH ? 'high'
    : priority >= PRIORITY_MEDIUM ? 'medium' : 'low';

  const fitLayer = layers.fit;
  const fit = Boolean(fitLayer.known && (fitLayer.score ?? 0) >= 70);

  return { priority, band, fit, layers, missing };
}
