import { randomUUID, createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { embed } from '../embed.js';
import { rawVisible, type ReadContext } from './readContext.js';
import { derivedViewerForContext, filterDerivedForViewer } from '../privacy/messagePrivacy.mjs';
import { noteFreshness, noteDecaysAt, resolveSaidAt, pairReplacements, DEAL_POSITION_CATEGORIES, type Replacement } from './claimTime.js';
import type { Freshness } from './claims.js';
import { normalizeClaimCategory, ACCOUNT_ROLLUP_CATEGORIES, isIntelClaim, claimLabel } from './claimCategories.js';

// Build the text we embed for a note claim. MUST match the embeddings worker's
// rowText() (apps/worker/src/workers/embeddings.mjs) so sync + backfill produce
// comparable vectors: human title/category + content, with a larger budget for
// documents (briefs/transcripts) than plain notes.
function noteEmbedText(value: {
  category?: string;
  content?: string;
  metadata?: Record<string, unknown>;
}): string {
  const meta = value.metadata ?? {};
  const head = (meta.title as string) || value.category || 'note';
  const cap = meta.doc_type ? 8000 : 2000;
  return `${head}\n${value.content ?? ''}`.slice(0, cap);
}

// Notes — the human-asserted memory layer, now claim-shaped.
//
// Each note is an `asserted` claim on an entity (workspace / company / person)
// with property `note.<uuid>` and value {category, content, source, metadata}.
// Asserted claims have no observation backing, so the claim engine never
// overwrites them. "Delete" is invalidation via invalid_at — per the v2 rule,
// claims are never hard-deleted. Replaces the v1 workspace_memories table.

export interface Note {
  id: string;
  workspace_id: string;
  entity_id: string;
  category: string;
  /** A concise 2–4 word tag for the claim (e.g. "Failed Vendor Pilot"), used as the
   *  chip label so the UI shows something meaningful instead of the first two words
   *  of the full sentence. Emitted by the extractor / backfilled; null on old rows. */
  label: string | null;
  /** Whether the claim is about the person or their company. From the controlled
   *  claim taxonomy (see claimCategories.ts). Null on legacy/document rows. */
  about: string | null;
  content: string;
  source: string;
  metadata: Record<string, unknown>;
  /** The source observation(s) this claim was extracted/derived from. The
   *  structural evidence chain back to the raw activity. Empty on manual/legacy rows. */
  supporting_observation_ids: string[];
  /** Confidence in this fact, 0–1. 1 = user-asserted; <1 = inferred/drafted. */
  confidence: number;
  /** Stable slot a fact belongs to (e.g. 'playbook.pricing'); lets a new fact
   *  supersede the previous one for the same belief instead of duplicating. */
  subject: string | null;
  /** When superseded, the id of the fact that replaced this one. */
  superseded_by: string | null;
  /** Last time the user re-confirmed this fact; resets staleness without losing
   *  the original created_at. Null if never reaffirmed. */
  reaffirmed_at: string | null;
  created_at: string;
  updated_at: string;
  is_active: boolean;
  /** When the claim was retired (superseded, resolved away), null while current. Read by the
   *  point-in-time account health (GET-804): a claim counts on a date it was valid on. */
  invalid_at?: string | null;
  /** When the source SAID it (valid_from). Older claims written before GET-770 carry their write time. */
  said_at: string;
  /** Computed at read from the category and said_at (GET-770) — the stored column is never trusted. */
  freshness: Freshness;
  /** False for bookkeeping on the note shelf: documents, health summaries, speaker-link notes (GET-417). */
  intel: boolean;
}

const COLUMNS =
  'id, workspace_id, entity_id, property, value, ' +
  'confidence, epistemic_class, freshness, valid_from, invalid_at, computed_at, ' +
  'supporting_observation_ids';

function noteFromClaim(c: Record<string, unknown>): Note {
  const v = (c.value as Record<string, unknown> | null) ?? {};
  const meta = (v.metadata as Record<string, unknown>) ?? {};
  // Extracted facts written before the taxonomy carry Title-Case labels ("Pain Points",
  // "Preferences"), which no category filter matches. Normalize them on read. Documents
  // and manual notes keep their own categories, which are not taxonomy keys.
  const category = v.source === 'signal_extraction'
    ? normalizeClaimCategory(v.category as string)
    : ((v.category as string) ?? 'General');
  return {
    id: c.id as string,
    workspace_id: c.workspace_id as string,
    entity_id: c.entity_id as string,
    category,
    // Built by code where the category says what the chip is (GET-959), on read too, so rows
    // written before it read the same as new ones. Bookkeeping keeps whatever it stored.
    label: isIntelClaim(v) ? claimLabel({ category, label: v.label as string, content: v.content as string, metadata: meta }) : ((v.label as string) ?? null),
    about: (meta.about as string) ?? null,
    content: (v.content as string) ?? '',
    source: (v.source as string) ?? 'manual',
    metadata: meta,
    supporting_observation_ids: (c.supporting_observation_ids as string[]) ?? [],
    confidence: typeof c.confidence === 'number' ? (c.confidence as number) : 1,
    subject: (meta.subject as string) ?? null,
    superseded_by: (meta.superseded_by as string) ?? null,
    reaffirmed_at: (meta.reaffirmed_at as string) ?? null,
    created_at: (c.valid_from as string) ?? (c.computed_at as string),
    updated_at: c.computed_at as string,
    is_active: c.invalid_at == null,
    invalid_at: (c.invalid_at as string | null) ?? null,
    said_at: (c.valid_from as string) ?? (c.computed_at as string),
    freshness: noteFreshness(category, (c.valid_from as string) ?? (c.computed_at as string)),
    // A fact about the account, or bookkeeping on the same shelf (GET-417). Readers that show
    // facts — the Intel tab, get_account's FACTS, the dedup corpus — keep only `intel: true`.
    intel: isIntelClaim(v),
  };
}

/** The workspace entity id — every workspace has exactly one (per migration). */
export async function getWorkspaceEntityId(
  supabase: SupabaseClient,
  workspaceId: string,
): Promise<string | null> {
  const { data } = await supabase
    .from('entities')
    .select('id')
    .eq('workspace_id', workspaceId)
    .eq('type', 'workspace')
    .limit(1)
    .maybeSingle();
  return (data as { id: string } | null)?.id ?? null;
}

export interface ListNotesOpts {
  entityId?: string;
  entityIds?: string[];
  categories?: string[];
  /** Restrict to one subject slot — used to read a fact's supersession history. */
  subject?: string;
  limit?: number;
  offset?: number;
  includeInactive?: boolean;
  /** Only claims SAID at or after this ISO time (valid_from). */
  since?: string;
  /** Also claims retired at or after this ISO time (GET-804): the health trend scores past dates
   *  against the claims that were valid then, so a fact retired last week still counts before it. */
  retiredSince?: string;
}

/** List notes, newest first.
 *  With a member-scoped ReadContext, DOCUMENTS (transcripts, meeting_notes — raw
 *  content) owned by another rep are dropped. An extracted fact is shared unless it
 *  came out of a message: then a viewer reads it only if they may read that message
 *  (GET-253). See PRIVACY_MODEL.md. */
export async function listNotes(
  supabase: SupabaseClient,
  workspaceId: string,
  opts: ListNotesOpts = {},
  ctx?: ReadContext,
): Promise<Note[]> {
  let q = supabase
    .from('claims')
    .select(COLUMNS)
    .eq('workspace_id', workspaceId)
    .like('property', 'note.%');
  if (opts.retiredSince && !opts.includeInactive) q = q.or(`invalid_at.is.null,invalid_at.gte.${opts.retiredSince}`);
  else if (!opts.includeInactive) q = q.is('invalid_at', null);
  // `note.*` is the INTELLIGENCE namespace — it is what the person page renders.
  // The identity resolver used saveNote to leave itself breadcrumbs ("Linked this
  // meeting by transcript speaker name…") because it was the only reversible,
  // auditable, per-entity write available, and dozens of those ended up shown to reps
  // alongside real facts about the human. They are notes the system wrote to
  // itself; they are not intel. Excluded here while the write sites move to the
  // meeting's own `raw` and to workspace_system_log.
  q = q.not('value->>category', 'eq', 'Data Quality');
  if (opts.entityId) q = q.eq('entity_id', opts.entityId);
  if (opts.entityIds?.length) q = q.in('entity_id', opts.entityIds);
  if (opts.since) q = q.gte('valid_from', opts.since);
  q = q.order('valid_from', { ascending: false });
  if (opts.limit != null) {
    const off = opts.offset ?? 0;
    q = q.range(off, off + opts.limit - 1);
  }

  const { data, error } = await q;
  if (error) throw error;

  // Category is inside JSONB value — filter in JS to keep the query portable.
  let notes = (data ?? []).map(c => noteFromClaim(c as unknown as Record<string, unknown>));
  if (opts.categories?.length) {
    const set = new Set(opts.categories);
    // saveNote stores a label outside the taxonomy ('ICP', 'Market') as 'general' and keeps the
    // label in metadata.category_raw (GET-346). A filter by that label still means those notes:
    // the ICP scorecard seed and the per-contact ICP scorers read them this way (GET-875).
    notes = notes.filter(n => set.has(n.category) || (n.category === 'general' && typeof n.metadata?.category_raw === 'string' && set.has(n.metadata.category_raw)));
  }
  if (opts.subject) {
    notes = notes.filter(n => n.subject === opts.subject);
  }
  // Member scope: drop other reps' raw documents. A document is a note WITH a
  // doc_type; its owner is stamped in metadata.owner_user_id. Facts (no doc_type)
  // are the shared extracted intel and stay visible.
  if (ctx && ctx.viewerScope === 'member') {
    notes = notes.filter(n =>
      !n.metadata?.doc_type || rawVisible(n.metadata.owner_user_id as string | null | undefined, ctx),
    );
  }
  // A fact pulled out of an email follows the email (GET-253).
  const viewer = await derivedViewerForContext(supabase, ctx);
  if (viewer) notes = await filterDerivedForViewer(supabase, workspaceId, notes, viewer);
  return notes;
}

/**
 * The notes an ACCOUNT record reads: everything saved on the company entity, plus its
 * people's extracted facts in the deal categories (ACCOUNT_ROLLUP_CATEGORIES).
 *
 * The account page, Deal Health (live and batch) and the company summary all read this, so
 * the record, the stored score and the summary rest on the same facts. A rolled-up fact
 * stays on the person; it is stamped `voiced_by_contact_id` so the account can say who
 * said it.
 */
export async function listAccountNotes(
  supabase: SupabaseClient,
  workspaceId: string,
  companyId: string,
  contactIds: string[],
  opts: { limit?: number; retiredSince?: string } = {},
  ctx?: ReadContext,
): Promise<Note[]> {
  const own = await listNotes(supabase, workspaceId, { entityId: companyId, limit: opts.limit ?? 200, retiredSince: opts.retiredSince }, ctx);
  if (!contactIds.length) return own;

  // Documents are excluded so a person's meeting notes can't crowd the facts off the page; the
  // category test runs in JS because legacy labels need normalizing.
  //
  // The test is `doc_type`, NOT `source = 'signal_extraction'`. It used to be the latter, which
  // meant "extracted by the worker" — and silently defined every OTHER writer out of the account.
  // A fact the revenue plugin recorded carries source 'fellow' or 'agent'; a health read carries
  // 'fellow:health'. Both are real extracted facts, both were filed on the right person in a
  // rollup category, and neither ever reached the account page. Measured on a customer workspace: well over
  // a hundred plugin-written and a handful of health facts on people, and about a thousand more on
  // companies through the same filter one layer up. A writer should not have to be the worker to be believed.
  // 1000 is PostgREST's row cap, far above any one account's people.
  const base = supabase
    .from('claims')
    .select(COLUMNS)
    .eq('workspace_id', workspaceId)
    .in('entity_id', contactIds)
    .like('property', 'note.%');
  const { data, error } = await (opts.retiredSince
    ? base.or(`invalid_at.is.null,invalid_at.gte.${opts.retiredSince}`)
    : base.is('invalid_at', null))
    .is('value->metadata->>doc_type', null)
    .order('valid_from', { ascending: false })
    .range(0, 999);
  if (error) throw error;

  const rollup = new Set(ACCOUNT_ROLLUP_CATEGORIES);
  let fromPeople = (data ?? [])
    .map(c => noteFromClaim(c as unknown as Record<string, unknown>))
    .filter(n => rollup.has(n.category))
    .map(n => ({ ...n, metadata: { ...n.metadata, voiced_by_contact_id: n.metadata.voiced_by_contact_id ?? n.entity_id } }));
  const viewer = await derivedViewerForContext(supabase, ctx);
  if (viewer) fromPeople = await filterDerivedForViewer(supabase, workspaceId, fromPeople, viewer);

  return [...own, ...fromPeople].sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''));
}

