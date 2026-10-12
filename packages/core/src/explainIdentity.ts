// "Why does it say that?" — for an IDENTITY, not a claim.
//
// Claim-level provenance has been answerable since Phase 0: getClaimProvenance gives the
// confidence, the freshness, the systems, the observations and who disagrees. The identity
// layer never had an equivalent, and identity is where the decisions with the biggest blast
// radius live — a wrong claim is a wrong field, a wrong merge is two humans filed as one.
//
// ⚠️ THE REASON THIS IS ONE FUNCTION. Four different places decide identity — getOrCreateEntity
// (is this someone new), mergeEntities (are these two one), the claim engine (which value
// wins), resolveFocus (who did you mean). Each was correct in isolation and none agreed on
// where its reasoning went, so the honest answer to "why does it say that" depended on which
// one you happened to ask. Fixing the four separately and leaving the reader to assemble them
// would have been the same bug in a different shape.

import type { SupabaseClient } from '@supabase/supabase-js';
import { systemLabel } from './evidence.js';
import { listConflicts } from './db/conflicts.js';

export interface IdentityIdentifier {
  kind: string;
  value: string;
  /** The system that asserted it. Null on rows written before this was recorded. */
  source: string | null;
  confidence: number | null;
  status: string | null;
  first_seen_at: string | null;
}

export interface IdentityMerge {
  keep_id: string;
  drop_id: string;
  /** What made them one record — the identifier kind and value, where it was recorded. */
  matched_kind: string | null;
  matched_value: string | null;
  reason: string | null;
  actor: string | null;
  at: string;
  /** Whether the rollback manifest exists. False means this merge can never be undone. */
  reversible: boolean;
}

export interface IdentityExplanation {
  entity_id: string;
  /** Every way this record can be recognised, and who said so. */
  identifiers: IdentityIdentifier[];
  /** Distinct systems that have asserted an identifier. One system is not corroboration. */
  source_count: number;
  /** Records folded into this one, and on what basis. */
  merges: IdentityMerge[];
  /** Records this one was folded INTO — i.e. this id is a tombstone. */
  merged_into: string | null;
  /** Live cross-source disagreements on this entity. */
  conflicts: { property: string; candidates: { source: string; value: unknown }[]; resolution: string }[];
  /**
   * What cannot be said, and why. An explanation that quietly omits its own gaps is the same
   * confident-wrong-answer problem one layer up: the reader assumes silence means nothing to
   * report, when it means nothing was recorded.
   */
  gaps: string[];
}

/**
 * Everything known about WHY this record is this record.
 *
 * Reads only — it derives nothing and decides nothing, so what a person is shown is what the
 * identity layer actually did, not a second opinion computed at display time that could
 * disagree with the first.
 */
export async function explainIdentity(
  supabase: SupabaseClient,
  workspaceId: string,
  entityId: string,
): Promise<IdentityExplanation> {
  const [{ data: ids }, { data: merges }, { data: self }] = await Promise.all([
    supabase.from('entity_identifiers')
      .select('kind, value, source, confidence, status, first_seen_at')
      .eq('workspace_id', workspaceId).eq('entity_id', entityId)
      .order('first_seen_at', { ascending: true })
      .then(r => r, () => ({ data: [] })),
    supabase.from('entity_merge_log')
      .select('keep_id, drop_id, matched_kind, matched_value, reason, actor, created_at, payload, unmerged_at')
      .eq('workspace_id', workspaceId).eq('keep_id', entityId)
      .order('created_at', { ascending: false })
      .then(r => r, () => ({ data: [] })),
    supabase.from('entities').select('merged_into').eq('id', entityId).maybeSingle()
      .then(r => r, () => ({ data: null })),
  ]);

  const identifiers: IdentityIdentifier[] = (ids ?? []).map(i => ({
    kind: i.kind as string,
    value: i.value as string,
    source: i.source ? systemLabel(i.source as string) : null,
    confidence: i.confidence as number | null,
    status: i.status as string | null,
    first_seen_at: i.first_seen_at as string | null,
  }));

  let conflicts: IdentityExplanation['conflicts'] = [];
  try {
    conflicts = (await listConflicts(supabase, workspaceId, { statuses: ['open'], limit: 100 }))
      .filter(c => c.entity_id === entityId)
      .map(c => ({
        property: c.canonical_property,
        candidates: (c.candidates ?? []).map(x => ({ source: systemLabel(x.source), value: x.value })),
        resolution: c.resolution,
      }));
  } catch { /* a conflicts read that fails must not take the explanation down with it */ }

  // Said out loud, because a reader cannot tell the difference between "nothing to report"
  // and "nothing was written down", and the two mean opposite things about how much to trust
  // what they are looking at.
  const gaps: string[] = [];
  const unsourced = identifiers.filter(i => !i.source).length;
  if (unsourced) {
    gaps.push(
      `${unsourced} of ${identifiers.length} identifiers predate source tracking, so we cannot say which system asserted them.`,
    );
  }
  for (const m of merges ?? []) {
    if (!m.matched_kind && !m.reason) {
      gaps.push(`A merge on ${String(m.created_at).slice(0, 10)} recorded what moved but not why — the basis for it was never written down.`);
    }
  }

  return {
    entity_id: entityId,
    identifiers,
    // Distinct SYSTEMS, not identifiers. Five identifiers from one CRM is one system's word.
    source_count: new Set(identifiers.map(i => i.source).filter(Boolean)).size,
    merges: (merges ?? []).map(m => ({
      keep_id: m.keep_id as string,
      drop_id: m.drop_id as string,
      matched_kind: (m.matched_kind as string | null) ?? null,
      matched_value: (m.matched_value as string | null) ?? null,
      reason: (m.reason as string | null) ?? null,
      actor: (m.actor as string | null) ?? null,
      at: m.created_at as string,
      // A payload IS the rollback manifest; consumed once, so an un-merged row is spent.
      reversible: Boolean(m.payload) && !m.unmerged_at,
    })),
    merged_into: (self as { merged_into?: string | null } | null)?.merged_into ?? null,
    conflicts,
    gaps,
  };
}
