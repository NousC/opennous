// CRM echo suppression (Phase 2, Task C). Records what Nous wrote to a CRM, and
// tells the pull which incoming fields are its own echo (so they aren't
// re-ingested as fresh CRM-sourced observations). Provider-agnostic; the pull
// normalizes every CRM to the same shape, so the check is uniform.
// See docs/crm-hygiene-phase-2-spec.md, Task C.

import type { SupabaseClient } from '@supabase/supabase-js';

function norm(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v.trim().toLowerCase();
  if (typeof v === 'number' || typeof v === 'boolean') return String(v).trim().toLowerCase();
  return JSON.stringify(v).trim().toLowerCase();
}

/** Record a value Nous wrote to a CRM field (latest wins per record+field). */
export async function recordWriteState(
  supabase: SupabaseClient,
  workspaceId: string,
  provider: string,
  crmRecordId: string,
  property: string,
  value: unknown,
): Promise<void> {
  try {
    await supabase.from('crm_write_state').upsert(
      { workspace_id: workspaceId, provider, crm_record_id: crmRecordId, property, value: value ?? null, written_at: new Date().toISOString() },
      { onConflict: 'workspace_id,provider,crm_record_id,property' },
    );
  } catch { /* best-effort — echo suppression is an optimization, not correctness */ }
}

/**
 * Of the given incoming pulled `fields`, return the set whose value matches a
 * recent Nous write to this record — i.e. echoes the pull should NOT re-ingest.
 * Matched write-state rows are consumed (deleted): each write suppresses exactly
 * one echo, so a genuine later human edit to the same value isn't muted forever.
 */
export async function echoFieldsToSkip(
  supabase: SupabaseClient,
  workspaceId: string,
  provider: string,
  crmRecordId: string,
  fields: Record<string, unknown>,
  windowDays = 14,
): Promise<Set<string>> {
  const props = Object.keys(fields).filter(k => fields[k] != null);
  if (!props.length) return new Set();
  const cutoff = new Date(Date.now() - windowDays * 86_400_000).toISOString();

  const { data } = await supabase.from('crm_write_state')
    .select('id, property, value')
    .eq('workspace_id', workspaceId).eq('provider', provider).eq('crm_record_id', crmRecordId)
    .in('property', props).gte('written_at', cutoff);

  const skip = new Set<string>();
  const consumed: string[] = [];
  for (const r of (data ?? []) as { id: string; property: string; value: unknown }[]) {
    if (norm(r.value) === norm(fields[r.property])) { skip.add(r.property); consumed.push(r.id); }
  }
  if (consumed.length) { try { await supabase.from('crm_write_state').delete().in('id', consumed); } catch { /* ignore */ } }
  return skip;
}
