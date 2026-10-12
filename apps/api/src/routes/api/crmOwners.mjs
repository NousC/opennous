// The settings surface behind "yours": which Nous member is which CRM owner.
//
// Owner scoping is the whole point of the accounts work, and it is inert until somebody answers
// this question once per workspace. The screen this backs shows three columns — the CRM owners
// actually present in the data, what each one holds, and the member they map to — so an admin can
// see at a glance who is unmapped and therefore still seeing everything.
//
// Everything here is admin-only. A member deciding which CRM owner they are would be a member
// deciding whose pipeline they can read.

import express from 'express';
import { getSupabaseClient } from '@nous/core';
import { verifySupabaseAuth } from '../../middleware/supabaseAuth.mjs';

export const crmOwnersApiRouter = express.Router();

const isAdmin = (req) => req.viewerScope === 'admin' || req.viewerScope === 'owner' || req.viewerScope == null;

/**
 * GET /api/crm-owners?workspaceId=
 * The owners the CRM actually gave us, what each holds, and who they map to.
 */
crmOwnersApiRouter.get('/', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { workspaceId } = req.query;
    if (!workspaceId) return res.status(400).json({ error: 'workspaceId required' });
    if (!isAdmin(req)) return res.status(403).json({ error: 'admin_only' });

    // Counted off the flattened rows rather than the claims table: this is the same scan the
    // lists do, and it is what the admin is about to scope people against.
    const owners = new Map();
    const bump = (name, email, key) => {
      if (!name && !email) return;
      const id = String(name ?? email).toLowerCase();
      const row = owners.get(id) ?? { owner_name: name ?? null, owner_email: email ?? null, accounts: 0, open_deals: 0 };
      row[key] += 1;
      if (!row.owner_email && email) row.owner_email = email;
      owners.set(id, row);
    };
    for (const kind of ['account', 'deal']) {
      for (let from = 0; ; from += 1000) {
        const { data, error } = await supabase.from('entity_list_rows')
          .select('owner_name, owner_email, status')
          .eq('workspace_id', workspaceId).eq('kind', kind)
          .order('entity_id', { ascending: true }).range(from, from + 999);
        if (error) throw error;
        for (const r of data ?? []) {
          if (kind === 'account') {
            bump(r.owner_name, r.owner_email, 'accounts');
          } else if (r.status === 'open') {
            bump(r.owner_name, r.owner_email, 'open_deals');
          }
        }
        if (!data || data.length < 1000) break;
      }
    }

    const [{ data: mappings }, { data: members }] = await Promise.all([
      supabase.from('workspace_crm_owners')
        .select('user_id, owner_name, owner_email, matched_by').eq('workspace_id', workspaceId),
      supabase.from('workspace_members').select('user_id').eq('workspace_id', workspaceId),
    ]);

    const userIds = [...new Set((members ?? []).map(m => m.user_id).filter(Boolean))];
    const people = [];
    for (let i = 0; i < userIds.length; i += 100) {
      const { data } = await supabase.from('users').select('id, name, email').in('id', userIds.slice(i, i + 100));
      people.push(...(data ?? []));
    }

    return res.json({
      owners: [...owners.values()].sort((a, b) => (b.open_deals + b.accounts) - (a.open_deals + a.accounts)),
      mappings: mappings ?? [],
      members: people,
      // An admin reading this should be able to see the consequence, not just the table: every
      // unmapped member still reads the whole workspace.
      unmapped: people.filter(p => !(mappings ?? []).some(m => m.user_id === p.id)).length,
    });
  } catch (err) {
    console.error('[GET /api/crm-owners]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

/**
 * POST /api/crm-owners — map a member to a CRM owner, or clear the mapping.
 * body: { workspaceId, userId, owner_name?, owner_email?, clear? }
 */
crmOwnersApiRouter.post('/', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { workspaceId, userId, owner_name = null, owner_email = null, clear = false } = req.body ?? {};
    if (!workspaceId || !userId) return res.status(400).json({ error: 'workspaceId and userId required' });
    if (!isAdmin(req)) return res.status(403).json({ error: 'admin_only' });

    if (clear) {
      const { error } = await supabase.from('workspace_crm_owners')
        .delete().eq('workspace_id', workspaceId).eq('user_id', userId);
      if (error) throw error;
      return res.json({ ok: true, cleared: true });
    }
    if (!owner_name && !owner_email) return res.status(400).json({ error: 'owner_name or owner_email required' });

    const { error } = await supabase.from('workspace_crm_owners').upsert({
      workspace_id: workspaceId, user_id: userId,
      owner_name, owner_email, matched_by: 'manual', updated_at: new Date().toISOString(),
    }, { onConflict: 'workspace_id,user_id' });
    // The unique indexes are the real guard: two members cannot claim one CRM owner, because each
    // would then see a different half of the same book with nothing saying why.
    if (error) {
      if (String(error.code) === '23505') return res.status(409).json({ error: 'owner_already_mapped' });
      throw error;
    }
    return res.json({ ok: true });
  } catch (err) {
    console.error('[POST /api/crm-owners]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});
