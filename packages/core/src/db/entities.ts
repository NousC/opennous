import type { SupabaseClient } from '@supabase/supabase-js';
import { normaliseLinkedInUrl, isUUID, isMemberUrnLinkedInUrl } from '../utils/identity.js';

// LinkedIn URL variants we'll accept as equivalent on lookup. Covers the
// historical inconsistency where the write path stored URLs raw (with/without
// trailing slash, with/without www, mixed case) but the read path now
// normalises. New writes go through normaliseLinkedInUrl so this is only
// load-bearing for pre-existing data; once a backfill runs it can shrink.
function linkedInVariants(url: string): string[] {
  const out = new Set<string>();
  const trimmed = url.trim();
  if (!trimmed) return [];
  const canonical = normaliseLinkedInUrl(trimmed);
  if (canonical) {
    const noWww = canonical.replace('https://www.', 'https://');
    for (const base of [canonical, noWww]) {
      out.add(base);
      out.add(base + '/');
    }
  }
  out.add(trimmed);
  out.add(trimmed.toLowerCase());
  return Array.from(out);
}

// Entities are canonical, temporal anchors. They hold almost no data —
// everything is observations and claims attached to them. The same
// person-entity survives a job change or a new email.

export type EntityType = 'person' | 'company' | 'deal' | 'workspace';

export interface Entity {
  id: string;
  workspace_id: string;
  type: EntityType;
  status: 'active' | 'merged';
}

export interface Identifier {
  kind: string;   // 'email' | 'domain' | 'linkedin_member_id' | 'hubspot' | …
  value: string;
}

/** Normalise an identifier value so writes + lookups land on the same string. */
export function normaliseIdentifier(kind: string, value: string): string {
  const v = value.trim();
  if (kind === 'email' || kind === 'domain') return v.toLowerCase();
  if (kind === 'linkedin_url') return normaliseLinkedInUrl(v) ?? v;
  return v;
}

/** Build the v2 Identifier[] list from a v1-style contact data blob. */
export function identifiersFromContactData(data: {
  email?: string | null;
  linkedin_url?: string | null;
  linkedin_member_id?: string | null;
  hubspot_id?: string | null;
  pipedrive_id?: string | null;
  apollo_id?: string | null;
  rb2b_id?: string | null;
  attio_id?: string | null;
}): Identifier[] {
  const out: Identifier[] = [];
  if (data.email)              out.push({ kind: 'email',              value: data.email });
  // Member-URN URLs (/in/ACoAA…) are not real public handles — keep them out of
  // the identifier set so they never resolve or surface as a scrapeable URL.
  if (data.linkedin_url && !isMemberUrnLinkedInUrl(data.linkedin_url))
                               out.push({ kind: 'linkedin_url',       value: data.linkedin_url });
  if (data.linkedin_member_id) out.push({ kind: 'linkedin_member_id', value: data.linkedin_member_id });
  if (data.hubspot_id)         out.push({ kind: 'hubspot',            value: data.hubspot_id });
  if (data.pipedrive_id)       out.push({ kind: 'pipedrive',          value: data.pipedrive_id });
  if (data.apollo_id)          out.push({ kind: 'apollo',             value: data.apollo_id });
  if (data.rb2b_id)            out.push({ kind: 'rb2b',               value: data.rb2b_id });
  if (data.attio_id)           out.push({ kind: 'attio',              value: data.attio_id });
  return out;
}

/** Resolve a single identifier to its entity id, or null if unknown. */
export async function resolveEntity(
  supabase: SupabaseClient,
  workspaceId: string,
  identifier: Identifier,
): Promise<string | null> {
  const value = normaliseIdentifier(identifier.kind, identifier.value);
  if (!value) return null;

  // LinkedIn URLs need variant matching so historical rows (stored before
  // normalisation existed) still resolve. .in() with the variant set is one
  // round-trip vs the old single-value .eq().
  if (identifier.kind === 'linkedin_url') {
    const variants = linkedInVariants(identifier.value);
    const { data } = await supabase
      .from('entity_identifiers')
      .select('entity_id')
      .eq('workspace_id', workspaceId)
      .eq('kind', 'linkedin_url')
      .in('value', variants)
      .eq('status', 'active')
      .limit(1);
    return (data as { entity_id: string }[] | null)?.[0]?.entity_id ?? null;
  }

  const { data } = await supabase
    .from('entity_identifiers')
    .select('entity_id')
    .eq('workspace_id', workspaceId)
    .eq('kind', identifier.kind)
    .eq('value', value)
    .eq('status', 'active')
    .maybeSingle();
  return data?.entity_id ?? null;
}

