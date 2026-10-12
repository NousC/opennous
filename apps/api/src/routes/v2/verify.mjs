import { Router } from 'express';
import { getSupabaseClient, resolveFocus, verifyClaim } from '@nous/core';

export const verifyV2Router = Router();

// POST /v2/verify — re-check a claim before acting on it.
// Body: { focus: <uuid|email|domain|linkedin|name>, property: string }
// v1: re-derives the claim from current observations and reports before/after.
// (Auto re-enrichment / live probes are a follow-up — they need connector wiring.)
verifyV2Router.post('/', async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { focus, property } = req.body;
    if (!focus || !property) {
      return res.status(400).json({ error: 'focus_and_property_required' });
    }

    const resolution = await resolveFocus(supabase, req.workspaceId, String(focus));
    if (resolution.status === 'not_found') return res.status(404).json({ error: 'entity_not_found' });
    if (resolution.status === 'ambiguous') {
      return res.json({ status: 'ambiguous', candidates: resolution.candidates });
    }

    const { before, after } = await verifyClaim(supabase, req.workspaceId, resolution.entity_id, property);
    if (!after) return res.status(404).json({ error: 'claim_not_found' });

    const stale = after.freshness === 'suspect' || after.freshness === 'expired';
    return res.json({
      property,
      before,
      after,
      note: stale
        ? `Re-derived from existing observations — still ${after.freshness}. No fresh evidence; ` +
          `record a new observation or re-enrich to confirm.`
        : 'Re-derived from current observations.',
    });
  } catch (err) {
    console.error('[POST /v2/verify]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});
