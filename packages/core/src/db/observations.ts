import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { rawVisible, type ReadContext } from './readContext.js';
import { isPrivateMessageType, canReadMessage, loadMessageViewer, filterDerivedForViewer } from '../privacy/messagePrivacy.mjs';
import type { ProjectableObservation } from '../services/canonicalProjection.js';

// Observations are the immutable, append-only spine — the system of record.
// Every enrichment result, email, reply, bounce, and agent action is one
// observation. They never mutate and never decay. A new observation insert
// auto-enqueues a claim recompute (DB trigger on the observations table).

export type ObservationKind = 'state' | 'event';

export interface ObservationInput {
  workspaceId: string;
  entityId: string;
  kind: ObservationKind;
  property: string;          // 'job_title' | 'interaction.email_sent' | 'email.bounced' | …
  value: unknown;            // stored as jsonb
  source: string;            // 'apollo' | 'gmail' | 'instantly' | 'agent' | 'user' | …
  method: string;            // 'api' | 'webhook' | 'extraction' | 'inference' | 'user_input'
  observedAt?: string;       // ISO; when it was true / happened. Defaults to now.
  sourceConfidence?: number;
  externalId?: string;       // source's own id — dedup key
  raw?: unknown;             // raw payload, kept for provenance
  sourceRef?: string;        // explicit pointer to the raw (vault path / git sha); else derived
  contentHash?: string;      // explicit hash of the raw; else derived from `raw`
}

export interface Observation {
  id: string;
  entity_id: string;
  kind: ObservationKind;
  property: string;
  value: unknown;
  source: string;
  method: string;
  source_confidence: number | null;
  observed_at: string;
  ingested_at: string;
  owner_user_id?: string | null;
}

const COLUMNS =
  'id, entity_id, kind, property, value, source, method, source_confidence, observed_at, ingested_at, owner_user_id, external_id, source_ref';

// Phase 0 provenance. content_hash = sha256 of the raw we stored, so a later fetch can be
// verified untampered. source_ref = a pointer to where the raw lives; when the caller does not
// supply one, derive the canonical `source://<source>/<external_id>` for any observation that
// carries an external id (the same tuple observations_dedup is keyed on, so resolveRaw can find it).
export function hashRaw(raw: unknown): string | null {
  if (raw == null) return null;
  const s = typeof raw === 'string' ? raw : JSON.stringify(raw);
  return createHash('sha256').update(s).digest('hex');
}
export function deriveSourceRef(source: string, externalId?: string | null): string | null {
  return externalId ? `source://${source}/${externalId}` : null;
}

function toRow(input: ObservationInput) {
  return {
    workspace_id: input.workspaceId,
    entity_id: input.entityId,
    kind: input.kind,
    property: input.property,
    value: input.value ?? null,
    source: input.source,
    method: input.method,
    source_confidence: input.sourceConfidence ?? null,
    observed_at: input.observedAt ?? new Date().toISOString(),
    external_id: input.externalId ?? null,
    raw: input.raw ?? null,
    source_ref: input.sourceRef ?? deriveSourceRef(input.source, input.externalId),
    content_hash: input.contentHash ?? hashRaw(input.raw),
  };
}

// Project a just-recorded observation onto its canonical axis (auto-reconcile). Dynamic
// import breaks the observations↔projection cycle; best-effort so a projection hiccup never
// fails ingestion. No-op unless the source_field_map covers this (source, property).
async function fireProjection(
  supabase: SupabaseClient,
  workspaceId: string,
  obs: ProjectableObservation,
): Promise<void> {
  try {
    const { projectObservation } = await import('../services/canonicalProjection.js');
    await projectObservation(supabase, workspaceId, obs);
  } catch { /* projection is best-effort; the claim engine is unaffected */ }
}

/** Append one observation. Returns null if it was a duplicate (external_id). */
export async function recordObservation(
  supabase: SupabaseClient,
  input: ObservationInput,
): Promise<Observation | null> {
  const { data, error } = await supabase
    .from('observations')
    .insert(toRow(input))
    .select(COLUMNS)
    .single();
  if (error) {
    if (error.code === '23505') return null;   // duplicate (workspace, source, external_id)
    throw new Error(`failed to record observation: ${error.message}`);
  }
  const obs = data as Observation;
  await fireProjection(supabase, input.workspaceId, {
    id: obs.id,
    entityId: obs.entity_id,
    kind: obs.kind,
    property: obs.property,
    value: obs.value,
    source: obs.source,
    observedAt: obs.observed_at,
  });
  return obs;
}