/** Attach identifiers to an entity, skipping any already registered. */
export async function attachIdentifiers(
  supabase: SupabaseClient,
  workspaceId: string,
  entityId: string,
  identifiers: Identifier[],
): Promise<void> {
  for (const id of identifiers) {
    const value = normaliseIdentifier(id.kind, id.value);
    if (!value) continue;
    const existing = await resolveEntity(supabase, workspaceId, { kind: id.kind, value });
    if (existing) continue;
    await supabase.from('entity_identifiers').insert({
      workspace_id: workspaceId,
      entity_id: entityId,
      kind: id.kind,
      value,
    });
  }
}

/**
 * Ensure (workspace, kind, value) is an ACTIVE identifier on `entityId`.
 *
 * IMPORTANT: the uniqueness on entity_identifiers is a PARTIAL index
 * (`UNIQUE (workspace_id, kind, value) WHERE status='active'`), which PostgREST
 * `.upsert({ onConflict: 'workspace_id,kind,value' })` cannot target — it errors,
 * and callers historically swallowed that error, so post-hoc identifiers (a
 * profile email, a healed LinkedIn URL, an edited field) silently never landed.
 * This does the correct reactivate-or-insert by hand instead of an upsert.
 *
 * Returns true if the identifier is active on this entity afterward; false if it
 * couldn't be attached because another entity already holds it active (a real
 * identity collision we must not steal).
 */
export async function upsertIdentifier(
  supabase: SupabaseClient,
  workspaceId: string,
  entityId: string,
  kind: string,
  value: string | null | undefined,
): Promise<boolean> {
  if (!value) return false;
  const v = normaliseIdentifier(kind, value);
  if (!v) return false;

  // Already on THIS entity (any status)? → ensure it's active.
  const { data: mine } = await supabase
    .from('entity_identifiers')
    .select('id, status')
    .eq('workspace_id', workspaceId).eq('entity_id', entityId)
    .eq('kind', kind).eq('value', v)
    .maybeSingle();
  if (mine) {
    if ((mine as { status?: string }).status !== 'active') {
      await supabase.from('entity_identifiers').update({ status: 'active' }).eq('id', (mine as { id: string }).id);
    }
    return true;
  }

  // Plain insert — works with the partial index. A 23505 means (ws,kind,value)
  // is already ACTIVE on another entity (identity collision): leave it alone.
  const { error } = await supabase.from('entity_identifiers')
    .insert({ workspace_id: workspaceId, entity_id: entityId, kind, value: v, status: 'active' });
  return !error;
}

/** The lowercase, letters-only local part of the incoming email, for surname-token matching. */
function incomingEmailLocal(identifiers: Identifier[]): string | null {
  const email = identifiers.find(i => i.kind === 'email')?.value;
  if (!email) return null;
  const local = email.split('@')[0]?.toLowerCase().replace(/[^a-z]/g, '') ?? '';
  return local.length >= 4 ? local : null;
}

/**
 * Last-resort person resolution when no identifier matched — attach to a UNIQUE
 * existing person instead of forking a duplicate. This is the dedup-PREVENTION
 * pair to mergeEntities: it stops the Ravi split (LinkedIn "Ravi Patel" +
 * Cal.com "Ravi P" / 099ravipatel@gmail.com) from ever happening.
 *
 * Anchored on an exact first-name match (cheap, bounded), then accepted only on
 * a UNIQUE corroborated candidate via one of two safe signals:
 *   - surname-token (strong): the incoming email's local part contains the
 *     candidate's surname ("ravipatel" ⊃ "patel"). High precision — accepted
 *     even when the candidate already has an email, because the email itself
 *     corroborates. This is what catches Ravi.
 *   - name-prefix (lossless only): the incoming surname is a prefix/initial of the
 *     candidate's ("P" ⊂ "Patel"), accepted only when the candidate has NO email
 *     of its own, so attaching is non-destructive.
 *
 * Any ambiguity (two same-first-name candidates) → null, never guess.
 */
