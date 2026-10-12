import type { SupabaseClient } from '@supabase/supabase-js';
import { normaliseLinkedInUrl, isUUID, isMemberUrnLinkedInUrl, normalizeEmailLocalPart, pickLocalPartMatch } from '../utils/identity.js';
import { upsertIdentityProposal, type IdentityCandidate } from './identityProposals.js';

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
  /**
   * WHICH SYSTEM asserted it. The question underneath every identity dispute — "Salesforce
   * says this email is his, Fireflies says it is hers" — and it was unanswerable, because an
   * identifier recorded what it was and never where it came from.
   *
   * Per-identifier because one call can carry several origins: a CRM sync supplies the email
   * from the CRM and the LinkedIn URL from an enrichment provider riding along with it.
   * Callers with a single origin pass it once via `opts.source` instead.
   */
  source?: string | null;
}

/** A single, well-formed address. Not RFC-complete on purpose — its job is to
 *  reject values that are not one address, which is the failure we actually had:
 *  "a@b.com,c@d.com" (two humans in one identifier, from an attendee list that
 *  joined them), and CSV junk like "d" or "kk" written into an email column. */
const SINGLE_EMAIL = /^[^@\s,;<>]+@[^@\s,;<>]+\.[a-z]{2,}$/i;

/**
 * Normalise an identifier value so writes and lookups land on the same string,
 * or `null` when the value cannot be an identifier at all.
 *
 * Returning null matters: matching is exact, so a malformed identifier matches
 * nothing, ever. Storing one is strictly worse than storing nothing — it looks
 * like the graph learned something when it learned nothing, and in the
 * comma-joined case it attaches one person's address to another person's record.
 */
export function normaliseIdentifier(kind: string, value: string): string | null {
  const v = (value ?? '').trim();
  if (!v) return null;
  if (kind === 'email') return SINGLE_EMAIL.test(v) ? v.toLowerCase() : null;
  if (kind === 'domain') return v.toLowerCase();
  if (kind === 'linkedin_url') return normaliseLinkedInUrl(v) ?? v;
  // MUST agree with normalise_identifier() in the database, which a trigger now
  // applies to every write. If the two disagree, the app looks up "RowanAchterberg"
  // while the row is stored as "rowanachterberg", and every lookup misses — the fix
  // for forking would itself fork. Real member URNs are case-sensitive and stay
  // as-is; a vanity handle filed under this kind folds to lowercase.
  if (kind === 'linkedin_member_id') return v.startsWith('ACoA') ? v : v.toLowerCase();
  return v;
}

/** Build the v2 Identifier[] list from a v1-style contact data blob. */
export function identifiersFromContactData(data: {
  email?: string | null;
  emails?: (string | null)[] | null;
  linkedin_url?: string | null;
  linkedin_member_id?: string | null;
  hubspot_id?: string | null;
  pipedrive_id?: string | null;
  apollo_id?: string | null;
  rb2b_id?: string | null;
  attio_id?: string | null;
}): Identifier[] {
  const out: Identifier[] = [];
  // A person can have several emails (work + personal). Attach EVERY one as an
  // identifier so future resolution matches on any of them, not just the primary.
  // De-duped case-insensitively; the primary `email` is kept first.
  const seenEmail = new Set<string>();
  for (const e of [data.email, ...(data.emails ?? [])]) {
    const v = typeof e === 'string' ? e.trim() : '';
    if (!v) continue;
    const key = v.toLowerCase();
    if (seenEmail.has(key)) continue;
    seenEmail.add(key);
    out.push({ kind: 'email', value: v });
  }
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

/**
 * Where an identifier match should actually land.
 *
 * Identifier lookups filter on the IDENTIFIER's status and never looked at the
 * ENTITY's. So an identifier still active on a merged record resolved to the
 * tombstone — and every write that followed went onto an entity that all the views
 * hide. Six such records existed with no `merged_into` pointer at all
 * (two company domains among them): a black hole for anything mentioning them.
 *
 * A merged entity forwards to its survivor (bounded, in case of a chain). A merged
 * entity with no pointer resolves to nothing, so the caller treats the identifier as
 * unknown rather than writing into the void. Archived and parked entities resolve
 * normally — re-engagement is supposed to find them.
 */
async function followMerge(supabase: SupabaseClient, entityId: string | null): Promise<string | null> {
  let id = entityId;
  for (let hop = 0; id && hop < 5; hop++) {
    const { data } = await supabase.from('entities')
      .select('status, merged_into').eq('id', id).maybeSingle();
    const e = data as { status: string; merged_into: string | null } | null;
    if (!e) return null;
    if (e.status !== 'merged') return id;
    id = e.merged_into;
  }
  return null;
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
    return followMerge(supabase, (data as { entity_id: string }[] | null)?.[0]?.entity_id ?? null);
  }

  const { data } = await supabase
    .from('entity_identifiers')
    .select('entity_id')
    .eq('workspace_id', workspaceId)
    .eq('kind', identifier.kind)
    .eq('value', value)
    .eq('status', 'active')
    .maybeSingle();
  if (data?.entity_id) {
    const landed = await followMerge(supabase, data.entity_id);
    if (landed) return landed;
  }

  // Fallback: the v1 `contacts` table is the source the UI trusts, and an email is
  // often a guessed/imported field there (contacts.email) that was NEVER promoted
  // to an entity_identifier. Resolving ONLY against identifiers made a real account
  // unreachable by email (get_context/get_account 404) AND forked a duplicate on
  // write (getOrCreateEntity created a new person because the email "didn't exist").
  // entity_id == contact.id by the migration convention, so the contact row IS the
  // entity. Only for email — LinkedIn/domain already resolve above, and callers that
  // resolve here go on to attachIdentifiers, which self-heals the missing identifier.
  if (identifier.kind === 'email') {
    const { data: c } = await supabase
      .from('contacts')
      .select('id')
      .eq('workspace_id', workspaceId)
      .ilike('email', value)
      .limit(1)
      .maybeSingle();
    if ((c as { id?: string } | null)?.id) return (c as { id: string }).id;
  }

  return null;
}

