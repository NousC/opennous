import { Router } from 'express';
import { getSupabaseClient, listConflicts, resolveConflictByHuman, setConflictStatus, assertClaims } from '@nous/core';
import { verifySupabaseAuth } from '../../middleware/supabaseAuth.mjs';
import { isWorkspaceMember } from '../../lib/authz.mjs';

// Auto-reconcile: the "see every conflict, resolved" surface. Cross-source disagreements on a
// canonical axis (e.g. Salesforce churned vs Stripe paid → lifecycle) raised by the claim
// engine.
export const conflictsApiRouter = Router();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// GET /api/conflicts?workspaceId= — open conflicts, pending (need a human) first, enriched
// with the account name/domain so the UI renders a row without extra calls.
conflictsApiRouter.get('/', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { workspaceId } = req.query;
    if (!workspaceId) return res.status(400).json({ error: 'workspaceId required' });
    if (!(await isWorkspaceMember(supabase, workspaceId, req.internalUserId))) {
      return res.status(403).json({ error: 'forbidden' });
    }

    const conflicts = await listConflicts(supabase, workspaceId, { statuses: ['open'], limit: 100 });
    const entityIds = [...new Set(conflicts.map(c => c.entity_id))];
    let nameById = new Map();
    if (entityIds.length) {
      const [{ data: companies }, { data: contacts }] = await Promise.all([
        supabase.from('companies').select('id, name, domain').in('id', entityIds),
        supabase.from('contacts').select('id, name').in('id', entityIds),
      ]);
      for (const c of companies || []) nameById.set(c.id, { name: c.name, domain: c.domain });
      for (const c of contacts || []) if (!nameById.has(c.id)) nameById.set(c.id, { name: c.name, domain: null });
    }

    const rows = conflicts.map(c => ({
      ...c,
      account_name: nameById.get(c.entity_id)?.name ?? null,
      account_domain: nameById.get(c.entity_id)?.domain ?? null,
    }));
    return res.json({ conflicts: rows });
  } catch (err) {
    console.error('[GET /api/conflicts]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// POST /api/conflicts/:id/resolve — { value } — a human picks the winning value. Asserts the
// claim (sticky, derivation won't revert it) and marks the conflict human_resolved.
conflictsApiRouter.post('/:id/resolve', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { id } = req.params;
    if (!UUID.test(id)) return res.status(400).json({ error: 'invalid_id' });
    const { value } = req.body || {};
    if (value === undefined) return res.status(400).json({ error: 'value required' });

    const { data: conflict } = await supabase
      .from('field_conflicts')
      .select('workspace_id, entity_id, canonical_property')
      .eq('id', id)
      .maybeSingle();
    if (!conflict) return res.status(404).json({ error: 'not_found' });
    if (!(await isWorkspaceMember(supabase, conflict.workspace_id, req.internalUserId))) {
      return res.status(403).json({ error: 'forbidden' });
    }

    // Assert first so the axis stops re-deriving away from the human's pick, then close.
    await assertClaims(supabase, conflict.workspace_id, conflict.entity_id, {
      values: { [conflict.canonical_property]: value },
      source: 'user',
    });
    const updated = await resolveConflictByHuman(supabase, id, value, req.internalUserId);
    return res.json({ conflict: updated });
  } catch (err) {
    console.error('[POST /api/conflicts/:id/resolve]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// POST /api/conflicts/:id/dismiss — hide it without picking a value.
conflictsApiRouter.post('/:id/dismiss', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { id } = req.params;
    if (!UUID.test(id)) return res.status(400).json({ error: 'invalid_id' });
    const { data: conflict } = await supabase.from('field_conflicts').select('workspace_id').eq('id', id).maybeSingle();
    if (!conflict) return res.status(404).json({ error: 'not_found' });
    if (!(await isWorkspaceMember(supabase, conflict.workspace_id, req.internalUserId))) {
      return res.status(403).json({ error: 'forbidden' });
    }
    const updated = await setConflictStatus(supabase, id, 'dismissed');
    return res.json({ conflict: updated });
  } catch (err) {
    console.error('[POST /api/conflicts/:id/dismiss]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});