async function resolvePersonByNameFallback(
  supabase: SupabaseClient,
  workspaceId: string,
  identifiers: Identifier[],
  nameHint?: { first_name?: string | null; last_name?: string | null },
): Promise<string | null> {
  const fn = nameHint?.first_name?.trim().toLowerCase() ?? '';
  const ln = nameHint?.last_name?.trim().toLowerCase() ?? '';
  if (fn.length < 2) return null;                       // need a first name to anchor on
  const emailLocal = incomingEmailLocal(identifiers);
  if (!emailLocal && !ln) return null;                  // nothing to corroborate with

  const { data } = await supabase
    .from('claims')
    .select('entity_id, property, value')
    .eq('workspace_id', workspaceId)
    .in('property', ['first_name', 'last_name'])
    .is('invalid_at', null)
    .limit(5000);
  const byEntity = new Map<string, { first?: string; last?: string }>();
  for (const c of (data as { entity_id: string; property: string; value: unknown }[]) ?? []) {
    const m = byEntity.get(c.entity_id) ?? {};
    if (c.property === 'first_name') m.first = String(c.value ?? '').trim().toLowerCase();
    else m.last = String(c.value ?? '').trim().toLowerCase();
    byEntity.set(c.entity_id, m);
  }

  const strong: string[] = [];   // surname appears in the incoming email — safe even if they have an email
  const weak: string[] = [];     // name-prefix only — gated below to email-less (lossless) candidates
  for (const [id, m] of byEntity) {
    if (!m.first || m.first !== fn) continue;           // anchor: exact first name
    const cand = m.last ?? '';
    if (emailLocal && cand.length >= 3 && emailLocal.includes(cand)) strong.push(id);
    else if (ln && cand && (cand === ln || cand.startsWith(ln) || ln.startsWith(cand))) weak.push(id);
  }

  if (strong.length === 1) return strong[0];
  if (strong.length > 1) return null;                   // ambiguous — never guess
  if (weak.length === 1) {
    const { data: hasEmail } = await supabase
      .from('entity_identifiers')
      .select('id').eq('entity_id', weak[0]).eq('kind', 'email').eq('status', 'active').limit(1);
    if (!hasEmail?.length) return weak[0];              // lossless: candidate had no email of its own
  }
  return null;
}

/**
 * Resolve an entity by any of its identifiers; create one if none match.
 * The entry point for ingestion — every observation needs an entity.
 *
 * `opts.nameHint` enables a safe last-resort name fallback (persons only) that
 * attaches to a unique corroborated existing person rather than forking a
 * duplicate — see resolvePersonByNameFallback. Callers that have the incoming
 * name (e.g. contact ingestion) should pass it; callers that don't are unaffected.
 */
export async function getOrCreateEntity(
  supabase: SupabaseClient,
  workspaceId: string,
  type: EntityType,
  identifiers: Identifier[],
  opts?: { nameHint?: { first_name?: string | null; last_name?: string | null } },
): Promise<string> {
  for (const id of identifiers) {
    const existing = await resolveEntity(supabase, workspaceId, id);
    if (existing) {
      await attachIdentifiers(supabase, workspaceId, existing, identifiers);
      return existing;
    }
  }

  // No identifier matched. Before forking a new person, try the corroborated
  // name fallback — this prevents the duplicate that merge_contacts would later fix.
  if (type === 'person' && opts?.nameHint) {
    const matched = await resolvePersonByNameFallback(supabase, workspaceId, identifiers, opts.nameHint);
    if (matched) {
      await attachIdentifiers(supabase, workspaceId, matched, identifiers);
      return matched;
    }
  }

  const { data, error } = await supabase
    .from('entities')
    .insert({ workspace_id: workspaceId, type, status: 'active' })
    .select('id')
    .single();
  if (error || !data) throw new Error(`failed to create entity: ${error?.message}`);

  await attachIdentifiers(supabase, workspaceId, data.id, identifiers);

  // Race reconciliation. This function is select-then-insert, so two calls carrying
  // the same identifier — e.g. several Cal.com BOOKING_CREATED webhooks for one
  // attendee arriving together, or a calendar poll overlapping a webhook — can BOTH
  // miss the initial resolve and BOTH create an entity. The entity_identifiers_active
  // unique index lets only ONE of them actually claim the identifier; attachIdentifiers'
  // insert silently no-ops for the loser. Left unreconciled, the loser keeps its own
  // bare entity and the caller mints a SECOND contact on it — one person fanning out
  // into N duplicate records (the "imported me 5×" bug). So: if any identifier now
  // resolves to a DIFFERENT entity, a concurrent create won — drop ours (no contact
  // row exists on it yet) and hand back the winner. The caller's contact insert then
  // collapses onto the shared id via its PK-conflict path.
  for (const id of identifiers) {
    const owner = await resolveEntity(supabase, workspaceId, id);
    if (owner && owner !== data.id) {
      await supabase.from('entities').delete()
        .eq('id', data.id).eq('workspace_id', workspaceId)
        .then(() => {}, () => {});
      return owner;
    }
  }

  // A brand-new person whose email is a workspace member is internal — a teammate,
  // not a prospect. Flag them the moment they enter the graph so they never get
  // scored or pushed. Best-effort: a hiccup here must not fail ingestion.
  if (type === 'person') {
    const email = identifiers.find(i => i.kind === 'email')?.value;
    if (email) {
      try {
        const { isEmailInternal, markEntityInternal } = await import('./teamMembers.js');
        if (await isEmailInternal(supabase, workspaceId, email)) {
          await markEntityInternal(supabase, workspaceId, data.id);
        }
      } catch { /* recognition is best-effort; the score worker is the backstop */ }
    }
  }

  return data.id;
}

