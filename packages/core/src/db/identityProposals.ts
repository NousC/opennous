import type { SupabaseClient } from '@supabase/supabase-js';

// Identity proposals — Piece 4 of auto-reconcile. A plausible-but-uncertain person match
// (fuzzy name / email-local, below the auto-attach bar) becomes a reviewable proposal instead
// of a silent fuse or a silent duplicate. Approve = merge; deny/dismiss = keep separate (and
// remember it). One live row per (workspace, subject entity), deduped like flags. The merge
// itself is done by the caller via mergeEntities — this module only stores the decision.

export type IdentityProposalStatus = 'pending' | 'approved' | 'denied' | 'dismissed';

export interface IdentityCandidate {
  entity_id: string;
  confidence: number;
  reason: string;   // surname_token | name_prefix | email_local_part
}

export interface IdentityProposal {
  id: string;
  workspace_id: string;
  entity_id: string;
  kind: 'merge' | 'attach';
  candidates: IdentityCandidate[];
  stakes: 'high' | 'low';
  status: IdentityProposalStatus;
  resolved_by: string | null;
  created_at: string;
  last_fired_at: string;
  resolved_at: string | null;
}

const COLUMNS =
  'id, workspace_id, entity_id, kind, candidates, stakes, status, resolved_by, created_at, last_fired_at, resolved_at';

export interface UpsertIdentityProposalParams {
  entityId: string;
  candidates: IdentityCandidate[];
  kind?: 'merge' | 'attach';
  stakes?: 'high' | 'low';
}

/**
 * Record (or refresh) a pending identity proposal for a subject entity. A resolved
 * (approved/denied/dismissed) proposal is left alone — we never re-nag once a human decided.
 * Returns the row, or null if suppressed by a prior decision or if there are no candidates.
 */
export async function upsertIdentityProposal(
  supabase: SupabaseClient,
  workspaceId: string,
  p: UpsertIdentityProposalParams,
): Promise<IdentityProposal | null> {
  const candidates = [...p.candidates].sort((a, b) => b.confidence - a.confidence);
  if (candidates.length === 0) return null;
  const now = new Date().toISOString();

  const { data: existing } = await supabase
    .from('identity_proposals')
    .select(COLUMNS)
    .eq('workspace_id', workspaceId)
    .eq('entity_id', p.entityId)
    .maybeSingle();
  const e = existing as unknown as IdentityProposal | null;
  if (e && e.status !== 'pending') return null;  // already decided — don't reopen

  if (e) {
    const { data } = await supabase
      .from('identity_proposals')
      .update({ candidates, last_fired_at: now, kind: p.kind ?? e.kind, stakes: p.stakes ?? e.stakes })
      .eq('id', e.id)
      .select(COLUMNS)
      .single();
    return (data as unknown as IdentityProposal) ?? null;
  }
  const { data } = await supabase
    .from('identity_proposals')
    .insert({
      workspace_id: workspaceId,
      entity_id: p.entityId,
      kind: p.kind ?? 'merge',
      candidates,
      stakes: p.stakes ?? 'high',
      status: 'pending',
      created_at: now,
      last_fired_at: now,
    })
    .select(COLUMNS)
    .single();
  return (data as unknown as IdentityProposal) ?? null;
}

/** The review queue — pending identity proposals, newest first. */
export async function listIdentityProposals(
  supabase: SupabaseClient,
  workspaceId: string,
  opts: { statuses?: IdentityProposalStatus[]; limit?: number } = {},
): Promise<IdentityProposal[]> {
  let q = supabase
    .from('identity_proposals')
    .select(COLUMNS)
    .eq('workspace_id', workspaceId)
    .in('status', opts.statuses ?? ['pending'])
    .order('last_fired_at', { ascending: false });
  if (opts.limit != null) q = q.limit(opts.limit);
  const { data, error } = await q;
  if (error) throw error;
  return (data as unknown as IdentityProposal[]) ?? [];
}

export async function getIdentityProposal(
  supabase: SupabaseClient,
  id: string,
): Promise<IdentityProposal | null> {
  const { data } = await supabase.from('identity_proposals').select(COLUMNS).eq('id', id).maybeSingle();
  return (data as unknown as IdentityProposal) ?? null;
}

export async function setIdentityProposalStatus(
  supabase: SupabaseClient,
  id: string,
  status: IdentityProposalStatus,
  resolvedBy?: string,
): Promise<IdentityProposal | null> {
  const { data } = await supabase
    .from('identity_proposals')
    .update({ status, resolved_by: resolvedBy ?? null, resolved_at: new Date().toISOString() })
    .eq('id', id)
    .select(COLUMNS)
    .single();
  return (data as unknown as IdentityProposal) ?? null;
}
