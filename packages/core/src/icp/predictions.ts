import type { SupabaseClient } from '@supabase/supabase-js';
import type { ScorecardSignal } from '../types.js';
import { SCORE_LAYERS } from '../types.js';
import { scoreToPrediction, modelVersion, scoreByLayer } from './scorecard.js';
import { getInternalEntityIds, isEntityInternal } from '../db/teamMembers.js';
import { getIcpScorer, getTierThresholds } from '../db/externalScores.js';
import { buildEntityFeatures, type StakeResult } from '../db/predictions.js';

// Staking the learned scorer's icp_fit predictions (GET-754 slice 8: Cloud-only). The feature
// extraction both this and an external score's snapshot read (buildEntityFeatures) stays public
// in db/predictions.ts.

// The ICP features a Scorecard actually scores on. If an entity carries none of
// these, it isn't scoreable yet (unenriched) — staking would record a hollow 0
// that's indistinguishable from a genuine bad fit and pollutes calibration.
// Name / company / pipeline claims alone don't count.
const SCOREABLE_FEATURES = ['job_title', 'seniority', 'department', 'industry', 'employee_count'];

// Persist the layered score (Fit · Pain · Intent · Ability + Priority) as claims
// on the entity, so the four layers LIVE on the account record — readable by the
// agent and the Accounts/People UI — instead of vanishing the instant they're
// computed. Written as `icp.<layer>` claims (numbers) plus `icp.priority` /
// `icp.priority_band`.
//
// Two rules that keep it honest:
//  • A layer that is UNKNOWN (no signal fired) gets NO claim — unknown ≠ 0, so the
//    account simply carries no `icp.<layer>` until evidence arrives, and the UI
//    renders "—". If a layer flips known → unknown (evidence retracted), the stale
//    claim is invalidated rather than left to mislead.
//  • These are the ICP model's own layer reads. The behavioural `intent_score`
//    claim (the decaying WHEN axis, written by the intent worker) is SEPARATE and
//    left untouched; reconciling the two Intent reads is a follow-up.
//
// A direct claims upsert (not the claim engine) so it never re-triggers scoring.
// Best-effort: a failure here must never fail the score itself.
export async function writeLayerClaims(
  supabase: SupabaseClient,
  workspaceId: string,
  entityId: string,
  features: Record<string, unknown>,
  signals: ScorecardSignal[],
  nowIso: string,
): Promise<void> {
  const layered = scoreByLayer(features, signals);

  // What the layers say RIGHT NOW, before this write. Read once, for two jobs:
  //  1. ASSERTED-CLAIM GUARD — if a human hand-corrected a layer (epistemic_class
  //     'asserted', via assertClaims), derivation must not clobber it. That is the
  //     substrate-wide rule (see recomputeClaim) and this writer used to break it: every
  //     rescoring silently overwrote manual corrections.
  //  2. CHANGE DETECTION for the history log below.
  // Best-effort: if the read fails we fall back to the old write-everything behaviour
  // rather than failing the score.
  const ICP_PROPS = [...SCORE_LAYERS.map(l => `icp.${l}`), 'icp.priority', 'icp.priority_band'];
  let existing = new Map<string, { value: unknown; asserted: boolean }>();
  try {
    const { data } = await supabase.from('claims')
      .select('property, value, epistemic_class')
      .eq('workspace_id', workspaceId)
      .eq('entity_id', entityId)
      .in('property', ICP_PROPS)
      .is('invalid_at', null);
    existing = new Map(((data as Array<{ property: string; value: unknown; epistemic_class?: string }>) ?? [])
      .map(r => [r.property, { value: r.value, asserted: r.epistemic_class === 'asserted' }]));
  } catch { /* read failure — behave as before */ }
  const isAsserted = (prop: string) => existing.get(prop)?.asserted === true;

  const base = {
    workspace_id: workspaceId,
    entity_id: entityId,
    distribution: null,
    confidence: 0.8,
    epistemic_class: 'inferred' as const,
    freshness: 'fresh' as const,
    valid_from: nowIso,
    invalid_at: null as string | null,
    supporting_observation_ids: [] as string[],
    observation_count: 0,
    last_observed_at: nowIso,
    computed_at: nowIso,
  };

  const rows: Array<Record<string, unknown>> = [];
  const stale: string[] = [];
  for (const layer of SCORE_LAYERS) {
    if (isAsserted(`icp.${layer}`)) continue;   // human ground truth — leave it alone
    const ls = layered.layers[layer];
    if (ls.known && ls.score != null) {
      rows.push({ ...base, property: `icp.${layer}`, value: ls.score });
    } else {
      stale.push(`icp.${layer}`);   // invalidate any prior claim for a now-unknown layer
    }
  }
  if (layered.priority != null) {
    if (!isAsserted('icp.priority')) rows.push({ ...base, property: 'icp.priority', value: layered.priority });
    if (layered.band && !isAsserted('icp.priority_band')) rows.push({ ...base, property: 'icp.priority_band', value: layered.band });
  } else {
    for (const p of ['icp.priority', 'icp.priority_band']) if (!isAsserted(p)) stale.push(p);
  }

  if (rows.length) {
    await supabase.from('claims').upsert(rows, { onConflict: 'workspace_id,entity_id,property' });
  }
  // Retire claims for layers that used to be known but no longer are, so the
  // account never shows a score for a layer we can't currently justify.
  if (stale.length) {
    await supabase.from('claims')
      .update({ invalid_at: nowIso })
      .eq('workspace_id', workspaceId)
      .eq('entity_id', entityId)
      .in('property', stale)
      .is('invalid_at', null);
  }

  // ── the durable history ──
  //
  // The claims above are the CURRENT layer values and are meant to be overwritten — that
  // is what a claim is. But overwrite-in-place means there was NO record of what a layer
  // was on any past date, and unlike intent (whose raw signal events survive and can be
  // replayed) the ICP inputs are themselves current-state claims — once a score changed
  // unlogged, the old value was simply gone. The forecast's win model trains on "what was
  // this account's fit in the weeks before it closed", which is unanswerable without this.
  //
  // History goes where history belongs in this substrate: append-only observations,
  // written ON CHANGE only. Scoring sweeps re-write identical values constantly; logging
  // every sweep would be thousands of rows saying "still 82". A changed number is the
  // signal, and the row records the previous value too so a series is legible on its own.
  // Best-effort: the history log must never fail the score that produced it.
  try {
    const historyRows: Array<Record<string, unknown>> = [];
    const trackable = new Set([...SCORE_LAYERS.map(l => `icp.${l}`), 'icp.priority']);
    for (const r of rows) {
      const prop = r.property as string;
      if (!trackable.has(prop)) continue;   // priority_band derives from priority — skip
      // Unwrap defensively: if anything ever left an object in the claim, compare against
      // its inner number so change detection cannot wedge open and log forever.
      const pv = existing.get(prop)?.value;
      const prev = pv !== null && typeof pv === 'object' ? (pv as { value?: unknown }).value : pv;
      const next = r.value;
      if (prev === next) continue;          // unchanged — no history row
      historyRows.push({
        workspace_id: workspaceId,
        entity_id: entityId,
        // kind 'event', NOT 'state' — and the distinction is load-bearing. Every
        // observation insert fires the claim-recompute trigger, and deriveClaim takes the
        // newest kind='state' observation's value verbatim. A 'state' row here (same
        // property as the live claim, object-shaped value) would CLOBBER the numeric
        // icp.* claim with {value, from} a minute later, break every Number(claim.value)
        // reader, and then never match change detection again — an infinite history loop.
        // An 'event' row is invisible to derivation while remaining a perfectly good
        // append-only series for the win model to read.
        kind: 'event',
        property: prop,
        value: { value: next, from: prev ?? null },
        source: 'system',
        method: 'inference',
        observed_at: nowIso,
      });
    }
    if (historyRows.length) {
      await supabase.from('observations').insert(historyRows).then(() => {}, () => {});
    }
  } catch { /* history is best-effort */ }
}