/**
 * Widen an incoming identifier set with the forms it implies.
 *
 * `linkedin_member_id` holds two different things: real member URNs (`ACoAA…`)
 * and vanity handles filed there by mistake — most of the values in one
 * workspace were handles, not URNs. That matters because matching is exact: one
 * record can carry `linkedin_member_id=rowanachterberg` while another carries
 * `linkedin_url=https://www.linkedin.com/in/rowanachterberg`, and those two
 * spellings of a single fact will never meet.
 *
 * Rather than rewrite the caller's data, emit BOTH forms. A handle implies its
 * profile URL, so attach that too and the two records resolve to each other on
 * the next touch.
 */
export function expandIdentifiers(identifiers: Identifier[]): Identifier[] {
  const out = [...identifiers];
  const seen = new Set(identifiers.map(i => `${i.kind}:${normaliseIdentifier(i.kind, i.value)}`));
  for (const id of identifiers) {
    if (id.kind !== 'linkedin_member_id') continue;
    const v = (id.value ?? '').trim();
    if (!v || v.startsWith('ACoA')) continue;          // a real URN implies no URL
    if (!/^[a-z0-9-]{3,100}$/i.test(v)) continue;      // not a plausible vanity handle
    const url = normaliseIdentifier('linkedin_url', `https://www.linkedin.com/in/${v}`);
    if (!url || seen.has(`linkedin_url:${url}`)) continue;
    seen.add(`linkedin_url:${url}`);
    // Inherits the handle's source: the derived URL was asserted by whoever asserted the
    // handle, and dropping it here would leave an identifier that came from nowhere.
    out.push({ kind: 'linkedin_url', value: url, source: id.source ?? null });
  }
  return out;
}

/**
 * Attach identifiers to an entity, skipping any already registered.
 *
 * `source` is the system asserting them, and it is worth passing: it is what lets the product
 * answer "why does it say that" about an identity rather than only about a claim.
 */
