// Skill download counter — public, unauthenticated. Powers the install-count
// social proof on the marketing site's /resources/skills. The copy button POSTs
// an increment; the index + detail pages read the counts. Real counts only.

import { Router } from 'express';
import { getSupabaseClient } from '@nous/core';

export const skillDownloadsRouter = Router();

// GET /api/public/skill-downloads — { counts: { slug: number } }
skillDownloadsRouter.get('/', async (_req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.from('skill_downloads').select('slug, count');
    if (error) throw error;
    const counts = {};
    for (const r of data || []) counts[r.slug] = Number(r.count) || 0;
    return res.json({ counts });
  } catch (err) {
    console.error('[GET /api/public/skill-downloads]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// POST /api/public/skill-downloads/:slug — increment, returns the new count.
skillDownloadsRouter.post('/:slug', async (req, res) => {
  try {
    const slug = String(req.params.slug || '').toLowerCase().slice(0, 80).replace(/[^a-z0-9-]/g, '');
    if (!slug) return res.status(400).json({ error: 'slug_required' });
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.rpc('increment_skill_download', { p_slug: slug });
    if (error) throw error;
    return res.json({ slug, count: Number(data) || 0 });
  } catch (err) {
    console.error('[POST /api/public/skill-downloads]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});
