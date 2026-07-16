import { Router } from 'express';
import { getSupabaseClient } from '@nous/core';

export const updatesRouter = Router();
export const adminUpdatesRouter = Router();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// GET /api/updates  (public — published only)
updatesRouter.get('/', async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.from('weekly_updates')
      .select('id, week, title, date, description, items, yt_title, yt_url, published, sort_order, created_at')
      .eq('published', true)
      .order('week', { ascending: false });
    if (error) return res.status(500).json({ error: 'internal_error' });
    return res.json({ updates: data || [] });
  } catch (err) {
    return res.status(500).json({ error: 'internal_error' });
  }
});

// GET /api/admin/updates
adminUpdatesRouter.get('/', async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.from('weekly_updates')
      .select('id, week, title, date, description, items, yt_title, yt_url, published, sort_order, created_at')
      .order('week', { ascending: false });
    if (error) return res.status(500).json({ error: 'internal_error' });
    return res.json({ updates: data || [] });
  } catch (err) {
    return res.status(500).json({ error: 'internal_error' });
  }
});

// POST /api/admin/updates
adminUpdatesRouter.post('/', async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { week, title, date, description, items, yt_title, yt_url, published } = req.body;
    if (!title?.trim() || !date?.trim()) return res.status(400).json({ error: 'title_and_date_required' });

    const { data: update, error } = await supabase.from('weekly_updates').insert({
      week: week ?? 1,
      title: title.trim(),
      date: date.trim(),
      description: description?.trim() || '',
      items: items || [],
      yt_title: yt_title?.trim() || null,
      yt_url: yt_url?.trim() || null,
      published: published !== false,
    }).select().single();

    if (error) return res.status(500).json({ error: 'internal_error' });
    return res.status(201).json({ update });
  } catch (err) {
    return res.status(500).json({ error: 'internal_error' });
  }
});

// PATCH /api/admin/updates/:id
adminUpdatesRouter.patch('/:id', async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { id } = req.params;
    if (!UUID.test(id)) return res.status(400).json({ error: 'invalid_id' });

    const { week, title, date, description, items, yt_title, yt_url, published } = req.body;
    const updates = { updated_at: new Date().toISOString() };
    if (week !== undefined) updates.week = week;
    if (title !== undefined) updates.title = title.trim();
    if (date !== undefined) updates.date = date.trim();
    if (description !== undefined) updates.description = description.trim();
    if (items !== undefined) updates.items = items;
    if (yt_title !== undefined) updates.yt_title = yt_title?.trim() || null;
    if (yt_url !== undefined) updates.yt_url = yt_url?.trim() || null;
    if (published !== undefined) updates.published = published;

    const { data: update, error } = await supabase.from('weekly_updates').update(updates).eq('id', id).select().single();
    if (error) return res.status(500).json({ error: 'internal_error' });
    return res.json({ update });
  } catch (err) {
    return res.status(500).json({ error: 'internal_error' });
  }
});

// DELETE /api/admin/updates/:id
adminUpdatesRouter.delete('/:id', async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { id } = req.params;
    if (!UUID.test(id)) return res.status(400).json({ error: 'invalid_id' });

    const { error } = await supabase.from('weekly_updates').delete().eq('id', id);
    if (error) return res.status(500).json({ error: 'internal_error' });
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: 'internal_error' });
  }
});
