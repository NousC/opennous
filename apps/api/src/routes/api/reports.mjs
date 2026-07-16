import { Router } from 'express';
import { getSupabaseClient } from '@nous/core';
import { verifySupabaseAuth } from '../../middleware/supabaseAuth.mjs';

export const reportsApiRouter = Router();

// GET /api/reports?workspaceId=&leadListId= — campaign reports, latest first.
// Reports are weekly campaign audits stored as markdown (the agent reads the body
// too, via its own tool). The page lists them; one row per generated report so the
// week-over-week history is just the list.
reportsApiRouter.get('/', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { workspaceId, leadListId } = req.query;
    if (!workspaceId) return res.status(400).json({ error: 'workspace_id_required' });
    if (req.workspaceId !== workspaceId) return res.status(403).json({ error: 'workspace_not_found_or_unauthorized' });

    let q = supabase.from('reports')
      .select('id, lead_list_id, provider, campaign_id, title, period_from, period_to, metrics_json, generated_at')
      .eq('workspace_id', workspaceId)
      .order('generated_at', { ascending: false }).limit(200);
    if (leadListId) q = q.eq('lead_list_id', leadListId);
    const { data, error } = await q;
    if (error) throw error;
    return res.json({ reports: data || [] });
  } catch (err) {
    console.error('[GET /api/reports]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// GET /api/reports/:id?workspaceId= — one report with its markdown body.
reportsApiRouter.get('/:id', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { workspaceId } = req.query;
    if (!workspaceId) return res.status(400).json({ error: 'workspace_id_required' });
    if (req.workspaceId !== workspaceId) return res.status(403).json({ error: 'workspace_not_found_or_unauthorized' });

    const { data, error } = await supabase.from('reports')
      .select('*').eq('id', req.params.id).eq('workspace_id', workspaceId).maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'report_not_found' });
    return res.json({ report: data });
  } catch (err) {
    console.error('[GET /api/reports/:id]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});
