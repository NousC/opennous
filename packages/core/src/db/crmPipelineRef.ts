// Which CRM pipeline a workspace means when it says "the pipeline".
//
// A CRM is allowed more than one pipeline and a real portal has several: a Sales pipeline, an
// Enterprise one, an Expansion one, each with its own stages. The workspace's PRIMARY pipeline
// (the CRM's own id, the literal `default` on HubSpot) is recorded on crm_sync_configs, and
// every reader that scopes to "the pipeline" reads it from here so they can never disagree.
//
// ── Why the write is its own statement ──
//
// `crm_sync_configs.primary_pipeline_ref` arrives via a migration applied BY HAND, so a live
// database can be running this code before the column exists. PostgREST rejects an entire
// write whose body names an unknown column (PGRST204). Folding the ref into the sync's own
// update would therefore take the SYNC CURSOR down with it: `last_synced_at` would never
// advance, every tick would re-pull the same window, and the run would still log success.
//
// So the ref is always written on its own, after the caller's real write has landed, and a
// failure is swallowed. Losing the ref costs one unscoped funnel until the migration runs.
// Losing the cursor costs a stalled integration nobody notices.

import type { SupabaseClient } from '@supabase/supabase-js';

/** The column is absent (migration not applied), or the whole table is. Never an error worth raising. */
const MISSING_SCHEMA = new Set(['42P01', 'PGRST204', 'PGRST205', '42703']);

const clean = (v: unknown): string | null => {
  const s = typeof v === 'string' ? v.trim() : '';
  return s || null;
};

/**
 * The CRM's id for the workspace's primary pipeline, or null.
 *
 * Null means "apply no pipeline filter", which is exactly how every reader behaved before the
 * column existed. A workspace with no CRM, one that has not synced since the id was first
 * recorded, and a database the migration has not reached all answer null, and none of them is
 * a reason for a deal list or a report to fail. A workspace holds one config per provider, so
 * the most recently updated row carrying a value wins.
 */
export async function readPrimaryPipelineRef(
  supabase: SupabaseClient,
  workspaceId: string,
): Promise<string | null> {
  try {
    const { data, error } = await supabase
      .from('crm_sync_configs')
      .select('primary_pipeline_ref, updated_at')
      .eq('workspace_id', workspaceId)
      .order('updated_at', { ascending: false });
    if (error) return null;
    for (const row of (data as Array<{ primary_pipeline_ref?: unknown }> | null) ?? []) {
      const ref = clean(row.primary_pipeline_ref);
      if (ref) return ref;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Record the primary pipeline for one workspace + provider, on its own and best-effort.
 *
 * Call it AFTER the write that carries the sync cursor, never inside it (see the header). A
 * null or blank `ref` is a no-op: the prelude could not fetch pipelines this run, and an
 * absent answer must not erase what a previous run recorded.
 *
 * Returns true when the value landed, false when it did not — the caller is free to ignore it.
 */
export async function writePrimaryPipelineRef(
  supabase: SupabaseClient,
  workspaceId: string,
  provider: string,
  ref: string | null | undefined,
): Promise<boolean> {
  const value = clean(ref);
  if (!value || !workspaceId || !provider) return false;
  try {
    const { error } = await supabase
      .from('crm_sync_configs')
      .update({ primary_pipeline_ref: value })
      .eq('workspace_id', workspaceId)
      .eq('provider', provider);
    if (!error) return true;
    if (!MISSING_SCHEMA.has(String(error.code))) {
      console.warn('[crmPipelineRef] primary_pipeline_ref not written:', error.message);
    }
    return false;
  } catch {
    return false;
  }
}
