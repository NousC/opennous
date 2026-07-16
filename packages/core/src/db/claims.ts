import type { SupabaseClient } from '@supabase/supabase-js';
import type { Observation } from './observations.js';
import { getObservations } from './observations.js';
import { collapseMeetingDupes } from './activities.js';
import { fireClaimTransitionTriggers } from './triggers.js';
import { listNotes } from './notes.js';
import type { ReadContext } from './readContext.js';

// Claims are the derived layer — the current best belief about
// (entity, property), with calibrated confidence, provenance, and decay.
// Claims are never written by hand: they are computed from observations
// and are fully regenerable. This replaces every bare column that lived
// on v1's `contacts` / `companies`.

export type EpistemicClass = 'observed' | 'inferred' | 'predicted' | 'asserted';
export type Freshness = 'fresh' | 'aging' | 'suspect' | 'expired';

export interface Claim {
  entity_id: string;
  property: string;
  value: unknown;
  confidence: number;
  epistemic_class: EpistemicClass;
  freshness: Freshness;
  decays_at: string | null;
  observation_count: number;
  last_observed_at: string | null;
}

/** A durable, decision-relevant fact about an account (an asserted note.* claim,
 *  excluding long-form documents). Surfaced inline so agents don't need a
 *  separate facts lookup. */
export interface AccountFact {
  category: string;
  content: string;
  date: string;
}

export interface AccountRecord {
  entity_id: string;
  type: string;
  claims: Record<string, Claim>;          // property -> claim
  recent_observations: Observation[];
  facts: AccountFact[];                    // atomic memory, newest first
}

// Reconcile needs the provenance chain (supporting_observation_ids) that the
// general getClaims SELECT omits — so it has a dedicated read. CRM hygiene uses
// it to run the loop-prevention gate (crmProvenance) and build the proof payload.
export interface ReconcileClaim {
  property: string;
  value: unknown;
  confidence: number;
  epistemic_class: EpistemicClass;
  freshness: Freshness;
  observation_count: number;
  last_observed_at: string | null;
  supporting_observation_ids: string[];
}

const RECONCILE_CLAIM_COLUMNS =
  'property, value, confidence, epistemic_class, freshness, observation_count, last_observed_at, supporting_observation_ids';

/** Current (valid) claims for specific properties on one entity, including the
 *  supporting_observation_ids provenance chain. */
export async function getClaimsForReconcile(
  supabase: SupabaseClient,
  workspaceId: string,
  entityId: string,
  properties: string[],
): Promise<ReconcileClaim[]> {
  if (!properties.length) return [];
  const { data, error } = await supabase
    .from('claims')
    .select(RECONCILE_CLAIM_COLUMNS)
    .eq('workspace_id', workspaceId)
    .eq('entity_id', entityId)
    .in('property', properties)
    .is('invalid_at', null);
  if (error) throw new Error(`failed to load reconcile claims: ${error.message}`);
  return (data as ReconcileClaim[]) ?? [];
}

// ── derivation ──────────────────────────────────────────────────────────────
// v1 policy: recency picks the value; corroboration and freshness set the
// confidence. Truth-discovery, calibration, and survival-based decay are
// Tier-A algorithms that come later, demand-driven by data volume.

const DECAY_DAYS = 180;          // default fact half-life; per-fact-type later
const DAY = 86_400_000;

export interface DerivedClaim {
  value: unknown;
  distribution: { value: unknown; weight: number }[];
  confidence: number;
  epistemic_class: EpistemicClass;
  freshness: Freshness;
  decays_at: string | null;
  supporting_observation_ids: string[];
  observation_count: number;
  last_observed_at: string | null;
}

function freshnessFor(ageDays: number): Freshness {
  if (ageDays < 30) return 'fresh';
  if (ageDays < 90) return 'aging';
  if (ageDays < DECAY_DAYS) return 'suspect';
  return 'expired';
}

