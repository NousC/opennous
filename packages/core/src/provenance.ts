// Provenance for a single claim — "why do you believe that?", answered in full.
//
// The substrate has carried the whole answer since Phase 0: every claim knows its confidence,
// its epistemic class, how fresh it is, how many observations back it, which ones, and when a
// source last confirmed it. None of that has ever reached a user. The record has been
// honest and silent, which from the outside is indistinguishable from the record being a
// guess with a nice font.
//
// This is the read path that closes that gap. It is deliberately a READ — it derives nothing
// and decides nothing, so what a user sees in the provenance popover is exactly what the
// claim engine wrote, not a second opinion computed at display time that could disagree with
// the first one.
//
// ── The one judgement it does make ──
//
// `confidence` is a float and a float is not a communication. 0.82 invites a precision nobody
// has earned — the difference between 0.82 and 0.79 is noise, and showing both teaches people
// to read noise as signal. So it bands. Three bands, because a person acts on at most three.

import type { SupabaseClient } from '@supabase/supabase-js';
import { systemLabel, readableProperty, gist } from './evidence.js';
import { listConflicts } from './db/conflicts.js';
import type { EpistemicClass, Freshness } from './db/claims.js';
import type { ReadContext } from './db/readContext.js';
import {
  derivedViewerForContext, loadDerivedSources, canReadDerived, isDerivedProperty, isPrivateMessageType,
  canReadMessage, redactedMessageLabel,
} from './privacy/messagePrivacy.mjs';

/** How sure, in a word. The float stays available for anyone who wants to sort by it. */
export type ConfidenceBand = 'high' | 'medium' | 'low';

export function confidenceBand(c: number | null | undefined): ConfidenceBand {
  const n = typeof c === 'number' ? c : 0;
  if (n >= 0.8) return 'high';
  if (n >= 0.5) return 'medium';
  return 'low';
}

/**
 * One observation that backs the claim, rendered for a citation row.
 *
 * `ref` is the pointer the evidence panel resolves into a real link. A supporting observation
 * with no ref is still worth showing — knowing a fact came from Salesforce on Tuesday is most
 * of verification — but it cannot promise a link it does not have, so the field stays null
 * rather than becoming a dead one.
 */
export interface ProvenanceSource {
  system: string;
  detail: string;
  when: string | null;
  ref: string | null;
  method: string | null;
}

export interface ClaimProvenance {
  property: string;
  /** How the property reads in a sentence — "job title", not "job_title". */
  label: string;
  value: unknown;
  confidence: number;
  band: ConfidenceBand;
  epistemic_class: EpistemicClass;
  freshness: Freshness;
  /** Distinct SYSTEMS behind it. The number a user should see next to "sources". */
  source_count: number;
  /** Raw observation count. Ten syncs from one CRM is ten observations and one source. */
  observation_count: number;
  /** When a source last confirmed this — the honest meaning of "last verified". */
  last_verified_at: string | null;
  sources: ProvenanceSource[];
  /** Other values live sources currently hold for this same property. Usually empty. */
  disputed_by: { system: string; value: unknown; when: string | null }[];
}

const SOURCE_LIMIT = 12;

/**
 * The provenance of one claim.
 *
 * Returns null when there is no live claim for the property, which is a real and useful
 * answer: it means the product never believed that, and a UI that renders a provenance chip
 * for a fact nobody asserted is inventing a belief to justify.
 */