/** Append many observations at once. Rows WITH an external_id dedup via the partial
 *  unique index (observations_dedup, WHERE external_id IS NOT NULL); rows WITHOUT one
 *  fall outside that index, so they're plain-inserted (append-only by design — e.g.
 *  enrichment state snapshots that carry no source event id). */
export async function recordObservations(
  supabase: SupabaseClient,
  inputs: ObservationInput[],
): Promise<number> {
  if (inputs.length === 0) return 0;
  const withExt = inputs.filter((i) => i.externalId != null && i.externalId !== '');
  const noExt = inputs.filter((i) => i.externalId == null || i.externalId === '');
  let count = 0;
  if (withExt.length) {
    // observations_dedup is a PARTIAL unique index (WHERE external_id IS NOT NULL). Postgres
    // only matches ON CONFLICT (cols) against a partial index when the clause repeats the
    // predicate, which PostgREST's onConflict cannot express — so the upsert form failed
    // every batch with "no unique or exclusion constraint matching the ON CONFLICT
    // specification" and nothing keyed by external_id was ever recorded this way. Dedup by
    // hand instead: skip what already exists, insert the rest, and fall back to one-by-one
    // (catching 23505) for the rare race between the check and the insert.
    const seen = new Set<string>();
    const rows = withExt.map(toRow).filter((r) => {
      const k = `${r.workspace_id} ${r.source} ${r.external_id}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    const bySource = new Map<string, typeof rows>();
    for (const r of rows) (bySource.get(`${r.workspace_id} ${r.source}`) ?? bySource.set(`${r.workspace_id} ${r.source}`, []).get(`${r.workspace_id} ${r.source}`)!).push(r);
    for (const group of bySource.values()) {
      const { workspace_id, source } = group[0];
      const existing = new Set<string>();
      for (let i = 0; i < group.length; i += 200) {
        const ids = group.slice(i, i + 200).map((r) => r.external_id as string);
        const { data } = await supabase
          .from('observations').select('external_id')
          .eq('workspace_id', workspace_id).eq('source', source).in('external_id', ids);
        for (const d of (data ?? []) as Array<{ external_id: string }>) existing.add(d.external_id);
      }
      const fresh = group.filter((r) => !existing.has(r.external_id as string));
      if (!fresh.length) continue;
      const { data, error } = await supabase.from('observations').insert(fresh).select('id');
      if (!error) { count += data?.length ?? 0; continue; }
      if (error.code !== '23505') throw new Error(`failed to record observations: ${error.message}`);
      for (const r of fresh) {
        const one = await supabase.from('observations').insert(r).select('id').single();
        if (!one.error) count += 1;
        else if (one.error.code !== '23505') throw new Error(`failed to record observations: ${one.error.message}`);
      }
    }
  }
  if (noExt.length) {
    const { data, error } = await supabase
      .from('observations')
      .insert(noExt.map(toRow))
      .select('id');
    if (error) throw new Error(`failed to record observations: ${error.message}`);
    count += data?.length ?? 0;
  }
  // Project each onto its canonical axis (auto-reconcile). Idempotent — projected rows dedup
  // on external_id, so re-projecting an already-seen input is a no-op. Best-effort.
  for (const i of inputs) {
    await fireProjection(supabase, i.workspaceId, {
      entityId: i.entityId, kind: i.kind, property: i.property,
      value: i.value, source: i.source, observedAt: i.observedAt,
    });
  }
  return count;
}

export interface ResolvedRaw {
  /** The observation's own value — carries `summary`/`description` for an interaction. */
  value?: unknown;
  raw: unknown;
  source: string;
  externalId: string | null;
  contentHash: string | null;
  /** True when the stored raw still hashes to its recorded content_hash (untampered). */
  verified: boolean;
  observedAt: string;
}

/**
 * Follow a `source_ref` back to the raw it points at — the read half of the provenance
 * standard. Gated by `rawVisible`: a private (owner-scoped) raw is returned only to its owner
 * or an admin; everyone else gets null, exactly like every other raw read. Prefer claims;
 * this is the escape hatch for "let me see the actual email/transcript."
 *
 * Today raw lives in Nous, so this reads `observations.raw` by its pointer. When raw moves to
 * the edge, this is the one place that branches on the source_ref scheme (vault:// , git://)
 * and fetches + verifies from there — callers never change.
 */
export async function resolveRaw(
  supabase: SupabaseClient,
  workspaceId: string,
  sourceRef: string | null | undefined,
  ctx?: ReadContext,
): Promise<ResolvedRaw | null> {
  if (!sourceRef) return null;
  const { data, error } = await supabase
    .from('observations')
    .select('raw, value, property, source, external_id, content_hash, owner_user_id, observed_at')
    .eq('workspace_id', workspaceId)
    .eq('source_ref', sourceRef)
    .order('observed_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  // A message follows the participant rule (GET-244): the people on it, and the members whose
  // mailbox holds a copy — whatever their role. Anything else keeps the owner rule.
  if (isPrivateMessageType(data.property)) {
    const viewer = ctx?.viewerUserId ? await loadMessageViewer(supabase, workspaceId, ctx.viewerUserId) : null;
    if (!canReadMessage(data, viewer)) return null;
  } else if (!rawVisible(data.owner_user_id as string | null, ctx)) return null;   // owner-private
  return {
    raw: data.raw,
    // The observation's own summary. For a note-taker the raw is only a pointer, so this is
    // often the ONLY thing that names the call — and a citation row reading just "Call" is a
    // source the reader cannot tell apart from the other three.
    value: data.value,
    source: data.source as string,
    externalId: (data.external_id as string | null) ?? null,
    contentHash: (data.content_hash as string | null) ?? null,
    verified: data.content_hash != null && hashRaw(data.raw) === data.content_hash,
    observedAt: data.observed_at as string,
  };
}

// Person/account attribute fields an enrichment provider can assert. These are
// written as state observations tagged with the TRUE provider source
// (apollo / prospeo / linkedin) so the claim engine and the CRM-hygiene
// provenance gate can distinguish enrichment-origin values from CRM-origin ones.
//
// Why this helper exists: writes routed through the v1 `contacts` view inherit
// the *record's* origin source (the view's single `source` column), so an
// Apollo-provided job_title on a HubSpot-pulled contact would be mis-tagged
// `hubspot` and look like the CRM's own data. Enrichment must therefore write
// these fields as observations directly, with its real source, and omit them
// from the `contacts` update so the view trigger doesn't emit a mis-tagged
// duplicate. See docs/crm-hygiene-phase-1b-spec.md, Task 0.
export const ENRICHMENT_ATTRIBUTES = [
  'job_title', 'seniority', 'department', 'company', 'phone', 'city', 'country', 'linkedin_url',
  'domain', 'reachability_status',
  // Descriptive company text captured from Apollo/Prospeo (written onto the
  // company entity), matched by `contains_any` exclusion rules at score time.
  'keywords', 'description',
] as const;

export async function recordEnrichmentObservations(
  supabase: SupabaseClient,
  workspaceId: string,
  entityId: string,
  source: string,
  facts: Record<string, unknown>,
): Promise<number> {
  const inputs: ObservationInput[] = [];
  for (const property of ENRICHMENT_ATTRIBUTES) {
    const value = facts[property];
    if (value == null || value === '') continue;
    inputs.push({ workspaceId, entityId, kind: 'state', property, value, source, method: 'enrichment' });
  }
  return recordObservations(supabase, inputs);
}

/**
 * Record a standalone email-verification result as a `reachability_status`
 * state observation, tagged with the verifier as the source (millionverifier /
 * neverbounce) and `method: 'verification'`. This is a DIFFERENT method from
 * enrichment: enrichment guesses a status while finding the email; verification
 * independently validates an email we already hold. The newer observation wins
 * in the claim engine, so a verify run upgrades the `email_status` shown on a
 * lead. The `method` also lets the lead-list verify reuse-gate ("don't re-pay
 * to re-verify within 90 days") query verification runs specifically.
 */
export async function recordVerificationObservation(
  supabase: SupabaseClient,
  workspaceId: string,
  entityId: string,
  source: string,
  status: string,
): Promise<number> {
  if (!status) return 0;
  return recordObservations(supabase, [
    { workspaceId, entityId, kind: 'state', property: 'reachability_status', value: status, source, method: 'verification' },
  ]);
}

/** Load observations by id (workspace-scoped) — used to resolve a claim's
 *  supporting_observation_ids to their sources/values for the CRM-hygiene
 *  provenance gate and proof payload. */
export async function getObservationsByIds(
  supabase: SupabaseClient,
  workspaceId: string,
  ids: string[],
): Promise<Observation[]> {
  if (!ids.length) return [];
  const { data, error } = await supabase
    .from('observations')
    .select(COLUMNS)
    .eq('workspace_id', workspaceId)
    .in('id', ids);
  if (error) throw new Error(`failed to load observations by id: ${error.message}`);
  return (data as Observation[]) ?? [];
}

/** Observations for an entity, newest first — the account timeline.
 *  With a member-scoped ReadContext, raw rows owned by another rep are excluded
 *  at the DB level (never fetched). Admin/legacy/system ctx sees all. Passing no
 *  ctx also sees all — an unmigrated caller, safe because it has no member to leak
 *  to (see PRIVACY_MODEL.md / rawVisible). */
export async function getObservations(
  supabase: SupabaseClient,
  workspaceId: string,
  entityId: string,
  opts: { property?: string; kind?: ObservationKind; limit?: number; asOf?: string } = {},
  ctx?: ReadContext,
): Promise<Observation[]> {
  // Any NAMED viewer — member or admin — reads through the DB-enforced backstop,
  // visible_observations_v2 (GET-244). Message content (email / LinkedIn) comes back only to its
  // participants and the members whose account holds a copy; everyone else, founders included,
  // gets the row with a label and `redacted: true`. Rows that are not messages keep the old rule
  // (admin sees all; a member sees shared rows and their own). The app reads via service_role
  // (RLS is bypassed), so this in-function predicate — not RLS — is the guarantee. The same rule
  // lives in privacy/messagePrivacy.mjs for readers that cannot go through the function.
  if (ctx && ctx.viewerUserId) {
    const viewer = await loadMessageViewer(supabase, workspaceId, ctx.viewerUserId);
    const { data, error } = await supabase.rpc('visible_observations_v2', {
      p_workspace_id: workspaceId,
      p_entity_id: entityId,
      p_viewer_user_id: ctx.viewerUserId,
      p_viewer_emails: [...(viewer?.emails ?? [])],
      p_viewer_is_admin: ctx.viewerScope === 'admin',
      p_property: opts.property ?? null,
      p_kind: opts.kind ?? null,
      p_as_of: opts.asOf ?? null,
      p_limit: opts.limit ?? 200,
    });
    if (error) throw new Error(`failed to load observations (guarded): ${error.message}`);
    // An action item read out of an email the viewer isn't on is dropped, like its claim (GET-253).
    return (await filterDerivedForViewer(supabase, workspaceId, (data as Observation[]) ?? [], viewer)) as Observation[];
  }

  // A member context with no named viewer keeps the original owner-strict function.
  if (ctx && ctx.viewerScope === 'member') {
    const { data, error } = await supabase.rpc('visible_observations', {
      p_workspace_id: workspaceId,
      p_entity_id: entityId,
      p_viewer_user_id: ctx.viewerUserId,
      p_viewer_is_admin: false,
      p_property: opts.property ?? null,
      p_kind: opts.kind ?? null,
      p_as_of: opts.asOf ?? null,
      p_limit: opts.limit ?? 200,
    });
    if (error) throw new Error(`failed to load observations (guarded): ${error.message}`);
    return (data as Observation[]) ?? [];
  }

  // System / unmigrated (no named viewer): read the table directly — sees all, unchanged.
  let q = supabase
    .from('observations')
    .select(COLUMNS)
    .eq('workspace_id', workspaceId)
    .eq('entity_id', entityId)
    .order('observed_at', { ascending: false })
    .limit(opts.limit ?? 200);
  if (opts.property) q = q.eq('property', opts.property);
  if (opts.kind) q = q.eq('kind', opts.kind);
  // Point-in-time: only what we had OBSERVED by `asOf` (ISO). Because observations are
  // append-only, filtering here + re-deriving reconstructs the belief as it stood then.
  if (opts.asOf) q = q.lte('observed_at', opts.asOf);
  const { data, error } = await q;
  if (error) throw new Error(`failed to load observations: ${error.message}`);
  return (data as Observation[]) ?? [];
}