/** Derive the current claim for one (entity, property) from its state observations. */
export function deriveClaim(observations: Observation[]): DerivedClaim | null {
  const states = observations
    .filter(o => o.kind === 'state' && o.value !== null && o.value !== undefined)
    .sort((a, b) => +new Date(b.observed_at) - +new Date(a.observed_at));
  if (states.length === 0) return null;

  const newest = states[0];
  const key = (v: unknown) => JSON.stringify(v);

  const groups = new Map<string, Observation[]>();
  for (const o of states) {
    const k = key(o.value);
    let g = groups.get(k);
    if (!g) { g = []; groups.set(k, g); }
    g.push(o);
  }

  const supporting = groups.get(key(newest.value))!;   // recency wins the value
  const contradicting = states.length - supporting.length;

  const ageDays = (Date.now() - +new Date(newest.observed_at)) / DAY;
  const freshness = freshnessFor(ageDays);

  // confidence: base + corroboration bonus − contradiction penalty − staleness
  let confidence =
    0.55 +
    Math.min(supporting.length - 1, 4) * 0.08 -
    Math.min(contradicting, 3) * 0.1 -
    (freshness === 'suspect' ? 0.1 : freshness === 'expired' ? 0.25 : 0);
  confidence = Math.max(0.2, Math.min(0.95, confidence));

  const inferredOnly = supporting.every(o => o.method === 'inference');

  return {
    value: newest.value,
    distribution: [...groups.entries()].map(([k, obs]) => ({
      value: JSON.parse(k),
      weight: obs.length / states.length,
    })),
    confidence,
    epistemic_class: inferredOnly ? 'inferred' : 'observed',
    freshness,
    decays_at: new Date(+new Date(newest.observed_at) + DECAY_DAYS * DAY).toISOString(),
    supporting_observation_ids: supporting.map(o => o.id),
    observation_count: states.length,
    last_observed_at: newest.observed_at,
  };
}

// ── read / write ────────────────────────────────────────────────────────────

/** Recompute and persist the claim for one (entity, property). The self-healing step. */
export async function recomputeClaim(
  supabase: SupabaseClient,
  workspaceId: string,
  entityId: string,
  property: string,
): Promise<void> {
  // Asserted claims are sticky. A user (or a workflow PATCH) declared this
  // fact as ground truth; derivation from observations must not overwrite it.
  // We also read the current value so we can detect a state transition below.
  const { data: existing } = await supabase
    .from('claims')
    .select('epistemic_class, value')
    .eq('workspace_id', workspaceId)
    .eq('entity_id', entityId)
    .eq('property', property)
    .is('invalid_at', null)
    .maybeSingle();
  if ((existing as { epistemic_class?: string } | null)?.epistemic_class === 'asserted') return;
  const beforeValue = (existing as { value?: unknown } | null)?.value;

  const observations = await getObservations(supabase, workspaceId, entityId, { property });
  const derived = deriveClaim(observations);
  if (!derived) return;

  const { error } = await supabase.from('claims').upsert(
    {
      workspace_id: workspaceId,
      entity_id: entityId,
      property,
      value: derived.value,
      distribution: derived.distribution,
      confidence: derived.confidence,
      epistemic_class: derived.epistemic_class,
      freshness: derived.freshness,
      decays_at: derived.decays_at,
      supporting_observation_ids: derived.supporting_observation_ids,
      observation_count: derived.observation_count,
      last_observed_at: derived.last_observed_at,
      computed_at: new Date().toISOString(),
    },
    { onConflict: 'workspace_id,entity_id,property' },
  );
  if (error) throw new Error(`failed to upsert claim: ${error.message}`);

  // Fire any outbound triggers implied by this value change (e.g. a LinkedIn
  // connection accept the moment channels.linkedin.state becomes 'connected').
  // Side effect of the state change — catches every writer, not just the ones
  // that also log an activity. Best-effort: errors are swallowed inside.
  const newestObs = observations.find(o => o.id === derived.supporting_observation_ids[0]);
  await fireClaimTransitionTriggers(supabase, {
    workspaceId,
    entityId,
    property,
    before: beforeValue,
    after: derived.value,
    source: newestObs?.source ?? 'system',
    occurredAt: derived.last_observed_at ?? new Date().toISOString(),
  });
}

export async function getClaims(
  supabase: SupabaseClient,
  workspaceId: string,
  entityId: string,
): Promise<Claim[]> {
  const { data, error } = await supabase
    .from('claims')
    .select(
      'entity_id, property, value, confidence, epistemic_class, freshness, decays_at, observation_count, last_observed_at',
    )
    .eq('workspace_id', workspaceId)
    .eq('entity_id', entityId);
  if (error) throw new Error(`failed to load claims: ${error.message}`);
  return (data as Claim[]) ?? [];
}

/**
 * The account record — the projection an agent reads. Entity + every current
 * claim (with its epistemics) + the recent observation timeline. There is no
 * `contacts` table; this is assembled on demand.
 */