// ── v2 overlay onto v1 contact/company rows ──────────────────────────────────
// Phase 4a transitional read-path: every reader of `contacts` / `companies`
// fetches the v1 row, then overlays whatever the v2 substrate carries
// (claims, identifiers, the latest icp_fit prediction, the works_at edge,
// the latest observation timestamp). The v2 path is exercised on every read;
// remaining v1-only columns (channels, deal_health_score, memory_summary,
// enrichment_status, source) still fall through. Phase 4b claim-ifies those.

export interface EntityOverlay {
  claims: Record<string, unknown>;
  identifiers: Record<string, string>;
  prediction: { score?: number; fit?: boolean; reason?: string } | null;
  latestObservedAt: string | null;
  worksAtCompanyId: string | null;
}

/** Batch-fetch v2 overlays for many entity ids. Empty entries are safe. */
export async function fetchEntityOverlays(
  supabase: SupabaseClient,
  entityIds: string[],
): Promise<Map<string, EntityOverlay>> {
  const map = new Map<string, EntityOverlay>();
  if (entityIds.length === 0) return map;
  for (const id of entityIds) {
    map.set(id, { claims: {}, identifiers: {}, prediction: null, latestObservedAt: null, worksAtCompanyId: null });
  }

  const [claimsRes, identsRes, predsRes, obsRes, relsRes] = await Promise.all([
    supabase.from('claims')
      .select('entity_id, property, value')
      .in('entity_id', entityIds)
      .is('invalid_at', null),
    supabase.from('entity_identifiers')
      .select('entity_id, kind, value')
      .in('entity_id', entityIds)
      .eq('status', 'active'),
    supabase.from('predictions')
      .select('entity_id, predicted_value, predicted_at')
      .in('entity_id', entityIds)
      .eq('kind', 'icp_fit')
      .order('predicted_at', { ascending: false }),
    supabase.from('observations')
      .select('entity_id, observed_at')
      .in('entity_id', entityIds)
      .order('observed_at', { ascending: false }),
    supabase.from('relationships')
      .select('from_entity_id, to_entity_id, type')
      .in('from_entity_id', entityIds)
      .eq('type', 'works_at')
      .is('valid_to', null),
  ]);

  for (const c of (claimsRes.data as { entity_id: string; property: string; value: unknown }[]) ?? []) {
    map.get(c.entity_id)!.claims[c.property] = c.value;
  }
  for (const i of (identsRes.data as { entity_id: string; kind: string; value: string }[]) ?? []) {
    map.get(i.entity_id)!.identifiers[i.kind] = i.value;
  }
  const seenPred = new Set<string>();
  for (const p of (predsRes.data as { entity_id: string; predicted_value: unknown }[]) ?? []) {
    if (seenPred.has(p.entity_id)) continue;
    seenPred.add(p.entity_id);
    map.get(p.entity_id)!.prediction = p.predicted_value as EntityOverlay['prediction'];
  }
  const seenObs = new Set<string>();
  for (const o of (obsRes.data as { entity_id: string; observed_at: string }[]) ?? []) {
    if (seenObs.has(o.entity_id)) continue;
    seenObs.add(o.entity_id);
    map.get(o.entity_id)!.latestObservedAt = o.observed_at;
  }
  for (const r of (relsRes.data as { from_entity_id: string; to_entity_id: string }[]) ?? []) {
    const o = map.get(r.from_entity_id)!;
    if (!o.worksAtCompanyId) o.worksAtCompanyId = r.to_entity_id;
  }

  return map;
}