// Whether a feature map carries at least one scoreable ICP feature. Entities
// with none are awaiting enrichment — scoring them records a hollow 0 that's
// indistinguishable from a genuine bad fit and pollutes calibration.
export function hasScoreableFeature(features: Record<string, unknown>): boolean {
  return SCOREABLE_FEATURES.some(k => {
    const v = features[k];
    return v !== undefined && v !== null && v !== '';
  });
}

/**
 * Score one person-entity from its claims and stake an `icp_fit` prediction.
 *
 * Features come from the entity's own claims plus the company-level claims of
 * its employer (followed via the works_at relationship). Returns null when the
 * entity has no claims to score yet.
 */
export async function scoreAndStake(
  supabase: SupabaseClient,
  workspaceId: string,
  entityId: string,
  signals: ScorecardSignal[],
): Promise<StakeResult | null> {
  // Team members are operators, not the market. entitiesNeedingScore already
  // filters them out; this guards the other scoring callers (rescore, enrichment)
  // so an internal account can never get a hollow ICP prediction staked.
  if (await isEntityInternal(supabase, workspaceId, entityId)) return null;
  // A workspace that scores for itself (GET-586) gets no Nous score staked beside its own.
  if (await getIcpScorer(supabase, workspaceId) === 'external') return null;

  const built = await buildEntityFeatures(supabase, workspaceId, entityId);
  if (!built) return null;
  const { features, snapshot } = built;

  // Gate: only stake on accounts we can actually score. If the entity carries
  // none of the scoreable ICP features yet, it's awaiting enrichment — skip,
  // don't record a hollow 0. It will be picked up once enrichment lands.
  if (!hasScoreableFeature(features)) return null;

  const { score, fit, reason, fired, tier, firedSignals } = scoreToPrediction(features, signals, await getTierThresholds(supabase, workspaceId));

  const { data, error } = await supabase
    .from('predictions')
    .insert({
      workspace_id: workspaceId,
      entity_id: entityId,
      kind: 'icp_fit',
      predicted_value: { score, fit, reason, tier },
      predicted_confidence: score / 100,
      feature_snapshot: snapshot,
      model_version: modelVersion(signals),
      // WHICH drivers scored this account, not just how many. The column has existed
      // since the schema was written and nothing has ever populated it, so every
      // account-to-signal link the scorer computed has been discarded at the point of
      // writing the row.
      //
      // This is the join that turns the ICP model from a table of weights into a map:
      // accounts as nodes, signals as hubs, an edge wherever one fired. Accounts that
      // share win-drivers cluster together, and that cluster is the real ICP.
      fired_signals: firedSignals,
    })
    .select('id')
    .single();
  if (error) throw new Error(`failed to stake prediction: ${error.message}`);

  // Persist the layered score alongside the flat prediction — best-effort, never
  // fails the stake.
  try {
    await writeLayerClaims(supabase, workspaceId, entityId, features, signals, new Date().toISOString());
  } catch { /* layer claims are additive; a write failure must not break scoring */ }

  return {
    prediction_id: (data as { id: string }).id,
    entity_id: entityId,
    score,
    fit,
    fired,
  };
}

