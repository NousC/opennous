import { Router } from 'express';
import {
  getSupabaseClient,
  listNotes,
  saveNote,
  getNote,
  updateNote,
  deleteNote,
  getWorkspaceEntityId,
} from '@nous/core';
import { verifySupabaseAuth } from '../../middleware/supabaseAuth.mjs';

// Workspace memories — backed by `asserted` claims on entities in the v2
// substrate. The on-the-wire shape is unchanged so the frontend keeps working.

export const workspaceMemoriesRouter = Router();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// POST /api/workspace/memories — add one memory fact with a category.
// Body: { workspaceId, content, category }
workspaceMemoriesRouter.post('/', verifySupabaseAuth, async (req, res) => {
  try {
    const { workspaceId, content, category } = req.body;
    if (!workspaceId || !content?.trim()) {
      return res.status(400).json({ error: 'workspaceId and content required' });
    }
    const memory = await saveNote(getSupabaseClient(), workspaceId, {
      content: content.trim(),
      category: category || 'General',
      source: 'manual',
    });
    return res.status(201).json({ memory });
  } catch (err) {
    console.error('[POST /api/workspace/memories]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// GET /api/workspace/memories?workspaceId&contact_id|company_id&limit&offset
workspaceMemoriesRouter.get('/', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { workspaceId, contact_id, company_id, limit = 100, offset = 0 } = req.query;
    if (!workspaceId) return res.status(400).json({ error: 'workspaceId required' });

    const opts = { limit: Number(limit), offset: Number(offset) };
    let memories;
    if (contact_id) {
      memories = await listNotes(supabase, workspaceId, { ...opts, entityId: contact_id });
    } else if (company_id) {
      memories = await listNotes(supabase, workspaceId, { ...opts, entityId: company_id });
    } else {
      // workspace-level view — only notes on the workspace entity
      const workspaceEntityId = await getWorkspaceEntityId(supabase, workspaceId);
      memories = workspaceEntityId
        ? await listNotes(supabase, workspaceId, { ...opts, entityId: workspaceEntityId })
        : [];
    }
    return res.json({ memories, total: memories.length });
  } catch (err) {
    console.error('[GET /api/workspace/memories]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// GET /api/workspace/memories/history?workspaceId&subject — the supersession
// timeline for one subject slot (active + superseded), newest first. Registered
// before /:id so "history" isn't parsed as an id.
workspaceMemoriesRouter.get('/history', verifySupabaseAuth, async (req, res) => {
  try {
    const { workspaceId, subject } = req.query;
    if (!workspaceId || !subject) {
      return res.status(400).json({ error: 'workspaceId and subject required' });
    }
    const supabase = getSupabaseClient();
    const entityId = await getWorkspaceEntityId(supabase, workspaceId);
    const history = entityId
      ? await listNotes(supabase, workspaceId, {
          entityId, subject: String(subject), includeInactive: true, limit: 50,
        })
      : [];
    return res.json({ history });
  } catch (err) {
    console.error('[GET /api/workspace/memories/history]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

workspaceMemoriesRouter.get('/:id', verifySupabaseAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { workspaceId } = req.query;
    if (!UUID.test(id)) return res.status(400).json({ error: 'invalid_id' });
    if (!workspaceId) return res.status(400).json({ error: 'workspaceId required' });
    const memory = await getNote(getSupabaseClient(), workspaceId, id);
    if (!memory) return res.status(404).json({ error: 'not_found' });
    return res.json({ memory });
  } catch (err) {
    return res.status(500).json({ error: 'internal_error' });
  }
});

workspaceMemoriesRouter.patch('/:id', verifySupabaseAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { workspaceId, content, category, is_active, confidence, reaffirm } = req.body;
    if (!UUID.test(id)) return res.status(400).json({ error: 'invalid_id' });
    if (!workspaceId) return res.status(400).json({ error: 'workspaceId required' });
    const memory = await updateNote(getSupabaseClient(), workspaceId, id, {
      content, category, is_active, confidence, reaffirm,
    });
    if (!memory) return res.status(404).json({ error: 'not_found' });
    return res.json({ memory });
  } catch (err) {
    console.error('[PATCH /api/workspace/memories]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

workspaceMemoriesRouter.delete('/:id', verifySupabaseAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { workspaceId } = req.body;
    if (!UUID.test(id)) return res.status(400).json({ error: 'invalid_id' });
    if (!workspaceId) return res.status(400).json({ error: 'workspaceId required' });
    await deleteNote(getSupabaseClient(), workspaceId, id);
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: 'internal_error' });
  }
});

// POST /api/workspace/memories/ingest — used by signal extractors / agents.
// Body: { workspaceId, content, contact_id?, source?, metadata? }
workspaceMemoriesRouter.post('/ingest', verifySupabaseAuth, async (req, res) => {
  try {
    const { workspaceId, content, contact_id, source = 'manual', metadata = {} } = req.body;
    if (!workspaceId || !content) return res.status(400).json({ error: 'workspaceId and content required' });
    const memory = await saveNote(getSupabaseClient(), workspaceId, {
      entityId: contact_id || undefined,
      content,
      source,
      metadata,
    });
    return res.json({ memory });
  } catch (err) {
    console.error('[POST /api/workspace/memories/ingest]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});