// ── The deal scope of an agent read (GET-798) ───────────────────────────────
//
// get_context and get_account on a PERSON used to read only that person's notes, and the deal
// lives mostly on the company: blockers, requirements and the stack are filed there. So an agent
// asking about the champion saw no blocker on a deal that had two. The scope below is the person
// plus their company's deal and stack facts; for a company it is the account read
// (listAccountNotes: its own notes plus its people's deal facts). Both go through listNotes /
// listAccountNotes, so the viewer filtering is the same one every other reader gets.

/** What a person's read borrows from their company: the deal topics and the stack. */
const COMPANY_FACTS_FOR_PERSON = new Set([...DEAL_POSITION_CATEGORIES, 'tech_stack']);

export interface DealScope {
  /** The entity's own notes, documents included. */
  own: Note[];
  /** Facts borrowed from the account: the company's (for a person) or its people's (for a company). */
  related: Note[];
  /** The entities `related` came from. */
  relatedIds: string[];
  /** The categories a related entity may contribute. */
  relatedCategories: ReadonlySet<string>;
}

/** The person's current company (works_at), or a company's people. */
async function accountLinks(
  supabase: SupabaseClient,
  workspaceId: string,
  entity: { id: string; type: string },
): Promise<string[]> {
  if (entity.type === 'person') {
    const { data } = await supabase.from('relationships')
      .select('to_entity_id')
      .eq('workspace_id', workspaceId).eq('from_entity_id', entity.id).eq('type', 'works_at')
      .is('valid_to', null).limit(1);
    const id = (data as { to_entity_id?: string }[] | null)?.[0]?.to_entity_id;
    return id ? [id] : [];
  }
  if (entity.type === 'company') {
    const { data } = await supabase.from('relationships')
      .select('from_entity_id')
      .eq('workspace_id', workspaceId).eq('to_entity_id', entity.id).eq('type', 'works_at')
      .is('valid_to', null).range(0, 999);
    return [...new Set(((data as { from_entity_id?: string }[] | null) ?? []).map(r => r.from_entity_id).filter(Boolean))] as string[];
  }
  return [];
}

