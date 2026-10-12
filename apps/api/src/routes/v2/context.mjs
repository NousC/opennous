import { Router } from 'express';
import { getSupabaseClient, assembleContext, resolveFocus, CONTEXT_INTENTS, readContextFromReq, getLatestScorecard } from '@nous/core';
import { icpFit, fetchIcpLayers } from '../../lib/icpFit.mjs';
import { accountMeetings } from '../../lib/calendar.mjs';
import { resolveDealRef, loadPublicDeal, contextDealBlock } from '../../lib/publicApi.mjs';

export const contextV2Router = Router();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// POST /v2/context — engineered context for an intent on one entity.
// Body: { focus: <entity UUID | email | deal id>, intent?: ContextIntent, budget_tokens?: number }
// Runs the pipeline: retrieve -> rank -> connect -> compress -> tag -> budget.
//
// A DEAL as the focus (a CRM deal entity UUID, or `implied:<account id>`): the context engine
// works on accounts, so the deal resolves to its account's context, and the deal itself rides
// FIRST in the response as `deal` — the list shape (/v2/deals) plus its stakeholders and the
// objections / competitors / budget / timeline filed to it. Done here, at the route, by wrapping
// the account context; core's assembleContext is untouched. win_probability is null in that
// block (the outlook is a workspace-wide pass — GET /v2/deals/:id carries it). A deal outside the
// caller's book is 404 deal_not_found.
contextV2Router.post('/', async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const workspaceId = req.workspaceId;
    const { focus, intent = 'account_review', budget_tokens } = req.body;

    if (!focus) return res.status(400).json({ error: 'focus_required' });
    if (!CONTEXT_INTENTS.includes(intent)) {
      return res.status(400).json({ error: 'invalid_intent', valid_intents: CONTEXT_INTENTS });
    }

    // A deal id first: it resolves to its account, and the deal leads the answer.
    let deal = null;
    let resolution;
    const dealRef = await resolveDealRef(supabase, req, workspaceId, String(focus));
    if (dealRef.status === 'not_found') {
      return res.status(404).json({ error: 'deal_not_found', ...(dealRef.detail ? { detail: dealRef.detail } : {}) });
    }
    if (dealRef.status === 'ok') {
      const detail = await loadPublicDeal(supabase, req, workspaceId, dealRef);
      if (!detail) return res.status(404).json({ error: 'deal_not_found' });
      deal = contextDealBlock(detail);
      resolution = { status: 'resolved', entity_id: dealRef.company.id };
    } else {
      // focus may be a UUID, email, domain, LinkedIn URL, or a name.
      resolution = await resolveFocus(supabase, workspaceId, String(focus));
    }
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
    // The layered ICP breakdown + enrichment worklist, so the agent reads the four
    // layers (Fit·Pain·Intent·Ability) and knows what's unresolved, not just one number.
    const layered = await fetchIcpLayers(supabase, workspaceId, resolution.entity_id);
    // Coaching v2 (GET-84): the latest call scorecard rides along so the after-call skill reads it.
    const scorecard = await getLatestScorecard(supabase, workspaceId, resolution.entity_id).catch(() => null);
    // GET-231: a meeting prep starts from the meeting — the next and last on this account, with
    // every attendee. Same reader as the in-app get_context.
    const meetings = intent === 'meeting_prep' || intent === 'call_prep'
      ? await accountMeetings(supabase, workspaceId, resolution.entity_id).catch(() => null)
      : null;
    return res.json({
      // A deal focus leads with the deal it was asked about.
      ...(deal ? { deal } : {}),
      // First, like the in-app tool: the meeting is what a prep is FOR (GET-238).
      ...(meetings ? { meetings } : {}),
      ...context,
      ...(icp ? { icp } : {}),
      ...(layered ? { layered } : {}),
      ...(scorecard ? { scorecard } : {}),
    });
  } catch (err) {
    console.error('[POST /v2/context]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});
