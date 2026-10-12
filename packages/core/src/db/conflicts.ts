import type { SupabaseClient } from '@supabase/supabase-js';
import { valuesGenuinelyDiffer } from './canonicalAxes.js';

// Field conflicts — the reviewable "see every conflict, resolved" surface. One live row per
// (workspace, entity, canonical_property), deduped like `flags`. Written by the authority-
// aware claim engine (see deriveAuthoritativeClaim / recomputeClaim) whenever ≥2 sources
// disagree on a canonical axis; auto_resolved when the authority margin is decisive, pending
// when a human must decide.

export type ConflictResolution = 'pending' | 'auto_resolved' | 'human_resolved';
export type ConflictStatus = 'open' | 'resolved' | 'dismissed';

/** One source's claim on the axis, with the effective confidence that ranked it. */
export interface ConflictCandidate {
  value: unknown;
  source: string;
  observed_at: string | null;
  effective: number;
  observation_id?: string | null;
}

export interface FieldConflict {
  id: string;
  workspace_id: string;
  entity_id: string;
  canonical_property: string;
  candidates: ConflictCandidate[];
  resolved_value: unknown;
  resolution: ConflictResolution;
  resolved_by: string | null;
  status: ConflictStatus;
  created_at: string;
  last_fired_at: string;
  resolved_at: string | null;
}

const COLUMNS =
  'id, workspace_id, entity_id, canonical_property, candidates, resolved_value, ' +
  'resolution, resolved_by, status, created_at, last_fired_at, resolved_at';

export interface DetectConflictParams {
  entityId: string;
  canonicalProperty: string;
  candidates: ConflictCandidate[]; // ranked, best first
  /** Auto-resolve margin: winner must beat runner-up by ≥ this to resolve without a human. */
  margin?: number;
}

const DEFAULT_MARGIN = 0.15;

/**
 * How many GENUINELY different values are on the table.
 *
 * Exact JSON comparison was right while the axes were enums. It stops being right the moment
 * free-text ones are watched: "VP Sales" and "VP of Sales" are the same job, and a review
 * queue that raises that has taught its reader to close the queue. Pairwise rather than by
 * key, because "sameness" here is a fuzzy relation and cannot be reduced to one hash.
 */
/**
 * Pure: do these candidates disagree for real — two genuinely different values from two sources?
 * The batch recompute (GET-299) asks this first so it only makes the round trip when there is a
 * conflict to raise or an open one to close; detectFieldConflict asks it too, so the rule is one.
 */
export function isFieldConflict(cands: ConflictCandidate[]): boolean {
  return distinctValues(cands) >= 2 && new Set(cands.map(c => c.source)).size >= 2;
}

function distinctValues(cands: ConflictCandidate[]): number {
  const kept: unknown[] = [];
  for (const c of cands) {
    if (!kept.some(k => !valuesGenuinelyDiffer(k, c.value))) kept.push(c.value);
  }
  return kept.length;
}

/**
 * Reconcile the conflict state for one canonical axis after a recompute.
 * - Fewer than 2 distinct values, or all from ONE source → not a conflict; close any open row.
 * - Otherwise upsert a live conflict row: `auto_resolved` (with the winner) when the top two
 *   candidates differ by ≥ margin, else `pending` for human review. A human_resolved row is
 *   left untouched (sticky, mirrors asserted claims). Returns the row, or null when no conflict.
 */
