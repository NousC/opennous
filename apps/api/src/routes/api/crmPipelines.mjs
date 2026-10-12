// The pipelines a person actually works.
//
// A CRM has several and a rep works some of them. A workspace might run six: Theo Bramwell holds
// open deals in four (Enterprise 40, Sales 20, Partners 10, Trials 1), Lena Quist in two
// (Sales 50, Expansion 5), Rowan Achterberg in one (Expansion 10). Nobody configures that — it falls
// out of what they own, so a new pipeline appears the day someone is given a deal in it and a
// retired one disappears when the last deal leaves.
//
// This is also the fix for the pooling. Until now every open deal from every pipeline landed in
// one list whose stage strip was built from the PRIMARY pipeline's ladder, so Trials'
// `New Signup` and Expansion's `Created ` ranked 1000, sorted to the end, and rendered in the
// same fallback blue as a stage the ladder actually knew. One strip, several funnels, no tell.
//
// NOT `/api/lifecycle/pipelines`: that is taken, by the lifecycle PHASES over `workspace_pipelines`
// (Handoff / Activation / Active customer / Expansion). Two unrelated things are already called
// "pipelines" in this codebase and a third would be one too many.

import { Router } from 'express';
import { getSupabaseClient } from '@nous/core';
import { verifySupabaseAuth } from '../../middleware/supabaseAuth.mjs';
import { resolveViewerOwner } from '../../lib/ownerScope.mjs';
import { listCrmPipelines } from '../../lib/crmPipelines.mjs';

export const crmPipelinesApiRouter = Router();

/**
 * GET /api/crm-pipelines?workspaceId=
 * { pipelines: [{ id, name, open_deals, deals, is_primary }], primary_pipeline_ref }
 */
crmPipelinesApiRouter.get('/', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { workspaceId } = req.query;
    if (!workspaceId) return res.status(400).json({ error: 'workspaceId required' });

    const owner = await resolveViewerOwner(supabase, workspaceId, req);
    return res.json(await listCrmPipelines(supabase, workspaceId, { owner }));
  } catch (err) {
    console.error('[GET /api/crm-pipelines]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});
