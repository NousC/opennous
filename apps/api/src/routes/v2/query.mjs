import { Router } from 'express';
import { getSupabaseClient, runQuery, readContextFromReq, resolveFocus } from '@nous/core';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const queryV2Router = Router();

// POST /v2/query — retrieve and summarise a corpus of observations.
// Body: {
//   scope:    { kind?, property?, source?, entity_id?, since_days?, limit? },
//   without?: { ...same shape as scope },        // entities IN scope minus entities IN without
//   return?:  'observations' | 'entities',       // default 'observations'
//   question?: string,                            // analytical question — echoed back; enables semantic mode
//   budget_tokens?: number
// }
// The API retrieves + compacts; the agent does the pattern-finding.
//
// Use cases the new params unlock:
//   • "Hottest leads"             — return:'entities' over recent replies
//   • "Didn't reply in 5 days"    — without: replies in same 5d window
//   • "Cooled in 5 days"          — without: any activity in last 5d
//   • "Funnel by stage"           — scope.kind='state', property='stage' → rollups.by_value
//   • "Which accounts want off X" — scope.facts:true + question → semantic search over the
//                                   FACTS corpus (note.* claims); return:'entities' = best
//                                   matching fact per account. Per-account facts come back
//                                   inline with get_account, so this is for cross-account lookup.
queryV2Router.post('/', async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    let { scope = {}, without, return: returnMode, question } = req.body;

    // scope.entity_id is documented as a pre-resolved id, but callers (and agents)
    // routinely pass a bare name. Resolve it here so a name scopes the query instead
    // of silently matching nothing. An ambiguous name returns its candidates rather
    // than picking one arbitrarily.
    if (scope?.entity_id && !UUID_RE.test(String(scope.entity_id))) {
      const r = await resolveFocus(supabase, req.workspaceId, String(scope.entity_id)).catch(() => null);
      if (r?.status === 'ambiguous') {
        return res.json({ status: 'ambiguous', candidates: r.candidates, question: question ?? null });
      }
      if (r?.entity_id) scope = { ...scope, entity_id: r.entity_id };
    }

    const result = await runQuery(supabase, req.workspaceId, scope, question, {
      return: returnMode,
      without,
      excludeInternal: true,
    }, readContextFromReq(req));
    return res.json({ ...result, question: question ?? null });
  } catch (err) {
    console.error('[POST /v2/query]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});
