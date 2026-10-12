import { Router } from 'express';
import { getSupabaseClient } from '@nous/core';
import { verifySupabaseAuth } from '../../middleware/supabaseAuth.mjs';

export const connectRouter = Router();

// GET /api/connect/cli-status?workspace_id=<id>
// Has a Nous CLI / MCP client ever called in for this workspace? verifyApiKey stamps
// api_keys.last_used_at on every tool call, so a non-null last_used_at means the agent
// connected. The Install page polls this to flip "Waiting…" → "Agent connected".
connectRouter.get('/cli-status', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { workspace_id } = req.query;
    if (!workspace_id) return res.status(400).json({ error: 'workspace_id_required' });

    const { data, error } = await supabase
      .from('api_keys')
      .select('last_used_at')
      .eq('workspace_id', workspace_id)
      .not('last_used_at', 'is', null)
      .order('last_used_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;

    const lastUsed = data?.last_used_at ?? null;
    return res.json({ connected: !!lastUsed, last_used_at: lastUsed });
  } catch (err) {
    console.error('[GET /api/connect/cli-status]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});
