import { Router } from 'express';
import { getSupabaseClient, getAttention, readContextFromReq } from '@nous/core';

export const attentionV2Router = Router();

// GET /v2/attention — what an agent should look at, workspace-wide:
// accounts gone quiet, key facts decayed. Ranked decisions, each with a
// suggested action.
attentionV2Router.get('/', async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const limit = req.query.limit ? parseInt(req.query.limit, 10) : undefined;
    const result = await getAttention(supabase, req.workspaceId, { limit }, readContextFromReq(req));
    return res.json(result);
  } catch (err) {
    console.error('[GET /v2/attention]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});
