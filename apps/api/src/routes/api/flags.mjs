import { Router } from 'express';
import { getSupabaseClient, listFlags, setFlagStatus, getWorkspaceMemberNames } from '@nous/core';
import { verifySupabaseAuth } from '../../middleware/supabaseAuth.mjs';
import { isWorkspaceMember } from '../../lib/authz.mjs';

export const flagsApiRouter = Router();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// GET /api/flags?workspaceId= — the open re-engagement worklist, ranked, enriched with
// the account name/domain and owner name so the UI can render a row without extra calls.
flagsApiRouter.get('/', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { workspaceId } = req.query;
    if (!workspaceId) return res.status(400).json({ error: 'workspaceId required' });
    if (!(await isWorkspaceMember(supabase, workspaceId, req.internalUserId))) {
      return res.status(403).json({ error: 'forbidden' });
    }

    const flags = await listFlags(supabase, workspaceId, { statuses: ['open'], limit: 100 });
    const entityIds = [...new Set(flags.map(f => f.entity_id))];
    let companyById = new Map();
    if (entityIds.length) {
      const { data: companies } = await supabase.from('companies')
        .select('id, name, domain').in('id', entityIds);
      companyById = new Map((companies || []).map(c => [c.id, c]));
    }
    const memberNames = await getWorkspaceMemberNames(supabase, workspaceId);

    const rows = flags.map(f => ({
      ...f,
      account_name: companyById.get(f.entity_id)?.name ?? null,
      account_domain: companyById.get(f.entity_id)?.domain ?? null,
      owner_name: f.owner_user_id ? (memberNames.get(f.owner_user_id) ?? null) : null,
    }));
    return res.json({ flags: rows });
  } catch (err) {
    console.error('[GET /api/flags]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// PATCH /api/flags/:id — { status: open|snoozed|dismissed|acted, snoozedUntil? }
flagsApiRouter.patch('/:id', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { id } = req.params;
    if (!UUID.test(id)) return res.status(400).json({ error: 'invalid_id' });
    const { status, snoozedUntil } = req.body || {};
    if (!['open', 'snoozed', 'dismissed', 'acted'].includes(status)) {
      return res.status(400).json({ error: 'invalid_status' });
    }
    const { data: flag } = await supabase.from('flags').select('workspace_id').eq('id', id).maybeSingle();
    if (!flag) return res.status(404).json({ error: 'not_found' });
    if (!(await isWorkspaceMember(supabase, flag.workspace_id, req.internalUserId))) {
      return res.status(403).json({ error: 'forbidden' });
    }
    const updated = await setFlagStatus(supabase, id, status, { snoozedUntil: snoozedUntil ?? null });
    return res.json({ flag: updated });
  } catch (err) {
    console.error('[PATCH /api/flags/:id]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});
