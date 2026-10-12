// /api/docs — everything the agent has written down, as a wiki (GET-197).
//
// Documents are their own objects now (packages/core/src/db/documents.ts): filed in a tree of
// accounts and reports, carrying their evidence, their links and their versions. This router
// is transport only — every rule about what a document is lives in core, so the reader, the
// agent tools and the backfill cannot disagree about it.
//
// Read-only by ruling (2026-09-13): the agent writes documents; a person can rename or delete
// one, and asks the agent for a new version rather than editing it.

import { Router } from 'express';
import {
  getSupabaseClient, documentTree, listDocuments, getDocument, searchDocuments,
  renameDocument, editDocumentSection, deleteDocument, labelEntities, DOCUMENT_KINDS,
} from '@nous/core';
import { verifySupabaseAuth } from '../../middleware/supabaseAuth.mjs';
import { viewerVisibleAccountSet } from '../../lib/visibility.mjs';

export const docsRouter = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The account gate every read goes through — the same dial as the account pages. A document
 * about an account in another rep's book is hidden exactly as the account is; a report about
 * the whole book has no subject and is visible to the workspace.
 */
async function visibilityFor(supabase, req) {
  const set = await viewerVisibleAccountSet(supabase, req.workspaceId, req.internalUserId ?? null, {
    isAdmin: req.viewerScope === 'admin',
  });
  return set.unrestricted ? () => true : (entityId) => set.ids.has(entityId);
}

const wsFrom = (req) => req.query.workspaceId ?? req.body?.workspaceId;

function withWorkspace(handler) {
  return async (req, res) => {
    try {
      if (!wsFrom(req)) return res.status(400).json({ error: 'workspaceId_required' });
      return await handler(req, res, getSupabaseClient());
    } catch (err) {
      console.error(`[${req.method} /api/docs${req.path}]`, err);
      return res.status(500).json({ error: 'internal_error' });
    }
  };
}

// GET /api/docs/tree?workspaceId= — the sidebar: accounts (with their people) and reports.
docsRouter.get('/tree', verifySupabaseAuth, withWorkspace(async (req, res, supabase) => {
  const visible = await visibilityFor(supabase, req);
  // Pages is the reports index; account- and person-scoped documents live on those records.
  const tree = await documentTree(supabase, req.workspaceId, { visible, workspaceOnly: true });
  return res.json({ tree });
}));

// GET /api/docs/search?workspaceId=&q= — passages, not titles.
docsRouter.get('/search', verifySupabaseAuth, withWorkspace(async (req, res, supabase) => {
  const q = String(req.query.q ?? '').trim();
  if (!q) return res.json({ results: [] });
  const visible = await visibilityFor(supabase, req);
  const hits = await searchDocuments(supabase, req.workspaceId, q, { limit: 20 });
  const results = hits.filter(h => !h.document.subject_entity_id || visible(h.document.subject_entity_id));
  const labels = await labelEntities(supabase, req.workspaceId, results.map(h => h.document.subject_entity_id).filter(Boolean));
  return res.json({
    results: results.map(h => ({ ...h, subject: h.document.subject_entity_id ? labels.get(h.document.subject_entity_id) ?? null : null })),
  });
}));

// GET /api/docs?workspaceId=&subject=&kind=&series=&cadence=&since= — a flat, filtered list.
// What an account page asks for ("the documents about this account").
docsRouter.get('/', verifySupabaseAuth, withWorkspace(async (req, res, supabase) => {
  const visible = await visibilityFor(supabase, req);
  const subject = String(req.query.subject ?? '').trim();
  if (subject && (!UUID_RE.test(subject) || !visible(subject))) return res.json({ docs: [] });
  const kinds = String(req.query.kind ?? '').split(',').map(s => s.trim()).filter(k => DOCUMENT_KINDS.includes(k));
  const docs = await listDocuments(supabase, req.workspaceId, {
    kinds: kinds.length ? kinds : undefined,
    subjectEntityIds: subject ? [subject] : undefined,
    series: req.query.series ? String(req.query.series) : null,
    cadence: req.query.cadence ? String(req.query.cadence) : null,
    since: req.query.since ? String(req.query.since) : null,
    limit: Math.min(Number(req.query.limit) || 100, 500),
  });
  const shown = docs.filter(d => !d.subject_entity_id || visible(d.subject_entity_id));
  const labels = await labelEntities(supabase, req.workspaceId, shown.map(d => d.subject_entity_id).filter(Boolean));
  return res.json({
    docs: shown.map(d => ({ ...d, subject: d.subject_entity_id ? labels.get(d.subject_entity_id) ?? null : null })),
  });
}));

