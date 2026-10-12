import type { SupabaseClient } from '@supabase/supabase-js';
import type { Observation } from './observations.js';
import { getObservations } from './observations.js';
import { collapseMeetingDupes } from './activities.js';
import { fireClaimTransitionTriggers } from './triggers.js';
import { listDealScopeNotes, listRecentlyReplaced } from './notes.js';
import { shapeContextFacts, type TechStackGroup, type Replacement } from './claimTime.js';
import { documentPreviews } from './documents.js';
import type { ReadContext } from './readContext.js';
import { derivedViewerForContext, filterDerivedForViewer, isDerivedProperty } from '../privacy/messagePrivacy.mjs';
// The buying committee is a PRODUCT projection (context-graph decouple #4) — a sales concept,
// not substrate. The substrate exposes a provider seam; the product registers loadBuyingCommittee
// at boot (api + worker). getAccountRecord returns an empty committee if none is registered.
export type CommitteeProvider = (
  supabase: SupabaseClient,
  workspaceId: string,
  entityId: string,
) => Promise<{ stakeholders: unknown[]; committee: unknown | null }>;
let committeeProvider: CommitteeProvider | null = null;
export function registerCommitteeProvider(fn: CommitteeProvider): void { committeeProvider = fn; }
import { isAuthorityAxis, isConflictAxis, loadAuthority } from './canonicalAxes.js';
import { detectFieldConflict, isFieldConflict } from './conflicts.js';

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
  /** When it was SAID (the source's date), not when it was written (GET-770). */
  date: string;
  /** How current it is now, from its category's clock and when it was said (claimTime.ts). */
  freshness?: Freshness;
  /** The call or message this was extracted from, so the fact can be checked against it.
   *  Followed from the note's `source_activity_id` when it carries no ref of its own. */
  source_ref?: string;
  /** A blocker's status (open | resolved), and a tech_stack fact's tool (GET-798). */
  status?: string;
  tool?: string;
}

/** A compact preview of a long-form document kept on an account (meeting brief,
 *  transcript, notes) — never its full body. Surfaced inline so an agent KNOWS a
 *  brief exists and can pull it with search_notes, instead of concluding there
 *  are no notes on file. */
export interface DocumentPreview {
  type: string;
  title: string | null;
  date: string | null;
  snippet: string;
  /** Pass to read_document to open it. */
  document_id?: string;
  /** Present on documents the agent wrote (nous://doc/…), so one can be cited. */
  source_ref?: string;
  mentioned_in?: boolean;
}