export async function listDealScopeNotes(
  supabase: SupabaseClient,
  workspaceId: string,
  entity: { id: string; type: string },
  opts: { limit?: number } = {},
  ctx?: ReadContext,
): Promise<DealScope> {
  const limit = opts.limit ?? 100;
  const links = await accountLinks(supabase, workspaceId, entity).catch(() => [] as string[]);
  if (entity.type === 'company') {
    const all = await listAccountNotes(supabase, workspaceId, entity.id, links, { limit }, ctx);
    return {
      own: all.filter(n => n.entity_id === entity.id),
      related: all.filter(n => n.entity_id !== entity.id),
      relatedIds: links,
      relatedCategories: new Set(ACCOUNT_ROLLUP_CATEGORIES),
    };
  }
  const [own, company] = await Promise.all([
    listNotes(supabase, workspaceId, { entityId: entity.id, limit }, ctx),
    links.length
      ? listNotes(supabase, workspaceId, { entityId: links[0], limit: 200 }, ctx)
      : Promise.resolve([] as Note[]),
  ]);
  return {
    own,
    related: company.filter(n => !n.metadata?.doc_type && COMPANY_FACTS_FOR_PERSON.has(n.category)),
    relatedIds: links,
    relatedCategories: COMPANY_FACTS_FOR_PERSON,
  };
}