// GET /api/docs/:id?workspaceId= — the document, its evidence, its links, its versions.
docsRouter.get('/:id', verifySupabaseAuth, withWorkspace(async (req, res, supabase) => {
  if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'not_found' });
  let detail = await getDocument(supabase, req.workspaceId, req.params.id);
  if (!detail) {
    // A chat turn written before GET-197 carries the NOTE id it was saved under. The backfill
    // records that id on the document, so an old "Open in Docs" link still lands on the page.
    const { data: moved } = await supabase.from('documents').select('id')
      .eq('workspace_id', req.workspaceId).eq('legacy_claim_id', req.params.id).maybeSingle();
    if (moved) detail = await getDocument(supabase, req.workspaceId, moved.id);
  }
  if (!detail) return res.status(404).json({ error: 'not_found' });
  const visible = await visibilityFor(supabase, req);
  const subjectId = detail.document.subject_entity_id;
  if (subjectId && !visible(subjectId)) return res.status(404).json({ error: 'not_found' });
  return res.json({
    ...detail,
    mentions: detail.mentions.filter(m => visible(m.id)),
    outgoing: detail.outgoing.filter(d => !d.subject_entity_id || visible(d.subject_entity_id)),
    backlinks: detail.backlinks.filter(d => !d.subject_entity_id || visible(d.subject_entity_id)),
    can_manage: await canManage(supabase, req, detail.document),
  });
}));

// Who may rename or delete: a workspace owner/admin, or whoever the document was written for.
async function canManage(_supabase, req, doc) {
  if (req.viewerScope === 'admin') return true;
  return !!doc.author_user_id && doc.author_user_id === req.internalUserId;
}

async function loadManaged(supabase, req, res) {
  if (!UUID_RE.test(req.params.id)) { res.status(404).json({ error: 'not_found' }); return null; }
  const detail = await getDocument(supabase, req.workspaceId, req.params.id);
  if (!detail) { res.status(404).json({ error: 'not_found' }); return null; }
  if (!(await canManage(supabase, req, detail.document))) { res.status(403).json({ error: 'forbidden' }); return null; }
  return detail;
}

// PATCH /api/docs/:id { workspaceId, title } — the one edit a read-only document takes.
docsRouter.patch('/:id', verifySupabaseAuth, withWorkspace(async (req, res, supabase) => {
  if (!(await loadManaged(supabase, req, res))) return;

  // A SECTION EDIT (GET-426). The agent writes a document; a person corrects it. Same guard
  // as rename and delete — whoever may remove it may fix a sentence in it.
  if (Number.isInteger(req.body?.section)) {
    try {
      const doc = await editDocumentSection(
        supabase, req.workspaceId, req.params.id, req.body.section, String(req.body.body ?? ''),
      );
      if (!doc) return res.status(404).json({ error: 'not_found' });
      return res.json({ doc });
    } catch (err) {
      const m = String(err?.message ?? err);
      // "This section is a chart" is a real answer, not a 500 — see editDocumentSection.
      if (m === 'section_has_blocks') return res.status(400).json({ error: 'section_has_blocks', message: 'That section is built from blocks and cannot be edited as text.' });
      if (m === 'section_not_found') return res.status(404).json({ error: 'section_not_found' });
      throw err;
    }
  }

  const title = String(req.body?.title ?? '').trim();
  if (!title) return res.status(400).json({ error: 'title_required' });
  const doc = await renameDocument(supabase, req.workspaceId, req.params.id, title);
  return res.json({ doc });
}));

// DELETE /api/docs/:id?workspaceId= — a status, and the previous version comes back.
docsRouter.delete('/:id', verifySupabaseAuth, withWorkspace(async (req, res, supabase) => {
  if (!(await loadManaged(supabase, req, res))) return;
  await deleteDocument(supabase, req.workspaceId, req.params.id);
  return res.json({ deleted: true });
}));
