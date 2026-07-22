import type { SupabaseClient } from '@supabase/supabase-js';
import { resolveFocus, getOrCreateEntity } from '../db/entities.js';
import { recordObservation } from '../db/observations.js';

// Named-person mentions → graph nodes, WITHOUT ever guessing identity.
//
// A Connections fact ("Jack shares a warm connection with Georgi") names a person.
// To make that person a real, taggable node in the graph — so "what warm
// connections can we use?" can traverse to an account, not just read a name — we
// have to answer "which Georgi?". We never guess. A mention resolves one of three
// ways, mirroring the identity-resolution rule already in the codebase
// (resolvePersonByNameFallback: "any ambiguity → null, never guess"):
//
//   - EXACTLY ONE match in the workspace  → link to that account. Unique = safe.
//   - TWO OR MORE matches (five Georgis)  → AMBIGUOUS: link nothing, carry all the
//                                           candidates on the edge for a human/agent
//                                           to pick. Never auto-choose.
//   - ZERO matches                        → create an explicitly UNRESOLVED stub
//                                           node (name-only, flagged mention-derived)
//                                           so the person exists in the graph and can
//                                           be tagged, PENDING identity. When more
//                                           evidence arrives (email, LinkedIn, fuller
//                                           name) it graduates by merging into the
//                                           real person (mergeEntities / merge_contacts).
//
// Every mention carries a resolution status and a confidence, so the graph degrades
// honestly instead of inventing links. This is general: any named person on any
// account flows through the same path.

const KNOWS = 'KNOWS';

export type MentionResolution =
  | { status: 'resolved'; entityId: string }
  | { status: 'ambiguous'; candidates: { entity_id: string; name: string | null; detail: string | null }[] }
  | { status: 'new' };

function splitName(name: string): { first: string; last: string } {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean);
  return { first: parts[0] ?? '', last: parts.slice(1).join(' ') };
}

/**
 * Resolve a named person to an existing account. Disambiguation is delegated to
 * resolveFocus (which searches identifiers, name claims, AND the contacts table):
 * one hit → resolved, several → ambiguous, none → new.
 */
export async function resolvePersonMention(
  supabase: SupabaseClient,
  workspaceId: string,
  name: string,
): Promise<MentionResolution> {
  const clean = (name ?? '').trim();
  if (clean.length < 2) return { status: 'new' };
  const r = await resolveFocus(supabase, workspaceId, clean);
  if (r.status === 'resolved') return { status: 'resolved', entityId: r.entity_id };
  if (r.status === 'ambiguous') return { status: 'ambiguous', candidates: r.candidates };
  return { status: 'new' };
}

/**
 * Create an explicitly-UNRESOLVED placeholder node for a mentioned person we can't
 * match yet. It's a real entity (so it shows in the graph and can be tagged), but
 * flagged `unresolved_mention` so it never poses as a confirmed account and can
 * later graduate into the real person. Goes through the contacts view (its INSERT
 * trigger owns the entity/claim rows), same path contact ingestion uses.
 */
export async function createMentionStub(
  supabase: SupabaseClient,
  workspaceId: string,
  name: string,
  opts: { mentionedByEntityId?: string | null } = {},
): Promise<string> {
  const { first, last } = splitName(name);
  const entityId = await getOrCreateEntity(supabase, workspaceId, 'person', []);
  await supabase.from('contacts').insert({
    id:             entityId,
    workspace_id:   workspaceId,
    first_name:     first || name,
    last_name:      last || null,
    source:         'mention',
    pipeline_stage: 'identified',
  }).then(null, () => {}); // PK conflict / trigger-owned row → fine

  // A queryable marker so graduation/merge and People-list filtering can find these
  // — an unresolved stub is not a lead and shouldn't be worked like one.
  await recordObservation(supabase, {
    workspaceId, entityId, kind: 'state', property: 'identity_status',
    value: { status: 'unresolved_mention', mentioned_by: opts.mentionedByEntityId ?? null },
    source: 'mention', method: 'inference',
  }).catch(() => {});

  return entityId;
}

async function upsertKnowsEdge(
  supabase: SupabaseClient,
  workspaceId: string,
  p: {
    subjectEntityId: string | null; subjectLabel: string;
    objectId: string | null; objectLabel: string;
    sourceMemoryId?: string | null; status: string; candidates?: unknown;
  },
): Promise<void> {
  const confidence = p.status === 'resolved' ? 0.9 : p.status === 'resolved_stub' ? 0.6 : 0.3;
  await supabase.from('workspace_graph_edges').upsert({
    workspace_id:     workspaceId,
    subject_type:     'contact',
    subject_id:       p.subjectEntityId,
    subject_label:    p.subjectLabel,
    relationship:     KNOWS,
    object_type:      'contact',
    object_id:        p.objectId,
    object_label:     p.objectLabel,
    source:           'mention',
    source_memory_id: p.sourceMemoryId ?? null,
    confidence,
    metadata:         { resolution: p.status, ...(p.candidates ? { candidates: p.candidates } : {}) },
  }, { onConflict: 'workspace_id,subject_label,relationship,object_label', ignoreDuplicates: false });
}

/**
 * Public entry point. Given a person named in a claim, resolve them → (stub if new,
 * unless allowStub is false) → write the KNOWS edge, and return the mention ref for
 * the claim's `metadata.mentions` (so the Intel card can render the @tag). An
 * ambiguous name is left UNLINKED (object_id null) with its candidates on the edge —
 * we surface the choice, we don't make it.
 */
export async function linkPersonMention(
  supabase: SupabaseClient,
  workspaceId: string,
  p: { subjectEntityId: string; subjectLabel: string; name: string; sourceMemoryId?: string | null; allowStub?: boolean },
): Promise<{ label: string; entity_id: string | null; status: string; candidates?: unknown }> {
  const res = await resolvePersonMention(supabase, workspaceId, p.name);
  let objectId: string | null = null;
  let status: string = res.status;
  let candidates: unknown;

  if (res.status === 'resolved') {
    objectId = res.entityId;
  } else if (res.status === 'ambiguous') {
    candidates = res.candidates;                       // never guess — surface the choice
  } else if (res.status === 'new' && p.allowStub !== false) {
    objectId = await createMentionStub(supabase, workspaceId, p.name, { mentionedByEntityId: p.subjectEntityId });
    status = 'resolved_stub';
  }

  await upsertKnowsEdge(supabase, workspaceId, {
    subjectEntityId: p.subjectEntityId, subjectLabel: p.subjectLabel,
    objectId, objectLabel: p.name, sourceMemoryId: p.sourceMemoryId, status, candidates,
  });

  return { label: p.name, entity_id: objectId, status, candidates };
}