/** Overlay v2 data onto a v1 contact row. Returns a new row; doesn't mutate. */
export function applyContactOverlay(
  row: Record<string, unknown>,
  overlay: EntityOverlay | undefined,
): Record<string, unknown> {
  if (!overlay) return row;
  const { claims, identifiers, prediction, latestObservedAt, worksAtCompanyId } = overlay;
  const pick = <T>(...candidates: T[]): T => {
    for (const c of candidates) if (c !== undefined && c !== null) return c;
    return candidates[candidates.length - 1];
  };
  return {
    ...row,
    // Identifiers
    email:              pick(identifiers.email,              row.email as unknown),
    linkedin_url:       pick(identifiers.linkedin_url,       row.linkedin_url as unknown),
    linkedin_member_id: pick(identifiers.linkedin_member_id, row.linkedin_member_id as unknown),
    hubspot_id:         pick(identifiers.hubspot,            row.hubspot_id as unknown),
    pipedrive_id:       pick(identifiers.pipedrive,          row.pipedrive_id as unknown),
    apollo_id:          pick(identifiers.apollo,             row.apollo_id as unknown),
    // Profile claims
    first_name:         pick(claims.first_name,              row.first_name),
    last_name:          pick(claims.last_name,               row.last_name),
    job_title:          pick(claims.job_title,               row.job_title),
    seniority:          pick(claims.seniority,               row.seniority),
    department:         pick(claims.department,              row.department),
    city:               pick(claims.city,                    row.city),
    country:            pick(claims.country,                 row.country),
    phone:              pick(claims.phone,                   row.phone),
    company:            pick(claims.company,                 row.company),
    photo_url:          pick(claims.photo_url,               row.photo_url),
    // Pipeline / lifecycle
    pipeline_stage:     pick(claims.pipeline_stage,          row.pipeline_stage),
    stage_locked:       pick(claims.stage_locked,            row.stage_locked),
    source:             pick(claims.source,                  row.source),
    first_seen_at:      pick(claims.first_seen_at,           row.first_seen_at as unknown),
    // Channels (LinkedIn / email state, JSONB)
    channels:           pick(claims.channels,                row.channels),
    // Relations
    company_id:         pick(worksAtCompanyId,               row.company_id as unknown),
    // Deal state
    deal_health_score:  pick(claims.deal_health_score,       row.deal_health_score),
    deal_stage:         pick(claims.deal_stage,              row.deal_stage),
    deal_value:         pick(claims.deal_value,              row.deal_value),
    // Enrichment process state
    enrichment_status:  pick(claims.enrichment_status,       row.enrichment_status),
    enriched_at:        pick(claims.enriched_at,             row.enriched_at as unknown),
    // LLM-derived summary
    memory_summary:     pick(claims.memory_summary,          row.memory_summary),
    // Scores (from the latest icp_fit prediction)
    icp_score:          pick(prediction?.score,              row.icp_score),
    icp_fit:            pick(prediction?.fit,                row.icp_fit),
    icp_reasoning:      pick(prediction?.reason,             row.icp_reasoning),
    // Derived from observations
    last_activity_at:   pick(latestObservedAt,               row.last_activity_at as unknown),
  };
}

/** Overlay v2 data onto a v1 company row. */
export function applyCompanyOverlay(
  row: Record<string, unknown>,
  overlay: EntityOverlay | undefined,
): Record<string, unknown> {
  if (!overlay) return row;
  const { claims, identifiers } = overlay;
  const pick = <T>(...candidates: T[]): T => {
    for (const c of candidates) if (c !== undefined && c !== null) return c;
    return candidates[candidates.length - 1];
  };
  return {
    ...row,
    name:               pick(claims.name,               row.name),
    domain:             pick(identifiers.domain,        row.domain as unknown),
    industry:           pick(claims.industry,           row.industry),
    employee_count:     pick(claims.employee_count,     row.employee_count),
    location:           pick(claims.location,           row.location),
    revenue_range:      pick(claims.revenue_range,      row.revenue_range),
    tech_stack:         pick(claims.tech_stack,         row.tech_stack),
    enrichment_status:  pick(claims.enrichment_status,  row.enrichment_status),
    enriched_at:        pick(claims.enriched_at,        row.enriched_at as unknown),
    deal_health_score:  pick(claims.deal_health_score,  row.deal_health_score),
    hubspot_company_id: pick(claims.hubspot_company_id, row.hubspot_company_id as unknown),
    apollo_account_id:  pick(claims.apollo_account_id,  row.apollo_account_id as unknown),
  };
}

export async function getEntity(
  supabase: SupabaseClient,
  workspaceId: string,
  entityId: string,
): Promise<Entity | null> {
  const { data } = await supabase
    .from('entities')
    .select('id, workspace_id, type, status')
    .eq('id', entityId)
    .eq('workspace_id', workspaceId)
    .maybeSingle();
  return (data as Entity) ?? null;
}