export async function getClaimProvenance(
  supabase: SupabaseClient,
  workspaceId: string,
  entityId: string,
  property: string,
  ctx?: ReadContext,
): Promise<ClaimProvenance | null> {
  const { data: claim, error } = await supabase
    .from('claims')
    .select('property, value, confidence, epistemic_class, freshness, observation_count, last_observed_at, supporting_observation_ids')
    .eq('workspace_id', workspaceId)
    .eq('entity_id', entityId)
    .eq('property', property)
    .is('invalid_at', null)
    .maybeSingle();
  if (error) throw error;
  if (!claim) return null;

  // A fact from a message the viewer can't read has no provenance for them — it isn't theirs to
  // see (GET-253). Answered as "no live claim", the same as a claim that doesn't exist.
  const viewer = await derivedViewerForContext(supabase, ctx);
  if (viewer && isDerivedProperty(property)) {
    const src = await loadDerivedSources(supabase, workspaceId, [claim]);
    if (!canReadDerived(claim, src, viewer)) return null;
  }

  const ids: string[] = Array.isArray(claim.supporting_observation_ids)
    ? claim.supporting_observation_ids.slice(0, SOURCE_LIMIT)
    : [];

  // Two reads, in parallel: the observations this claim was actually derived FROM, and every
  // observation on the property regardless of whether it made the cut. The second is what
  // finds a source that disagrees — a value the engine ranked below the winner is invisible
  // in the claim, and it is precisely the thing a sceptical reader wants to see.
  const [supporting, allOnProperty] = await Promise.all([
    ids.length
      ? supabase
          .from('observations')
          .select('id, property, value, source, method, observed_at, source_ref, owner_user_id, raw')
          .eq('workspace_id', workspaceId)
          .in('id', ids)
          .then(r => r.data ?? [])
      : Promise.resolve([]),
    supabase
      .from('observations')
      .select('value, source, observed_at')
      .eq('workspace_id', workspaceId)
      .eq('entity_id', entityId)
      .eq('property', property)
      .order('observed_at', { ascending: false })
      .limit(50)
      .then(r => r.data ?? []),
  ]);

  // Preserve the engine's own ordering — supporting_observation_ids is ranked, newest and
  // most authoritative first, and re-sorting it here would quietly disagree with the claim
  // about which observation mattered most.
  const byId = new Map(supporting.map(o => [o.id, o]));
  const sources: ProvenanceSource[] = ids
    .map(id => byId.get(id))
    .filter(Boolean)
    .map(o => ({
      system: systemLabel(o!.source),
      // A supporting email the viewer isn't on is cited as "Email received", never quoted (GET-244).
      detail: isPrivateMessageType(o!.property) && !canReadMessage(o!, viewer)
        ? redactedMessageLabel(o!.property, o!.raw, null)
        : gist(o!.value, 140),
      when: o!.observed_at ?? null,
      ref: o!.source_ref ?? null,
      method: o!.method ?? null,
    }));

  const winner = JSON.stringify(claim.value);
  const seen = new Set<string>();
  const disputed = allOnProperty
    .filter(o => JSON.stringify(o.value) !== winner)
    .filter(o => {
      // One row per disagreeing SYSTEM. A CRM that has held the old value through forty
      // nightly syncs is one dissenting source, not forty.
      const k = `${o.source}|${JSON.stringify(o.value)}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .slice(0, 4)
    .map(o => ({ system: systemLabel(o.source), value: o.value, when: o.observed_at ?? null }));

  return {
    property,
    label: readableProperty(property),
    value: claim.value,
    confidence: Number(claim.confidence) || 0,
    band: confidenceBand(claim.confidence),
    epistemic_class: claim.epistemic_class as EpistemicClass,
    freshness: claim.freshness as Freshness,
    source_count: new Set(sources.map(s => s.system)).size,
    observation_count: Number(claim.observation_count) || 0,
    last_verified_at: claim.last_observed_at ?? null,
    sources,
    disputed_by: disputed,
  };
}

/**
 * Provenance for several claims at once, for a record view that renders a chip per field.
 *
 * Sequential would be one round trip per field and a record has dozens; `Promise.all` here is
 * the difference between a page that renders with its evidence and a page that renders and
 * then fills in.
 */
export async function getClaimProvenanceBatch(
  supabase: SupabaseClient,
  workspaceId: string,
  entityId: string,
  properties: string[],
  ctx?: ReadContext,
): Promise<Record<string, ClaimProvenance>> {
  const out: Record<string, ClaimProvenance> = {};
  const results = await Promise.all(
    properties.slice(0, 24).map(p =>
      getClaimProvenance(supabase, workspaceId, entityId, p, ctx).catch(() => null),
    ),
  );
  results.forEach(r => { if (r) out[r.property] = r; });
  return out;
}

/** Open conflicts on an entity, for the "contradicting evidence" line on a record header. */
export async function countOpenConflicts(
  supabase: SupabaseClient,
  workspaceId: string,
  entityId: string,
): Promise<number> {
  try {
    const conflicts = await listConflicts(supabase, workspaceId, { statuses: ['open'], limit: 100 });
    return conflicts.filter(c => c.entity_id === entityId).length;
  } catch {
    return 0;
  }
}