/**
 * What changed on this account lately (GET-798): claims retired by a newer one (invalid_at set,
 * metadata.superseded_by naming the successor), paired with that successor. Both sides go through
 * the same viewer filter as listNotes, and a pair is dropped when either side is not readable.
 * Best effort: a failed read returns no pairs rather than failing the account read.
 */
export async function listRecentlyReplaced(
  supabase: SupabaseClient,
  workspaceId: string,
  scope: { entityId: string; relatedIds?: string[]; relatedCategories?: ReadonlySet<string> },
  ctx?: ReadContext,
  { now = Date.now(), windowDays = 60, limit = 6 }: { now?: number; windowDays?: number; limit?: number } = {},
): Promise<Replacement[]> {
  const ids = [scope.entityId, ...(scope.relatedIds ?? [])];
  const cutoff = new Date(now - windowDays * 86_400_000).toISOString();
  const { data, error } = await supabase
    .from('claims')
    .select(COLUMNS)
    .eq('workspace_id', workspaceId)
    .in('entity_id', ids)
    .like('property', 'note.%')
    .not('invalid_at', 'is', null)
    .gte('invalid_at', cutoff)
    // Replaced by a newer claim, or settled with a reason and no successor (GET-1027).
    .or('value->metadata->>superseded_by.not.is.null,value->metadata->>superseded_why.not.is.null')
    .order('invalid_at', { ascending: false })
    .range(0, 199);
  if (error || !data?.length) return [];

  const rows = data as unknown as Record<string, unknown>[];
  const invalidAt = new Map(rows.map(r => [r.id as string, (r.invalid_at as string | null) ?? null]));
  const readable = async (notes: Note[]): Promise<Note[]> => {
    const viewer = await derivedViewerForContext(supabase, ctx);
    return viewer ? filterDerivedForViewer(supabase, workspaceId, notes, viewer) : notes;
  };
  const isFact = (n: Note) => n.intel && !n.metadata?.doc_type && n.content.trim() !== '';

  const whyOf = (n: Note) => (typeof n.metadata?.superseded_why === 'string' ? n.metadata.superseded_why as string : null);
  let retired = rows.map(noteFromClaim).filter(n => isFact(n) && (n.superseded_by || whyOf(n))
    && (n.entity_id === scope.entityId || !scope.relatedCategories || scope.relatedCategories.has(n.category)));
  retired = await readable(retired);
  const successorIds = [...new Set(retired.map(n => n.superseded_by).filter((id): id is string => !!id))];
  // Settled by what is on file rather than by a claim: the reason stands in as the new side.
  const settled = new Map(retired.filter(n => !n.superseded_by && whyOf(n)).map(n => [`settled:${n.id}`,
    { category: n.category, content: whyOf(n) as string, said_at: invalidAt.get(n.id) ?? n.said_at }]));
  if (!successorIds.length && !settled.size) return [];

  const { data: next, error: e2 } = successorIds.length
    ? await supabase.from('claims').select(COLUMNS).eq('workspace_id', workspaceId).in('id', successorIds)
    : { data: [], error: null };
  if (e2) return [];
  const successors = await readable(
    ((next ?? []) as unknown as Record<string, unknown>[]).map(noteFromClaim).filter(isFact),
  );

  return pairReplacements(
    retired.map(n => ({
      category: n.category, content: n.content, said_at: n.said_at,
      superseded_by: n.superseded_by ?? `settled:${n.id}`, invalid_at: invalidAt.get(n.id) ?? null,
    })),
    new Map([...successors.map(n => [n.id, { category: n.category, content: n.content, said_at: n.said_at }] as const), ...settled]),
    { now, windowDays, limit },
  );
}