export interface AccountRecord {
  entity_id: string;
  name?: string | null;
  type: string;
  claims: Record<string, Claim>;          // property -> claim
  recent_observations: Observation[];
  facts: AccountFact[];                    // atomic memory, current-first (GET-770)
  /** Where the deal stands now (GET-770, GET-798): the newest live fact per deal topic plus every
   *  open blocker and live requirement, read across the account. */
  current_position?: AccountFact[];
  /** The stack, one entry per tool (GET-798). */
  tech_stack?: TechStackGroup<AccountFact>[];
  /** Claims replaced by a newer one in the last 60 days, newest first (GET-798). */
  recently_replaced?: Replacement[];
  /** How many facts there are besides current_position and tech_stack; `facts` is capped. */
  facts_total?: number;
  documents: DocumentPreview[];            // saved briefs/notes/transcripts (preview only), newest first
  stakeholders: unknown[];                 // buying committee — filled by the product provider, else []
  committee: unknown | null;               // committee structure + health — product provider, else null
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

// ── authority-aware derivation (canonical enum axes) ─────────────────────────
// For enum axes like `lifecycle`, recency-wins is wrong: a stale "churned" must not beat a
// live "paid". Instead each source's assertion is scored by
//   effective = source_authority × freshness × event_validity
// and the highest-effective value wins. event_validity rides in on the observation's
// source_confidence (set by canonical projection; 1.0 for a plain state field). This is
// what powers "Salesforce says churned, Stripe says paid → resolved to customer".

const FRESHNESS_FACTOR: Record<Freshness, number> = { fresh: 1.0, aging: 0.8, suspect: 0.5, expired: 0.2 };

export interface AuthorityInfo { authority: number; eventGroundTruth: boolean }

export interface AuthorityCandidate {
  value: unknown;
  source: string;
  observed_at: string | null;
  effective: number;
  observation_id?: string | null;
}

export interface AuthoritativeClaim extends DerivedClaim {
  /** One entry per distinct value (its strongest supporting observation), ranked best-first.
   *  Feeds conflict detection. */
  candidates: AuthorityCandidate[];
}

/** Derive a canonical enum claim by source authority instead of recency. */
export function deriveAuthoritativeClaim(
  observations: Observation[],
  authorityBySource: Record<string, AuthorityInfo>,
  opts?: { defaultAuthority?: number },
): AuthoritativeClaim | null {
  const defaultAuthority = opts?.defaultAuthority ?? 0.4;
  const states = observations.filter(o => o.kind === 'state' && o.value !== null && o.value !== undefined);
  if (states.length === 0) return null;

  const scored = states.map(o => {
    const ageDays = (Date.now() - +new Date(o.observed_at)) / DAY;
    const freshness = freshnessFor(ageDays);
    const authority = authorityBySource[o.source]?.authority ?? defaultAuthority;
    const eventValidity = typeof o.source_confidence === 'number' ? o.source_confidence : 1.0;
    const effective = Math.max(0, authority * FRESHNESS_FACTOR[freshness] * eventValidity);
    return { o, ageDays, freshness, effective };
  });

  // Best (highest-effective) observation per distinct value.
  const key = (v: unknown) => JSON.stringify(v);
  const bestByValue = new Map<string, (typeof scored)[number]>();
  for (const s of scored) {
    const k = key(s.o.value);
    const cur = bestByValue.get(k);
    if (!cur || s.effective > cur.effective) bestByValue.set(k, s);
  }

  const ranked = [...bestByValue.values()].sort((a, b) => b.effective - a.effective);
  const winner = ranked[0];
  const supporting = states.filter(o => key(o.value) === key(winner.o.value));
  const totalEff = ranked.reduce((sum, r) => sum + r.effective, 0) || 1;

  const confidence = Math.max(0.2, Math.min(0.99, winner.effective));
  const inferredOnly = supporting.every(o => o.method === 'inference');

  return {
    value: winner.o.value,
    distribution: ranked.map(r => ({ value: r.o.value, weight: r.effective / totalEff })),
    confidence,
    epistemic_class: inferredOnly ? 'inferred' : 'observed',
    freshness: winner.freshness,
    decays_at: new Date(+new Date(winner.o.observed_at) + DECAY_DAYS * DAY).toISOString(),
    supporting_observation_ids: supporting.map(o => o.id),
    observation_count: states.length,
    last_observed_at: winner.o.observed_at,
    candidates: ranked.map(r => ({
      value: r.o.value,
      source: r.o.source,
      observed_at: r.o.observed_at,
      effective: r.effective,
      observation_id: r.o.id,
    })),
  };
}

// ── point-in-time reconstruction (Phase 4.2) ─────────────────────────────────
// "What did we believe on date X." The claims table only holds the CURRENT belief, but the
// observation log is append-only, so a past belief is re-derivable: derive from the
// observations that existed at that instant. Nothing extra is stored.

/**
 * Pure: derive every property's claim from a flat observation list, the same way the live
 * engine does per property — authority axes by source authority, the rest by recency.
 * `authorityByProperty` supplies the source-authority map for each authority axis present.
 * Feed it observations already filtered to `observed_at <= asOf` to get a point-in-time view.
 */
export function deriveClaimsFromObservations(
  observations: Observation[],
  authorityByProperty: Record<string, Record<string, AuthorityInfo>> = {},
): { property: string; derived: DerivedClaim }[] {
  const byProp = new Map<string, Observation[]>();
  for (const o of observations) {
    if (!o.property) continue;
    const g = byProp.get(o.property) ?? [];
    g.push(o);
    byProp.set(o.property, g);
  }
  const out: { property: string; derived: DerivedClaim }[] = [];
  for (const [property, obs] of byProp) {
    const derived = isAuthorityAxis(property)
      ? deriveAuthoritativeClaim(obs, authorityByProperty[property] ?? {})
      : deriveClaim(obs);
    if (derived) out.push({ property, derived });
  }
  return out;
}

/**
 * Reconstruct an entity's derived claims as they stood at `asOf` (ISO). Re-derives from the
 * immutable observation history up to that instant — point-in-time is free because
 * observations are append-only. `ctx` scopes the raw layer to the viewer (a member only
 * reconstructs from rows they could see). Read-only; never writes the claims table.
 */
export async function reconstructClaimsAsOf(
  supabase: SupabaseClient,
  workspaceId: string,
  entityId: string,
  asOf: string,
  ctx?: ReadContext,
): Promise<{ property: string; derived: DerivedClaim }[]> {
  const observations = await getObservations(supabase, workspaceId, entityId, { asOf, limit: 5000 }, ctx);
  // Load authority maps only for the authority-axis properties actually present.
  const authAxes = [...new Set(observations.map(o => o.property).filter((p): p is string => !!p && isAuthorityAxis(p)))];
  const authorityByProperty: Record<string, Record<string, AuthorityInfo>> = {};
  for (const p of authAxes) authorityByProperty[p] = await loadAuthority(supabase, workspaceId, p);
  return deriveClaimsFromObservations(observations, authorityByProperty);
}

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

