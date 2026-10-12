import { Router } from 'express';
import { getSupabaseClient } from '@nous/core';

// Granola-style editable notes on an account/person (entity_notes table). One note per
// (workspace, entity, user) — the member's own working note, autosaved in place. Distinct
// from the agent's append-only /v2/notes documents. Supabase-JWT (frontend) auth.
export const entityNotesRouter = Router();

// Resolve the member's workspace when the request didn't carry a workspaceId param
// (mirrors the personal router) so every handler has one.
entityNotesRouter.use(async (req, res, next) => {
  try {
    if (!req.workspaceId && req.internalUserId) {
      const supabase = getSupabaseClient();
      const { data } = await supabase.from('workspace_members')
        .select('workspace_id').eq('user_id', req.internalUserId)
        .order('created_at', { ascending: true }).limit(1);
      if (data?.[0]?.workspace_id) req.workspaceId = data[0].workspace_id;
    }
  } catch { /* handlers 401 if still unresolved */ }
  next();
});

const scope = (req) => ({ workspaceId: req.workspaceId, userId: req.internalUserId });

// GET /api/notes?entityId=&kind=  → this member's note for that record (or an empty one).
entityNotesRouter.get('/', async (req, res) => {
  try {
    const { workspaceId, userId } = scope(req);
    if (!workspaceId || !userId) return res.status(401).json({ error: 'unauthorized' });
    const entityId = String(req.query.entityId ?? '').trim();
    if (!entityId) return res.status(400).json({ error: 'entityId_required' });
    const supabase = getSupabaseClient();
    const { data } = await supabase.from('entity_notes')
      .select('id, title, body, updated_at')
      .eq('workspace_id', workspaceId).eq('user_id', userId).eq('entity_id', entityId)
      .maybeSingle();
    return res.json({ note: data ?? null });
  } catch (err) {
    console.error('[GET /api/notes]', err);
    return res.status(500).json({ error: 'load_failed' });
  }
});

// PUT /api/notes  { entityId, entityKind, title?, body }  → upsert the member's note.
entityNotesRouter.put('/', async (req, res) => {
  try {
    const { workspaceId, userId } = scope(req);
    if (!workspaceId || !userId) return res.status(401).json({ error: 'unauthorized' });
    const { entityId, entityKind, title, body } = req.body ?? {};
    if (!entityId || !String(entityId).trim()) return res.status(400).json({ error: 'entityId_required' });
    const kind = entityKind === 'company' ? 'company' : 'person';
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.from('entity_notes')
      .upsert({
        workspace_id: workspaceId, user_id: userId,
        entity_id: String(entityId).trim(), entity_kind: kind,
        title: title ?? null, body: body ?? '',
        updated_at: new Date().toISOString(),
      }, { onConflict: 'workspace_id,entity_id,user_id' })
      .select('id, title, body, updated_at').single();
    if (error) throw error;
    return res.json({ note: data });
  } catch (err) {
    console.error('[PUT /api/notes]', err);
    return res.status(500).json({ error: 'save_failed' });
  }
});