// ── merge ──────────────────────────────────────────────────────────────────
// Fold one person-entity into another. The agent's dedup primitive: when the
// same human exists as two entities (e.g. one from a LinkedIn connection with
// no email, one from a Cal.com booking with an email and a truncated name),
// merge collapses them into one.

export interface MergeSummary {
  keep_id: string;
  drop_id: string;
  identifiers_moved: number;
  claims_moved: number;
  claims_conflicted: number;       // kept on the survivor; drop's copy parked on the tombstone
  observations_moved: number;
  observations_conflicted: number; // (source, external_id) collisions left on the tombstone
  relationships_repointed: number;
  relationships_removed: number;   // self-loops + duplicate edges
  collections_moved: number;
  collections_deduped: number;
  rows_repointed: Record<string, number>;
}

/**
 * Merge `dropId` into `keepId` (same workspace, same entity type).
 *
 * Lossless: drop's active identifiers (a second email, a LinkedIn URL) re-attach
 * to keep, so a future match on EITHER identifier resolves to the one entity —
 * no primary/secondary, both are live keys. Conflict policy is keep-wins: a
 * claim / observation / edge that would collide is left on the drop tombstone
 * rather than overwriting keep or tripping a unique index.
 *
 * Soft + reversible: drop becomes status='merged', merged_into=keepId, so it
 * drops out of resolveEntity automatically (every lookup filters status='active')
 * and the merge can be undone by re-activating it.
 */
