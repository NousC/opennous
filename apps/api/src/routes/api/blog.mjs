import { Router } from 'express';
import { getSupabaseClient } from '@nous/core';

export const blogRouter = Router();

// GET /api/blog/articles — public read (used by opennous.cloud website)
//
// The blog_articles table doesn't have an `excerpt` column — it uses
// `meta_description` and `intro_text` instead. We alias meta_description as
// `excerpt` in the response so existing clients (opennous.cloud / nous-site)
// keep working with the original shape.
blogRouter.get('/articles', async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { limit = 100, article_type, category } = req.query;

    let query = supabase
      .from('blog_articles')
      .select(
        'id, title, slug, excerpt:meta_description, meta_description, cover_image_url, article_type, category, featured, status, created_at, published_at'
      )
      .eq('status', 'published')
      .order('published_at', { ascending: false, nullsFirst: false })
      .limit(Number(limit));

    if (article_type) query = query.eq('article_type', article_type);
    if (category) query = query.eq('category', category);

    const { data: articles, error } = await query;
    if (error) {
      console.error('[blog.articles] Supabase error:', error);
      return res.status(500).json({ error: 'internal_error' });
    }
    return res.json({ articles: articles || [] });
  } catch (err) {
    console.error('[blog.articles] Caught exception:', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// GET /api/blog/articles/:slug — public read
blogRouter.get('/articles/:slug', async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { data: article, error } = await supabase
      .from('blog_articles')
      .select('*')
      .eq('slug', req.params.slug)
      .eq('status', 'published')
      .single();

    if (error || !article) return res.status(404).json({ error: 'not_found' });
    return res.json({ article });
  } catch (err) {
    return res.status(500).json({ error: 'internal_error' });
  }
});