export async function attachIdentifiers(
  supabase: SupabaseClient,
  workspaceId: string,
  entityId: string,
  identifiers: Identifier[],
  source?: string | null,
): Promise<void> {
  for (const id of expandIdentifiers(identifiers)) {
    const value = normaliseIdentifier(id.kind, id.value);
    if (!value) continue;
    const existing = await resolveEntity(supabase, workspaceId, { kind: id.kind, value });
    if (existing) continue;
    await supabase.from('entity_identifiers').insert({
      workspace_id: workspaceId,
      entity_id: entityId,
      kind: id.kind,
      value,
      // The identifier's own source wins over the caller's default: one sync can carry an
      // email from the CRM and a LinkedIn URL from the enrichment provider beside it.
      source: id.source ?? source ?? null,
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
 * pair to mergeEntities: it stops the Caius split (LinkedIn "Caius Merriday" +
 * Cal.com "Caius M" / 099caiusmerriday@example.com) from ever happening.
 *
 * Anchored on an exact first-name match (cheap, bounded), then accepted only on
 * a UNIQUE corroborated candidate via one of two safe signals:
 *   - surname-token (strong): the incoming email's local part contains the
 *     candidate's surname ("caiusmerriday" ⊃ "merriday"). High precision — accepted
 *     even when the candidate already has an email, because the email itself
 *     corroborates. This is what catches Caius.
 *   - name-prefix (lossless only): the incoming surname is a prefix/initial of the
 *     candidate's ("P" ⊂ "Patel"), accepted only when the candidate has NO email
 *     of its own, so attaching is non-destructive.
 *
 * Any ambiguity (two same-first-name candidates) → null, never guess.
 */
/** One row of `person_name_candidates` — already lower-cased by the function. */
interface PersonNameCandidate {
  entity_id: string;
  first_name: string | null;
  last_name: string | null;
  has_email: boolean;
}

async function resolvePersonByNameFallback(
  supabase: SupabaseClient,
  workspaceId: string,
  identifiers: Identifier[],
  nameHint?: { first_name?: string | null; last_name?: string | null },
): Promise<string | null> {
  const fn = nameHint?.first_name?.trim().toLowerCase() ?? '';
  const ln = nameHint?.last_name?.trim().toLowerCase() ?? '';
  // Three, not two. A CSV import writes whatever is in the column, so the graph
  // holds first names like "nn" and "kk" — dozens of people in one workspace
  // had a 1-2 character first name. At a floor of 2 those stubs are live anchors
  // and can corroborate a match they have no business corroborating.
  if (fn.length < 3) return null;                       // need a real first name to anchor on
  const emailLocal = incomingEmailLocal(identifiers);
  if (!emailLocal && !ln) return null;                  // nothing to corroborate with

  // Ask the database for the people who share this first name, rather than pulling
  // the workspace across the wire and filtering here. The old shape — every
  // first_name/last_name claim in the workspace, `.limit(5000)`, no ORDER BY, then
  // a JS scan — went blind the moment a workspace outgrew the limit: one workspace held
  // about twice that many such claims, so it saw about half the graph and WHICH half changed call
  // to call. A twin outside that slice is invisible, and we fork a duplicate we had
  // every means to avoid. Raising the number would only move the cliff.
  const byEntity = new Map<string, { first?: string; last?: string; hasEmail?: boolean }>();
  const { data: candidates, error: rpcError } = await supabase
    .rpc('person_name_candidates', { ws: workspaceId, fname: fn });

  if (rpcError) {
    // Migration not applied yet. Degrade to the old client-side scan rather than
    // resolving nothing — a narrowed view is still better than forking on every
    // ingest — but say so, because this path silently loses matches.
    console.warn(`[IDENTITY] person_name_candidates unavailable (${rpcError.message}) — falling back to the truncated client-side scan`);
    const { data } = await supabase
      .from('claims')
      .select('entity_id, property, value')
      .eq('workspace_id', workspaceId)
      .in('property', ['first_name', 'last_name'])
      .is('invalid_at', null)
      .limit(5000);
    for (const c of (data as { entity_id: string; property: string; value: unknown }[]) ?? []) {
      const m = byEntity.get(c.entity_id) ?? {};
      if (c.property === 'first_name') m.first = String(c.value ?? '').trim().toLowerCase();
      else m.last = String(c.value ?? '').trim().toLowerCase();
      byEntity.set(c.entity_id, m);
    }
  } else {
    for (const c of (candidates as PersonNameCandidate[]) ?? []) {
      byEntity.set(c.entity_id, {
        first: c.first_name ?? undefined,
        last:  c.last_name ?? undefined,
        hasEmail: c.has_email,
      });
    }
  }

  // Race guard for same-batch imports. Name CLAIMS are derived asynchronously
  // (~30s after ingest), but a concurrent same-person row is created within
  // milliseconds — so at decision time the twin has no queryable claim yet and we
  // fork a duplicate (the "why is there always an empty account" bug). The name
  // OBSERVATIONS, however, are written synchronously at ingest. Fold in recent
  // name observations on ACTIVE entities to see twins whose claims haven't
  // derived yet; bounded to the last 15 min because anything older already has a
  // claim above. Claims win when present.
  const since = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  const { data: recentObs } = await supabase
    .from('observations')
    .select('entity_id, property, value, entities!inner(status)')
    .eq('workspace_id', workspaceId)
    .eq('kind', 'state')
    .in('property', ['first_name', 'last_name'])
    .eq('entities.status', 'active')
    .gte('ingested_at', since)
    .order('ingested_at', { ascending: false })
    .limit(5000);
  for (const o of (recentObs as { entity_id: string; property: string; value: unknown }[]) ?? []) {
    const m = byEntity.get(o.entity_id) ?? {};
    const v = String(o.value ?? '').trim().toLowerCase();
    if (!v) continue;
    // order is newest-first; only fill a gap the claim didn't already provide
    if (o.property === 'first_name') { if (!m.first) m.first = v; }
    else if (!m.last) m.last = v;
    byEntity.set(o.entity_id, m);
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
    // The RPC already told us whether this candidate owns an email; only the
    // observation-derived entries (and the degraded fallback path) need the query.
    const cached = byEntity.get(weak[0])?.hasEmail;
    let hasEmail = cached;
    if (hasEmail === undefined) {
      const { data: rows } = await supabase
        .from('entity_identifiers')
        .select('id').eq('entity_id', weak[0]).eq('kind', 'email').eq('status', 'active').limit(1);
      hasEmail = !!rows?.length;
    }
    if (!hasEmail) return weak[0];                      // lossless: candidate had no email of its own
  }
  return null;
}

/**
 * Normalised email local-part fallback (docs/identity-resolution.md §Planned).
 * Runs AFTER the name fallback and, unlike it, needs no name hint — it catches
 * the bare-email fork the name tier structurally cannot: a person who signs up
 * as `fakelenaquist9@gmail.com` while an outbound record already exists under
 * `fakelenaquist15@gmail.com` (different email, no shared LinkedIn, and — in the real
 * case that motivated this — the signup put the name in `company`, so there is
 * no first_name to anchor Step 2 on).
 *
 * Matches on (normalised local part, domain). The heavy lifting and the "unique
 * candidate only" safety live in the pure `pickLocalPartMatch`; this wrapper only
 * fetches the workspace's active email identifiers (bounded — hundreds, not
 * millions) scoped to ACTIVE entities so a merged tombstone can never be chosen.
 */
async function resolvePersonByEmailLocalPart(
  supabase: SupabaseClient,
  workspaceId: string,
  identifiers: Identifier[],
): Promise<string | null> {
  const incoming = identifiers.filter(i => i.kind === 'email').map(i => i.value);
  if (!incoming.some(e => normalizeEmailLocalPart(e))) return null; // nothing distinctive to match on

  const { data } = await supabase
    .from('entity_identifiers')
    .select('entity_id, value, entities!inner(status)')
    .eq('workspace_id', workspaceId)
    .eq('kind', 'email')
    .eq('status', 'active')
    .eq('entities.status', 'active')
    .limit(20000);

  const existing = ((data as { entity_id: string; value: string }[] | null) ?? [])
    .map(r => ({ entity_id: r.entity_id, email: r.value }));
  return pickLocalPartMatch(incoming, existing);
}

// Piece 4: find plausible-but-uncertain duplicate candidates for a person we just
// created (fuzzy name / email-local matches, below the auto-attach bar). Returns ranked
// candidates with a confidence + reason; the caller records them as a merge proposal for a
// human to approve. This does NOT attach — it only surfaces. Confidences match the spec:
// surname_token 0.72, name_prefix 0.62, email_local_part 0.65 (all in the [τ_ask, τ_auto)
// ask band). Bounded queries, best-effort — never called on the bulk-import path.
const CONF_SURNAME_TOKEN = 0.72;
const CONF_NAME_PREFIX = 0.62;
const CONF_EMAIL_LOCAL = 0.65;

export async function detectDuplicateCandidates(
  supabase: SupabaseClient,
  workspaceId: string,
  identifiers: Identifier[],
  nameHint: { first_name?: string | null; last_name?: string | null } | undefined,
  excludeEntityId?: string,
): Promise<IdentityCandidate[]> {
  const best = new Map<string, IdentityCandidate>();
  const add = (entity_id: string, confidence: number, reason: string) => {
    if (!entity_id || entity_id === excludeEntityId) return;
    const cur = best.get(entity_id);
    if (!cur || confidence > cur.confidence) best.set(entity_id, { entity_id, confidence, reason });
  };

  // Name-anchored candidates (first-name exact + surname corroboration).
  const fn = nameHint?.first_name?.trim().toLowerCase() ?? '';
  const ln = nameHint?.last_name?.trim().toLowerCase() ?? '';
  const emailLocal = incomingEmailLocal(identifiers);
  if (fn.length >= 2 && (emailLocal || ln)) {
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
    for (const [id, m] of byEntity) {
      if (!m.first || m.first !== fn) continue;
      const cand = m.last ?? '';
      if (emailLocal && cand.length >= 3 && emailLocal.includes(cand)) add(id, CONF_SURNAME_TOKEN, 'surname_token');
      else if (ln && cand && (cand === ln || cand.startsWith(ln) || ln.startsWith(cand))) add(id, CONF_NAME_PREFIX, 'name_prefix');
    }
  }

  // Email-local candidates (same normalized local part AND same domain — the domain guard
  // keeps 'john@a.com' from matching 'john@b.com').
  const incoming = identifiers.filter(i => i.kind === 'email').map(i => i.value);
  const key = (e: string) => {
    const local = normalizeEmailLocalPart(e);
    const domain = e.split('@')[1]?.trim().toLowerCase();
    return local && domain ? `${local}@${domain}` : null;
  };
  const incomingKeys = new Set(incoming.map(key).filter(Boolean) as string[]);
  if (incomingKeys.size) {
    const { data } = await supabase
      .from('entity_identifiers')
      .select('entity_id, value, entities!inner(status)')
      .eq('workspace_id', workspaceId)
      .eq('kind', 'email')
      .eq('status', 'active')
      .eq('entities.status', 'active')
      .limit(20000);
    for (const r of (data as { entity_id: string; value: string }[]) ?? []) {
      const k = key(r.value);
      if (k && incomingKeys.has(k)) add(r.entity_id, CONF_EMAIL_LOCAL, 'email_local_part');
    }
  }

  return [...best.values()].sort((a, b) => b.confidence - a.confidence).slice(0, 5);
}

/**
 * Resolve an entity by any of its identifiers; create one if none match.
 * The entry point for ingestion — every observation needs an entity.
 *
 * `opts.nameHint` enables a safe last-resort name fallback (persons only) that
 * attaches to a unique corroborated existing person rather than forking a
 * duplicate — see resolvePersonByNameFallback. Callers that have the incoming
 * name (e.g. contact ingestion) should pass it; callers that don't are unaffected.
 *
 * `opts.proposeDuplicates` (Piece 4) — for high-stakes single-record ingestion only. When a
 * NEW person entity is forked (no confident match), record a merge proposal if a plausible
 * duplicate exists, so a human confirms instead of the duplicate sitting silently. OFF by
 * default and never set on bulk imports (it costs two extra bounded queries per create).
 */
export async function getOrCreateEntity(
  supabase: SupabaseClient,
  workspaceId: string,
  type: EntityType,
  identifiers: Identifier[],
  opts?: {
    nameHint?: { first_name?: string | null; last_name?: string | null };
    proposeDuplicates?: boolean;
    /** The system creating or matching this entity — stamped on every identifier it writes. */
    source?: string | null;
  },
): Promise<string> {
  // Resolve against the implied forms too, not just what the caller happened to
  // send — a vanity handle arriving as a `linkedin_member_id` must find a record
  // that stored the same person as a `linkedin_url`.
  identifiers = expandIdentifiers(identifiers);
  for (const id of identifiers) {
    const existing = await resolveEntity(supabase, workspaceId, id);
    if (existing) {
      await attachIdentifiers(supabase, workspaceId, existing, identifiers, opts?.source);
      return existing;
    }
  }

  // No identifier matched. Before forking a new person, try the corroborated
  // fallbacks — these prevent the duplicate that merge_contacts would later fix.
  if (type === 'person') {
    // 1) Name fallback: exact first name + surname corroboration (needs a name hint).
    if (opts?.nameHint) {
      const matched = await resolvePersonByNameFallback(supabase, workspaceId, identifiers, opts.nameHint);
      if (matched) {
        await attachIdentifiers(supabase, workspaceId, matched, identifiers, opts?.source);
        return matched;
      }
    }
    // 2) Normalised email local-part: catches the nameless bare-email fork the
    //    name tier can't (fakelenaquist9 vs fakelenaquist15). Needs no name hint.
    const byLocal = await resolvePersonByEmailLocalPart(supabase, workspaceId, identifiers);
    if (byLocal) {
      await attachIdentifiers(supabase, workspaceId, byLocal, identifiers, opts?.source);
      return byLocal;
    }
  }

  const { data, error } = await supabase
    .from('entities')
    .insert({ workspace_id: workspaceId, type, status: 'active' })
    .select('id')
    .single();
  if (error || !data) throw new Error(`failed to create entity: ${error?.message}`);

  await attachIdentifiers(supabase, workspaceId, data.id, identifiers, opts?.source);

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

    // We just forked a NEW person. If a plausible duplicate exists, surface a merge
    // proposal instead of letting the duplicate sit silently. Best-effort — a hiccup
    // here must never fail ingestion.
    //
    // Now on by DEFAULT. It was opt-in, and the paths that most needed it were the
    // ones that didn't ask: the LinkedIn handler and enrichment both forked people
    // silently for months, and nobody learned about it until someone opened a record
    // and saw the same human twice. A fork we can't prevent should at least be
    // visible. Bulk importers opt OUT explicitly — a 4,000-row lead list would
    // otherwise bury the queue in proposals nobody asked for.
    if (opts?.proposeDuplicates !== false) {
      try {
        const candidates = await detectDuplicateCandidates(supabase, workspaceId, identifiers, opts?.nameHint, data.id);
        if (candidates.length) {
          await upsertIdentityProposal(supabase, workspaceId, { entityId: data.id, candidates, kind: 'merge', stakes: 'high' });
        }
      } catch { /* proposal is best-effort */ }
    }
  }

  return data.id;
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
  /**
   * Whether the rollback manifest was actually written.
   *
   * False means the merge happened and can NEVER be undone. Worth returning rather than only
   * logging: the caller is the one holding a UI that offers an undo, and offering one that
   * cannot work is a worse promise than admitting it up front.
   */
  reversible?: boolean;
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
  /**
   * WHY these two are one record.
   *
   * ⚠️ Optional only so the existing callers keep compiling — it should always be passed.
   * Merging two humans is the least reversible thing this product does to somebody's data,
   * and until now the log recorded everything that MOVED and nothing about the decision. You
   * could reverse a merge you could not explain, which is the wrong half to have.
   */
  why?: {
    /** The identifier kind that made them one — email, linkedin_url, domain. */
    matchedKind?: string | null;
    /** Its value. What a person reads when they ask why these two are the same person. */
    matchedValue?: string | null;
    reason?: 'identifier_match' | 'human_review' | 'duplicate_sweep' | 'agent' | string;
    confidence?: number | null;
    /** A user id, or the job that decided. */
    actor?: string | null;
  },
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

  // Provenance — every row we re-point is recorded so unmergeEntities can put it back
  // exactly. Deletions (dedup self-loops / duplicate memberships) are NOT recorded: they
  // were redundant, so a reversal doesn't need them. The v1 contacts row IS snapshotted
  // (it gets hard-deleted below) so un-merge can recreate it.
  const prov: MergeProvenance = {
    identifiers: [], claims: [], observations: [], relationships: [], collections: [], plain: {}, contact: null,
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
    prov.identifiers.push(id.id);
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
    prov.claims.push(c.id);
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
    prov.observations.push(o.id);
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
    prov.relationships.push({ id: r.id, from: r.from_entity_id, to: r.to_entity_id }); // ORIGINAL endpoints
    summary.relationships_repointed++;
  }

  // workspace_graph_edges — the SAME re-point the relationships table gets, and it was missing.
  // Edges are keyed by (subject_id, object_id) and nothing repointed them, so every merge ever
  // performed left its edges aimed at a tombstone: dozens of them across prod when this was found.
  // A committee map built from REPORTS_TO / CHAMPIONS silently loses a member each time, and
  // resolveEntity filters status='active', so the edge does not error — it just stops resolving.
  const { data: keepGe } = await supabase
    .from('workspace_graph_edges').select('subject_id, object_id, relationship')
    .eq('workspace_id', workspaceId)
    .or(`subject_id.eq.${keepId},object_id.eq.${keepId}`);
  const keepGeKey = new Set(((keepGe as { subject_id: string; object_id: string; relationship: string }[]) ?? [])
    .map(r => `${r.subject_id}|${r.object_id}|${r.relationship}`));
  const { data: dropGe } = await supabase
    .from('workspace_graph_edges').select('id, subject_id, object_id, relationship')
    .eq('workspace_id', workspaceId)
    .or(`subject_id.eq.${dropId},object_id.eq.${dropId}`);
  for (const g of (dropGe as { id: string; subject_id: string; object_id: string; relationship: string }[]) ?? []) {
    const subject = g.subject_id === dropId ? keepId : g.subject_id;
    const object  = g.object_id  === dropId ? keepId : g.object_id;
    // A self-edge ("Kim REPORTS_TO Kim") is what a merge makes of an edge between the two halves
    // of one person, and a duplicate is what it makes of the same fact recorded on both.
    if (subject === object || keepGeKey.has(`${subject}|${object}|${g.relationship}`)) {
      await supabase.from('workspace_graph_edges').delete().eq('id', g.id);
      summary.relationships_removed++;
      continue;
    }
    keepGeKey.add(`${subject}|${object}|${g.relationship}`);
    await supabase.from('workspace_graph_edges').update({ subject_id: subject, object_id: object }).eq('id', g.id);
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
      prov.collections.push(c.collection_id);
      summary.collections_moved++;
    }
  }

  // plain re-points — PK-only tables + the v1 contact_id back-references
  for (const [table, col] of PLAIN_REPOINTS) {
    const { data: moved } = await supabase.from(table).update({ [col]: keepId }).eq(col, dropId).select('id');
    if (moved && moved.length) {
      summary.rows_repointed[table] = moved.length;
      prov.plain[table] = (moved as { id: string }[]).map(m => m.id);
    }
  }

  // snapshot then delete the duplicate v1 contacts row (entity tombstone preserves lineage)
  const { data: contactRow } = await supabase.from('contacts').select('*').eq('id', dropId).maybeSingle();
  prov.contact = (contactRow as Record<string, unknown> | null) ?? null;
  await supabase.from('contacts').delete().eq('id', dropId);
  await supabase.from('entities').update({ status: 'merged', merged_into: keepId }).eq('id', dropId);

  // Record provenance so this merge is reversible. Best-effort: a logging failure must
  // not fail the merge — it only means this particular merge can't be un-merged later.
  try {
    // ⚠️ `.insert()` RESOLVES with an error; it does not throw. So the try/catch around it
    // caught nothing and every failure passed as success — which is why a batch of merges has no log
    // row and nothing anywhere says so. Check the returned error.
    const { error: logErr } = await supabase.from('entity_merge_log').insert({
      workspace_id: workspaceId, keep_id: keepId, drop_id: dropId, payload: prov,
      matched_kind:  why?.matchedKind  ?? null,
      matched_value: why?.matchedValue ?? null,
      // Unstated is recorded as unstated. A default of "identifier_match" would be the log
      // asserting a basis nobody gave it, which is worse than an honest blank.
      reason:        why?.reason       ?? null,
      confidence:    why?.confidence   ?? null,
      actor:         why?.actor        ?? null,
    });
    summary.reversible = true;
  } catch (e) {
    // The merge STANDS — a logging failure must never undo somebody's data operation. But it
    // must not be silent either: without the log this merge can never be reversed, and
    // "no log row" was indistinguishable from "never logged". A batch of merges in one month has no
    // row and there is no way to tell which of the two happened to them.
    console.error('[mergeEntities] provenance log FAILED — this merge is NOT reversible', {
      workspaceId, keepId, dropId, error: (e as Error)?.message,
    });
    summary.reversible = false;
  }

  return summary;
}

// PK-only tables re-pointed wholesale on merge, and reversed on un-merge. Shared by
// mergeEntities (log the moved ids) and unmergeEntities (set them back).
const PLAIN_REPOINTS: [string, string][] = [
  ['predictions', 'entity_id'], ['claim_jobs', 'entity_id'], ['crm_hygiene_proposals', 'entity_id'],
  ['outbound_events', 'entity_id'], ['leads', 'contact_id'], ['workspace_system_log', 'contact_id'],
];

interface MergeProvenance {
  identifiers: string[];
  claims: string[];
  observations: string[];
  relationships: { id: string; from: string; to: string }[]; // original endpoints
  collections: string[];                                      // collection_ids moved
  plain: Record<string, string[]>;                            // table -> moved row ids
  contact: Record<string, unknown> | null;                    // snapshot of the deleted v1 contacts row
}

export interface UnmergeSummary {
  keep_id: string;
  drop_id: string;
  identifiers: number;
  claims: number;
  observations: number;
  relationships: number;
  collections: number;
  rows_repointed: Record<string, number>;
  contact_restored: boolean;
}

/**
 * Reverse a merge recorded in entity_merge_log — the forward-only un-merge. Puts every
 * re-pointed row back on the drop entity, restores the deleted v1 contacts row from its
 * snapshot, and re-activates the tombstone. Merges done before provenance existed have no
 * log row and throw `not_reversible`; a log is consumed once (unmerged_at), so a second
 * un-merge of the same tombstone also throws.
 *
 * Not restored: rows the merge DELETED as redundant (self-loop / duplicate edges, duplicate
 * collection memberships). They were dedup casualties, not data — the reversal is complete
 * for everything that carried information.
 */
export async function unmergeEntities(
  supabase: SupabaseClient,
  workspaceId: string,
  dropId: string,
): Promise<UnmergeSummary> {
  const { data: logRow } = await supabase
    .from('entity_merge_log')
    .select('id, keep_id, drop_id, payload')
    .eq('workspace_id', workspaceId).eq('drop_id', dropId).is('unmerged_at', null)
    .order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (!logRow) throw new Error('not_reversible'); // pre-provenance merge, or already un-merged

  const keepId = (logRow as { keep_id: string }).keep_id;
  const p = (logRow as { payload: MergeProvenance }).payload;

  const { data: drop } = await supabase
    .from('entities').select('id, status').eq('id', dropId).eq('workspace_id', workspaceId).maybeSingle();
  if (!drop) throw new Error('drop entity not found');
  if ((drop as { status: string }).status !== 'merged') throw new Error('entity is not a merged tombstone');

  const summary: UnmergeSummary = {
    keep_id: keepId, drop_id: dropId,
    identifiers: 0, claims: 0, observations: 0, relationships: 0, collections: 0,
    rows_repointed: {}, contact_restored: false,
  };

  for (const id of p.identifiers ?? []) {
    await supabase.from('entity_identifiers').update({ entity_id: dropId }).eq('id', id);
    summary.identifiers++;
  }
  for (const id of p.claims ?? []) {
    await supabase.from('claims').update({ entity_id: dropId }).eq('id', id);
    summary.claims++;
  }
  for (const id of p.observations ?? []) {
    await supabase.from('observations').update({ entity_id: dropId }).eq('id', id);
    summary.observations++;
  }
  for (const r of p.relationships ?? []) {
    await supabase.from('relationships').update({ from_entity_id: r.from, to_entity_id: r.to }).eq('id', r.id);
    summary.relationships++;
  }
  for (const cid of p.collections ?? []) {
    await supabase.from('collection_entities').update({ entity_id: dropId }).eq('entity_id', keepId).eq('collection_id', cid);
    summary.collections++;
  }
  for (const [table, col] of PLAIN_REPOINTS) {
    const ids = p.plain?.[table];
    if (ids && ids.length) {
      await supabase.from(table).update({ [col]: dropId }).in('id', ids);
      summary.rows_repointed[table] = ids.length;
    }
  }

  // Recreate the v1 contacts row from the snapshot taken at merge time.
  if (p.contact) {
    const { error: cErr } = await supabase.from('contacts').insert(p.contact);
    if (!cErr) summary.contact_restored = true;
    else console.warn('[unmergeEntities] contact restore failed:', cErr.message);
  }

  // Re-activate the tombstone and consume the log row.
  await supabase.from('entities').update({ status: 'active', merged_into: null }).eq('id', dropId);
  await supabase.from('entity_merge_log').update({ unmerged_at: new Date().toISOString() }).eq('id', (logRow as { id: string }).id);

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
  /**
   * HOW the name matched, which is what separates a resolution from a guess.
   *
   * `exact` / `prefix` — they typed a name or the start of one. "Thad" → Thaddeus.
   * `contains`         — the term appeared INSIDE a longer name. "Nell" → Agathe
   *                      VanNELLe. Sometimes right, often a coincidence of spelling.
   * `company`          — matched the employer, not the person. "the Fernpoint guy".
   */
  matched_on?: 'exact' | 'prefix' | 'contains' | 'company';
}

export type FocusResolution =
  | { status: 'resolved'; entity_id: string }
  /**
   * Two or more people fit — OR one fits only loosely, which is the same problem wearing a
   * different face. `needs_confirmation` says which: several real candidates, versus a
   * single guess the operator should get to veto.
   */
  | { status: 'ambiguous'; candidates: FocusCandidate[]; needs_confirmation?: boolean; matched_on?: string }
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

  // Not a hard identifier — treat it as a name.
  const candidates = await searchEntitiesByName(supabase, workspaceId, f);

  // A one-word name that is a company's DOMAIN LABEL ("brightharbor" → brightharbor.example) is that
  // company, when no name matched it cleanly. People write a company the way its website spells
  // it, and the claim name may carry spaces or a suffix the operator never types (GET-238).
  if (!candidates.some(c => c.matched_on === 'exact' || c.matched_on === 'prefix')) {
    const byDomain = await resolveByDomainLabel(supabase, workspaceId, f);
    if (byDomain) return { status: 'resolved', entity_id: byDomain };
  }

  if (candidates.length === 0) return { status: 'not_found' };

  if (candidates.length === 1) {
    const only = candidates[0];
    // ⭐ ONE CANDIDATE IS NOT THE SAME AS ONE ANSWER. A name that matched exactly or by
    // prefix is a resolution — that is how people refer to each other. A term found INSIDE
    // a longer name, or via the employer, is a guess, and a guess that goes unchallenged is
    // worse than a question: the agent briefed "Nell" as Agathe VanNELLe and reported
    // her empty pipeline, which reads as a fact about a deal that was never looked at.
    //
    // Returned as `ambiguous` on purpose: every caller already handles that branch and hands
    // it to the operator. `needs_confirmation` is what lets the agent phrase it as "did you
    // mean…" rather than "which one".
    if (only.matched_on === 'exact' || only.matched_on === 'prefix') {
      return { status: 'resolved', entity_id: only.entity_id };
    }
    return { status: 'ambiguous', candidates, needs_confirmation: true, matched_on: only.matched_on };
  }

  // Several fit. If any matched cleanly, those are the real candidates — a prefix hit and a
  // mid-word coincidence are not equals, and offering both makes the operator do the sorting.
  const strong = candidates.filter(c => c.matched_on === 'exact' || c.matched_on === 'prefix');
  const shortlist = strong.length ? strong : candidates;
  if (shortlist.length === 1) return { status: 'resolved', entity_id: shortlist[0].entity_id };
  return { status: 'ambiguous', candidates: shortlist.slice(0, 10) };
}

/** The one active entity whose domain is `<label>.<tld>`, for a single-word label; else null. */
async function resolveByDomainLabel(supabase: SupabaseClient, workspaceId: string, term: string): Promise<string | null> {
  const label = term.trim().toLowerCase();
  if (!/^[a-z0-9-]{4,63}$/.test(label)) return null;
  const { data } = await supabase
    .from('entity_identifiers')
    .select('entity_id, value')
    .eq('workspace_id', workspaceId)
    .eq('kind', 'domain')
    .eq('status', 'active')
    .ilike('value', `${label}.%`)
    .limit(10);
  // `brightharbor.example` yes; `brightharbor.co.example` yes; `brightharborapp.example` no (the label must end at the dot).
  const ids = [...new Set(((data as { entity_id: string; value: string }[] | null) ?? [])
    .filter(r => String(r.value).toLowerCase().split('.')[0] === label)
    .map(r => r.entity_id))];
  if (ids.length !== 1) return null;
  const { data: ent } = await supabase.from('entities').select('id')
    .eq('workspace_id', workspaceId).eq('id', ids[0]).eq('status', 'active').maybeSingle();
  return (ent as { id: string } | null)?.id ?? null;
}

/**
 * Match entities by display name.
 *
 * Filtering happens in memory, so we must actually HOLD every name claim to do
 * it. PostgREST caps a single response at 1000 rows regardless of the `.limit()`
 * we ask for — so the old `.limit(5000)` silently searched the first 1000 name
 * claims of a workspace that had several thousand, and anyone outside that window was
 * invisible to the agent. It would tell you a person "isn't in the workspace"
 * while they sat in the Accounts table. Page through the lot instead.
 */
const NAME_PROPS = ['first_name', 'last_name', 'name', 'company', 'job_title'];
const PAGE = 1000;              // PostgREST's hard per-response ceiling
const MAX_NAME_CLAIMS = 50_000; // sanity bound; ~10k entities


// ─── Near-misses ────────────────────────────────────────────────────────────
//
// Everything above matches on exact substring, so a name typed slightly wrong finds NOTHING
// and the agent reports that an account is not in the workspace while it sits in the Accounts
// table. Watching it happen: one mistyped company name cost a CRM lookup and three record
// reads to recover from, and the operator's reasonable conclusion was that the product could
// not find its own data.
//
// So an exact pass that found nothing falls through to a fuzzy one. Deliberately a FALLBACK
// and never a widener: when the exact pass found something, that IS the answer, and mixing
// near-misses into a good result set is how "Jack" starts returning Jacqueline.
//
// Damerau-Levenshtein rather than plain Levenshtein, because the overwhelmingly common typo is
// two adjacent characters swapped — "Harbolrine" for "Harborline" — and plain Levenshtein charges
// two edits for a transposition, which is exactly enough to push a real match past the
// threshold.
function editDistance(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev2: number[] = [];
  let prev: number[] = Array.from({ length: n + 1 }, (_, j) => j);
  let cur: number[] = new Array(n + 1);
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        cur[j] = Math.min(cur[j], prev2[j - 2] + 1);   // the swap, priced as one edit
      }
    }
    prev2 = prev; prev = cur; cur = new Array(n + 1);
  }
  return prev[n];
}