  // Canonical enum axes (e.g. `lifecycle`) resolve by source authority, not recency, and
  // feed the cross-source conflict surface. Everything else uses the recency engine.
  let derived: DerivedClaim | null;
  let candidates: AuthorityCandidate[] | null = null;
  if (isAuthorityAxis(property)) {
    const authority = await loadAuthority(supabase, workspaceId, property);
    const auth = deriveAuthoritativeClaim(observations, authority);
    derived = auth;
    // Only conflict-surfacing axes raise a reviewable row; free-text axes (job_title)
    // reconcile by authority silently. See CONFLICT_AXES.
    candidates = auth && isConflictAxis(property) ? auth.candidates : null;
  } else {
    derived = deriveClaim(observations);
  }
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

  // For canonical enum axes, reconcile the "see every conflict, resolved" surface:
  // ≥2 sources disagreeing raises/refreshes a field_conflicts row (auto_resolved when the
  // authority margin is decisive, pending otherwise). Best-effort — never fails a recompute.
  if (candidates) {
    await detectFieldConflict(supabase, workspaceId, {
      entityId,
      canonicalProperty: property,
      candidates,
    }).catch(() => {});
  }
}

// ── batch recompute (GET-299) ────────────────────────────────────────────────
// recomputeClaim is three or four round trips per (entity, property). That is right for the engine's
// steady trickle and wrong for an import: One customer's HubSpot pull produced tens of thousands of deal
// fields and more people fields, and at a few dozen claims a second the app could not report on a
// single deal for most of a day. The import said "complete" the whole time.
//
// The batch does the same work in three calls however many targets it holds: read the current
// claims, read the observations, upsert. It does NOT get its own derivation — every value goes
// through deriveClaim / deriveAuthoritativeClaim, exactly as recomputeClaim does, because two
// implementations of "what is true about this deal" is the most expensive bug this codebase has.

/** Newest-N observations a derivation reads per target, matching getObservations' default. */
const OBSERVATIONS_PER_TARGET = 200;

export interface ClaimTarget { entityId: string; property: string }

export interface PlannedClaim {
  target: ClaimTarget;
  derived: DerivedClaim;
  before: unknown;
  /** Present only for conflict axes, the same condition recomputeClaim uses. */
  candidates: AuthorityCandidate[] | null;
}

/**
 * Pure: decide what recomputeClaim would write for each target, given what is already stored.
 * `existing` is keyed `${entityId}|${property}`; `observations` holds each target's rows, any order.
 * Asserted claims are skipped (sticky ground truth); a target with nothing derivable is skipped.
 */