export async function getAccountRecord(
  supabase: SupabaseClient,
  workspaceId: string,
  entityId: string,
  ctx?: ReadContext,
): Promise<AccountRecord | null> {
  const { data: entity } = await supabase
    .from('entities')
    .select('id, type')
    .eq('id', entityId)
    .eq('workspace_id', workspaceId)
    .maybeSingle();
  if (!entity) return null;

  // ctx scopes the raw layers (timeline observations + document facts) to the
  // viewer; claims (derived intel) stay shared. See PRIVACY_MODEL.md.
  const [claims, recent, notes] = await Promise.all([
    getClaims(supabase, workspaceId, entityId),
    getObservations(supabase, workspaceId, entityId, { limit: 50 }, ctx),
    listNotes(supabase, workspaceId, { entityId, limit: 50 }, ctx),
  ]);

  // Atomic facts = asserted note.* claims minus long-form documents. Surface them
  // as a clean, capped list so an agent gets the account's durable memory inline
  // (no separate facts call). The raw note.<uuid> claims are removed from `claims`
  // to avoid duplicating them as opaque uuid-keyed entries.
  const facts = notes
    .filter(n => !n.metadata?.doc_type && n.content.trim())
    .slice(0, 15)
    .map(n => ({ category: n.category, content: n.content, date: n.created_at }));

  return {
    entity_id: entity.id,
    type: entity.type,
    claims: Object.fromEntries(
      claims.filter(c => !c.property.startsWith('note.')).map(c => [c.property, c]),
    ),
    // collapse one meeting reported by two connectors into a single row
    recent_observations: collapseMeetingDupes(recent),
    facts,
  };
}

const CLAIM_COLUMNS =
  'entity_id, property, value, confidence, epistemic_class, freshness, decays_at, observation_count, last_observed_at';

/** A single claim for one (entity, property), or null. */
export async function getClaim(
  supabase: SupabaseClient,
  workspaceId: string,
  entityId: string,
  property: string,
): Promise<Claim | null> {
  const { data, error } = await supabase
    .from('claims')
    .select(CLAIM_COLUMNS)
    .eq('workspace_id', workspaceId)
    .eq('entity_id', entityId)
    .eq('property', property)
    .maybeSingle();
  if (error) throw new Error(`failed to load claim: ${error.message}`);
  return (data as Claim) ?? null;
}

// ── assertions ──────────────────────────────────────────────────────────────
// A PATCH endpoint writes here. Asserted claims have no observation backing
// and are protected from the derivation engine (see recomputeClaim above).
// They are the deterministic write surface workflow runtimes need; agents
// should still prefer recording observations and letting the substrate derive.

export interface AssertClaimsInput {
  /** property -> value. Pass null to invalidate (soft-delete) the claim. */
  values: Record<string, unknown>;
  /** Where the assertion came from. Defaults to 'user'. */
  source?: string;
}

/**
 * Assert one or more claims on an entity. Each (entity, property) is upserted
 * as an asserted claim with confidence 1.0; passing null invalidates the
 * claim. Returns the property names that were written or invalidated.
 */
export async function assertClaims(
  supabase: SupabaseClient,
  workspaceId: string,
  entityId: string,
  input: AssertClaimsInput,
): Promise<{ written: string[]; invalidated: string[] }> {
  const now = new Date().toISOString();
  const written: string[] = [];
  const invalidated: string[] = [];

  for (const [property, value] of Object.entries(input.values)) {
    if (!property) continue;
    if (value === null) {
      const { error } = await supabase
        .from('claims')
        .update({ invalid_at: now })
        .eq('workspace_id', workspaceId)
        .eq('entity_id', entityId)
        .eq('property', property)
        .is('invalid_at', null);
      if (error) throw new Error(`failed to invalidate claim ${property}: ${error.message}`);
      invalidated.push(property);
      continue;
    }
    const { error } = await supabase.from('claims').upsert(
      {
        workspace_id: workspaceId,
        entity_id: entityId,
        property,
        value,
        distribution: null,
        confidence: 1.0,
        epistemic_class: 'asserted',
        freshness: 'fresh',
        valid_from: now,
        invalid_at: null,
        supporting_observation_ids: [],
        observation_count: 0,
        last_observed_at: null,
        computed_at: now,
      },
      { onConflict: 'workspace_id,entity_id,property' },
    );
    if (error) throw new Error(`failed to assert claim ${property}: ${error.message}`);
    written.push(property);
  }

  return { written, invalidated };
}

/** Re-derive a claim on demand and report before/after — the calibration check. */
export async function verifyClaim(
  supabase: SupabaseClient,
  workspaceId: string,
  entityId: string,
  property: string,
): Promise<{ before: Claim | null; after: Claim | null }> {
  const before = await getClaim(supabase, workspaceId, entityId, property);
  await recomputeClaim(supabase, workspaceId, entityId, property);
  const after = await getClaim(supabase, workspaceId, entityId, property);
  return { before, after };
}
