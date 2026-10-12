import type { SupabaseClient } from '@supabase/supabase-js';

// Phase 4.3 — multi-hop graph traversal. A thin wrapper over the traverse_graph SQL function
// (see migration 2026_08_17_graph_traverse.sql): a bounded, cycle-guarded recursive walk over
// the resolved edges in workspace_graph_edges, returning typed paths (the node reached plus
// the sequence of relationship verbs that got there). This is the general path query the
// fixed 1-hop readers (committee, war-room) can't express.
//
// Node-level audience filtering is the caller's job (a member may only see some accounts) —
// pass the reachable entity ids to the API's entityVisibleToMember before surfacing them.

export interface GraphPath {
  /** Number of hops from the start (1 = a direct edge). */
  depth: number;
  /** The entity id reached at the end of this path. */
  endEntity: string;
  /** The label of the end node as recorded on the edge (may be null). */
  endLabel: string | null;
  /** The full node chain, start first, endEntity last. */
  pathEntities: string[];
  /** The relationship verbs traversed, one per hop (length === depth). */
  pathRelationships: string[];
}

const MAX_DEPTH_CAP = 5;

/**
 * Find the paths reachable from `startEntity` within a workspace, up to `maxDepth` hops.
 * Directed (subject -> object). `edgeTypes` restricts to specific relationship verbs
 * (e.g. ['KNOWS','WORKS_WITH']); omit for any. Depth is clamped to 1..5. Returns one row
 * per reachable path (a node can appear at multiple depths via different routes).
 */
export async function findPaths(
  supabase: SupabaseClient,
  workspaceId: string,
  startEntity: string,
  opts: { maxDepth?: number; edgeTypes?: string[] } = {},
): Promise<GraphPath[]> {
  const depth = Math.min(Math.max(Math.floor(opts.maxDepth ?? 3), 1), MAX_DEPTH_CAP);
  const { data, error } = await supabase.rpc('traverse_graph', {
    p_workspace_id: workspaceId,
    p_start_entity: startEntity,
    p_max_depth: depth,
    p_edge_types: opts.edgeTypes && opts.edgeTypes.length ? opts.edgeTypes : null,
  });
  if (error) throw new Error(`traverse_graph failed: ${error.message}`);
  return ((data as RawPath[]) ?? []).map(r => ({
    depth: r.depth,
    endEntity: r.end_entity,
    endLabel: r.end_label ?? null,
    pathEntities: r.path_entities ?? [],
    pathRelationships: r.path_relationships ?? [],
  }));
}

interface RawPath {
  depth: number;
  end_entity: string;
  end_label: string | null;
  path_entities: string[];
  path_relationships: string[];
}
