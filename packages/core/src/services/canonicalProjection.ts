import type { SupabaseClient } from '@supabase/supabase-js';
import { recordObservation, type Observation } from '../db/observations.js';
import {
  isAuthorityAxis,
  loadFieldMap,
  mapToCanonicalAxis,
  type SourceFieldMap,
} from '../db/canonicalAxes.js';

// Canonical projection — the step that makes cross-source conflicts detectable.
//
// A raw observation from a source (SF `lifecycle_stage="Churned"`, Stripe `invoice.paid`)
// is projected onto a shared canonical axis (`lifecycle`) via the source_field_map, so the
// authority-aware claim engine can finally compare them. Projected rows are first-class
// observations (append-only, provenance back to the origin), tagged method:'inference' and
// carrying the source's TRUE name (so authority resolves), with the mapping's validity
// factor in source_confidence.

// Per-workspace field-map cache. Most workspaces have only global defaults; the cache keeps
// the hot observation-insert path from re-reading the map on every write. Empty maps are
// cached too (as []), so a workspace that hasn't configured overrides short-circuits fast.
const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { at: number; map: SourceFieldMap[] }>();

async function fieldMapFor(supabase: SupabaseClient, workspaceId: string): Promise<SourceFieldMap[]> {
  const hit = cache.get(workspaceId);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.map;
  const map = await loadFieldMap(supabase, workspaceId);
  cache.set(workspaceId, { at: Date.now(), map });
  return map;
}

/** Test/ops seam: drop the field-map cache (after editing source_field_map). */
export function clearFieldMapCache(): void {
  cache.clear();
}

export interface ProjectableObservation {
  id?: string;             // origin observation id (provenance), when known
  entityId: string;
  kind: 'state' | 'event';
  property: string;        // the source's raw key: 'lifecycle_stage' | 'invoice.paid'
  value: unknown;
  source: string;
  observedAt?: string | null;
}

/**
 * Project one raw observation onto its canonical axis, if the field map covers it. Records
 * (at most one) canonical state observation and returns it, or null when nothing maps.
 * Idempotent: the projected row dedups on external_id `proj:<originId|property:value>`.
 * Best-effort by contract — callers should not let a projection failure fail ingestion.
 */
export async function projectObservation(
  supabase: SupabaseClient,
  workspaceId: string,
  obs: ProjectableObservation,
  fieldMap?: SourceFieldMap[],
): Promise<Observation | null> {
  // Never project a canonical axis back onto itself (recursion guard), and skip sourceless rows.
  if (!obs.source || isAuthorityAxis(obs.property)) return null;

  const map = fieldMap ?? (await fieldMapFor(supabase, workspaceId));
  if (map.length === 0) return null;

  const kind = obs.kind === 'event' ? 'event' : 'state_field';
  const match = mapToCanonicalAxis(map, obs.source, kind, obs.property, obs.value);
  if (!match) return null;

  const dedupKey = obs.id ?? `${obs.property}:${String(obs.value ?? '')}`;
  return recordObservation(supabase, {
    workspaceId,
    entityId: obs.entityId,
    kind: 'state',
    property: match.canonical_property,
    value: match.canonical_value,
    source: obs.source,                 // keep the TRUE source so authority resolves
    method: 'inference',
    observedAt: obs.observedAt ?? undefined,
    sourceConfidence: match.event_validity, // carried into effective = authority × freshness × this
    externalId: `proj:${dedupKey}`,
    raw: { projected_from: obs.property, origin_observation_id: obs.id ?? null },
  });
}
