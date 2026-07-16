import { Router } from 'express';
import { getSupabaseClient } from '@nous/core';
import { ensureUserAndTeam } from '../../lib/auth.mjs';

// Curated resource links for the Coffee Shop hub's "Resources" tab.
const RESOURCE_TYPES = ['repo', 'video', 'paper', 'docs', 'guide'];

function detectResourceType(url) {
  const u = String(url).toLowerCase();
  if (/youtube\.com|youtu\.be|vimeo\.com|loom\.com/.test(u)) return 'video';
  if (/github\.com|gitlab\.com|bitbucket\.org/.test(u)) return 'repo';
  if (/arxiv\.org/.test(u) || u.includes('paper')) return 'paper';
  if (/(^|\/\/|\.)docs[./]/.test(u) || u.includes('/docs')) return 'docs';
  return 'guide';
}

function getYouTubeId(url) {
  const m = String(url).match(
    /(?:youtube\.com\/(?:watch\?v=|embed\/)|youtu\.be\/)([\w-]{11})/,
  );
  return m ? m[1] : null;
}

function decodeHtmlEntities(s) {
  return String(s)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&#x27;/gi, "'");
}

function extractMeta(html, prop) {
  const patterns = [
    new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]*content=["']([^"']*)["']`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${prop}["']`, 'i'),
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m && m[1]) return decodeHtmlEntities(m[1]).trim();
  }
  return null;
}

async function unfurlUrl(url) {
  const type = detectResourceType(url);

  // YouTube — oEmbed gives a reliable title; thumbnail is deterministic.
  const ytId = getYouTubeId(url);
  if (ytId) {
    let title = null;
    let description = null;
    try {
      const oe = await fetch(
        `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`,
      );
      if (oe.ok) {
        const j = await oe.json();
        title = j.title || null;
        description = j.author_name ? `by ${j.author_name}` : null;
      }
    } catch { /* ignore */ }
    return {
      title,
      description,
      image: `https://img.youtube.com/vi/${ytId}/hqdefault.jpg`,
      type: 'video',
    };
  }

  // Generic — fetch the page and parse Open Graph / Twitter meta tags.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const resp = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NousBot/1.0)' },
    });
    const html = await resp.text();
    const title =
      extractMeta(html, 'og:title') ||
      extractMeta(html, 'twitter:title') ||
      (html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim() ?? null);
    const description =
      extractMeta(html, 'og:description') ||
      extractMeta(html, 'twitter:description') ||
      extractMeta(html, 'description');
    const image = extractMeta(html, 'og:image') || extractMeta(html, 'twitter:image');
    return { title, description: description || null, image: image || null, type };
  } finally {
    clearTimeout(timer);
  }
}

// ─── Public router — mounted at /api/resources ──────────────────────────────
export const resourcesRouter = Router();

// GET /api/resources — published resources, optionally filtered by ?type=
resourcesRouter.get('/', async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { type } = req.query;
    let query = supabase
      .from('resources')
      .select('id, title, url, type, description, thumbnail_url, sort_order, created_at')
      .eq('published', true)
      .order('sort_order', { ascending: true })
      .order('created_at', { ascending: false });
    if (type && RESOURCE_TYPES.includes(type)) query = query.eq('type', type);
    const { data, error } = await query;
    if (error) {
      console.error('[resources] Supabase error:', error);
      return res.status(500).json({ error: 'internal_error' });
    }
    return res.json({ resources: data || [] });
  } catch (err) {
    console.error('[resources] Caught exception:', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// ─── Admin router — mounted at /api/admin/resources (auth applied at mount) ──
export const adminResourcesRouter = Router();

// GET /api/admin/resources/links — all resources incl. unpublished
adminResourcesRouter.get('/links', async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('resources')
      .select('*')
      .order('sort_order', { ascending: true })
      .order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: 'internal_error', detail: String(error.message || error) });
    return res.json({ resources: data || [] });
  } catch (err) {
    return res.status(500).json({ error: 'internal_error', detail: String(err.message || err) });
  }
});

// POST /api/admin/resources/links — create
adminResourcesRouter.post('/links', async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { title, url, type, description, thumbnail_url, sort_order, published } = req.body;
    if (!title || !url) return res.status(400).json({ error: 'title and url are required' });
    const { user } = await ensureUserAndTeam(req.user);
    const { data, error } = await supabase
      .from('resources')
      .insert({
        title,
        url,
        type: RESOURCE_TYPES.includes(type) ? type : 'docs',
        description: description || null,
        thumbnail_url: thumbnail_url || null,
        sort_order: Number.isFinite(sort_order) ? sort_order : 0,
        published: published !== false,
        created_by_user_id: user.id,
      })
      .select()
      .single();
    if (error) return res.status(500).json({ error: 'internal_error', detail: String(error.message || error) });
    return res.json({ resource: data });
  } catch (err) {
    return res.status(500).json({ error: 'internal_error', detail: String(err.message || err) });
  }
});

// PATCH /api/admin/resources/links/:id — update
adminResourcesRouter.patch('/links/:id', async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { id } = req.params;
    const { title, url, type, description, thumbnail_url, sort_order, published } = req.body;
    const updateData = { updated_at: new Date().toISOString() };
    if (title !== undefined) updateData.title = title;
    if (url !== undefined) updateData.url = url;
    if (type !== undefined) updateData.type = RESOURCE_TYPES.includes(type) ? type : 'docs';
    if (description !== undefined) updateData.description = description;
    if (thumbnail_url !== undefined) updateData.thumbnail_url = thumbnail_url;
    if (sort_order !== undefined) updateData.sort_order = sort_order;
    if (published !== undefined) updateData.published = published;
    const { data, error } = await supabase
      .from('resources')
      .update(updateData)
      .eq('id', id)
      .select()
      .single();
    if (error) {
      if (error.code === 'PGRST116') return res.status(404).json({ error: 'resource_not_found' });
      return res.status(500).json({ error: 'internal_error', detail: String(error.message || error) });
    }
    return res.json({ resource: data });
  } catch (err) {
    return res.status(500).json({ error: 'internal_error', detail: String(err.message || err) });
  }
});

// DELETE /api/admin/resources/links/:id
adminResourcesRouter.delete('/links/:id', async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { error } = await supabase.from('resources').delete().eq('id', req.params.id);
    if (error) return res.status(500).json({ error: 'internal_error', detail: String(error.message || error) });
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: 'internal_error', detail: String(err.message || err) });
  }
});

// POST /api/admin/resources/unfurl — fetch OG metadata for a pasted URL
adminResourcesRouter.post('/unfurl', async (req, res) => {
  try {
    const { url } = req.body;
    if (!url || !/^https?:\/\//i.test(url)) {
      return res.status(400).json({ error: 'valid_url_required' });
    }
    const result = await unfurlUrl(url);
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ error: 'unfurl_failed', detail: String(err.message || err) });
  }
});
