import { Router } from 'express';
import { getSupabaseClient, listIdentityProposals, getIdentityProposal, setIdentityProposalStatus, mergeEntities } from '@nous/core';
import { verifySupabaseAuth } from '../../middleware/supabaseAuth.mjs';
import { isWorkspaceMember } from '../../lib/authz.mjs';

// Piece 4 of auto-reconcile: identity approve/deny. A plausible-but-uncertain person match
// surfaces as a proposal; approve merges, deny/dismiss keeps them separate.
export const identityProposalsApiRouter = Router();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// GET /api/identity-proposals?workspaceId= — pending merge proposals, enriched with the
// subject + candidate names so the UI can render "merge A into B?" without extra calls.
identityProposalsApiRouter.get('/', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { workspaceId } = req.query;
    if (!workspaceId) return res.status(400).json({ error: 'workspaceId required' });
    if (!(await isWorkspaceMember(supabase, workspaceId, req.internalUserId))) {
      return res.status(403).json({ error: 'forbidden' });
    }

    const proposals = await listIdentityProposals(supabase, workspaceId, { statuses: ['pending'], limit: 100 });
    const ids = new Set();
    for (const p of proposals) { ids.add(p.entity_id); for (const c of p.candidates) ids.add(c.entity_id); }
    let nameById = new Map();
    if (ids.size) {
      const { data: contacts } = await supabase.from('contacts').select('id, name, email').in('id', [...ids]);
      for (const c of contacts || []) nameById.set(c.id, { name: c.name, email: c.email });
    }
    const label = (id) => nameById.get(id)?.name || nameById.get(id)?.email || 'Unknown';
    const rows = proposals.map(p => ({
      ...p,
      subject_name: label(p.entity_id),
      candidates: p.candidates.map(c => ({ ...c, name: label(c.entity_id) })),
    }));
    return res.json({ proposals: rows });
  } catch (err) {
    console.error('[GET /api/identity-proposals]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// POST /api/identity-proposals/:id/approve — { candidateEntityId } — merge the subject into
// the chosen existing account (keep the richer existing record, drop the new duplicate).
identityProposalsApiRouter.post('/:id/approve', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { id } = req.params;
    if (!UUID.test(id)) return res.status(400).json({ error: 'invalid_id' });
    const { candidateEntityId } = req.body || {};
    if (!candidateEntityId || !UUID.test(candidateEntityId)) return res.status(400).json({ error: 'candidateEntityId required' });

    const proposal = await getIdentityProposal(supabase, id);
    if (!proposal) return res.status(404).json({ error: 'not_found' });
    if (!(await isWorkspaceMember(supabase, proposal.workspace_id, req.internalUserId))) {
      return res.status(403).json({ error: 'forbidden' });
    }
    if (!proposal.candidates.some(c => c.entity_id === candidateEntityId)) {
      return res.status(400).json({ error: 'candidate_not_in_proposal' });
    }

    // Keep the chosen existing account, drop the just-created subject (lossless, reversible).
    const summary = await mergeEntities(supabase, proposal.workspace_id, candidateEntityId, proposal.entity_id);
    await setIdentityProposalStatus(supabase, id, 'approved', req.internalUserId);
    return res.json({ merged_into: candidateEntityId, summary });
  } catch (err) {
    console.error('[POST /api/identity-proposals/:id/approve]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// POST /api/identity-proposals/:id/deny — keep them separate; remember the decision.
identityProposalsApiRouter.post('/:id/deny', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { id } = req.params;
    if (!UUID.test(id)) return res.status(400).json({ error: 'invalid_id' });
    const proposal = await getIdentityProposal(supabase, id);
    if (!proposal) return res.status(404).json({ error: 'not_found' });
    if (!(await isWorkspaceMember(supabase, proposal.workspace_id, req.internalUserId))) {
      return res.status(403).json({ error: 'forbidden' });
    }
    const updated = await setIdentityProposalStatus(supabase, id, 'denied', req.internalUserId);
    return res.json({ proposal: updated });
  } catch (err) {
    console.error('[POST /api/identity-proposals/:id/deny]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});