export interface SaveNoteParams {
  /** Defaults to the workspace entity. */
  entityId?: string;
  category?: string;
  /** Concise 2–4 word chip label for the claim. Optional; the UI falls back to a
   *  derived short form when absent. */
  label?: string;
  content: string;
  source?: string;
  metadata?: Record<string, unknown>;
  /** Stable slot this fact belongs to, so it can be superseded later. */
  subject?: string;
  /** Source observation id(s) this claim was extracted from — the evidence chain. */
  supportingObservationIds?: string[];
  /** 0–1. Defaults to 1 (user-asserted). Lower it for inferred/drafted facts. */
  confidence?: number;
  /** When the source said it — the call's or the message's time (GET-770). Defaults to now. A
   *  backfill reading June must file June's facts under June, or they read as this week's news. */
  saidAt?: string | null;
}

export async function saveNote(
  supabase: SupabaseClient,
  workspaceId: string,
  params: SaveNoteParams,
): Promise<Note | null> {
  let entityId = params.entityId;
  if (!entityId) {
    const fallback = await getWorkspaceEntityId(supabase, workspaceId);
    if (!fallback) throw new Error('workspace entity not found');
    entityId = fallback;
  }
  const now = new Date().toISOString();
  const saidAt = resolveSaidAt(params.saidAt);
  const metadata: Record<string, unknown> = { ...(params.metadata ?? {}) };
  if (params.subject) metadata.subject = params.subject;
  // The controlled vocabulary, enforced where claims are actually written rather than wherever a
  // caller remembers (GET-346). The old default was 'General' — capitalised, outside the
  // vocabulary, and therefore invisible to every rollup that filters by key.
  const requested = String(params.category ?? '').trim();
  const category = normalizeClaimCategory(requested);
  // Keep what the caller asked for when it was not a category we know. Nothing is lost, and the
  // taxonomy mining can tell a coerced row from genuine `general` pressure — the share of `general`
  // is the number that decides whether a new category is needed, so inflating it with other
  // people's labels would corrupt that decision.
  if (requested && category === 'general' && requested.toLowerCase() !== 'general') {
    metadata.category_raw = requested;
  }
  const value: Record<string, unknown> = {
    category,
    content: params.content,
    source: params.source ?? 'manual',
    metadata,
  };
  // The chip, and the title of the signal this claim fires (GET-959): code-built where the
  // category defines it, else the writer's label, else the start of the fact.
  if (isIntelClaim(value)) value.label = claimLabel({ category, label: params.label, content: params.content, metadata });
  else if (params.label) value.label = params.label;
  const { data, error } = await supabase
    .from('claims')
    .insert({
      workspace_id: workspaceId,
      entity_id: entityId,
      property: `note.${randomUUID()}`,
      value,
      confidence: params.confidence ?? 1.0,
      epistemic_class: 'asserted',
      // A snapshot for SQL readers; every reader through noteFromClaim recomputes it (GET-770).
      freshness: noteFreshness(category, saidAt),
      decays_at: noteDecaysAt(category, saidAt),
      valid_from: saidAt,
      computed_at: now,
      supporting_observation_ids: params.supportingObservationIds ?? [],
    })
    .select(COLUMNS)
    .single();
  if (error) throw error;
  const saved = data ? noteFromClaim(data as unknown as Record<string, unknown>) : null;

  // Embed synchronously (best-effort) so the note is findable by semantic search
  // (search_notes / get_context) in the SAME session — instead of waiting up to
  // ~2min for the embedding worker's sweep. Falls back silently if there's no
  // OPENAI_API_KEY or the call fails; the worker backfills it on its next pass.
  if (saved) {
    try {
      const vec = await embed(noteEmbedText(value));
      if (vec) {
        await supabase
          .from('claims')
          .update({ embedding: JSON.stringify(vec) })
          .eq('id', saved.id)
          .eq('workspace_id', workspaceId);
      }
    } catch {
      // non-fatal — the embeddings worker will pick this row up later
    }
  }
  return saved;
}

