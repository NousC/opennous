import type { SupabaseClient } from '@supabase/supabase-js';
import type { ScorecardSignal } from '../types.js';
import { listSignals, scoreToPrediction, modelVersion } from '../db/scorecard.js';
import { buildEntityFeatures, hasScoreableFeature, scoreAndStake } from '../db/predictions.js';

// Re-score-open — keeps the *current fit* fresh as the model evolves.
//
// The bet-vs-current-fit principle: a RESOLVED prediction is an immutable bet
// (the only honest ground truth for "is the model improving?") and is NEVER
// touched here. An OPEN prediction is just today's estimate — it has no outcome
// yet, so when the model changes we recompute it in place from its stored
// feature_snapshot. The prior score is pushed into predicted_value.history so
// the account trail reads "Scored 15 → Re-scored 35", and the head stays the
// current fit. When the account later resolves, the row freezes with its
// history intact and the latest (most-informed) score as the bet.
//
// Triggered after the nightly learning loop ships a signal change
// (scorecardLoop), so a model change immediately refreshes every open account.

export interface RescoreResult {
  rescored: number;       // open predictions whose score actually moved
  restamped: number;      // model changed but this account's score didn't
  version: string | null; // the model fingerprint everything is now at
}

function featuresFromSnapshot(snap: Record<string, { value?: unknown }> | null): Record<string, unknown> {
  const features: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(snap || {})) features[k] = v?.value;
  return features;
}

/**
 * Backfill `predictions.fired_signals` for predictions staked before we started
 * recording it.
 *
 * The scorer has always known WHICH signals fired on an account — `scoreLead` returns
 * them — and `scoreToPrediction` threw the list away, keeping only the count. So the
 * column has sat at its `'[]'` default on every row ever written, and the
 * account-to-driver join, the single most useful thing the model knows, was discarded
 * at the point of writing.
 *
 * This recomputes it from each prediction's stored `feature_snapshot`, which is exactly
 * what the rescorer does, and writes NOTHING ELSE. It cannot move a score, because it
 * never touches `predicted_value`. It cannot corrupt a bet, because resolved rows are
 * never selected.
 *
 * It is a one-off. `scoreAndStake` and `rescoreOpenPredictions` both write the drivers
 * now, so nothing staked from here on needs it.
 *
 * Note the column is NOT NULL with a `'[]'` default, which means an unwritten row and
 * an account on which genuinely zero signals fired are indistinguishable. That is why
 * this is a deliberate pass rather than a guard inside the rescorer: such a guard could
 * never terminate.
 */
export async function backfillFiredSignals(
  supabase: SupabaseClient,
  workspaceId: string,
  opts: { limit?: number; dryRun?: boolean } = {},
): Promise<{ scanned: number; written: number; withSignals: number; noSignals: number }> {
  const signals: ScorecardSignal[] = await listSignals(supabase, workspaceId);

  const { data, error } = await supabase
    .from('predictions')
    .select('id, feature_snapshot, fired_signals')
    .eq('workspace_id', workspaceId)
    .eq('kind', 'icp_fit')
    .is('resolved_at', null)
    .limit(opts.limit ?? 5000);
  if (error) throw error;

  let written = 0, withSignals = 0, noSignals = 0;
  for (const p of data || []) {
    const already = Array.isArray(p.fired_signals) && p.fired_signals.length > 0;
    if (already) continue; // nothing to do; never clobber a real value

    const features = featuresFromSnapshot(p.feature_snapshot);
    const { firedSignals } = scoreToPrediction(features, signals);

    if (firedSignals.length) withSignals++; else noSignals++;
    if (opts.dryRun) continue;

    // fired_signals ONLY. Not predicted_value, not model_version, not confidence.
    const { error: e } = await supabase
      .from('predictions')
      .update({ fired_signals: firedSignals })
      .eq('id', p.id);
    if (e) throw new Error(`backfill failed on ${p.id}: ${e.message}`);
    written++;
  }

  return { scanned: (data || []).length, written, withSignals, noSignals };
}

