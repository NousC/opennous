import { Router } from 'express';
import Anthropic, { setUser } from 'useleak';
import {
  getSupabaseClient, listInsights, upsertInsight, insightCategoryLabel,
  INSIGHT_CATEGORY_KEYS, listNotes, buildInsightExtractionPrompt, parseInsightsJson, appendInsights,
} from '@nous/core';
import { verifySupabaseAuth } from '../../middleware/supabaseAuth.mjs';

// Insights are the mirror of foundations: docs Nous LEARNS from calls, not docs
// the user authors. One row per (workspace, category) — product, positioning,
// market, buyer. The extractor appends to them automatically after every call;
// this router lets the Vault list/read/edit them and re-run extraction on demand.

export const insightsApiRouter = Router();

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// GET /api/insights?workspaceId= — the workspace's insight docs (no body, for the list).
insightsApiRouter.get('/', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { workspaceId } = req.query;
    if (!workspaceId) return res.status(400).json({ error: 'workspace_id_required' });
    if (req.workspaceId !== workspaceId) return res.status(403).json({ error: 'workspace_not_found_or_unauthorized' });
    const insights = await listInsights(supabase, workspaceId);
    return res.json({ insights: insights.map(({ body_md, ...rest }) => rest) });
  } catch (err) {
    console.error('[GET /api/insights]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// POST /api/insights/extract?workspaceId= — re-run the insight extractor over the
// workspace's recent call transcripts (the "Extract insights from calls" button).
// Body: { limit? } — how many recent meeting_notes docs to scan (default 25).
insightsApiRouter.post('/extract', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { workspaceId } = req.query;
    if (!workspaceId) return res.status(400).json({ error: 'workspace_id_required' });
    if (req.workspaceId !== workspaceId) return res.status(403).json({ error: 'workspace_not_found_or_unauthorized' });
    setUser({ id: String(workspaceId) });

    const limit = Math.min(50, Math.max(1, Number(req.body?.limit) || 25));
    const notes = await listNotes(supabase, workspaceId, { limit: 200 });
    const calls = notes
      .filter(n => ['meeting_notes', 'transcript'].includes(n.metadata?.doc_type) && (n.content || '').length > 200)
      .slice(0, limit);

    let written = 0, scanned = 0;
    for (const call of calls) {
      scanned += 1;
      try {
        const msg = await anthropic.messages.create({
          feature: 'call-insights-extract',
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 1400,
          messages: [{ role: 'user', content: buildInsightExtractionPrompt(call.content) }],
        });
        const items = parseInsightsJson(msg.content[0]?.text ?? '[]');
        if (items.length) {
          const sourceLabel = (call.metadata?.title || call.metadata?.contact_name || 'a call');
          written += await appendInsights(supabase, workspaceId, items.slice(0, 6), { sourceLabel });
        }
      } catch (e) {
        console.warn('[POST /api/insights/extract] one call failed', e.message);
      }
    }
    return res.json({ scanned, written });
  } catch (err) {
    console.error('[POST /api/insights/extract]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// GET /api/insights/:id?workspaceId= — one insight doc with its markdown body.
insightsApiRouter.get('/:id', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { workspaceId } = req.query;
    if (!workspaceId) return res.status(400).json({ error: 'workspace_id_required' });
    if (req.workspaceId !== workspaceId) return res.status(403).json({ error: 'workspace_not_found_or_unauthorized' });
    const { data, error } = await supabase.from('insights')
      .select('*').eq('id', req.params.id).eq('workspace_id', workspaceId).maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'insight_not_found' });
    return res.json({ insight: data });
  } catch (err) {
    console.error('[GET /api/insights/:id]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// PUT /api/insights/:category?workspaceId= — edit a doc from the Vault. Body: { body_md }.
insightsApiRouter.put('/:category', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { workspaceId } = req.query;
    const { category } = req.params;
    if (!workspaceId) return res.status(400).json({ error: 'workspace_id_required' });
    if (req.workspaceId !== workspaceId) return res.status(403).json({ error: 'workspace_not_found_or_unauthorized' });
    if (!INSIGHT_CATEGORY_KEYS.includes(category)) return res.status(400).json({ error: 'invalid_category' });
    const { body_md } = req.body || {};
    const insight = await upsertInsight(supabase, workspaceId, category, body_md ?? '');
    return res.json({ insight });
  } catch (err) {
    console.error('[PUT /api/insights/:category]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});