/**
 * Evolve a fact: insert a new note that replaces `oldId`, then invalidate the
 * old one — keeping it as history rather than deleting it. The new note records
 * `metadata.supersedes`; the old one records `metadata.superseded_by`, so the
 * full timeline for a subject stays reconstructable. This is the v2 "evolve,
 * never delete" rule applied to the GTM context.
 */
export async function supersedeNote(
  supabase: SupabaseClient,
  workspaceId: string,
  oldId: string,
  params: SaveNoteParams,
): Promise<Note | null> {
  const fresh = await saveNote(supabase, workspaceId, {
    ...params,
    metadata: { ...(params.metadata ?? {}), supersedes: oldId },
  });

  // Read the old note's value so we can merge the back-link without clobbering
  // its category/content, then invalidate it in the same update.
  const { data: cur } = await supabase
    .from('claims')
    .select('value')
    .eq('id', oldId)
    .eq('workspace_id', workspaceId)
    .maybeSingle();
  const curVal = ((cur as { value?: Record<string, unknown> } | null)?.value) ?? {};
  const curMeta = (curVal.metadata as Record<string, unknown>) ?? {};
  await supabase
    .from('claims')
    .update({
      invalid_at: new Date().toISOString(),
      value: { ...curVal, metadata: { ...curMeta, superseded_by: fresh?.id ?? null } },
    })
    .eq('id', oldId)
    .eq('workspace_id', workspaceId);

  return fresh;
}

/**
 * End a claim because a newer one replaces it (GET-770): `invalid_at` on the old one, and a link
 * both ways — `superseded_by` (+ why) on the old, `supersedes` on the new — so the account's
 * history of a position stays readable. Nothing is deleted. The merge used to retire a claim with
 * `updateNote({ is_active: false })`, which left no trace of what replaced it.
 */
