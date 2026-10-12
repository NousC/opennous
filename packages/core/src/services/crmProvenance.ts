// CRM hygiene — source-trust ladder + loop-prevention provenance gate.
//
// Pure logic over observation sources (zero CRM access, unit-testable), plus a
// thin DB helper that resolves a claim's supporting observations to their
// sources and runs the gate. This is what makes "Nous wins only when it has
// INDEPENDENT evidence" enforceable, and what stops the sync loop.
// See docs/crm-hygiene-phase-1b-spec.md, Task 1.

import type { SupabaseClient } from '@supabase/supabase-js';
import { getObservationsByIds } from '../db/observations.js';

// CRMs are the projection target, never an independent source for writing back.
export const CRM_PROVIDERS = new Set(['hubspot', 'pipedrive', 'attio', 'salesforce']);
// Origin-erased rows whose true source wasn't preserved (the v1→v2 trigger
// fallback, and historical backfills/migrations) — these NEVER count as
// independent evidence (fail-closed). Any `v1_*` source qualifies.
export const UNKNOWN_PROVENANCE = 'v1_compat';   // kept for back-compat references
export const UNKNOWN_PROVENANCE_SOURCES = new Set(['v1_compat', 'v1_backfill']);

export function isUnknownProvenance(source: string): boolean {
  return UNKNOWN_PROVENANCE_SOURCES.has(source) || source.startsWith('v1_');
}

export interface TrustTier { rank: number; tier: string; sources: string[]; }

// Trust ladder for STATE ATTRIBUTES (the reconciled fields), most trusted first
// (rank 1 = highest trust). A config constant so a workspace can later reorder
// it; used to break ties (Task 2), NOT to gate (the gate is independence-only).
export const SOURCE_TRUST_LADDER: TrustTier[] = [
  { rank: 1, tier: 'human_asserted', sources: ['user', 'manual'] },
  { rank: 2, tier: 'first_party',    sources: ['gmail', 'smtp', 'fathom', 'fireflies', 'signal_extraction', 'linkedin'] },
  { rank: 3, tier: 'crm',            sources: ['hubspot', 'pipedrive', 'attio', 'salesforce'] },
  { rank: 4, tier: 'enrichment',     sources: ['apollo', 'prospeo'] },
  { rank: 5, tier: 'inferred',       sources: ['agent', 'mind', 'inferred'] },
];
export const UNKNOWN_RANK = 99;

const RANK_BY_SOURCE: Record<string, number> = Object.fromEntries(
  SOURCE_TRUST_LADDER.flatMap(t => t.sources.map(s => [s, t.rank] as const)),
);

export function sourceTrustRank(source: string): number {
  return RANK_BY_SOURCE[source] ?? UNKNOWN_RANK;
}

export function isCrmSource(source: string): boolean {
  return CRM_PROVIDERS.has(source);
}

/** Independent of the CRMs = neither a CRM provider nor unknown provenance. */
export function isIndependentSource(source: string): boolean {
  return !isCrmSource(source) && !isUnknownProvenance(source);
}

/**
 * Loop-prevention gate (the hard rule). A claim's value may be PROPOSED for
 * write-back to a CRM only if ≥1 supporting observation comes from a source
 * independent of the CRMs (not any CRM provider, not v1_compat/unknown).
 * Fail-closed: empty support, or only CRM/unknown support → false. This alone
 * prevents (a) writing CRM data back to the same CRM, (b) cross-CRM laundering,
 * (c) acting on unknown-origin rows.
 */
export function passesProvenanceGate(sources: string[]): boolean {
  return sources.some(isIndependentSource);
}

/** Highest-trust independent source backing the claim, or null if none. */
export function bestIndependentSource(sources: string[]): string | null {
  let best: string | null = null;
  let bestRank = Infinity;
  for (const s of sources) {
    if (!isIndependentSource(s)) continue;
    const r = sourceTrustRank(s);
    if (r < bestRank) { bestRank = r; best = s; }
  }
  return best;
}

/** One supporting observation, reduced to what the proof payload needs. */
export interface SupportingEvidence {
  source: string;
  observed_at: string;
  method: string;
  value: unknown;
}

export interface ProvenanceVerdict {
  sources: string[];             // distinct sources backing the claim value
  independentSources: string[];  // the non-CRM, non-unknown subset
  passes: boolean;               // gate result
  bestSource: string | null;     // highest-trust independent source
  independentObservations: SupportingEvidence[]; // proof — the non-CRM obs backing the value
}

/**
 * Resolve a claim's `supporting_observation_ids` to their sources and run the
 * gate. The ids come from claims.supporting_observation_ids — the observations
 * deriveClaim chose as consistent with the winning value (contradicting ones
 * already excluded), so this measures support for the CURRENT claim value.
 */
export async function evaluateProvenance(
  supabase: SupabaseClient,
  workspaceId: string,
  supportingObservationIds: string[],
): Promise<ProvenanceVerdict> {
  const obs = await getObservationsByIds(supabase, workspaceId, supportingObservationIds);
  const sources = [...new Set(obs.map(o => o.source))];
  const independentSources = sources.filter(isIndependentSource);
  const independentObservations: SupportingEvidence[] = obs
    .filter(o => isIndependentSource(o.source))
    .map(o => ({ source: o.source, observed_at: o.observed_at, method: o.method, value: o.value }));
  return {
    sources,
    independentSources,
    passes: independentSources.length > 0,
    bestSource: bestIndependentSource(sources),
    independentObservations,
  };
}
