import type { SupabaseClient } from '@supabase/supabase-js';
import { isUUID } from '../utils/identity.js';
import type { ScorecardSignal, ScorecardSignalRule } from '../types.js';

// DB layer + scorer for the Scorecard — the weighted signal list that turns a
// lead into a 0–100 number. See docs/adaptive-lead-scoring.md.

const SIGNAL_COLUMNS =
  'id, workspace_id, key, label, weight, rule, coverage, added_in, active, created_at, updated_at';

// ── The scorer ────────────────────────────────────────────────────────────────

// Evaluate one signal rule against a lead's feature snapshot.
function ruleFires(rule: ScorecardSignalRule | null | undefined, features: Record<string, unknown>): boolean {
  if (!rule || !rule.feature) return false;
  const v = features[rule.feature];
  switch (rule.op) {
    case 'exists': return v !== undefined && v !== null;
    case '==':     return v === rule.value;
    case '!=':     return v !== rule.value;
    case '>=':     return typeof v === 'number' && v >= (rule.value as number);
    case '<=':     return typeof v === 'number' && v <= (rule.value as number);
    case '>':      return typeof v === 'number' && v > (rule.value as number);
    case '<':      return typeof v === 'number' && v < (rule.value as number);
    case 'in':     return Array.isArray(rule.value) && rule.value.includes(v);
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
  const str = active.join('|');
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0; // djb2
  return `sc_${h.toString(36)}`;
}

// The {score, fit, reason} a staked OR re-scored prediction carries — shared so
// the stake path and the re-score path produce identical shapes.
// The ICP tier — the actionable classification on top of the raw score. The
// tier is what drives the play (Tier 1 worked by hand, Tier 2 queued to
// automation, Tier 3 nurtured, Not-ICP suppressed). Thresholds are the default
// bands; a workspace can override them later. Keeping this in one place means
// the score, the API, and the UI all agree on what a tier is.
export type IcpTier = 'tier_1' | 'tier_2' | 'tier_3' | 'not_icp';

export interface TierThresholds { tier_1: number; tier_2: number; tier_3: number; }
export const DEFAULT_TIER_THRESHOLDS: TierThresholds = { tier_1: 85, tier_2: 70, tier_3: 50 };

// Map a 0–100 score to its tier using the given (or default) thresholds.
export function scoreTier(score: number | null | undefined, t: TierThresholds = DEFAULT_TIER_THRESHOLDS): IcpTier | null {
  if (score == null || Number.isNaN(Number(score))) return null;
  const s = Number(score);
  if (s >= t.tier_1) return 'tier_1';
  if (s >= t.tier_2) return 'tier_2';
  if (s >= t.tier_3) return 'tier_3';
  return 'not_icp';
}

// Human label + the recommended play for a tier — the single source the UI and
// the agent read so "what do I do with this account" is never ambiguous.
export const TIER_META: Record<IcpTier, { label: string; play: string }> = {
  tier_1:  { label: 'Tier 1',  play: 'Work by hand — deep personalization, 1:1 outreach.' },
  tier_2:  { label: 'Tier 2',  play: 'Queue to automation — base sequence with variables.' },
  tier_3:  { label: 'Tier 3',  play: 'Nurture — low-cost touch; watch for a signal to promote.' },
  not_icp: { label: 'Not ICP', play: 'Suppress — outside the profile, do not spend.' },
};

export function scoreToPrediction(
  features: Record<string, unknown>,
  signals: ScorecardSignal[],
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
  const { score, fired, excluded } = scoreLead(features, signals);
  const fit = score >= 70;
  const tier = scoreTier(score)!;
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

// ── Signal queries ────────────────────────────────────────────────────────────

export async function listSignals(
  supabase: SupabaseClient,
  workspaceId: string,
  opts: { activeOnly?: boolean } = {},
): Promise<ScorecardSignal[]> {
  let query = supabase
    .from('scorecard_signals')
    .select(SIGNAL_COLUMNS)
    .eq('workspace_id', workspaceId)
    .order('weight', { ascending: false });
  if (opts.activeOnly) query = query.eq('active', true);

  const { data, error } = await query;
  if (error) throw error;
  return (data || []) as unknown as ScorecardSignal[];
}

export interface SeedSignalInput {
  key: string;
  label: string;
  weight: number;
  rule: ScorecardSignalRule;
}

// Re-seed the Scorecard from a freshly translated ICP. This replaces the
// SEED-ORIGIN signals (added_in IS NULL) but PRESERVES what the learning loop
// discovered (added_in set) — so editing the ICP (e.g. adding an exclusion) and
// re-syncing never wipes the negatives/positives learned from real closed deals.
// Upserts by key so a re-seeded signal that collides with a learned key updates
// in place instead of erroring on the unique (workspace_id, key) constraint.
export async function seedSignals(
  supabase: SupabaseClient,
  workspaceId: string,
  signals: SeedSignalInput[],
): Promise<ScorecardSignal[]> {
  // Clear only prior seed-origin signals; learned ones (added_in not null) stay.
  await supabase.from('scorecard_signals')
    .delete().eq('workspace_id', workspaceId).is('added_in', null);
  if (signals.length === 0) return [];

  const payload = signals.map(s => ({
    workspace_id: workspaceId,
    key: s.key,
    label: s.label,
    weight: Math.round(s.weight),
    rule: s.rule ?? {},
    added_in: null,
    active: true,
  }));
  const { data, error } = await supabase
    .from('scorecard_signals')
    .upsert(payload, { onConflict: 'workspace_id,key' })
    .select(SIGNAL_COLUMNS);
  if (error) throw error;
  return (data || []) as unknown as ScorecardSignal[];
}

// Add or recalibrate one signal (used by the learning loop, Phase 4c).
export async function upsertSignal(
  supabase: SupabaseClient,
  workspaceId: string,
  signal: SeedSignalInput & { coverage?: number; added_in?: string | null },
): Promise<void> {
  const { error } = await supabase
    .from('scorecard_signals')
    .upsert(
      {
        workspace_id: workspaceId,
        key: signal.key,
        label: signal.label,
        weight: Math.round(signal.weight),
        rule: signal.rule ?? {},
        coverage: signal.coverage ?? 0,
        added_in: signal.added_in ?? null,
        active: true,
      },
      { onConflict: 'workspace_id,key' },
    );
  if (error) throw error;
}

// Activate / deactivate a signal (the loop prunes by deactivating).
export async function setSignalActive(
  supabase: SupabaseClient,
  workspaceId: string,
  id: string,
  active: boolean,
): Promise<void> {
  if (!isUUID(id)) return;
  const { error } = await supabase
    .from('scorecard_signals')
    .update({ active })
    .eq('id', id)
    .eq('workspace_id', workspaceId);
  if (error) throw error;
}

// Recompute a signal's coverage — how many episodes its rule fired on.
export async function setSignalCoverage(
  supabase: SupabaseClient,
  workspaceId: string,
  id: string,
  coverage: number,
): Promise<void> {
  if (!isUUID(id)) return;
  const { error } = await supabase
    .from('scorecard_signals')
    .update({ coverage })
    .eq('id', id)
    .eq('workspace_id', workspaceId);
  if (error) throw error;
}

// ── Run log ───────────────────────────────────────────────────────────────────

export interface ScorecardRunInput {
  target?: number | null;
  steps?: number;
  gap_before?: number | null;
  gap_after?: number | null;
  signal_count?: number | null;
  note?: string | null;
}

export async function logScorecardRun(
  supabase: SupabaseClient,
  workspaceId: string,
  run: ScorecardRunInput,
): Promise<string | null> {
  const { data, error } = await supabase
    .from('scorecard_runs')
    .insert({ workspace_id: workspaceId, ...run })
    .select('id')
    .single();
  if (error) throw error;
  return (data as { id: string } | null)?.id ?? null;
}
