import type { SupabaseClient } from '@supabase/supabase-js';
import { embed } from '../embed.js';

// Semantic search over the substrate. Step 2 of the Context API pipeline
// (Retrieve) — the pre-filter that narrows candidates before assembly.
// Returns [] if embeddings aren't available (no OPENAI_API_KEY) so callers
// fall back to structured retrieval.

export interface ClaimSearchHit {
  id: string;
  entity_id: string;
  property: string;
  value: unknown;
  confidence: number;
  freshness: string;
  valid_from?: string | null;
  similarity: number;
}

export async function searchClaims(
  supabase: SupabaseClient,
  workspaceId: string,
  query: string,
  opts: { limit?: number; threshold?: number; propertyPrefix?: string } = {},
): Promise<ClaimSearchHit[]> {
  const vector = await embed(query);
  if (!vector) return [];

  // propertyPrefix restricts the candidate set BEFORE the vector sort (e.g.
  // 'note.' to dedup only against notes). Without it the search scans every
  // claim in the workspace — tens of thousands — when the caller only cares
  // about a few hundred notes, which is both slow and low-recall (the nearest
  // global claims are rarely notes).
  const { data, error } = await supabase.rpc('search_claims', {
    p_workspace_id: workspaceId,
    p_embedding: JSON.stringify(vector),   // pgvector accepts the array literal as text
    p_threshold: opts.threshold ?? 0.3,
    p_limit: opts.limit ?? 20,
    p_property_prefix: opts.propertyPrefix ?? null,
  });
  if (error) {
    // function missing (RPC not yet created) — degrade silently
    if (error.code === '42883' || error.code === 'PGRST202') return [];
    console.error('[searchClaims]', error.message);
    return [];
  }
  return (data as ClaimSearchHit[]) ?? [];
}

export interface ObservationSearchHit {
  id: string;
  entity_id: string;
  property: string;
  value: unknown;
  source: string;
  observed_at: string;
  similarity: number;
}

/** Semantic search over observations, with structured pre-filters. */
export async function searchObservations(
  supabase: SupabaseClient,
  workspaceId: string,
  query: string,
  scope: { kind?: string; property?: string; source?: string; since?: string } = {},
  limit = 50,
): Promise<ObservationSearchHit[]> {
  const vector = await embed(query);
  if (!vector) return [];

  const { data, error } = await supabase.rpc('search_observations', {
    p_workspace_id: workspaceId,
    p_embedding: JSON.stringify(vector),
    p_kind: scope.kind ?? null,
    p_property_prefix: scope.property ?? null,
    p_source: scope.source ?? null,
    p_since: scope.since ?? null,
    p_limit: limit,
  });
  if (error) {
    if (error.code === '42883' || error.code === 'PGRST202') return [];
    console.error('[searchObservations]', error.message);
    return [];
  }
  return (data as ObservationSearchHit[]) ?? [];
}
