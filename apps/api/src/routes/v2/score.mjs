import { Router } from 'express';
import { getSupabaseClient } from '@nous/core';
import { scoreIdentifier } from '../../lib/scoreIdentifier.mjs';

export const scoreV2Router = Router();

const MAX_BATCH = 100;

// POST /v2/score — the public scoring verb. The thin contract an external list
// (Google Sheet, Clay column, agent) calls to get Nous's judgment on a row and
// have it land in the graph. Bills as a retrieval op (logV2Op), same as
// get_context / query — you pay for the intelligence, not for storing the list.
//
// Single:  { identifier: "jane@acme.com", intent?: "..." }
// Batch:   { identifiers: ["jane@acme.com", "acme.com", ...], intent?: "..." }
//          (capped at 100 per call; loop for larger lists.)
//
// identifier accepts an email, domain, LinkedIn URL, or entity UUID.
scoreV2Router.post('/', async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const workspaceId = req.workspaceId;
    const { identifier, identifiers, intent } = req.body || {};

    if (Array.isArray(identifiers)) {
      if (identifiers.length === 0) return res.status(400).json({ error: 'identifiers_empty' });
      if (identifiers.length > MAX_BATCH) {
        return res.status(400).json({ error: 'batch_too_large', max: MAX_BATCH });
      }
      const results = [];
      for (const id of identifiers) {
        const r = await scoreIdentifier(supabase, workspaceId, id, { intent });
        results.push({ identifier: id, ...r });
      }
      return res.json({ results });
    }

    if (!identifier) return res.status(400).json({ error: 'identifier_required' });
    const result = await scoreIdentifier(supabase, workspaceId, identifier, { intent });
    return res.json(result);
  } catch (err) {
    console.error('[POST /v2/score]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});
