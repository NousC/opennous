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
    // entities). If focus can't be resolved, fall back to a workspace-wide search.
    let entityId = null;
    if (focus) {
      const r = await resolveFocus(supabase, workspaceId, String(focus)).catch(() => null);
      if (r?.entity_id) entityId = r.entity_id;
    }

    const max = Math.min(Math.max(Number(limit) || 8, 1), 20);
    const ctx = readContextFromReq(req);
    const hits = await searchClaims(supabase, workspaceId, String(question), { limit: 40, threshold: 0.2 });
    const documents = hits
      .filter(h => typeof h.property === 'string' && h.property.startsWith('note.') && h.value?.metadata?.doc_type)
      .filter(h => !entityId || h.entity_id === entityId)
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

    return res.json({ documents, count: documents.length });
  } catch (err) {
    console.error('[POST /v2/notes/search]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});
