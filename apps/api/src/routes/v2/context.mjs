import { Router } from 'express';
import { getSupabaseClient, assembleContext, resolveFocus, CONTEXT_INTENTS, readContextFromReq } from '@nous/core';
import { icpFit } from '../../lib/icpFit.mjs';

export const contextV2Router = Router();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// POST /v2/context — engineered context for an intent on one entity.
// Body: { focus: <entity UUID | email>, intent?: ContextIntent, budget_tokens?: number }
// Runs the pipeline: retrieve -> rank -> connect -> compress -> tag -> budget.
contextV2Router.post('/', async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const workspaceId = req.workspaceId;
    const { focus, intent = 'account_review', budget_tokens } = req.body;

    if (!focus) return res.status(400).json({ error: 'focus_required' });
    if (!CONTEXT_INTENTS.includes(intent)) {
      return res.status(400).json({ error: 'invalid_intent', valid_intents: CONTEXT_INTENTS });
    }

    // focus may be a UUID, email, domain, LinkedIn URL, or a name.
    const resolution = await resolveFocus(supabase, workspaceId, String(focus));
    if (resolution.status === 'not_found') {
      return res.status(404).json({ error: 'entity_not_found' });
    }
    if (resolution.status === 'ambiguous') {
      // a name matched several people — the agent picks one and re-calls
      return res.json({ status: 'ambiguous', candidates: resolution.candidates });
    }

    const context = await assembleContext(supabase, workspaceId, resolution.entity_id, intent, budget_tokens, readContextFromReq(req));
    if (!context) return res.status(404).json({ error: 'entity_not_found' });
    const icp = await icpFit(supabase, workspaceId, resolution.entity_id);
    return res.json(icp ? { ...context, icp } : context);
  } catch (err) {
    console.error('[POST /v2/context]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});