export async function retireNote(
  supabase: SupabaseClient,
  workspaceId: string,
  oldId: string,
  newId: string | null,
  reason: 'contradicted' | 'updated' | 'resolved' = 'updated',
  /** Why it no longer holds, in a few words (GET-1027): kept on the old claim, and the only trace
   *  when nothing newer replaced it (the people on file did, e.g. the CEO who is now a contact). */
  why: string | null = null,
): Promise<void> {
  const read = async (id: string) => {
    const { data } = await supabase.from('claims').select('value, invalid_at')
      .eq('id', id).eq('workspace_id', workspaceId).maybeSingle();
    return (data as { value?: Record<string, unknown>; invalid_at?: string | null } | null) ?? null;
  };
  const old = await read(oldId);
  // Already retired: its first successor stays its successor. Two parts of one long call can both
  // name the same claim; the second must not overwrite the first's link.
  if (!old?.value || old.invalid_at) return;
  const oldVal = old.value;
  const oldMeta = (oldVal.metadata as Record<string, unknown>) ?? {};
  const { error } = await supabase.from('claims')
    .update({
      invalid_at: new Date().toISOString(),
      value: { ...oldVal, metadata: { ...oldMeta, superseded_by: newId, superseded_reason: reason, ...(why ? { superseded_why: why } : {}) } },
    })
    .eq('id', oldId).eq('workspace_id', workspaceId).is('invalid_at', null);
  // supabase-js reports a failed write in `error`, it does not throw — say so rather than link a
  // successor to a claim that is still live.
  if (error) { console.warn(`[RETIRE_NOTE] could not retire ${oldId}: ${error.message}`); return; }
  if (!newId) return;
  const fresh = await read(newId);
  if (!fresh?.value) return;
  const newMeta = (fresh.value.metadata as Record<string, unknown>) ?? {};
  const { error: e2 } = await supabase.from('claims')
    .update({ value: { ...fresh.value, metadata: { ...newMeta, supersedes: oldId } } })
    .eq('id', newId).eq('workspace_id', workspaceId);
  if (e2) console.warn(`[RETIRE_NOTE] could not link ${newId} → ${oldId}: ${e2.message}`);
}

/**
 * The same fact heard again: add the new source to the fact already on file, instead of filing a
 * second copy. The fact keeps its words and its first date; it gains the evidence, a mention
 * count and when it was last heard — so a restatement still counts, and never becomes another chip.
 */
export async function corroborateNote(
  supabase: SupabaseClient,
  workspaceId: string,
  id: string,
  sourceIds: string[],
): Promise<boolean> {
  const { data: cur, error } = await supabase
    .from('claims')
    .select('value, supporting_observation_ids')
    .eq('id', id)
    .eq('workspace_id', workspaceId)
    .is('invalid_at', null)
    .maybeSingle();
  if (error || !cur) return false;
  const row = cur as unknown as { value: Record<string, unknown> | null; supporting_observation_ids: string[] | null };
  const v = row.value ?? {};
  const meta = (v.metadata as Record<string, unknown>) ?? {};
  const had = row.supporting_observation_ids ?? [];
  const fresh = sourceIds.filter(s => s && !had.includes(s));
  if (!fresh.length) return true;
  const { error: e2 } = await supabase
    .from('claims')
    .update({
      supporting_observation_ids: [...had, ...fresh],
      value: { ...v, metadata: { ...meta, mentions: Number(meta.mentions ?? 1) + 1, reaffirmed_at: new Date().toISOString() } },
    })
    .eq('id', id)
    .eq('workspace_id', workspaceId);
  return !e2;
}

export async function updateNote(
  supabase: SupabaseClient,
  workspaceId: string,
  id: string,
  patch: { content?: string; category?: string; is_active?: boolean; confidence?: number; reaffirm?: boolean },
): Promise<Note | null> {
  const { data: current, error: e1 } = await supabase
    .from('claims')
    .select(COLUMNS)
    .eq('id', id)
    .eq('workspace_id', workspaceId)
    .maybeSingle();
  if (e1) throw e1;
  if (!current) return null;

  const cur = current as unknown as Record<string, unknown>;
  const v = (cur.value as Record<string, unknown>) ?? {};
  const nextValue: Record<string, unknown> = { ...v };
  if (patch.content !== undefined) nextValue.content = patch.content;
  if (patch.category !== undefined) nextValue.category = patch.category;
  // Reaffirming stamps metadata.reaffirmed_at so staleness resets while the
  // original created_at (valid_from) is preserved.
  if (patch.reaffirm) {
    nextValue.metadata = { ...((v.metadata as Record<string, unknown>) ?? {}), reaffirmed_at: new Date().toISOString() };
  }

  const updates: Record<string, unknown> = {
    value: nextValue,
    computed_at: new Date().toISOString(),
  };
  if (patch.confidence !== undefined) updates.confidence = Math.min(Math.max(patch.confidence, 0), 1);
  if (patch.is_active === false) updates.invalid_at = new Date().toISOString();
  if (patch.is_active === true) updates.invalid_at = null;

  const { data, error } = await supabase
    .from('claims')
    .update(updates)
    .eq('id', id)
    .eq('workspace_id', workspaceId)
    .select(COLUMNS)
    .single();
  if (error) throw error;
  return data ? noteFromClaim(data as unknown as Record<string, unknown>) : null;
}