export async function rescoreOpenPredictions(
  supabase: SupabaseClient,
  workspaceId: string,
  opts: { limit?: number; now?: number } = {},
): Promise<RescoreResult> {
  const signals = await listSignals(supabase, workspaceId);
  const active = signals.filter(s => s.active);
  if (!active.length) return { rescored: 0, restamped: 0, version: null };

  const version = modelVersion(signals);
  const nowIso = new Date(opts.now ?? Date.now()).toISOString();

  const { data: open, error } = await supabase
    .from('predictions')
    .select('id, predicted_value, feature_snapshot, predicted_at, model_version, fired_signals')
    .eq('workspace_id', workspaceId)
    .eq('kind', 'icp_fit')
    .is('resolved_at', null)
    .limit(opts.limit ?? 1000);

  if (error?.code === '42P01' || error?.code === 'PGRST205') return { rescored: 0, restamped: 0, version };
  if (error) throw error;

  let rescored = 0;
  let restamped = 0;
  for (const p of open || []) {
    // NOTE: `fired_signals` cannot be used as a "needs backfill" flag. The column is
    // NOT NULL with a default of '[]', so an unwritten row and an account on which
    // genuinely zero signals fired are indistinguishable — guarding on it would
    // restamp every no-signal account on every run, forever.
    //
    // So: rescore on model change, as before, and always WRITE the drivers in both
    // branches. Rows staked before this change are backfilled by a deliberate one-off
    // pass, not by a guard that can never terminate.
    if (p.model_version === version) continue; // already at the current model

    const features = featuresFromSnapshot(p.feature_snapshot);
    const { score, fit, reason, tier, firedSignals } = scoreToPrediction(features, signals);
    const prev = (p.predicted_value as Record<string, any>) || {};

    if (score === prev.score) {
      // The score did not move. Stamp the version and, if it was missing, fill in the
      // drivers — recomputing them costs nothing and it is the only reason this row is
      // being touched at all.
      await supabase.from('predictions')
        .update({ model_version: version, fired_signals: firedSignals })
        .eq('id', p.id);
      restamped++;
      continue;
    }

    // Score moved: mutate the open estimate, preserving the prior score as
    // history. (Mutating an UNRESOLVED prediction is safe — it isn't a graded
    // bet yet. Resolved rows are never selected here.)
    const priorHistory = Array.isArray(prev.history) ? prev.history : [];
    const priorEntry = {
      score: prev.score ?? null,
      fit: prev.fit ?? null,
      tier: prev.tier ?? null,
      reason: prev.reason ?? null,
      at: prev.rescored_at || p.predicted_at,
      model_version: p.model_version ?? null,
    };
    await supabase
      .from('predictions')
      .update({
        predicted_value: { score, fit, reason, tier, rescored_at: nowIso, history: [priorEntry, ...priorHistory] },
        predicted_confidence: score / 100,
        model_version: version,
        fired_signals: firedSignals,
      })
      .eq('id', p.id);
    rescored++;
  }

  return { rescored, restamped, version };
}

export interface EntityRescoreResult {
  status: 'rescored' | 'restamped' | 'no_open_prediction' | 'not_scoreable' | 'no_model';
  from?: number | null;
  to?: number | null;
}

