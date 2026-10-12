import { Router } from 'express';
import { getSupabaseClient } from '@nous/core';
import { learnedIcpModel, cloudOnlyIcp } from '../../lib/icpScorer.mjs';

export const scoreV2Router = Router();

const MAX_BATCH = 100;
// Inline (stateless) batch can go much higher — it's pure in-memory scoring off a
// model loaded once, no per-lead DB work and nothing written.
const MAX_INLINE_BATCH = 1000;

// POST /v2/score — the public scoring verb. The thin contract an external list
// (Google Sheet, Clay column, agent) calls to get Nous's judgment on a row and
// have it land in the graph. Bills as a retrieval op (logV2Op), same as
// get_context / query — you pay for the intelligence, not for storing the list.
//
// Single:  { identifier: "jane@acme.example", intent?: "..." }
// Cold:    { attributes: { job_title, company_type, industry, employee_count, keywords|headline, ... }, intent? }
//          — a lead NOT in Nous, scored inline from what you have; nothing is written.
//          (identifier + attributes together: score the entity if it exists, else the attributes.)
// Cold batch (external list): { leads: [{ ref?, ...attributes } | { ref?, attributes }, ...] }
//          — up to 1000 cold leads scored inline in ONE call, model loaded once,
//          nothing written. `ref`/`id` on each lead is echoed back to match rows.
// Graph batch: { identifiers: ["jane@acme.example", "acme.example", ...], intent?: "..." }
//          (entity-based, capped at 100; loop for larger lists.)
//
// identifier accepts an email, domain, LinkedIn URL, or entity UUID.
//
// The judgment is the learned ICP scorer's, Nous Cloud's (GET-754 slice 8). An open-source build
// answers 403 cloud_only_feature: there a workspace scores with its own model and posts the
// results to POST /v2/scores, and reads them back through get_context / get_account.
scoreV2Router.post('/', async (req, res) => {
  try {
    const learned = await learnedIcpModel();
    if (!learned) return cloudOnlyIcp(res);
    const { scoreIdentifier, scoreLeadsInline } = learned;
    const supabase = getSupabaseClient();
    const workspaceId = req.workspaceId;
    const { identifier, identifiers, intent, attributes, leads } = req.body || {};

    // Cold-list inline batch — pure, stateless, no writes.
    if (Array.isArray(leads)) {
      if (leads.length === 0) return res.status(400).json({ error: 'leads_empty' });
      if (leads.length > MAX_INLINE_BATCH) return res.status(400).json({ error: 'batch_too_large', max: MAX_INLINE_BATCH });
      const results = await scoreLeadsInline(supabase, workspaceId, leads);
      return res.json({ results, persisted: false });
    }

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

    if (!identifier && !attributes) return res.status(400).json({ error: 'identifier_required' });
    const result = await scoreIdentifier(supabase, workspaceId, identifier, { intent, attributes });
    return res.json(result);
  } catch (err) {
    console.error('[POST /v2/score]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});
