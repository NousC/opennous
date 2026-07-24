import { Router } from 'express';
import { getSupabaseClient, listInsights, getInsight } from '@nous/core';

// Agent-facing insights (what Nous LEARNED about us from calls). Auth is the pk_
// API key (verifyApiKey sets req.workspaceId), so MCP tools and Claude Code can
// read them. Read-only over MCP: insights are authored by the extractor, not by
// agents. GET /v2/insights[?category=].
export const insightsV2Router = Router();

insightsV2Router.get('/', async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { category } = req.query;
    if (category) {
      const insight = await getInsight(supabase, req.workspaceId, category);
      return res.json({ insights: insight ? [insight] : [] });
    }
    const insights = await listInsights(supabase, req.workspaceId);
    return res.json({ insights });
  } catch (err) {
    console.error('[GET /v2/insights]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});