/**
 * Person-entities that carry claims but have NO `icp_fit` prediction yet — the
 * ones the score worker should stake a prediction for next. Each entity is
 * scored exactly ONCE: its prediction is re-scored in place while open (when the
 * model changes, see rescore.ts) and frozen once it resolves (won/lost/
 * no_opportunity). We deliberately do NOT re-stake after resolution — doing so
 * churned closed-won customers back into the pipeline as fresh "Pending" rows.
 */
export async function entitiesNeedingScore(
  supabase: SupabaseClient,
  workspaceId: string,
  limit = 200,
): Promise<string[]> {
  const [people, scored] = await Promise.all([
    supabase
      .from('entities')
      .select('id')
      .eq('workspace_id', workspaceId)
      .eq('type', 'person')
      .eq('status', 'active'),
    supabase
      .from('predictions')
      .select('entity_id')
      .eq('workspace_id', workspaceId)
      .eq('kind', 'icp_fit'),                 // ANY prediction (open OR resolved)
  ]);
  if (people.error) throw new Error(`failed to list entities: ${people.error.message}`);
  if (scored.error) throw new Error(`failed to list predictions: ${scored.error.message}`);

  const alreadyScored = new Set((scored.data ?? []).map(p => p.entity_id as string));
  // Team members are operators, not the market — never stake an ICP score on them.
  const internal = await getInternalEntityIds(supabase, workspaceId);
  return (people.data ?? [])
    .map(p => p.id as string)
    .filter(id => !alreadyScored.has(id) && !internal.has(id))
    .slice(0, limit);
}
