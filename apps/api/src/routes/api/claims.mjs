// Phase 4 — a claim's DERIVED visibility, separate from the evidence it came from.
// Default (null/inherit) = visible exactly per the account dial (open_account_visibility).
// 'shared' = an admin has promoted this extracted fact to the whole workspace, so it reads
// team-wide even for owner-scoped accounts — WITHOUT exposing the raw behind it. Two surfaces:
// promote (admin only) + read the promoted set (any member). The account-gated readers are
// left untouched; this is the one path that intentionally crosses the account gate, and it
// only ever exposes admin-promoted claim VALUES, never supporting raw.

import { Router } from 'express';
import { getSupabaseClient } from '@nous/core';
import { verifySupabaseAuth } from '../../middleware/supabaseAuth.mjs';

export const claimsApiRouter = Router();

const isAdmin = (req) => ['founder', 'owner', 'admin'].includes(req.workspaceRole);

// A raw-bearing claim is a note/document (property `note.*`, or a doc_type in its value) — its
// value IS the raw text, so it can NEVER be promoted. Only structured extracted facts can be shared.
function isRawBearing(claim) {
  if (String(claim?.property || '').startsWith('note.')) return true;
  const v = claim?.value;
  return !!(v && typeof v === 'object' && v.metadata && v.metadata.doc_type);
}

// PATCH /api/claims/:id/visibility { derived_visibility: 'shared' | 'inherit' | null } — admin only.
claimsApiRouter.patch('/:id/visibility', verifySupabaseAuth, async (req, res) => {
  try {
    if (!req.workspaceId) return res.status(401).json({ error: 'unauthorized' });
    if (!isAdmin(req)) return res.status(403).json({ error: 'admins_only' });
    let v = req.body?.derived_visibility ?? null;
    if (v === 'inherit') v = null;                 // inherit == default == null
    if (v !== null && v !== 'shared') return res.status(400).json({ error: 'bad_visibility' });

    const supabase = getSupabaseClient();
    const { data: claim } = await supabase.from('claims')
      .select('id, property, value').eq('id', req.params.id).eq('workspace_id', req.workspaceId).maybeSingle();
    if (!claim) return res.status(404).json({ error: 'not_found' });
    // Leakage guard — never promote a claim whose value carries verbatim raw.
    if (v === 'shared' && isRawBearing(claim)) {
      return res.status(400).json({ error: 'not_promotable', detail: 'This is a raw note/document; only extracted facts can be shared with the team.' });
    }
    const { data, error } = await supabase.from('claims')
      .update({ derived_visibility: v }).eq('id', req.params.id).eq('workspace_id', req.workspaceId)
      .select('id, derived_visibility').single();
    if (error) throw error;
    return res.json({ claim: data });
  } catch (err) {
    console.error('[PATCH /api/claims/:id/visibility]', err);
    return res.status(500).json({ error: 'update_failed' });
  }
});

// GET /api/claims/shared?workspaceId= — the promoted-claims surface. Any member, even for
// accounts they can't otherwise see: the extracted VALUE + a light entity label, never raw.
claimsApiRouter.get('/shared', verifySupabaseAuth, async (req, res) => {
  try {
    if (!req.workspaceId) return res.status(401).json({ error: 'unauthorized' });
    const supabase = getSupabaseClient();
    const { data: claims } = await supabase.from('claims')
      .select('id, entity_id, property, value, confidence, last_observed_at')
      .eq('workspace_id', req.workspaceId)
      .eq('derived_visibility', 'shared')
      .not('property', 'like', 'note.%')          // belt-and-suspenders: never surface a raw note
      .order('last_observed_at', { ascending: false })
      .limit(200);

    // Light entity label only (company/contact name) — never the full record.
    const ids = [...new Set((claims ?? []).map((c) => c.entity_id))];
    const labels = new Map();
    if (ids.length) {
      const [{ data: cos }, { data: cts }] = await Promise.all([
        supabase.from('companies').select('id, name, domain').in('id', ids),
        supabase.from('contacts').select('id, first_name, last_name').in('id', ids),
      ]);
      for (const c of cos ?? []) labels.set(c.id, c.name || c.domain);
      for (const c of cts ?? []) labels.set(c.id, [c.first_name, c.last_name].filter(Boolean).join(' ') || null);
    }
    return res.json({
      claims: (claims ?? []).map((c) => ({
        id: c.id, entity_id: c.entity_id, entity: labels.get(c.entity_id) ?? null,
        property: c.property, value: c.value, confidence: c.confidence, last_observed_at: c.last_observed_at,
      })),
    });
  } catch (err) {
    console.error('[GET /api/claims/shared]', err);
    return res.status(500).json({ error: 'list_failed' });
  }
});
