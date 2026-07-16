import { Router } from 'express';
import { getSupabaseClient } from '@nous/core';
import { verifySupabaseAuth } from '../../../middleware/supabaseAuth.mjs';
import { requireAdmin } from '../../../middleware/requireAdmin.mjs';
import { ensureUserAndTeam } from '../../../lib/auth.mjs';

export const adminBlogRouter = Router();

// GET /api/admin/blog/articles
adminBlogRouter.get('/articles', async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { status, article_type } = req.query;

    let query = supabase.from('blog_articles').select('*').order('created_at', { ascending: false });
    if (status && status !== 'all') query = query.eq('status', status);
    if (article_type === 'article') query = query.eq('article_type', 'article');
    else if (article_type === 'announcement') query = query.eq('article_type', 'announcement');

    const { data: articles, error } = await query;
    if (error) return res.status(500).json({ error: 'internal_error', detail: String(error.message || error) });
    return res.json({ articles: articles || [] });
  } catch (err) {
    return res.status(500).json({ error: 'internal_error', detail: String(err.message || err) });
  }
});

// GET /api/admin/blog/articles/:id
adminBlogRouter.get('/articles/:id', async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { data: article, error } = await supabase.from('blog_articles').select('*').eq('id', req.params.id).single();
    if (error) {
      if (error.code === 'PGRST116') return res.status(404).json({ error: 'article_not_found' });
      return res.status(500).json({ error: 'internal_error', detail: String(error.message || error) });
    }
    if (!article) return res.status(404).json({ error: 'article_not_found' });
    return res.json({ article });
  } catch (err) {
    return res.status(500).json({ error: 'internal_error', detail: String(err.message || err) });
  }
});

// POST /api/admin/blog/articles
adminBlogRouter.post('/articles', async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { title, slug, meta_description, cover_image_url, content, featured, status, is_guide, article_type, category, video_url, intro_text, related_workflow_slugs } = req.body;
    const { user } = await ensureUserAndTeam(req.user);

    if (!title || !slug) return res.status(400).json({ error: 'title and slug are required' });

    const { data: existing, error: checkError } = await supabase.from('blog_articles').select('id').eq('slug', slug).single();
    if (checkError && checkError.code !== 'PGRST116') return res.status(500).json({ error: 'internal_error', detail: String(checkError.message || checkError) });
    if (existing) return res.status(400).json({ error: 'slug_already_exists' });

    const articleStatus = status === 'published' ? 'published' : 'draft';
    const { data: article, error } = await supabase.from('blog_articles').insert({
      title, slug,
      meta_description: meta_description || null,
      cover_image_url: cover_image_url || null,
      content: content || {},
      status: articleStatus,
      published_at: articleStatus === 'published' ? new Date().toISOString() : null,
      featured: featured || false,
      is_guide: is_guide || false,
      article_type: article_type || 'article',
      category: category || 'blog',
      video_url: video_url || null,
      intro_text: intro_text || null,
      related_workflow_slugs: related_workflow_slugs || [],
      created_by_user_id: user.id,
    }).select().single();

    if (error) return res.status(500).json({ error: 'internal_error', detail: String(error.message || error) });
    return res.json({ article });
  } catch (err) {
    return res.status(500).json({ error: 'internal_error', detail: String(err.message || err) });
  }
});

// PATCH /api/admin/blog/articles/:id
adminBlogRouter.patch('/articles/:id', async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { id } = req.params;
    const { title, slug, meta_description, cover_image_url, content, featured, status, is_guide, article_type, category, video_url, intro_text, related_workflow_slugs } = req.body;

    if (slug) {
      const { data: existing, error: checkError } = await supabase.from('blog_articles').select('id').eq('slug', slug).neq('id', id).single();
      if (checkError && checkError.code !== 'PGRST116') return res.status(500).json({ error: 'internal_error', detail: String(checkError.message || checkError) });
      if (existing) return res.status(400).json({ error: 'slug_already_exists' });
    }

    const updateData = {};
    if (title !== undefined) updateData.title = title;
    if (slug !== undefined) updateData.slug = slug;
    if (meta_description !== undefined) updateData.meta_description = meta_description;
    if (cover_image_url !== undefined) updateData.cover_image_url = cover_image_url;
    if (content !== undefined) updateData.content = content;
    if (featured !== undefined) updateData.featured = featured;
    if (is_guide !== undefined) updateData.is_guide = is_guide;
    if (article_type !== undefined) updateData.article_type = article_type;
    if (category !== undefined) updateData.category = category;
    if (video_url !== undefined) updateData.video_url = video_url;
    if (intro_text !== undefined) updateData.intro_text = intro_text;
    if (related_workflow_slugs !== undefined) updateData.related_workflow_slugs = related_workflow_slugs;
    if (status !== undefined) {
      updateData.status = status;
      if (status === 'published') {
        const { data: cur } = await supabase.from('blog_articles').select('published_at').eq('id', id).single();
        if (!cur?.published_at) updateData.published_at = new Date().toISOString();
      }
    }

    const { data: article, error } = await supabase.from('blog_articles').update(updateData).eq('id', id).select().single();
    if (error) {
      if (error.code === 'PGRST116') return res.status(404).json({ error: 'article_not_found' });
      return res.status(500).json({ error: 'internal_error', detail: String(error.message || error) });
    }
    return res.json({ article });
  } catch (err) {
    return res.status(500).json({ error: 'internal_error', detail: String(err.message || err) });
  }
});

// DELETE /api/admin/blog/articles/:id
adminBlogRouter.delete('/articles/:id', async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { error } = await supabase.from('blog_articles').delete().eq('id', req.params.id);
    if (error) return res.status(500).json({ error: 'internal_error', detail: String(error.message || error) });
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: 'internal_error', detail: String(err.message || err) });
  }
});

// POST /api/admin/blog/articles/:id/publish
adminBlogRouter.post('/articles/:id/publish', async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { data: article, error } = await supabase.from('blog_articles')
      .update({ status: 'published', published_at: new Date().toISOString() })
      .eq('id', req.params.id).select().single();
    if (error) {
      if (error.code === 'PGRST116') return res.status(404).json({ error: 'article_not_found' });
      return res.status(500).json({ error: 'internal_error', detail: String(error.message || error) });
    }
    return res.json({ article });
  } catch (err) {
    return res.status(500).json({ error: 'internal_error', detail: String(err.message || err) });
  }
});

// POST /api/admin/blog/articles/:id/unpublish
adminBlogRouter.post('/articles/:id/unpublish', async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { data: article, error } = await supabase.from('blog_articles')
      .update({ status: 'draft', published_at: null })
      .eq('id', req.params.id).select().single();
    if (error) {
      if (error.code === 'PGRST116') return res.status(404).json({ error: 'article_not_found' });
      return res.status(500).json({ error: 'internal_error', detail: String(error.message || error) });
    }
    return res.json({ article });
  } catch (err) {
    return res.status(500).json({ error: 'internal_error', detail: String(err.message || err) });
  }
});

export function applyAdminBlogMiddleware(router) {
  router.use(verifySupabaseAuth, requireAdmin);
}