export function planClaimRecomputes(
  targets: ClaimTarget[],
  existing: Map<string, { epistemic_class?: string; value?: unknown }>,
  observations: Map<string, Observation[]>,
  authorityByProperty: Record<string, Record<string, AuthorityInfo>>,
): PlannedClaim[] {
  const out: PlannedClaim[] = [];
  for (const target of targets) {
    const key = `${target.entityId}|${target.property}`;
    const current = existing.get(key);
    if (current?.epistemic_class === 'asserted') continue;
    const obs = [...(observations.get(key) ?? [])]
      .sort((a, b) => +new Date(b.observed_at) - +new Date(a.observed_at))
      .slice(0, OBSERVATIONS_PER_TARGET);
    let derived: DerivedClaim | null;
    let candidates: AuthorityCandidate[] | null = null;
    if (isAuthorityAxis(target.property)) {
      const auth = deriveAuthoritativeClaim(obs, authorityByProperty[target.property] ?? {});
      derived = auth;
      candidates = auth && isConflictAxis(target.property) ? auth.candidates : null;
    } else {
      derived = deriveClaim(obs);
    }
    if (!derived) continue;
    out.push({ target, derived, before: current?.value, candidates });
  }
  return out;
}

/**
 * Recompute and persist many claims in one workspace with a fixed number of round trips.
 * Same guarantees as recomputeClaim: asserted claims untouched, transition triggers fired, conflict
 * surface refreshed. Keep `targets` to a few hundred per call so every statement stays inside the
 * API's statement budget. Returns how many claims were written.
 */
