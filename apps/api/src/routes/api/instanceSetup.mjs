// GET /api/instance/setup?workspaceId= — Settings → Instance setup on a self-hosted install
// (GET-837): what the operator's nous.env has configured. Owners and admins only; 404 on Cloud,
// where none of this is the customer's to set. Never returns a value, only whether it is set.
import { Router } from 'express';
import { getSupabaseClient, claudeClientOptions } from '@nous/core';
import { isSelfHosted } from '../../lib/plans.mjs';
import { modelSetupStatus } from '../../lib/llm.mjs';
import { jobBuilderModel } from '../../lib/model.mjs';
import { integrationStatus, emailStatus, addressStatus, SELF_HOST_GUIDE } from '../../lib/instanceSetup.mjs';

export const instanceSetupRouter = Router();

/** The models, plus the Job Builder's (GET-905): RevBox jobs are built on it, a Claude model by id. */
export function aiSetup(env = process.env) {
  const ai = modelSetupStatus();
  const builder = { tier: 'job_builder', label: 'Building RevBox jobs', model: jobBuilderModel(env).modelId, route: 'anthropic',
    ready: !!claudeClientOptions({ env }), fallback: null, fallbackReady: null };
  return { ...ai, jobs: [...ai.jobs, builder] };
}

instanceSetupRouter.get('/', async (req, res) => {
  if (!isSelfHosted()) return res.status(404).json({ error: 'not_found' });
  if (!(req.workspaceRole === 'owner' || req.workspaceRole === 'admin')) {
    return res.status(403).json({ error: 'admin_required' });
  }
  try {
    const { data: keys } = await getSupabaseClient()
      .from('api_keys').select('last_used_at').eq('workspace_id', req.workspaceId).is('revoked_at', null);
    return res.json({
      guide: SELF_HOST_GUIDE,
      address: addressStatus(),
      ai: aiSetup(),
      email: emailStatus(),
      integrations: integrationStatus(),
      agent: { key_created: (keys ?? []).length > 0, connected: (keys ?? []).some((k) => !!k.last_used_at) },
    });
  } catch (err) {
    console.error('[GET /api/instance/setup]', err?.message || err);
    return res.status(500).json({ error: 'internal_error' });
  }
});