// Re-score-on-enrichment — keeps the *current fit* and the account trail fresh
// when the underlying DATA changes, not just when the model changes.
//
// `rescoreOpenPredictions` (above) recomputes from the FROZEN feature_snapshot
// — perfect for a model change, blind to new evidence. But an account is first
// scored the moment it becomes scoreable, then enriched later (job title,
// seniority, company firmographics arrive after). Without this, that open
// prediction stays stuck on its pre-enrichment score and the trail never shows
// the change. This recomputes the entity's OPEN prediction from its CURRENT
// claims (re-reading employer + pipeline too), pushes the prior score into
// history so the trail reads "Scored X → Re-scored Y", and refreshes the
// snapshot to today's evidence. Resolved bets are immutable and never touched.
//
// Called from the claim engine after a score-affecting claim is recomputed (the
// point where enrichment data actually lands). No-ops cheaply when the entity
// has no open prediction or isn't scoreable yet.
export async function rescoreEntityFromClaims(
  supabase: SupabaseClient,
  workspaceId: string,
  entityId: string,
  opts: { signals?: ScorecardSignal[]; now?: number } = {},
): Promise<EntityRescoreResult> {
  const signals = opts.signals ?? await listSignals(supabase, workspaceId);
  if (!signals.some(s => s.active)) return { status: 'no_model' };

  // Only ever refresh an OPEN estimate; resolved bets are immutable history.
  const { data: openRows, error } = await supabase
    .from('predictions')
    .select('id, predicted_value, predicted_at, model_version')
    .eq('workspace_id', workspaceId)
    .eq('entity_id', entityId)
    .eq('kind', 'icp_fit')
    .is('resolved_at', null)
    .order('predicted_at', { ascending: false })
    .limit(1);
  if (error?.code === '42P01' || error?.code === 'PGRST205') return { status: 'no_open_prediction' };
  if (error) throw error;
  const open = openRows?.[0];
  if (!open) return { status: 'no_open_prediction' };

  const built = await buildEntityFeatures(supabase, workspaceId, entityId);
  if (!built || !hasScoreableFeature(built.features)) return { status: 'not_scoreable' };

  const version = modelVersion(signals);
  const nowIso = new Date(opts.now ?? Date.now()).toISOString();
  const { score, fit, reason, tier } = scoreToPrediction(built.features, signals);
  const prev = (open.predicted_value as Record<string, any>) || {};

  if (score === prev.score) {
    // Data refreshed but the score didn't move — keep the snapshot + model
    // version current (so a later model-rescore reads today's evidence) without
    // adding a noisy trail entry.
    await supabase
      .from('predictions')
      .update({ feature_snapshot: built.snapshot, model_version: version })
      .eq('id', open.id);
    return { status: 'restamped', from: prev.score ?? null, to: score };
  }

  // Score moved: push the prior score into history, refresh the head + snapshot.
  const priorHistory = Array.isArray(prev.history) ? prev.history : [];
  const priorEntry = {
    score: prev.score ?? null,
    fit: prev.fit ?? null,
    tier: prev.tier ?? null,
    reason: prev.reason ?? null,
    at: prev.rescored_at || open.predicted_at,
    model_version: open.model_version ?? null,
  };
  await supabase
    .from('predictions')
    .update({
      predicted_value: { score, fit, reason, tier, rescored_at: nowIso, history: [priorEntry, ...priorHistory] },
      predicted_confidence: score / 100,
      feature_snapshot: built.snapshot,
      model_version: version,
    })
    .eq('id', open.id);
  return { status: 'rescored', from: prev.score ?? null, to: score };
}

// Fan a COMPANY-level claim change out to the people who work there. Buying
// signals and exclusions live on the company, but the SCORES live on its people
// (companies aren't scored by the loop) — so when one changes, every person at
// that company must re-score for the new evidence to land. This is what makes an
// exclusion flag cap the whole buying committee the instant signal-scan records
// it, instead of waiting for the nightly pass.
//
// No-ops when the entity has no people (it's a person, or an unlinked company).
// Each member: re-score its open prediction, or stake one if it's scoreable and
// has none yet. Best-effort per member — one failure never blocks the rest.
export async function rescoreCompanyMembers(
  supabase: SupabaseClient,
  workspaceId: string,
  companyEntityId: string,
  opts: { signals?: ScorecardSignal[]; now?: number } = {},
): Promise<{ members: number; rescored: number }> {
  const { data: rels } = await supabase
    .from('relationships')
    .select('from_entity_id')
    .eq('workspace_id', workspaceId)
    .eq('to_entity_id', companyEntityId)
    .eq('type', 'works_at')
    .is('valid_to', null);
  const memberIds = [...new Set((rels ?? []).map(r => (r as { from_entity_id: string }).from_entity_id))];
  if (memberIds.length === 0) return { members: 0, rescored: 0 };

  const signals = opts.signals ?? await listSignals(supabase, workspaceId);
  if (!signals.some(s => s.active)) return { members: memberIds.length, rescored: 0 };

  let rescored = 0;
  for (const personId of memberIds) {
    try {
      const r = await rescoreEntityFromClaims(supabase, workspaceId, personId, { signals, now: opts.now });
      if (r.status === 'rescored') { rescored++; continue; }
      if (r.status === 'no_open_prediction') {
        const staked = await scoreAndStake(supabase, workspaceId, personId, signals);
        if (staked) rescored++;
      }
    } catch {
      // best-effort — keep going for the rest of the committee
    }
  }
  return { members: memberIds.length, rescored };
}