export async function recomputeClaims(
  supabase: SupabaseClient,
  workspaceId: string,
  targets: ClaimTarget[],
): Promise<{ written: number }> {
  if (!targets.length) return { written: 0 };
  const entityIds = [...new Set(targets.map(t => t.entityId))];
  const properties = [...new Set(targets.map(t => t.property))];
  const wanted = new Set(targets.map(t => `${t.entityId}|${t.property}`));

  const existing = new Map<string, { epistemic_class?: string; value?: unknown }>();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from('claims')
      .select('entity_id, property, epistemic_class, value')
      .eq('workspace_id', workspaceId).in('entity_id', entityIds).in('property', properties)
      .is('invalid_at', null).order('id').range(from, from + 999);
    if (error) throw new Error(`failed to load claims: ${error.message}`);
    for (const r of (data ?? []) as { entity_id: string; property: string; epistemic_class: string; value: unknown }[]) {
      existing.set(`${r.entity_id}|${r.property}`, r);
    }
    if (!data || data.length < 1000) break;
  }

  // The cross product of ids and properties can include pairs nobody asked for; they are dropped
  // here rather than derived and written.
  const observations = new Map<string, Observation[]>();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from('observations')
      .select('id, entity_id, kind, property, value, source, method, source_confidence, observed_at, ingested_at, owner_user_id, external_id, source_ref')
      .eq('workspace_id', workspaceId).in('entity_id', entityIds).in('property', properties)
      .order('id').range(from, from + 999);
    if (error) throw new Error(`failed to load observations: ${error.message}`);
    for (const o of (data ?? []) as Observation[]) {
      const key = `${o.entity_id}|${o.property}`;
      if (!wanted.has(key)) continue;
      const g = observations.get(key) ?? [];
      g.push(o);
      observations.set(key, g);
    }
    if (!data || data.length < 1000) break;
  }

  const authorityByProperty: Record<string, Record<string, AuthorityInfo>> = {};
  for (const p of properties.filter(isAuthorityAxis)) authorityByProperty[p] = await loadAuthority(supabase, workspaceId, p);

  const planned = planClaimRecomputes(targets, existing, observations, authorityByProperty);
  if (!planned.length) return { written: 0 };

  const computedAt = new Date().toISOString();
  const { error } = await supabase.from('claims').upsert(
    planned.map(({ target, derived }) => ({
      workspace_id: workspaceId,
      entity_id: target.entityId,
      property: target.property,
      value: derived.value,
      distribution: derived.distribution,
      confidence: derived.confidence,
      epistemic_class: derived.epistemic_class,
      freshness: derived.freshness,
      decays_at: derived.decays_at,
      supporting_observation_ids: derived.supporting_observation_ids,
      observation_count: derived.observation_count,
      last_observed_at: derived.last_observed_at,
      computed_at: computedAt,
    })),
    { onConflict: 'workspace_id,entity_id,property' },
  );
  if (error) throw new Error(`failed to upsert claims: ${error.message}`);

  // Which of these targets already has an open conflict row. detectFieldConflict on a target with
  // no disagreement exists only to CLOSE such a row, and it pays an UPDATE round trip to find out
  // there is none. Measured on a customer workspace: `company` is a conflict axis on every one of tens of thousands of people,
  // the workspace had a handful of open conflicts, and those no-op updates were most of the settle's time.
  const conflictTargets = planned.filter(p => p.candidates);
  const openConflicts = new Set<string>();
  if (conflictTargets.length) {
    const { data: open, error: openErr } = await supabase.from('field_conflicts')
      .select('entity_id, canonical_property')
      .eq('workspace_id', workspaceId)
      .in('entity_id', [...new Set(conflictTargets.map(p => p.target.entityId))])
      .in('canonical_property', [...new Set(conflictTargets.map(p => p.target.property))])
      .eq('status', 'open');
    // If the lookup fails, fall back to checking every target — slower, never less correct.
    if (openErr) for (const p of conflictTargets) openConflicts.add(`${p.target.entityId}|${p.target.property}`);
    for (const r of (open ?? []) as { entity_id: string; canonical_property: string }[]) {
      openConflicts.add(`${r.entity_id}|${r.canonical_property}`);
    }
  }

  // Side effects only where they can do something: a value that actually moved (the trigger
  // recomputeClaim fires), a real disagreement, or an open conflict to close.
  const effects = planned.filter(p =>
    JSON.stringify(p.before) !== JSON.stringify(p.derived.value)
    || (p.candidates && (isFieldConflict(p.candidates) || openConflicts.has(`${p.target.entityId}|${p.target.property}`))));
  const EFFECT_CONCURRENCY = 8;
  for (let i = 0; i < effects.length; i += EFFECT_CONCURRENCY) {
    await Promise.all(effects.slice(i, i + EFFECT_CONCURRENCY).map(async (p) => {
      if (JSON.stringify(p.before) !== JSON.stringify(p.derived.value)) {
        const newest = (observations.get(`${p.target.entityId}|${p.target.property}`) ?? [])
          .find(o => o.id === p.derived.supporting_observation_ids[0]);
        await fireClaimTransitionTriggers(supabase, {
          workspaceId,
          entityId: p.target.entityId,
          property: p.target.property,
          before: p.before,
          after: p.derived.value,
          source: newest?.source ?? 'system',
          occurredAt: p.derived.last_observed_at ?? computedAt,
        });
      }
      if (p.candidates && (isFieldConflict(p.candidates) || openConflicts.has(`${p.target.entityId}|${p.target.property}`))) {
        await detectFieldConflict(supabase, workspaceId, {
          entityId: p.target.entityId,
          canonicalProperty: p.target.property,
          candidates: p.candidates,
        }).catch(() => {});
      }
    }));
  }
  return { written: planned.length };
}

