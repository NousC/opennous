import type { SupabaseClient } from '@supabase/supabase-js';
import type { ScorecardSignal } from '../types.js';
import type { Claim } from './claims.js';
import { scoreToPrediction, modelVersion } from './scorecard.js';
import { getClaims } from './claims.js';
import { getInternalEntityIds, isEntityInternal } from './teamMembers.js';
import { pipelineFeatures } from '../services/pipelineFeatures.js';

// The prediction-write half of the compound-intelligence loop.
//
// Scoring an entity STAKES a prediction: an immutable snapshot of what the
// Scorecard believed about it, and how reliable that belief was. Later the
// outcome job resolves it against realised evidence — and the
// (prediction, outcome) pair is one graded episode the learning loop trains
// on. Predictions are never updated; a fresh score stakes a new row.

// Company-level features merged in from the entity's employer. Person-level
// features are simply every other claim the entity carries.
// `keywords` (array) and `description` (text) are the descriptive enrichment
// fields a `contains_any` exclusion matches on — captured from Apollo/Prospeo —
// so a "cold-calling" keyword caps the whole company at score time, no website read.
const COMPANY_FEATURES = ['industry', 'employee_count', 'keywords', 'description'];

// The ICP features a Scorecard actually scores on. If an entity carries none of
// these, it isn't scoreable yet (unenriched) — staking would record a hollow 0
// that's indistinguishable from a genuine bad fit and pollutes calibration.
// Name / company / pipeline claims alone don't count.
const SCOREABLE_FEATURES = ['job_title', 'seniority', 'department', 'industry', 'employee_count'];

export interface StakeResult {
  prediction_id: string;
  entity_id: string;
  score: number;
  fit: boolean;
  fired: number;
}

// Build the feature map + the per-feature {value, confidence} snapshot from a
// set of claims. The snapshot is what lets the learning loop weight an episode
// by how reliable its evidence was at scoring time.
function buildSnapshot(claims: Claim[]): {
  features: Record<string, unknown>;
  snapshot: Record<string, { value: unknown; confidence: number }>;
} {
  const features: Record<string, unknown> = {};
  const snapshot: Record<string, { value: unknown; confidence: number }> = {};
  for (const c of claims) {
    features[c.property] = c.value;
    snapshot[c.property] = { value: c.value, confidence: c.confidence };
  }
  return { features, snapshot };
}

export interface EntityFeatures {
  features: Record<string, unknown>;
  snapshot: Record<string, { value: unknown; confidence: number }>;
}

/**
 * Build the CURRENT feature map + snapshot for an entity from its live claims:
 * the entity's own claims, the company-level claims of its employer (via
 * works_at), and pipeline-engagement features derived from its activity log.
 *
 * This is the single source of feature extraction shared by `scoreAndStake`
 * (the first score) and `rescoreEntityFromClaims` (re-scoring an open
 * prediction after enrichment changes the underlying data) — so the two paths
 * never drift. Returns null when the entity carries no claims yet.
 */
export async function buildEntityFeatures(
  supabase: SupabaseClient,
  workspaceId: string,
  entityId: string,
): Promise<EntityFeatures | null> {
  const personClaims = await getClaims(supabase, workspaceId, entityId);
  if (personClaims.length === 0) return null;

  // Merge in the employer's company-level claims, if any.
  let claims = personClaims;
  const { data: rels } = await supabase
    .from('relationships')
    .select('to_entity_id')
    .eq('workspace_id', workspaceId)
    .eq('from_entity_id', entityId)
    .eq('type', 'works_at')
    .is('valid_to', null)
    .limit(1);
  const companyId = rels?.[0]?.to_entity_id as string | undefined;
  // Company signal.<class> claims, inherited by the person as graded numeric
  // features (signal.<class> = the 0–10 strength) so the scorecard can score on
  // them. Signals are company-level, so every person at the company inherits them.
  // exclusion.<key> claims ride the same rails — a semantic disqualifier set by
  // signal-scan (e.g. "this is a cold-calling agency") that firmographics can't
  // express. Inherited as a present feature so the disqualifier's `exists` rule
  // fires and caps the whole buying committee out, not just one person.
  const companySignals: Record<string, number> = {};
  const companyExclusions: Record<string, unknown> = {};
  if (companyId) {
    const allCompanyClaims = await getClaims(supabase, workspaceId, companyId);
    const companyFeatureClaims = allCompanyClaims.filter(c => COMPANY_FEATURES.includes(c.property));
    claims = [...personClaims, ...companyFeatureClaims];
    for (const c of allCompanyClaims) {
      if (c.property.startsWith('signal.')) {
        const v = c.value as { score?: unknown } | null;
        const sc = typeof v?.score === 'number' ? v.score : null;
        if (sc != null) companySignals[c.property] = sc;
      } else if (c.property.startsWith('exclusion.')) {
        // Only a positive match excludes — a `matched:false` claim (an explicit
        // "checked, not excluded") must NOT make the `exists` rule fire.
        const v = c.value as { matched?: unknown } | null;
        if (v?.matched !== false) companyExclusions[c.property] = c.value ?? true;
      }
    }
  }

  const { features, snapshot } = buildSnapshot(claims);
  // Merge the inherited company signals as numeric strength features.
  for (const [k, v] of Object.entries(companySignals)) {
    features[k] = v;
    snapshot[k] = { value: v, confidence: 1 };
  }
  // Merge inherited exclusion flags — present = the disqualifier fires.
  for (const [k, v] of Object.entries(companyExclusions)) {
    features[k] = v;
    snapshot[k] = { value: v, confidence: 1 };
  }

  // Pipeline-engagement features — *how the deal is going* (lead source, channel,
  // inbound/outbound, replied, banded meeting/touch counts), derived from the
  // entity's activity log. Captured into the snapshot so the Mind can learn lift
  // on engagement, not just firmographics.
  const { data: acts } = await supabase
    .from('observations')
    .select('property, source, observed_at')
    .eq('entity_id', entityId).eq('kind', 'event').like('property', 'interaction.%')
    .order('observed_at', { ascending: true }).limit(500);
  for (const [k, v] of Object.entries(pipelineFeatures(acts || []))) {
    features[k] = v;
    snapshot[k] = { value: v, confidence: 1 };
  }

  return { features, snapshot };
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

  const built = await buildEntityFeatures(supabase, workspaceId, entityId);
  if (!built) return null;
  const { features, snapshot } = built;

  // Gate: only stake on accounts we can actually score. If the entity carries
  // none of the scoreable ICP features yet, it's awaiting enrichment — skip,
  // don't record a hollow 0. It will be picked up once enrichment lands.
  if (!hasScoreableFeature(features)) return null;

  const { score, fit, reason, fired, tier, firedSignals } = scoreToPrediction(features, signals);

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
