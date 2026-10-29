import type { SupabaseClient } from '@supabase/supabase-js';
import { isUUID } from '../utils/identity.js';
import type { ScorecardSignal, ScorecardSignalRule, ScoreLayer } from '../types.js';

// DB layer for the Scorecard — the weighted signal list that turns a lead into a 0–100
// number — plus the ICP tiers. The scorer itself (scoreLead, scoreByLayer, the model
// fingerprint) is the learned ICP model and lives in src/icp/scorecard.ts (open source since 2026-10-29).
// See docs/adaptive-lead-scoring.md.

const SIGNAL_COLUMNS =
  'id, workspace_id, key, label, weight, rule, coverage, added_in, active, layer, manual, created_at, updated_at';

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

// The layer a signal scores, from its rule feature. signal-scan emits a fixed set
// of signal.<class> features; everything else (personas, firmographics,
// signal.domain, disqualifiers) is Fit. Shared by the seed and the SQL backfill so
// the two never drift.
export function layerForFeature(feature: string | null | undefined): ScoreLayer {
  const f = feature || '';
  if (f === 'signal.friction') return 'pain';
  // Timing (hiring, funding and growth, expressed intent) and engagement (pipe.*: replied,
  // meetings, touches) say WHEN to care, not WHO is a fit (GET-689). Tech stack is fit.
  if (f === 'signal.hiring' || f === 'signal.momentum' || f === 'signal.intent' || f.startsWith('pipe.')) return 'intent';
  return 'fit';
}

/**
 * Whether a rule counts toward the ICP score (GET-689). ICP is FIT: who they are — industry,
 * size, geography, title, stack, team, and who we are NOT. It stays stable. Timing and
 * engagement move priority and deal health instead; their rules still score the Pain and
 * Intent layers, they just never move the ICP number.
 */
export function countsTowardIcp(feature: string | null | undefined): boolean {
  return layerForFeature(feature) === 'fit';
}

/** The rules that make up the ICP score: fit rules, plus every exclusion whatever it reads. */
export function icpSignals(signals: ScorecardSignal[]): ScorecardSignal[] {
  return signals.filter(s => s.rule?.disqualify || countsTowardIcp(s.rule?.feature));
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
  layer?: ScoreLayer;   // omitted → derived from the rule feature via layerForFeature
}

// Re-seed the Scorecard from a freshly translated ICP. This replaces the
// SEED-ORIGIN signals (added_in IS NULL) but PRESERVES what the learning loop
// discovered (added_in set) AND what the operator added by hand (manual = true) —
// so editing the ICP (e.g. adding an exclusion) and re-syncing never wipes the
// negatives/positives learned from real closed deals, nor the criteria a person
// typed into the ICP page.
// Upserts by key so a re-seeded signal that collides with a learned key updates
// in place instead of erroring on the unique (workspace_id, key) constraint.
export async function seedSignals(
  supabase: SupabaseClient,
  workspaceId: string,
  signals: SeedSignalInput[],
): Promise<ScorecardSignal[]> {
  // Clear only prior seed-origin signals; learned (added_in not null) and
  // hand-added (manual) ones stay.
  await supabase.from('scorecard_signals')
    .delete().eq('workspace_id', workspaceId).is('added_in', null).eq('manual', false);
  if (signals.length === 0) return [];

  const payload = signals.map(s => ({
    workspace_id: workspaceId,
    key: s.key,
    label: s.label,
    weight: Math.round(s.weight),
    rule: s.rule ?? {},
    added_in: null,
    active: true,
    layer: s.layer ?? layerForFeature(s.rule?.feature),
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
        layer: signal.layer ?? layerForFeature(signal.rule?.feature),
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
