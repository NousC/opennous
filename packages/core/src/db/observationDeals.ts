// Activity → deal attribution.
//
// An observation hangs off one entity, a person. A call can be ABOUT one deal on that
// person's account, or two, or none. This is the one place that link is written and read,
// whoever decided it: the CRM (a mirrored association, confidence 1), a human (the CRM
// agent's "which deal?" answer, confidence 1, `decided_by` set), or an inference (the
// ranker's best guess, confidence < 1, never written back to a CRM on its own).
//
// Deliberately NOT a relationship row: relationships join two entities, and an
// observation is not an entity. Deliberately NOT a field on the observation: the deal
// timeline needs an index, and "who said so" needs columns.

import type { SupabaseClient } from '@supabase/supabase-js';

export type ObservationDealSource = 'crm' | 'human' | 'inferred';

export interface ObservationDealRow {
  workspace_id: string;
  observation_id: string;
  deal_entity_id: string;
  source: ObservationDealSource;
  confidence: number;
  decided_by: string | null;
}

/**
 * The rows for one observation attributed to some deals. Pure. Dedupes deal ids, drops
 * blanks, clamps confidence into [0, 1]. A human attribution always carries confidence 1
 * regardless of what was passed: the human is the ground truth, not a guess.
 */
export function observationDealRows(
  workspaceId: string,
  observationId: string,
  dealEntityIds: Array<string | null | undefined>,
  source: ObservationDealSource,
  opts: { confidence?: number; decidedBy?: string | null } = {},
): ObservationDealRow[] {
  const seen = new Set<string>();
  const conf = source === 'human' ? 1 : Math.max(0, Math.min(1, opts.confidence ?? 1));
  const rows: ObservationDealRow[] = [];
  for (const id of dealEntityIds) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    rows.push({
      workspace_id: workspaceId, observation_id: observationId, deal_entity_id: id,
      source, confidence: conf, decided_by: source === 'human' ? (opts.decidedBy ?? null) : null,
    });
  }
  return rows;
}

/**
 * Write the link. Idempotent on (observation, deal). A human answer OVERWRITES a mirrored
 * or inferred row for the same pair (the person's call beats the machine's); any other
 * source leaves an existing row alone. Best-effort: a missing table (migration not yet
 * applied) returns false rather than throwing into a sync.
 */
export async function linkObservationToDeals(
  supabase: SupabaseClient,
  workspaceId: string,
  observationId: string,
  dealEntityIds: Array<string | null | undefined>,
  source: ObservationDealSource,
  opts: { confidence?: number; decidedBy?: string | null } = {},
): Promise<boolean> {
  const rows = observationDealRows(workspaceId, observationId, dealEntityIds, source, opts);
  if (!rows.length) return true;
  const { error } = await supabase.from('observation_deals').upsert(rows, {
    onConflict: 'observation_id,deal_entity_id',
    ignoreDuplicates: source !== 'human',
  });
  if (!error) return true;
  if (error.code === '42P01' || error.code === 'PGRST205') return false;   // migration not applied
  throw new Error(error.message);
}

/** Observation ids filed against a deal, newest link first. The per-deal timeline's seed. */
export async function getDealObservationIds(
  supabase: SupabaseClient,
  workspaceId: string,
  dealEntityId: string,
  opts: { limit?: number } = {},
): Promise<Array<{ observation_id: string; source: ObservationDealSource; confidence: number }>> {
  const { data, error } = await supabase.from('observation_deals')
    .select('observation_id, source, confidence')
    .eq('workspace_id', workspaceId).eq('deal_entity_id', dealEntityId)
    .order('created_at', { ascending: false })
    .limit(opts.limit ?? 500);
  if (error) {
    if (error.code === '42P01' || error.code === 'PGRST205') return [];
    throw new Error(error.message);
  }
  return (data ?? []) as Array<{ observation_id: string; source: ObservationDealSource; confidence: number }>;
}

/** The deals an observation was filed against. Empty when nobody has attributed it yet. */
export async function getObservationDeals(
  supabase: SupabaseClient,
  workspaceId: string,
  observationId: string,
): Promise<Array<{ deal_entity_id: string; source: ObservationDealSource; confidence: number }>> {
  const { data, error } = await supabase.from('observation_deals')
    .select('deal_entity_id, source, confidence')
    .eq('workspace_id', workspaceId).eq('observation_id', observationId);
  if (error) {
    if (error.code === '42P01' || error.code === 'PGRST205') return [];
    throw new Error(error.message);
  }
  return (data ?? []) as Array<{ deal_entity_id: string; source: ObservationDealSource; confidence: number }>;
}