/** Soft-delete (invalidate). Per the v2 rule, claims are never hard-deleted. */
export async function deleteNote(
  supabase: SupabaseClient,
  workspaceId: string,
  id: string,
): Promise<void> {
  await supabase
    .from('claims')
    .update({ invalid_at: new Date().toISOString() })
    .eq('id', id)
    .eq('workspace_id', workspaceId);
}

export async function getNote(
  supabase: SupabaseClient,
  workspaceId: string,
  id: string,
): Promise<Note | null> {
  const { data, error } = await supabase
    .from('claims')
    .select(COLUMNS)
    .eq('id', id)
    .eq('workspace_id', workspaceId)
    .maybeSingle();
  if (error) throw error;
  return data ? noteFromClaim(data as unknown as Record<string, unknown>) : null;
}

/** Active notes count across the workspace. */
export async function countActiveNotes(
  supabase: SupabaseClient,
  workspaceId: string,
): Promise<number> {
  const { count } = await supabase
    .from('claims')
    .select('id', { count: 'exact', head: true })
    .eq('workspace_id', workspaceId)
    .like('property', 'note.%')
    .is('invalid_at', null);
  return count ?? 0;
}

// ── Contact documents ─────────────────────────────────────────────────────────
// A document is a note carrying a `doc_type` (meeting brief, transcript, notes,
// …) — a long-form artifact kept on a contact. The category is derived for
// display; the full text is the note content. Append-only: each is a dated
// entry, so a contact builds a record over time. Used by the /v2/notes endpoint
// (agent write-back) and the meeting webhooks (Fireflies/Fathom capture).

const DOC_CATEGORY: Record<string, string> = {
  note:          'Note',
  meeting_brief: 'Meeting Brief',
  transcript:    'Transcript',
  meeting_notes: 'Meeting Notes',
  pre_meeting:   'Pre-Meeting',
  research:      'Research',
};

/** The display category for a document type (defaults to 'Note'). */
export function documentCategory(type?: string): string {
  return (type && DOC_CATEGORY[type]) || 'Note';
}

export interface SaveDocumentParams {
  entityId: string;
  content: string;
  type?: string;
  title?: string;
  date?: string;
  source?: string;
  /** Extra metadata to keep alongside the doc (e.g. source_url, meeting_id). */
  meta?: Record<string, unknown>;
}

export async function saveDocument(
  supabase: SupabaseClient,
  workspaceId: string,
  params: SaveDocumentParams,
): Promise<Note | null> {
  const type = params.type && DOC_CATEGORY[params.type] ? params.type : 'note';
  const metadata: Record<string, unknown> = { ...(params.meta ?? {}), doc_type: type };
  if (params.title) metadata.title = String(params.title).slice(0, 200);
  if (params.date) metadata.date = String(params.date);
  // Phase 0 provenance (parity with observations): a document's raw IS its content, so hash it,
  // and record a pointer to the source (source_url / <source>:<meeting_id> when present). Stored
  // in metadata since notes live in claims (JSONB) — no schema change. resolveRaw can follow it.
  if (params.content) metadata.content_hash = createHash('sha256').update(String(params.content)).digest('hex');
  const meetingId = (params.meta?.meeting_id ?? params.meta?.external_id) as string | undefined;
  metadata.source_ref = (params.meta?.source_url as string | undefined)
    ?? (meetingId ? `source://${params.source ?? 'agent'}/${meetingId}` : undefined)
    ?? metadata.source_ref;
  return saveNote(supabase, workspaceId, {
    entityId: params.entityId,
    category: DOC_CATEGORY[type],
    content: String(params.content).trim(),
    source: params.source ?? 'agent',
    metadata,
  });
}
