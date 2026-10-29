import type { SupabaseClient } from '@supabase/supabase-js';
import type { Claim } from './claims.js';
import { getClaims } from './claims.js';
import { pipelineFeatures } from '../services/pipelineFeatures.js';

// The prediction-write half of the compound-intelligence loop.
//
// Scoring an entity STAKES a prediction: an immutable snapshot of what the
// Scorecard believed about it, and how reliable that belief was. Later the
// outcome job resolves it against realised evidence — and the
// (prediction, outcome) pair is one graded episode the learning loop trains
// on. Predictions are never updated; a fresh score stakes a new row.
//
// This file is the public half: the feature snapshot a prediction carries, which an external
// score (db/externalScores.ts) stakes with too. Staking the learned scorer's own predictions is
// src/icp/predictions.ts (open source since 2026-10-29), turned on by Cloud (services/icpScorer.ts).

// Company-level features merged in from the entity's employer. Person-level
// features are simply every other claim the entity carries.
// `keywords` (array) and `description` (text) are the descriptive enrichment
// fields a `contains_any` exclusion matches on — captured from Apollo/Prospeo —
// so a "cold-calling" keyword caps the whole company at score time, no website read.
const COMPANY_FEATURES = ['industry', 'employee_count', 'keywords', 'description'];

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