export async function mergeEntities(
  supabase: SupabaseClient,
  workspaceId: string,
  keepId: string,
  dropId: string,
): Promise<MergeSummary> {
  if (keepId === dropId) throw new Error('cannot merge an entity into itself');

  const { data: ents } = await supabase
    .from('entities')
    .select('id, workspace_id, type, status')
    .in('id', [keepId, dropId]);
  const keep = (ents as Entity[] | null)?.find(e => e.id === keepId);
  const drop = (ents as Entity[] | null)?.find(e => e.id === dropId);
  if (!keep || !drop) throw new Error('one or both entities not found');
  if (keep.workspace_id !== workspaceId || drop.workspace_id !== workspaceId)
    throw new Error('entity not in this workspace');
  if (keep.type !== drop.type) throw new Error(`type mismatch: ${keep.type} vs ${drop.type}`);
  if (drop.status === 'merged') throw new Error('drop entity is already merged');

  const summary: MergeSummary = {
    keep_id: keepId, drop_id: dropId,
    identifiers_moved: 0, claims_moved: 0, claims_conflicted: 0,
    observations_moved: 0, observations_conflicted: 0,
    relationships_repointed: 0, relationships_removed: 0,
    collections_moved: 0, collections_deduped: 0, rows_repointed: {},
  };

  // identifiers — re-attach drop's active ones unless keep already actively holds the value
  const { data: dropIdents } = await supabase
    .from('entity_identifiers')
    .select('id, kind, value')
    .eq('entity_id', dropId).eq('status', 'active');
  for (const id of (dropIdents as { id: string; kind: string; value: string }[]) ?? []) {
    const { data: held } = await supabase
      .from('entity_identifiers')
      .select('id')
      .eq('workspace_id', workspaceId).eq('kind', id.kind).eq('value', id.value)
      .eq('status', 'active').neq('entity_id', dropId).maybeSingle();
    if (held) continue;                                       // real collision — leave it on drop
    await supabase.from('entity_identifiers').update({ entity_id: keepId }).eq('id', id.id);
    summary.identifiers_moved++;
  }

  // claims — move only properties keep doesn't already have (one row per ws+entity+property)
  const { data: keepClaims } = await supabase
    .from('claims').select('property').eq('entity_id', keepId).is('invalid_at', null);
  const keepProps = new Set(((keepClaims as { property: string }[]) ?? []).map(c => c.property));
  const { data: dropClaims } = await supabase
    .from('claims').select('id, property, invalid_at').eq('entity_id', dropId);
  for (const c of (dropClaims as { id: string; property: string; invalid_at: string | null }[]) ?? []) {
    if (c.invalid_at == null && keepProps.has(c.property)) { summary.claims_conflicted++; continue; }
    if (c.invalid_at == null) keepProps.add(c.property);
    await supabase.from('claims').update({ entity_id: keepId }).eq('id', c.id);
    summary.claims_moved++;
  }

  // observations — move all except (source, external_id) collisions
  const { data: keepObs } = await supabase
    .from('observations').select('source, external_id').eq('entity_id', keepId).not('external_id', 'is', null);
  const keepObsKeys = new Set(((keepObs as { source: string; external_id: string }[]) ?? []).map(o => `${o.source}|${o.external_id}`));
  const { data: dropObs } = await supabase
    .from('observations').select('id, source, external_id').eq('entity_id', dropId);
  for (const o of (dropObs as { id: string; source: string; external_id: string | null }[]) ?? []) {
    if (o.external_id != null && keepObsKeys.has(`${o.source}|${o.external_id}`)) { summary.observations_conflicted++; continue; }
    await supabase.from('observations').update({ entity_id: keepId }).eq('id', o.id);
    summary.observations_moved++;
  }

  // relationships — re-point both ends; drop self-loops and duplicate edges
  const { data: keepRels } = await supabase
    .from('relationships').select('from_entity_id, to_entity_id, type')
    .or(`from_entity_id.eq.${keepId},to_entity_id.eq.${keepId}`);
  const keepEdge = new Set(((keepRels as { from_entity_id: string; to_entity_id: string; type: string }[]) ?? [])
    .map(r => `${r.from_entity_id}|${r.to_entity_id}|${r.type}`));
  const { data: dropRels } = await supabase
    .from('relationships').select('id, from_entity_id, to_entity_id, type')
    .or(`from_entity_id.eq.${dropId},to_entity_id.eq.${dropId}`);
  for (const r of (dropRels as { id: string; from_entity_id: string; to_entity_id: string; type: string }[]) ?? []) {
    const from = r.from_entity_id === dropId ? keepId : r.from_entity_id;
    const to   = r.to_entity_id   === dropId ? keepId : r.to_entity_id;
    if (from === to || keepEdge.has(`${from}|${to}|${r.type}`)) {
      await supabase.from('relationships').delete().eq('id', r.id);
      summary.relationships_removed++;
      continue;
    }
    keepEdge.add(`${from}|${to}|${r.type}`);
    await supabase.from('relationships').update({ from_entity_id: from, to_entity_id: to }).eq('id', r.id);
    summary.relationships_repointed++;
  }

  // collection_entities — move unless keep already a member of that collection
  const { data: keepCols } = await supabase.from('collection_entities').select('collection_id').eq('entity_id', keepId);
  const keepColSet = new Set(((keepCols as { collection_id: string }[]) ?? []).map(c => c.collection_id));
  const { data: dropCols } = await supabase.from('collection_entities').select('collection_id').eq('entity_id', dropId);
  for (const c of (dropCols as { collection_id: string }[]) ?? []) {
    if (keepColSet.has(c.collection_id)) {
      await supabase.from('collection_entities').delete().eq('entity_id', dropId).eq('collection_id', c.collection_id);
      summary.collections_deduped++;
    } else {
      await supabase.from('collection_entities').update({ entity_id: keepId }).eq('entity_id', dropId).eq('collection_id', c.collection_id);
      summary.collections_moved++;
    }
  }

  // plain re-points — PK-only tables + the v1 contact_id back-references
  const plain: [string, string][] = [
    ['predictions', 'entity_id'], ['claim_jobs', 'entity_id'], ['crm_hygiene_proposals', 'entity_id'],
    ['outbound_events', 'entity_id'], ['leads', 'contact_id'], ['workspace_system_log', 'contact_id'],
  ];
  for (const [table, col] of plain) {
    const { data: moved } = await supabase.from(table).update({ [col]: keepId }).eq(col, dropId).select('id');
    if (moved && moved.length) summary.rows_repointed[table] = moved.length;
  }

  // delete the duplicate v1 contacts row (entity tombstone preserves lineage), then tombstone
  await supabase.from('contacts').delete().eq('id', dropId);
  await supabase.from('entities').update({ status: 'merged', merged_into: keepId }).eq('id', dropId);

  return summary;
}

// ── focus resolution ─────────────────────────────────────────────────────────
// An agent passes whatever it has. A UUID / email / domain / LinkedIn URL is a
// real *identifier* — it resolves to exactly one entity. A bare name is NOT an
// identifier — it may match several entities, so we return candidates.

export interface FocusCandidate {
  entity_id: string;
  name: string | null;
  detail: string | null;          // company / title — to tell candidates apart
}

export type FocusResolution =
  | { status: 'resolved'; entity_id: string }
  | { status: 'ambiguous'; candidates: FocusCandidate[] }
  | { status: 'not_found' };

const DOMAIN_RE = /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i;

export type DetectedIdentifier = {
  kind: 'entity_id' | 'email' | 'linkedin_url' | 'domain';
  value: string;
};