/**
 * How wrong a name may be, by how long it is. Short names get NO slack: at three characters
 * one edit reaches half the alphabet, and "Jon" matching "Tom" is worse than finding nothing.
 * The allowance grows with length because a long name has room to be mistyped without becoming
 * a different name.
 */
function typoBudget(len: number): number {
  if (len <= 4) return 0;
  if (len <= 7) return 1;
  if (len <= 12) return 2;
  return 3;
}

/** Is `candidate` a plausible mistyping of `needle`? Compared against the whole name and each
 *  word of it, so a surname typo still lands and a company suffix does not block the match. */
function nearMiss(needle: string, candidate: string): number | null {
  const budget = typoBudget(needle.length);
  if (budget === 0) return null;
  const c = candidate.toLowerCase();
  let best: number | null = null;
  for (const piece of [c, ...c.split(/\s+/)]) {
    if (!piece) continue;
    // A length gap wider than the budget cannot be closed by edits; skip the work.
    if (Math.abs(piece.length - needle.length) > budget) continue;
    const d = editDistance(needle, piece);
    if (d <= budget && (best === null || d < best)) best = d;
  }
  return best;
}

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

  let out: FocusCandidate[] = [];
  for (const [id, m] of byEntity) {
    const full = m.name
      ? String(m.name)
      : [m.first_name, m.last_name].filter(Boolean).join(' ');
    const first = m.first_name ? String(m.first_name) : '';
    const last = m.last_name ? String(m.last_name) : '';
    const company = m.company ? String(m.company) : '';

    // "Thad" should find Thaddeus. A first or last name that STARTS with the term
    // counts, as does the full name containing it — so partial first names and
    // surnames both resolve, which is how people actually refer to each other.
    // ── HOW it matched, not just THAT it matched ──
    //
    // "Thad" finding Thaddeus is a resolution. "Nell" finding Agathe VanNELLe is a
    // coincidence of spelling, and the two were indistinguishable — both returned one
    // candidate, and one candidate always resolved. So the agent confidently briefed the
    // wrong person and reported an empty deal.
    const hay = full.toLowerCase();
    const fl = first.toLowerCase();
    const ll = last.toLowerCase();
    // The same name written with or without its spaces and punctuation is the same name:
    // "Brightharbor" is the company "Bright Harbor", and missing that sent the lookup to a
    // PERSON who works there, as a guess to confirm (GET-238). Whole-name only, and never
    // for a short needle, where squashing would make unrelated names collide.
    const sq = (s: string) => s.replace(/[^a-z0-9]/g, '');
    const needleSq = sq(needle);
    const hayMatchesSquashed = needleSq.length >= 5 && sq(hay) === needleSq;
    const hayPrefixSquashed = needleSq.length >= 5 && !hayMatchesSquashed && sq(hay).startsWith(needleSq);
    let matched_on: FocusCandidate['matched_on'] | null = null;
    if (hay === needle || fl === needle || ll === needle || hayMatchesSquashed) matched_on = 'exact';
    else if (hay.startsWith(needle) || fl.startsWith(needle) || ll.startsWith(needle) || hayPrefixSquashed) matched_on = 'prefix';
    else if (hay.includes(needle)) matched_on = 'contains';
    // Let a company name find the people at it ("the Fernpoint guy") — but that is a match
    // on the EMPLOYER, so it names a room rather than a person.
    else if (company && company.toLowerCase().includes(needle)) matched_on = 'company';

    if (!matched_on) continue;
    out.push({
      entity_id: id,
      name: full || null,
      detail: company || (m.job_title ? String(m.job_title) : null),
      matched_on,
    });
  }

  // The claims scan above is status-BLIND, but a merge leaves conflicting name
  // claims on the tombstone ("conflicts stay on the drop") and a parked lead keeps
  // its name claims too — so without this, a merged duplicate or a parked lead
  // still surfaces here and the agent reports a "duplicate" that no longer exists
  // (the person-appears-twice bug). Drop any candidate whose entity is not active.
  if (out.length) {
    const ids = out.map(o => o.entity_id);
    const active = new Set<string>();
    for (let i = 0; i < ids.length; i += PAGE) {
      const { data: ents } = await supabase
        .from('entities')
        .select('id')
        .eq('workspace_id', workspaceId)
        .eq('status', 'active')
        .in('id', ids.slice(i, i + PAGE));
      for (const e of (ents as { id: string }[] | null) ?? []) active.add(e.id);
    }
    out = out.filter(o => active.has(o.entity_id));
  }

  // Same v1/v2 sync gap as resolveEntity: a contact whose name CLAIMS went missing
  // or stale is invisible to the claim search above, even though the UI shows them
  // straight from the `contacts` table. Union in contacts matches so a real account
  // still resolves by name. Filter the query by the first token, then apply the same
  // match rule in memory (entity_id == contact.id).
  const token = needle.split(/\s+/)[0]?.replace(/[(),]/g, '') ?? '';
  if (token) {
    const seen = new Set(out.map(o => o.entity_id));
    const { data: contacts } = await supabase
      .from('contacts')
      .select('id, first_name, last_name, company, job_title')
      .eq('workspace_id', workspaceId)
      .or(`first_name.ilike.%${token}%,last_name.ilike.%${token}%,company.ilike.%${token}%`)
      .limit(50);
    for (const c of (contacts as any[]) ?? []) {
      if (seen.has(c.id)) continue;
      const full = [c.first_name, c.last_name].filter(Boolean).join(' ');
      const first = String(c.first_name ?? '').toLowerCase();
      const last = String(c.last_name ?? '').toLowerCase();
      const company = String(c.company ?? '').toLowerCase();
      const matches =
        (full && full.toLowerCase().includes(needle)) ||
        first.startsWith(needle) || last.startsWith(needle) ||
        (company && company.includes(needle));
      if (!matches) continue;
      seen.add(c.id);
      out.push({ entity_id: c.id, name: full || null, detail: c.company || c.job_title || null });
    }
  }

  // Nothing matched exactly. Try again allowing for a typo — a FALLBACK, never a widener.
  if (!out.length) {
    const scored: Array<{ c: FocusCandidate; d: number }> = [];
    for (const [id, m] of byEntity) {
      const full = m.name ? String(m.name) : [m.first_name, m.last_name].filter(Boolean).join(' ');
      const company = m.company ? String(m.company) : '';
      const d = [full, company].filter(Boolean)
        .map(v => nearMiss(needle, v))
        .filter((x): x is number => x !== null)
        .sort((a, b) => a - b)[0];
      if (d === undefined) continue;
      scored.push({ c: { entity_id: id, name: full || null, detail: company || (m.job_title ? String(m.job_title) : null) }, d });
    }
    if (scored.length) {
      // Only the CLOSEST band. Returning everything within budget turns one typo into an
      // ambiguity prompt listing six strangers, which is a worse answer than not finding it.
      const closest = Math.min(...scored.map(x => x.d));
      const near = scored.filter(x => x.d === closest).map(x => x.c);
      const ids = near.map(o => o.entity_id);
      const active = new Set<string>();
      for (let i = 0; i < ids.length; i += PAGE) {
        const { data: ents } = await supabase
          .from('entities').select('id')
          .eq('workspace_id', workspaceId).eq('status', 'active')
          .in('id', ids.slice(i, i + PAGE));
        for (const e of (ents as { id: string }[] | null) ?? []) active.add(e.id);
      }
      const alive = near.filter(o => active.has(o.entity_id));
      if (alive.length) return alive.slice(0, 10);
    }
  }

  return out;
}
