// /v2/company-documents, for agents (GET-1117): the files in Documents this reader may see, and how an
// operator's agent pushes one in. The MCP's `documents` tool reads and pushes here. A key with no person
// behind it reads only what everyone may read, and pushes nothing.
import { Router } from 'express';
import { getSupabaseClient, readableContextFiles, pushDocument, validateContextFile, NO_CONTENT_VIEWER } from '@nous/core';
import { allowQueryParams } from '../../lib/v2Query.mjs';

export const companyDocumentsV2Router = Router();

const reader = (req) => {
  const person = req.memberUserId && !req.noContent && req.memberUserId !== NO_CONTENT_VIEWER ? req.memberUserId : null;
  return { userId: person, admin: req.viewerScope === 'admin' };
};
const summary = (f) => ({ id: f.id, title: f.title, folder: f.folder ?? 'Library', shared: f.visibility === 'workspace' ? 'everyone' : f.visibility === 'operators' ? 'operators' : 'only me', updated_at: f.updated_at });
const wrap = (label, fn) => async (req, res) => {
  try { return await fn(req, res); }
  catch (err) { console.error(`[${label}]`, err); return res.status(500).json({ error: 'internal_error' }); }
};

// GET /v2/company-documents?q= -> { documents }, with no text; a word in q filters on title and text.
companyDocumentsV2Router.get('/', allowQueryParams(['q']), wrap('GET /v2/company-documents', async (req, res) => {
  const files = await readableContextFiles(getSupabaseClient(), req.workspaceId, reader(req));
  const q = String(req.query.q ?? '').trim().toLowerCase();
  const hit = q ? files.filter(f => `${f.title}\n${f.body ?? ''}`.toLowerCase().includes(q)) : files;
  return res.json({ documents: hit.map(summary) });
}));

// GET /v2/company-documents/:id -> one document with its text. A file this reader can't see is a 404.
companyDocumentsV2Router.get('/:id', allowQueryParams([]), wrap('GET /v2/company-documents/:id', async (req, res) => {
  const files = await readableContextFiles(getSupabaseClient(), req.workspaceId, reader(req));
  const f = files.find(x => x.id === req.params.id);
  if (!f) return res.status(404).json({ error: 'document_not_found' });
  return res.json({ ...summary(f), body: f.body ?? '' });
}));

const SHARED = { everyone: 'workspace', operators: 'operators', only_me: 'boxes' };

// POST /v2/company-documents { title, folder, markdown, shared_with? } -> 201 new, 200 next version.
companyDocumentsV2Router.post('/', allowQueryParams([]), async (req, res) => {
  try {
    const { title, folder, markdown, shared_with: shared } = req.body ?? {};
    const { userId, admin } = reader(req);
    if (!userId || !admin) return res.status(403).json({ error: 'operators_only', detail: 'Only a workspace owner or admin can push a document, with their own key.' });
    if (shared != null && !SHARED[shared]) return res.status(400).json({ error: 'bad_shared_with', detail: 'Use everyone, operators or only_me.' });
    const invalid = validateContextFile({ title, folder, body: markdown });
    if (invalid) return res.status(400).json({ error: 'invalid_document', detail: invalid });
    const { file, created } = await pushDocument(getSupabaseClient(), req.workspaceId, userId, { title, folder, body: markdown, ...(shared ? { visibility: SHARED[shared] } : {}) });
    return res.status(created ? 201 : 200).json({ ...summary(file), created });
  } catch (err) {
    if (err?.status) return res.status(err.status).json({ error: err.message });
    console.error('[POST /v2/company-documents]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});
