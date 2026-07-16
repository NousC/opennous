import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { embed } from '../embed.js';
import { rawVisible, type ReadContext } from './readContext.js';

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
}

const COLUMNS =
  'id, workspace_id, entity_id, property, value, ' +
  'confidence, epistemic_class, freshness, valid_from, invalid_at, computed_at, ' +
  'supporting_observation_ids';

function noteFromClaim(c: Record<string, unknown>): Note {
  const v = (c.value as Record<string, unknown> | null) ?? {};
  const meta = (v.metadata as Record<string, unknown>) ?? {};
  return {
    id: c.id as string,
    workspace_id: c.workspace_id as string,
    entity_id: c.entity_id as string,
    category: (v.category as string) ?? 'General',
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
}

/** List notes, newest first.
 *  With a member-scoped ReadContext, DOCUMENTS (transcripts, meeting_notes — raw
 *  content) owned by another rep are dropped; extracted facts (no doc_type) are
 *  shared and never filtered. See PRIVACY_MODEL.md. */
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
  if (!opts.includeInactive) q = q.is('invalid_at', null);
  if (opts.entityId) q = q.eq('entity_id', opts.entityId);
  if (opts.entityIds?.length) q = q.in('entity_id', opts.entityIds);
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
    notes = notes.filter(n => set.has(n.category));
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
  return notes;
}

export interface SaveNoteParams {
  /** Defaults to the workspace entity. */
  entityId?: string;
  category?: string;
  content: string;
  source?: string;
  metadata?: Record<string, unknown>;
  /** Stable slot this fact belongs to, so it can be superseded later. */
  subject?: string;
  /** Source observation id(s) this claim was extracted from — the evidence chain. */
  supportingObservationIds?: string[];
  /** 0–1. Defaults to 1 (user-asserted). Lower it for inferred/drafted facts. */
  confidence?: number;
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
  const metadata: Record<string, unknown> = { ...(params.metadata ?? {}) };
  if (params.subject) metadata.subject = params.subject;
  const value = {
    category: params.category ?? 'General',
    content: params.content,
    source: params.source ?? 'manual',
    metadata,
  };
  const { data, error } = await supabase
    .from('claims')
    .insert({
      workspace_id: workspaceId,
      entity_id: entityId,
      property: `note.${randomUUID()}`,
      value,
      confidence: params.confidence ?? 1.0,
      epistemic_class: 'asserted',
      freshness: 'fresh',
      valid_from: now,
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
  return saveNote(supabase, workspaceId, {
    entityId: params.entityId,
    category: DOC_CATEGORY[type],
    content: String(params.content).trim(),
    source: params.source ?? 'agent',
    metadata,
  });
}