/**
 * Detect a hard identifier in a focus string. Returns null when the input is
 * not a hard identifier (e.g. a bare name) — that case needs a search, not a
 * lookup. Shared by resolveFocus (reads) and the write path (observations).
 */
export function detectIdentifier(focus: string): DetectedIdentifier | null {
  const f = (focus ?? '').trim();
  if (!f) return null;
  if (isUUID(f)) return { kind: 'entity_id', value: f };
  if (f.includes('@')) return { kind: 'email', value: f.toLowerCase() };
  if (/linkedin\.com/i.test(f)) {
    const url = normaliseLinkedInUrl(f);
    return url ? { kind: 'linkedin_url', value: url } : null;
  }
  if (!f.includes(' ') && DOMAIN_RE.test(f)) return { kind: 'domain', value: f.toLowerCase() };
  return null;
}

export async function resolveFocus(
  supabase: SupabaseClient,
  workspaceId: string,
  focus: string,
): Promise<FocusResolution> {
  const f = (focus ?? '').trim();
  if (!f) return { status: 'not_found' };

  const ident = detectIdentifier(f);
  if (ident) {
    if (ident.kind === 'entity_id') {
      const e = await getEntity(supabase, workspaceId, ident.value);
      return e ? { status: 'resolved', entity_id: ident.value } : { status: 'not_found' };
    }
    const id = await resolveEntity(supabase, workspaceId, { kind: ident.kind, value: ident.value });
    return id ? { status: 'resolved', entity_id: id } : { status: 'not_found' };
  }

  // not a hard identifier — treat as a name; one hit resolves, several is ambiguous
  const candidates = await searchEntitiesByName(supabase, workspaceId, f);
  if (candidates.length === 0) return { status: 'not_found' };
  if (candidates.length === 1) return { status: 'resolved', entity_id: candidates[0].entity_id };
  return { status: 'ambiguous', candidates: candidates.slice(0, 10) };
}

/**
 * Match entities by display name.
 *
 * Filtering happens in memory, so we must actually HOLD every name claim to do
 * it. PostgREST caps a single response at 1000 rows regardless of the `.limit()`
 * we ask for — so the old `.limit(5000)` silently searched the first 1000 name
 * claims of a workspace that had 8,000+, and anyone outside that window was
 * invisible to the agent. It would tell you a person "isn't in the workspace"
 * while they sat in the Accounts table. Page through the lot instead.
 */
const NAME_PROPS = ['first_name', 'last_name', 'name', 'company', 'job_title'];
const PAGE = 1000;              // PostgREST's hard per-response ceiling
const MAX_NAME_CLAIMS = 50_000; // sanity bound; ~10k entities

async function searchEntitiesByName(
  supabase: SupabaseClient,
  workspaceId: string,
  term: string,
): Promise<FocusCandidate[]> {
  const needle = term.trim().toLowerCase();
  if (!needle) return [];

  const rows: any[] = [];
  for (let from = 0; from < MAX_NAME_CLAIMS; from += PAGE) {
    const { data } = await supabase
      .from('claims')
      .select('entity_id, property, value')
      .eq('workspace_id', workspaceId)
      .in('property', NAME_PROPS)
      .range(from, from + PAGE - 1);
    if (!data?.length) break;
    rows.push(...data);
    if (data.length < PAGE) break; // last page
  }

  const byEntity = new Map<string, Record<string, unknown>>();
  for (const c of rows) {
    const m = byEntity.get(c.entity_id) ?? {};
    m[c.property] = c.value;
    byEntity.set(c.entity_id, m);
  }

  const out: FocusCandidate[] = [];
  for (const [id, m] of byEntity) {
    const full = m.name
      ? String(m.name)
      : [m.first_name, m.last_name].filter(Boolean).join(' ');
    const first = m.first_name ? String(m.first_name) : '';
    const last = m.last_name ? String(m.last_name) : '';
    const company = m.company ? String(m.company) : '';

    // "Vik" should find Vikram. A first or last name that STARTS with the term
    // counts, as does the full name containing it — so partial first names and
    // surnames both resolve, which is how people actually refer to each other.
    const hay = full.toLowerCase();
    const matches =
      (hay && hay.includes(needle)) ||
      first.toLowerCase().startsWith(needle) ||
      last.toLowerCase().startsWith(needle) ||
      // Let a company name find the people at it ("the WindSeeker guy").
      (company && company.toLowerCase().includes(needle));

    if (!matches) continue;
    out.push({
      entity_id: id,
      name: full || null,
      detail: company || (m.job_title ? String(m.job_title) : null),
    });
  }
  return out;
}
