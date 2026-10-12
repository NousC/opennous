import type { SupabaseClient } from '@supabase/supabase-js';
import { embed } from '../embed.js';
import { rawVisible, type ReadContext } from './readContext.js';
import { loadMessageViewer, redactObservationRowsForViewer, isPrivateMessageType, derivedViewerForContext, filterDerivedForViewer } from '../privacy/messagePrivacy.mjs';

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
  opts: { limit?: number; threshold?: number; propertyPrefix?: string; entityId?: string | null; onFailure?: (reason: string) => void } = {},
  ctx?: ReadContext,
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
    // Scope to the record the caller cares about. Dedup asks "have we already said this about
    // THIS subject", and the answer never involved another account's notes — but the search read
    // every note in the workspace to find out, thousands of them on the largest, reading each one's
    // 1536-dimension embedding. That is what put it over the 8s statement timeout often enough to
    // lose a real share of duplicate checks silently.
    p_entity_id: opts.entityId ?? null,
  });
  if (error) {
    // function missing (RPC not yet created) — degrade silently
    if (error.code === '42883' || error.code === 'PGRST202') return [];
    // A FAILED search and an EMPTY one both return [], and the caller cannot tell them apart —
    // so a dedup pass whose search timed out silently becomes "nothing similar found", i.e. always
    // ADD. That is how a handful of timeouts in one small sample produced duplicate claims with no
    // sign that anything had gone wrong. Callers that care pass onFailure and can count it.
    console.error('[searchClaims]', error.message);
    opts.onFailure?.(error.message);
    return [];
  }
  const hits = (data as ClaimSearchHit[]) ?? [];
  // A hit derived from a message the viewer can't read is not theirs (GET-253).
  const viewer = await derivedViewerForContext(supabase, ctx);
  return viewer ? filterDerivedForViewer(supabase, workspaceId, hits, viewer) : hits;
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
  ctx?: ReadContext,
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
  const hits = (data as ObservationSearchHit[]) ?? [];

  // Per-viewer scoping. The RPC drops owner_user_id, so for a scoped member we
  // re-fetch the owner of each matched observation and keep only the rows that
  // viewer is allowed to read — otherwise a cross-account semantic search would
  // surface another rep's private message bodies. Mirrors the runQuery path.
  let out = hits;
  if (ctx && ctx.viewerScope === 'member' && out.length) {
    const ids = out.map(h => h.id);
    const { data: owners } = await supabase
      .from('observations')
      .select('id, owner_user_id, property')
      .eq('workspace_id', workspaceId)
      .in('id', ids);
    const byId = new Map((owners ?? []).map((o: { id: string; owner_user_id: string | null; property: string }) => [o.id, o]));
    // Messages stay (their content is judged below); other rows keep the owner rule.
    out = out.filter(h => isPrivateMessageType(h.property) || rawVisible(byId.get(h.id)?.owner_user_id ?? null, ctx));
  }
  // Message content only for its participants (GET-244), whatever the viewer's role.
  if (ctx && ctx.viewerUserId && out.length) {
    const viewer = await loadMessageViewer(supabase, workspaceId, ctx.viewerUserId);
    out = (await redactObservationRowsForViewer(supabase, workspaceId, out, viewer)) as ObservationSearchHit[];
    out = (await filterDerivedForViewer(supabase, workspaceId, out, viewer)) as ObservationSearchHit[];   // GET-253
  }
  return out;
}
