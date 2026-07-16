import { Router } from 'express';
import { getSupabaseClient } from '@nous/core';

// GET /v2/action-items — the agent's read path for commitments extracted from
// meetings/emails. Action items live as `action_item.*` state claims on the
// account entity (written by the worker), so this just reads + filters them.
//   owner=me|prospect|all   (default me — the founder's own commitments)
//   status=open|done|all    (default open)
//   focus=<email|entity_id> (optional — scope to one account)
//   due=today|week|all      (default all; today/week filter items that have a due_at)
export const actionItemsV2Router = Router();

const DAY = 86_400_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

actionItemsV2Router.get('/', async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const workspaceId = req.workspaceId;
    const owner  = (req.query.owner  || 'me').toString();
    const status = (req.query.status || 'open').toString();
    const due    = (req.query.due    || 'all').toString();
    const focus  = req.query.focus ? req.query.focus.toString().trim() : null;
    const limit  = Math.min(parseInt(req.query.limit, 10) || 200, 500);

    // Optional account scope: resolve focus (entity id or email) → entity_id.
    let focusEntityId = null;
    if (focus) {
      if (UUID.test(focus)) {
        focusEntityId = focus;
      } else {
        const email = focus.toLowerCase();
        const { data: ident } = await supabase.from('entity_identifiers')
          .select('entity_id').eq('workspace_id', workspaceId)
          .eq('kind', 'email').eq('value', email).maybeSingle();
        focusEntityId = ident?.entity_id
          || (await supabase.from('contacts').select('id')
                .eq('workspace_id', workspaceId).eq('email', email).maybeSingle()).data?.id
          || null;
      }
      if (!focusEntityId) return res.json({ items: [], count: 0 });
    }

    let q = supabase.from('claims')
      .select('entity_id, property, value, computed_at')
      .eq('workspace_id', workspaceId)
      .like('property', 'action_item.%')
      .is('invalid_at', null)
      .limit(limit);
    if (focusEntityId) q = q.eq('entity_id', focusEntityId);
    const { data: rows, error } = await q;
    if (error) throw error;

    const now = Date.now();
    let items = (rows || []).map(r => {
      const v = r.value || {};
      return {
        id:          r.property,
        entity_id:   r.entity_id,
        title:       v.title || null,
        owner_kind:  v.owner_kind || 'user',
        owner_name:  v.owner_name || null,
        status:      v.status || 'open',
        due_at:      v.due_at || null,
        source_type: v.source_type || null,
        source_id:   v.source_id || null,
        recorded_at: r.computed_at,
      };
    }).filter(i => i.title);

    if (owner !== 'all') {
      const want = owner === 'me' ? 'user' : owner;
      items = items.filter(i => i.owner_kind === want);
    }
    if (status !== 'all') items = items.filter(i => i.status === status);
    if (due === 'today' || due === 'week') {
      const horizon = now + (due === 'today' ? DAY : 7 * DAY);
      items = items.filter(i => i.due_at && new Date(i.due_at).getTime() <= horizon);
    }

    const ids = [...new Set(items.map(i => i.entity_id).filter(Boolean))];
    if (ids.length) {
      const { data: contacts } = await supabase.from('contacts')
        .select('id, first_name, last_name, email, company').in('id', ids);
      const byId = new Map((contacts || []).map(c => [c.id, c]));
      for (const i of items) {
        const c = byId.get(i.entity_id);
        i.account       = c ? ([c.first_name, c.last_name].filter(Boolean).join(' ') || c.email) : null;
        i.account_email = c?.email || null;
        i.company       = c?.company || null;
      }
    }
    items.sort((a, b) => new Date(b.recorded_at).getTime() - new Date(a.recorded_at).getTime());
    return res.json({ items, count: items.length });
  } catch (err) {
    console.error('[GET /v2/action-items]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});
