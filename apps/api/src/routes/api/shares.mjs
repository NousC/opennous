import { Router } from 'express';
import { getSupabaseClient } from '@nous/core';

// Sharing an account/person with a teammate (entity_shares). The record shows up on the
// recipient's "Shared with me" page. Supabase-JWT (frontend) auth.
export const sharesRouter = Router();

// Resolve the member's workspace when the request didn't carry a workspaceId param.
sharesRouter.use(async (req, res, next) => {
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

// GET /api/shares/with-me  → records teammates have shared with me, newest first.
sharesRouter.get('/with-me', async (req, res) => {
  try {
    const { workspaceId, userId } = scope(req);
    if (!workspaceId || !userId) return res.status(401).json({ error: 'unauthorized' });
    const supabase = getSupabaseClient();
    const { data } = await supabase.from('entity_shares')
      .select('entity_id, entity_kind, entity_name, created_at, sharer:shared_by(id, name, email, profile_picture_url)')
      .eq('workspace_id', workspaceId).eq('shared_with', userId)
      .order('created_at', { ascending: false });
    return res.json({ shares: data ?? [] });
  } catch (err) {
    console.error('[GET /api/shares/with-me]', err);
    return res.status(500).json({ error: 'load_failed' });
  }
});

// GET /api/shares?entityId=  → the team (minus me) with a `shared` flag for this record,
// so the share menu can render toggles.
sharesRouter.get('/', async (req, res) => {
  try {
    const { workspaceId, userId } = scope(req);
    if (!workspaceId || !userId) return res.status(401).json({ error: 'unauthorized' });
    const entityId = String(req.query.entityId ?? '').trim();
    if (!entityId) return res.status(400).json({ error: 'entityId_required' });
    const supabase = getSupabaseClient();

    const { data: members } = await supabase.from('workspace_members')
      .select('user_id, users:user_id(id, name, email, profile_picture_url)')
      .eq('workspace_id', workspaceId);
    const { data: shares } = await supabase.from('entity_shares')
      .select('shared_with').eq('workspace_id', workspaceId).eq('entity_id', entityId);
    const sharedSet = new Set((shares ?? []).map(s => s.shared_with));

    const team = (members ?? [])
      .filter(m => m.user_id !== userId)   // can't share with yourself
      .map(m => ({
        user_id: m.user_id,
        name: m.users?.name ?? null,
        email: m.users?.email ?? null,
        avatar: m.users?.profile_picture_url ?? null,
        shared: sharedSet.has(m.user_id),
      }));
    return res.json({ team });
  } catch (err) {
    console.error('[GET /api/shares]', err);
    return res.status(500).json({ error: 'load_failed' });
  }
});

// POST /api/shares  { entityId, entityKind, entityName, userId }  → share with a teammate.
sharesRouter.post('/', async (req, res) => {
  try {
    const { workspaceId, userId } = scope(req);
    if (!workspaceId || !userId) return res.status(401).json({ error: 'unauthorized' });
    const { entityId, entityKind, entityName, userId: targetUserId } = req.body ?? {};
    if (!entityId || !targetUserId) return res.status(400).json({ error: 'entityId_and_userId_required' });
    if (targetUserId === userId) return res.status(400).json({ error: 'cannot_share_with_self' });
    const supabase = getSupabaseClient();
    const { error } = await supabase.from('entity_shares').upsert({
      workspace_id: workspaceId,
      entity_id: String(entityId).trim(),
      entity_kind: entityKind === 'company' ? 'company' : 'person',
      entity_name: entityName ?? null,
      shared_by: userId,
      shared_with: targetUserId,
    }, { onConflict: 'workspace_id,entity_id,shared_with' });
    if (error) throw error;
    return res.json({ ok: true });
  } catch (err) {
    console.error('[POST /api/shares]', err);
    return res.status(500).json({ error: 'share_failed' });
  }
});

// DELETE /api/shares?entityId=&userId=  → stop sharing with a teammate.
sharesRouter.delete('/', async (req, res) => {
  try {
    const { workspaceId, userId } = scope(req);
    if (!workspaceId || !userId) return res.status(401).json({ error: 'unauthorized' });
    const entityId = String(req.query.entityId ?? '').trim();
    const targetUserId = String(req.query.userId ?? '').trim();
    if (!entityId || !targetUserId) return res.status(400).json({ error: 'entityId_and_userId_required' });
    const supabase = getSupabaseClient();
    const { error } = await supabase.from('entity_shares').delete()
      .eq('workspace_id', workspaceId).eq('entity_id', entityId).eq('shared_with', targetUserId);
    if (error) throw error;
    return res.json({ ok: true });
  } catch (err) {
    console.error('[DELETE /api/shares]', err);
    return res.status(500).json({ error: 'unshare_failed' });
  }
});