export async function detectFieldConflict(
  supabase: SupabaseClient,
  workspaceId: string,
  p: DetectConflictParams,
): Promise<FieldConflict | null> {
  const cands = [...p.candidates].sort((a, b) => b.effective - a.effective);
  const isConflict = isFieldConflict(cands);

  if (!isConflict) {
    await resolveConflictIfOpen(supabase, workspaceId, p.entityId, p.canonicalProperty);
    return null;
  }

  const now = new Date().toISOString();
  const margin = p.margin ?? DEFAULT_MARGIN;
  const winner = cands[0];
  const runnerUp = cands[1];
  const cleared = winner.effective - (runnerUp?.effective ?? 0) >= margin;
  const resolution: ConflictResolution = cleared ? 'auto_resolved' : 'pending';

  const { data: existing } = await supabase
    .from('field_conflicts')
    .select(COLUMNS)
    .eq('workspace_id', workspaceId)
    .eq('entity_id', p.entityId)
    .eq('canonical_property', p.canonicalProperty)
    .maybeSingle();
  const e = existing as unknown as FieldConflict | null;

  // A human decision is sticky — refresh the evidence but never downgrade it.
  if (e && e.resolution === 'human_resolved' && e.status !== 'dismissed') {
    const { data } = await supabase
      .from('field_conflicts')
      .update({ candidates: cands, last_fired_at: now })
      .eq('id', e.id)
      .select(COLUMNS)
      .single();
    return (data as unknown as FieldConflict) ?? null;
  }
  if (e && e.status === 'dismissed') return null;

  const row = {
    workspace_id: workspaceId,
    entity_id: p.entityId,
    canonical_property: p.canonicalProperty,
    candidates: cands,
    resolved_value: cleared ? winner.value : null,
    resolution,
    resolved_by: cleared ? winner.source : null,
    status: 'open' as ConflictStatus,
    last_fired_at: now,
    resolved_at: null,
  };

  if (e) {
    const { data } = await supabase.from('field_conflicts').update(row).eq('id', e.id).select(COLUMNS).single();
    return (data as unknown as FieldConflict) ?? null;
  }
  const { data } = await supabase
    .from('field_conflicts')
    .insert({ ...row, created_at: now })
    .select(COLUMNS)
    .single();
  return (data as unknown as FieldConflict) ?? null;
}

/** Sources re-converged → close an OPEN conflict. Leaves human_resolved/dismissed alone. */
export async function resolveConflictIfOpen(
  supabase: SupabaseClient,
  workspaceId: string,
  entityId: string,
  canonicalProperty: string,
): Promise<void> {
  await supabase
    .from('field_conflicts')
    .update({ status: 'resolved', resolved_at: new Date().toISOString() })
    .eq('workspace_id', workspaceId)
    .eq('entity_id', entityId)
    .eq('canonical_property', canonicalProperty)
    .eq('status', 'open')
    .in('resolution', ['pending', 'auto_resolved']);
}

/** The review queue — open conflicts, pending (need a human) first. */
export async function listConflicts(
  supabase: SupabaseClient,
  workspaceId: string,
  opts: { statuses?: ConflictStatus[]; limit?: number } = {},
): Promise<FieldConflict[]> {
  let q = supabase
    .from('field_conflicts')
    .select(COLUMNS)
    .eq('workspace_id', workspaceId)
    .in('status', opts.statuses ?? ['open'])
    .order('resolution', { ascending: true }) // 'auto_resolved' < 'human_resolved' < 'pending' — see note
    .order('last_fired_at', { ascending: false });
  if (opts.limit != null) q = q.limit(opts.limit);
  const { data, error } = await q;
  if (error) throw error;
  // Pending first for the human queue (alpha order puts it last, so re-sort in memory).
  const rows = (data as unknown as FieldConflict[]) ?? [];
  return rows.sort((a, b) => (a.resolution === 'pending' ? 0 : 1) - (b.resolution === 'pending' ? 0 : 1));
}

/** A human picks the winning value → sticky asserted-style resolution. The caller is
 *  responsible for also asserting the claim (assertClaims) so derivation won't revert it. */
export async function resolveConflictByHuman(
  supabase: SupabaseClient,
  conflictId: string,
  resolvedValue: unknown,
  userId: string,
): Promise<FieldConflict | null> {
  const now = new Date().toISOString();
  const { data } = await supabase
    .from('field_conflicts')
    .update({
      resolved_value: resolvedValue,
      resolution: 'human_resolved',
      resolved_by: userId,
      status: 'resolved',
      resolved_at: now,
    })
    .eq('id', conflictId)
    .select(COLUMNS)
    .single();
  return (data as unknown as FieldConflict) ?? null;
}

export async function setConflictStatus(
  supabase: SupabaseClient,
  conflictId: string,
  status: ConflictStatus,
): Promise<FieldConflict | null> {
  const patch: Record<string, unknown> = { status };
  if (status === 'resolved' || status === 'dismissed') patch.resolved_at = new Date().toISOString();
  const { data } = await supabase.from('field_conflicts').update(patch).eq('id', conflictId).select(COLUMNS).single();
  return (data as unknown as FieldConflict) ?? null;
}
