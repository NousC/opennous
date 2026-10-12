import { Router } from 'express';
import {
  getSupabaseClient,
  getOrCreateEntity,
  detectIdentifier,
  saveDocument,
  searchClaims,
  resolveFocus,
  rawVisible,
  readContextFromReq,
  listNotes,
} from '@nous/core';

export const notesV2Router = Router();

// POST /v2/notes — attach a note or document to a person or company.
// Body: {
//   focus:   <entity UUID | email | LinkedIn URL | domain>,
//   content: <the note/document text — short note or a full brief/transcript>,
//   type?:   one of note|meeting_brief|transcript|meeting_notes|pre_meeting|research (default note),
//   title?:  a short name, e.g. "Pre-meeting brief — renewal",
//   date?:   the relevant date (e.g. the meeting date); defaults to now
// }
// This is for ARTIFACTS you keep on a contact, not interactions — for "an email
// was sent / a meeting happened", use POST /v2/observations (record).
notesV2Router.post('/', async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const workspaceId = req.workspaceId;
    const { focus, content, type, title, date } = req.body ?? {};

    if (!focus || !content || !String(content).trim()) {
      return res.status(400).json({ error: 'focus_and_content_required' });
    }

    // Resolve focus to an entity, like /v2/observations — a precise identifier,
    // never a bare name.
    const ident = detectIdentifier(String(focus));
    if (!ident) {
      return res.status(400).json({
        error: 'invalid_focus',
        detail: 'provide an entity id, email, LinkedIn URL, or domain — not a bare name',
      });
    }
    let entityId;
    if (ident.kind === 'entity_id') {
      entityId = ident.value;
    } else if (ident.kind === 'domain') {
      entityId = await getOrCreateEntity(supabase, workspaceId, 'company', [{ kind: 'domain', value: ident.value }]);
    } else {
      entityId = await getOrCreateEntity(supabase, workspaceId, 'person', [{ kind: ident.kind, value: ident.value }]);
    }

    const note = await saveDocument(supabase, workspaceId, {
      entityId, type, title, date, content, source: 'agent',
    });

    return res.status(201).json({ note, entity_id: entityId, doc_type: note?.metadata?.doc_type ?? 'note' });
  } catch (err) {
    console.error('[POST /v2/notes]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// POST /v2/notes/search — semantic search over saved notes & documents (meeting
// briefs, transcripts, notes). This is how the agent retrieves relevant content
// from the record ("what did we discuss about pricing", "compare the last 3
// meetings") instead of dumping whole documents into context.
// Body: { question, focus?, limit? }
//   question — the natural-language query to match against document content
//   focus?   — restrict to one person/company (email/UUID/domain); omit for all
//   limit?   — max documents to return (default 8, max 20)
notesV2Router.post('/search', async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const workspaceId = req.workspaceId;
    const { question, focus, limit } = req.body ?? {};
    if (!question || !String(question).trim()) {
      return res.status(400).json({ error: 'question required' });
    }

    // Optional entity scope — resolve without creating (a search shouldn't mint
    // entities). A resolved name scopes to that one entity; an AMBIGUOUS name (a
    // duplicate contact, say) scopes to ALL its candidates instead of silently
    // widening to the whole workspace — and, importantly, still runs the recency
    // fallback below (which only fires when a scope exists), so a just-saved note on
    // any candidate is still found. An unresolvable name falls back to workspace-wide.
    let scopeIds = null;
    if (focus) {
      const r = await resolveFocus(supabase, workspaceId, String(focus)).catch(() => null);
      if (r?.entity_id) scopeIds = new Set([r.entity_id]);
      else if (r?.status === 'ambiguous' && Array.isArray(r.candidates)) {
        const ids = r.candidates.map(c => c.entity_id).filter(Boolean);
        if (ids.length) scopeIds = new Set(ids);
      }
    }

    const max = Math.min(Math.max(Number(limit) || 8, 1), 20);
    const ctx = readContextFromReq(req);
    const hits = await searchClaims(supabase, workspaceId, String(question), { limit: 40, threshold: 0.2 }, ctx);
    const documents = hits
      .filter(h => typeof h.property === 'string' && h.property.startsWith('note.') && h.value?.metadata?.doc_type)
      .filter(h => !scopeIds || scopeIds.has(h.entity_id))
      // Per-member privacy: a raw document is visible only to its owning rep +
      // admins (owner is stamped in metadata.owner_user_id). See PRIVACY_MODEL.md.
      .filter(h => rawVisible(h.value?.metadata?.owner_user_id, ctx))
      .map(h => {
        const v = h.value;
        const text = String(v.content ?? '').replace(/\s+/g, ' ').trim();
        return {
          entity_id: h.entity_id,
          type: v.metadata.doc_type,
          title: v.metadata.title ?? null,
          date: v.metadata.date ?? null,
          similarity: Math.round((h.similarity ?? 0) * 100) / 100,
          snippet: text.length > 400 ? text.slice(0, 400) + '…' : text,
        };
      })
      .slice(0, max);

    // Recency fallback. Semantic search is embeddings-backed, so a note saved
    // seconds ago (not yet embedded) matches nothing — the exact case where a
    // brief you just wrote comes back empty. When the search is scoped to one or
    // more contacts, union in each contact's newest documents (listNotes applies
    // the same per-member visibility via ctx) so a fresh brief is always found.
    if (scopeIds) {
      const seen = new Set(documents.map(d => `${d.entity_id}|${d.title}|${d.date}`));
      for (const eid of scopeIds) {
        const recent = (await listNotes(supabase, workspaceId, { entityId: eid, limit: max }, ctx))
          .filter(n => n.metadata?.doc_type && String(n.content ?? '').trim())
          .map(n => {
            const text = String(n.content ?? '').replace(/\s+/g, ' ').trim();
            return {
              entity_id: n.entity_id,
              type: n.metadata.doc_type,
              title: n.metadata.title ?? null,
              date: n.metadata.date ?? null,
              similarity: null, // matched by recency, not similarity
              snippet: text.length > 400 ? text.slice(0, 400) + '…' : text,
            };
          });
        for (const d of recent) {
          const key = `${d.entity_id}|${d.title}|${d.date}`;
          if (!seen.has(key)) { seen.add(key); documents.push(d); }
        }
      }
    }

    const out = documents.slice(0, max);
    return res.json({ documents: out, count: out.length });
  } catch (err) {
    console.error('[POST /v2/notes/search]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// GET /v2/notes — list saved notes newest-first (chronological, not semantic). Optional
// ?focus= scopes to one person/company; ?limit (default 20, max 100) + ?offset paginate.
// This is the list companion to POST /search (semantic) — for "show me the notes on X" or
// enumerating notes so you have their ids (e.g. to delete_note). Per-member visibility applies.
notesV2Router.get('/', async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const workspaceId = req.workspaceId;
    const { focus } = req.query;
    const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const ctx = readContextFromReq(req);

    let entityId;
    if (focus) {
      const r = await resolveFocus(supabase, workspaceId, String(focus)).catch(() => null);
      if (r?.entity_id) entityId = r.entity_id;
      else if (r?.status === 'ambiguous') return res.json({ status: 'ambiguous', candidates: r.candidates });
      else return res.status(404).json({ error: 'entity_not_found', value: focus });
    }

    const notes = await listNotes(supabase, workspaceId, { entityId, limit, offset }, ctx);
    const out = (notes || [])
      .filter(n => n.metadata?.doc_type)
      .map(n => {
        const text = String(n.content ?? '').replace(/\s+/g, ' ').trim();
        return {
          id: n.id,
          entity_id: n.entity_id,
          type: n.metadata.doc_type,
          title: n.metadata.title ?? null,
          date: n.metadata.date ?? null,
          snippet: text.length > 280 ? text.slice(0, 280) + '…' : text,
        };
      });
    return res.json({ notes: out, count: out.length, has_more: out.length === limit });
  } catch (err) {
    console.error('[GET /v2/notes]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// DELETE /v2/notes/:id — retract a note saved by mistake. A note is a claim row with
// a `note.<uuid>` property; we invalidate it (invalid_at = now) rather than hard-delete,
// so it drops out of search/get_context immediately while the timeline stays
// reconstructable (the "evolve, never destroy" rule). Guarded so it can only touch a
// note-claim, never a real derived fact.
notesV2Router.delete('/:id', async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const workspaceId = req.workspaceId;
    const { id } = req.params;

    const { data: claim } = await supabase
      .from('claims')
      .select('id, property, invalid_at')
      .eq('id', id).eq('workspace_id', workspaceId)
      .maybeSingle();
    if (!claim) return res.status(404).json({ error: 'note_not_found' });
    if (typeof claim.property !== 'string' || !claim.property.startsWith('note.')) {
      // Refuse to invalidate a derived fact through the notes endpoint.
      return res.status(400).json({ error: 'not_a_note', detail: 'That id is not a note.' });
    }
    if (claim.invalid_at) return res.json({ status: 'already_deleted', id });

    const { error } = await supabase
      .from('claims')
      .update({ invalid_at: new Date().toISOString() })
      .eq('id', id).eq('workspace_id', workspaceId);
    if (error) throw error;

    return res.json({ status: 'deleted', id });
  } catch (err) {
    console.error('[DELETE /v2/notes/:id]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});