export async function getClaims(
  supabase: SupabaseClient,
  workspaceId: string,
  entityId: string,
  ctx?: ReadContext,
): Promise<Claim[]> {
  const { data, error } = await supabase
    .from('claims')
    .select(
      'entity_id, property, value, confidence, epistemic_class, freshness, decays_at, observation_count, last_observed_at, supporting_observation_ids',
    )
    .eq('workspace_id', workspaceId)
    .eq('entity_id', entityId)
    // Exclude retracted/soft-deleted claims — otherwise a fact the user
    // invalidated still surfaces in getAccountRecord and assembleContext. Every
    // other reader (getClaimsForReconcile, attention, overlay…) filters this.
    .is('invalid_at', null);
  if (error) throw new Error(`failed to load claims: ${error.message}`);
  let rows = (data ?? []) as (Claim & { supporting_observation_ids?: string[] | null })[];
  // A fact, action item or reply disposition from a message the viewer can't read is not theirs
  // to see (GET-253). The pointer column is read for that and not returned.
  const viewer = await derivedViewerForContext(supabase, ctx);
  if (viewer) rows = await filterDerivedForViewer(supabase, workspaceId, rows, viewer, { isDerived: (r: { property: string }) => isDerivedProperty(r.property) });
  return rows.map(({ supporting_observation_ids: _ids, ...c }) => c as Claim);
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

  // ctx scopes the raw layers (timeline observations + documents) to the viewer, and drops what
  // was derived from a message they can't read (GET-253). See PRIVACY_MODEL.md.
  const [claims, recent, scope, committeeResult] = await Promise.all([
    getClaims(supabase, workspaceId, entityId, ctx),
    getObservations(supabase, workspaceId, entityId, { limit: 50 }, ctx),
    // 100, not 50: the cap below now keeps the CURRENT facts, so it needs the wider pool to choose
    // from — the newest 50 written can all be one re-extraction of an old call (GET-770).
    // The deal scope (GET-798): a person's own notes plus their company's deal and stack facts; a
    // company's own plus its people's deal facts. Documents stay the entity's own.
    listDealScopeNotes(supabase, workspaceId, entity, { limit: 100 }, ctx),
    // The buying committee — same structure get_context builds, so the full account
    // record carries who else is at the account and how they relate. Person entities
    // only; a company entity resolves to no committee (returns empty).
    entity.type === 'person' && committeeProvider
      ? committeeProvider(supabase, workspaceId, entityId)
      : Promise.resolve({ stakeholders: [] as unknown[], committee: null as unknown }),
  ]);

  // Atomic facts = asserted note.* claims minus long-form documents. Surface them
  // as a clean, capped list so an agent gets the account's durable memory inline
  // (no separate facts call). The raw note.<uuid> claims are removed from `claims`
  // to avoid duplicating them as opaque uuid-keyed entries.
  // Current-first (GET-770): fresh before stale, newest-said first within a tier.
  const notes = scope.own;
  const factPool = [...notes, ...scope.related]
    .filter(n => !n.metadata?.doc_type && n.content.trim())
    .map(n => ({
      n, category: n.category, date: n.created_at, content: n.content,
      status: (n.metadata?.status as string | undefined) ?? null,
      tool: (n.metadata?.tool as string | undefined) ?? null,
    }));
  // The current position comes from the whole pool, not the top 15: a year-fresh firmographic
  // outranks a 20-day-old (aging) buying signal in the ordering, and must not push it out of here.
  // GET-798: deal topics only (every open blocker and live requirement), the stack grouped by
  // tool, and the facts list without what those two already show.
  const shaped = shapeContextFacts(factPool, { cap: 15 });
  const currentNoteList = shaped.current_position.map(x => x.n);
  const factNotes = shaped.facts.map(x => x.n);
  const techNotes = shaped.tech_stack.flatMap(g => g.facts.map(x => x.n));
  const describedNotes = [...new Map([...factNotes, ...currentNoteList, ...techNotes].map(n => [n.id, n])).values()];

  // ── Give every fact the pointer back to the call it came out of ──
  //
  // A fact is the most-cited thing in the product and had NO way back to its source. It
  // carries `source_activity_id` — the observation it was extracted from — and that
  // observation carries the source_ref, so the chain existed and nobody walked it. Verified
  // on production: most sampled facts resolve to an observation with a ref, and most of
  // those to a call.
  //
  // One batched lookup, not one per fact: the account record is on the hot path of almost
  // every answer, and fifteen round trips there is the difference between a record that
  // loads and one that arrives.
  const activityIds = [...new Set(
    describedNotes.map(n => (n.metadata as { source_activity_id?: string } | null)?.source_activity_id).filter(Boolean),
  )] as string[];
  const refByActivity = new Map<string, string>();
  if (activityIds.length) {
    const { data: acts } = await supabase
      .from('observations')
      .select('id, source_ref')
      .eq('workspace_id', workspaceId)
      .in('id', activityIds);
    for (const a of acts ?? []) if (a.source_ref) refByActivity.set(a.id as string, a.source_ref as string);
  }

  const described = describedNotes.map(n => {
    const m = (n.metadata ?? {}) as {
      quote?: string; speaker?: string; extraction_source?: string; source_activity_id?: string; source_ref?: string;
    };
    // The note's own ref wins when it has one; otherwise follow the activity. Both are the
    // same pointer shape, so the citation panel does not care which road it came by.
    const ref = m.source_ref ?? (m.source_activity_id ? refByActivity.get(m.source_activity_id) : undefined);
    return {
      id: n.id,
      category: n.category, content: n.content, date: n.created_at, freshness: n.freshness,
      ...(m.quote ? { quote: m.quote } : {}),
      ...(m.speaker ? { speaker: m.speaker } : {}),
      ...(m.extraction_source ? { source: m.extraction_source } : {}),
      ...(ref ? { source_ref: ref } : {}),
      ...(n.category === 'blocker' && n.metadata?.status ? { status: String(n.metadata.status) } : {}),
      ...(n.category === 'tech_stack' && n.metadata?.tool ? { tool: String(n.metadata.tool) } : {}),
    };
  });
  const byId = new Map(described.map(f => [f.id, f]));
  const strip = ({ id: _id, ...f }: typeof described[number]) => f;
  // In the shaped order: current-first for facts, newest first for the position.
  const facts = factNotes.map(n => byId.get(n.id)!);
  const current_position = currentNoteList.map(n => strip(byId.get(n.id)!));
  const tech_stack = shaped.tech_stack.map(g => ({
    tool: g.tool, summary: g.summary, facts: g.facts.map(x => strip(byId.get(x.n.id)!)),
  }));
  const recently_replaced = await listRecentlyReplaced(supabase, workspaceId, {
    entityId, relatedIds: scope.relatedIds, relatedCategories: scope.relatedCategories,
  }, ctx).catch(() => [] as Replacement[]);

  // Long-form documents = notes WITH a doc_type (meeting_brief, transcript, …).
  // These were previously loaded and then dropped — filtered out of `facts` and
  // never surfaced anywhere — so a saved brief was invisible on the record. Emit
  // them as compact previews (the body is pulled on demand via search_notes).
  //
  // Plus the documents the agent wrote (GET-197) — briefs, plans, reports naming this account —
  // which live in `documents` now, not in notes.
  const written: DocumentPreview[] = await documentPreviews(supabase, workspaceId, entityId).catch(() => []);
  const documents: DocumentPreview[] = [
    ...written,
    ...notes
      .filter(n => n.metadata?.doc_type && n.content.trim())
      .map(n => {
        const text = n.content.replace(/\s+/g, ' ').trim();
        const date = (n.metadata?.date as string) ?? n.created_at ?? null;
        return {
          type: String(n.metadata!.doc_type),
          title: (n.metadata?.title as string) ?? null,
          date,
          snippet: text.length > 200 ? text.slice(0, 200) + '…' : text,
          document_id: n.id,
        };
      }),
  ]
    .sort((a, b) => +new Date(b.date ?? 0) - +new Date(a.date ?? 0))
    .slice(0, 10);

  return {
    entity_id: entity.id,
    // The account's own name. Carried so a citation OF the record can name it — the record
    // is a source in its own right (stage, deal value, owner are not "from" a call), and a
    // source row that cannot say which account it is is not a citation.
    name: (claims.find(c => c.property === 'name')?.value as string | undefined)
      ?? (entity as { name?: string }).name
      ?? null,
    type: entity.type,
    claims: Object.fromEntries(
      claims.filter(c => !c.property.startsWith('note.')).map(c => [c.property, c]),
    ),
    // collapse one meeting reported by two connectors into a single row
    recent_observations: collapseMeetingDupes(recent),
    facts: facts.map(strip),
    current_position,
    tech_stack,
    recently_replaced,
    // How many other facts there are, vs the capped `facts` (GET-371).
    facts_total: shaped.total,
    documents,
    stakeholders: committeeResult.stakeholders,
    committee: committeeResult.committee,
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
    .is('invalid_at', null) // never return a retracted/soft-deleted claim as live
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
    // Never store an email address as a person's name. Some imports fall back to
    // the email when the name column is blank; that address then shows where a
    // name belongs AND blocks name-based dedup (a "evan.marsh@brightwell.example" first name
    // can't match the real "Evan Marsh"). Skip it — enrichment fills the real name.
    if ((property === 'first_name' || property === 'last_name')
      && typeof value === 'string' && value.includes('@')) continue;
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
