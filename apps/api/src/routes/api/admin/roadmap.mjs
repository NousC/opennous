import { Router } from 'express';
import { getSupabaseClient } from '@nous/core';

export const roadmapRouter = Router();
export const adminRoadmapRouter = Router();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALID_STATUSES = ['planned', 'in_progress', 'shipped'];

// GET /api/roadmap/items  (public)
roadmapRouter.get('/items', async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { data: items, error } = await supabase.from('roadmap_items')
      .select('id, title, description, status, sort_order, created_at')
      .order('sort_order', { ascending: true });
    if (error) return res.status(500).json({ error: 'internal_error' });
    return res.json({ items: items || [] });
  } catch (err) {
    return res.status(500).json({ error: 'internal_error' });
  }
});

// POST /api/admin/roadmap/items
adminRoadmapRouter.post('/items', async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { title, description, status, sort_order } = req.body;
    if (!title?.trim()) return res.status(400).json({ error: 'title_required' });
    if (!VALID_STATUSES.includes(status)) return res.status(400).json({ error: 'invalid_status' });

    const { data: item, error } = await supabase.from('roadmap_items').insert({
      title: title.trim(),
      description: description?.trim() || null,
      status,
      sort_order: sort_order ?? 0,
    }).select('id, title, description, status, sort_order, created_at').single();

    if (error) return res.status(500).json({ error: 'internal_error' });
    return res.status(201).json({ item });
  } catch (err) {
    return res.status(500).json({ error: 'internal_error' });
  }
});

// PATCH /api/admin/roadmap/items/:id
adminRoadmapRouter.patch('/items/:id', async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { id } = req.params;
    if (!UUID.test(id)) return res.status(400).json({ error: 'invalid_id' });

    const { title, description, status, sort_order } = req.body;
    const updates = { updated_at: new Date().toISOString() };
    if (title !== undefined) updates.title = title.trim();
    if (description !== undefined) updates.description = description?.trim() || null;
    if (status !== undefined) {
      if (!VALID_STATUSES.includes(status)) return res.status(400).json({ error: 'invalid_status' });
      updates.status = status;
    }
    if (sort_order !== undefined) updates.sort_order = sort_order;

    const { data: item, error } = await supabase.from('roadmap_items').update(updates).eq('id', id)
      .select('id, title, description, status, sort_order, created_at').single();
    if (error) return res.status(500).json({ error: 'internal_error' });
    return res.json({ item });
  } catch (err) {
    return res.status(500).json({ error: 'internal_error' });
  }
});

// DELETE /api/admin/roadmap/items/:id
adminRoadmapRouter.delete('/items/:id', async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { id } = req.params;
    if (!UUID.test(id)) return res.status(400).json({ error: 'invalid_id' });

    const { error } = await supabase.from('roadmap_items').delete().eq('id', id);
    if (error) return res.status(500).json({ error: 'internal_error' });
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: 'internal_error' });
  }
});
