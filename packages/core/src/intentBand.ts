// Canonical `intent_band` reader — the single place that knows the claim can
// arrive in either of two shapes.
//
// WHY THIS EXISTS. Two writers stake `intent_band` and they disagree on shape,
// both deliberately:
//
//   • upsertIntentClaim (apps/worker/src/intentScore.mjs) writes the CLAIM as a
//     bare string — `"Warm"` — because a claim is the current value.
//   • writeIntentBandChange (same file) appends the durable history as an
//     OBSERVATION whose value is an object — `{ band, score, from }` — so the
//     series carries the magnitude and the transition, not just the bucket.
//
// A `kind: 'state'` observation enqueues a claim recompute (the claim_jobs
// trigger), so the object-shaped history row can be re-derived back OVER the
// string-shaped claim. Both shapes therefore appear in `claims.intent_band` in
// the same workspace, and a reader that assumes a scalar renders the object as
// the literal text "[object Object]" — which is what the Attention feed showed.
//
// Pure (no DB, no model) so the worker, the API and core services can all import
// it and stay in step.

// The band vocabulary, as staked by apps/worker/src/intentScore.mjs. Two axes
// share the field: a PROSPECT is banded by intent score, and a won CLIENT is
// banded by account health instead (a client is out of the buying funnel, so
// "Warm/Hot" would be meaningless there).
export const INTENT_BANDS = ['Dormant', 'Aware', 'Warm', 'Hot', 'Red-hot'] as const;
export const CLIENT_BANDS = ['At-risk', 'Active', 'Expansion'] as const;
export type IntentBand = (typeof INTENT_BANDS)[number] | (typeof CLIENT_BANDS)[number];

/**
 * Rank for "which band wins" when an account takes the hottest of its people.
 * The client axis is mapped onto the same scale so a mixed account still
 * compares: At-risk sits at Dormant, Active at Warm, Expansion at Hot.
 * Unknown bands sort below everything (callers use `?? -1`).
 */
export const INTENT_BAND_ORDER: Record<string, number> = {
  Dormant: 0, Aware: 1, Warm: 2, Hot: 3, 'Red-hot': 4,
  'At-risk': 0, Active: 2, Expansion: 3,
};

/**
 * Read an `intent_band` claim/observation value as a plain band string,
 * whichever shape it was stored in. Returns null when there is no usable band,
 * so the caller decides its own fallback rather than inheriting one.
 *
 *   "Warm"                              -> "Warm"
 *   { band: "Warm", score: 58 }         -> "Warm"
 *   null / {} / 42                      -> null
 */
export function readIntentBand(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null;
  if (value && typeof value === 'object') {
    const band = (value as { band?: unknown }).band;
    if (typeof band === 'string') return band.trim() || null;
  }
  return null;
}

/** Same read, with a caller-chosen fallback for display paths. */
export function intentBandOr(value: unknown, fallback = 'Dormant'): string {
  return readIntentBand(value) ?? fallback;
}

/**
 * The score that may ride along inside the object shape. The string shape
 * carries none, so this returns null there and the caller keeps using the
 * separate `intent_score` claim.
 */
export function readIntentScore(value: unknown): number | null {
  if (value && typeof value === 'object') {
    const n = Number((value as { score?: unknown }).score);
    if (Number.isFinite(n)) return n;
  }
  return null;
}
