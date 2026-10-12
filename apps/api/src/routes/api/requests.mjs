import { Router } from 'express';
import { getSupabaseClient, countActiveNotes } from '@nous/core';
import { verifySupabaseAuth } from '../../middleware/supabaseAuth.mjs';
import { ensureUserAndTeam, workspaceInTeam } from '../../lib/auth.mjs';

export const requestsRouter = Router();

const EVENT_TYPE_MAP = {
  contact_read:   { op_type: 'retrieve', entity_type: 'contact' },
  contact_list:   { op_type: 'retrieve', entity_type: 'contact' },
  contact_create: { op_type: 'write',    entity_type: 'contact' },
  contact_update: { op_type: 'write',    entity_type: 'contact' },
  contact_delete: { op_type: 'delete',   entity_type: 'contact' },
  memory_write:   { op_type: 'write',    entity_type: 'memory'  },
  memory_search:  { op_type: 'retrieve', entity_type: 'memory'  },
  memory_delete:  { op_type: 'delete',   entity_type: 'memory'  },
  company_read:   { op_type: 'retrieve', entity_type: 'company' },
};

// GET /api/requests/log
requestsRouter.get('/log', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { user, team } = await ensureUserAndTeam(req.user);
    const { op_type, entity_type, days = '7', limit = '50', offset = '0', workspace_id } = req.query;
    const lim = Math.min(parseInt(limit), 100);
    const off = parseInt(offset);
    const since = days === 'all' ? null : new Date(Date.now() - parseInt(days) * 86400000).toISOString();

    // Scope to ONE workspace when asked (the Ops page always asks) — a workspace
    // must never surface another workspace's ops. Without workspace_id this stays
    // team-wide for the older team-level callers.
    let wsIds;
    if (workspace_id) {
      const owned = await workspaceInTeam(supabase, workspace_id, team.id);
      if (!owned) return res.status(403).json({ error: 'workspace_forbidden' });
      wsIds = [owned];
    } else {
      const { data: teamWorkspaces } = await supabase
        .from('workspaces')
        .select('id')
        .eq('team_id', team.id);
      wsIds = (teamWorkspaces || []).map(w => w.id);
    }

    // The live op log (workspace_system_log) is the single source of truth.
    const sysRes = wsIds.length ? await (() => {
      let q = supabase.from('workspace_system_log')
        .select('id, occurred_at, event_type, source, summary')
        .in('workspace_id', wsIds)
        .in('source', ['mcp', 'sdk', 'api'])
        .order('occurred_at', { ascending: false });
      if (since) q = q.gte('occurred_at', since);
      return q;
    })() : { data: [] };

    // Map system log entries to request format, applying filters
    const sysRows = (sysRes.data || [])
      .map(r => {
        const mapped = EVENT_TYPE_MAP[r.event_type] || { op_type: 'retrieve', entity_type: 'contact' };
        return { id: r.id, created_at: r.occurred_at, op_type: mapped.op_type, entity_type: mapped.entity_type, source: r.source, api_key_id: null, summary: r.summary };
      })
      .filter(r => {
        if (op_type && op_type !== 'all' && r.op_type !== op_type) return false;
        if (entity_type && entity_type !== 'all' && r.entity_type !== entity_type) return false;
        return true;
      });

    // Sort by time, paginate
    const merged = sysRows
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    const page = merged.slice(off, off + lim);
    const total = merged.length;

    const keyIds = [...new Set(page.filter(r => r.api_key_id).map(r => r.api_key_id))];
    let keyMap = {};
    if (keyIds.length) {
      const { data: keys } = await supabase.from('api_keys').select('id, name').in('id', keyIds);
      keyMap = Object.fromEntries((keys || []).map(k => [k.id, k.name]));
    }

    return res.json({
      requests: page.map(r => ({
        id: r.id,
        created_at: r.created_at,
        op_type: r.op_type,
        entity_type: r.entity_type,
        source: r.source,
        api_key_name: r.api_key_id ? (keyMap[r.api_key_id] || 'Unknown') : (r.source === 'mcp' ? 'MCP' : null),
        summary: r.summary || null,
      })),
      total,
    });
  } catch (err) {
    console.error('[GET /api/requests/log]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// GET /api/requests/stats
requestsRouter.get('/stats', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { team } = await ensureUserAndTeam(req.user);
    const { days = '7', workspace_id } = req.query;

    const since = days === 'all' ? null : new Date(Date.now() - parseInt(days) * 86400000).toISOString();
    const { data: workspaces } = await supabase.from('workspaces').select('id').eq('team_id', team.id);
    const allWsIds = (workspaces || []).map(w => w.id);
    let wsFilter = allWsIds.length ? allWsIds : ['00000000-0000-0000-0000-000000000000'];
    if (workspace_id && allWsIds.includes(workspace_id)) wsFilter = [workspace_id];

    const [factsRes, contactsRes, companiesRes, opsRes] = await Promise.all([
      Promise.all(wsFilter.map(id => countActiveNotes(supabase, id))).then(counts => ({
        count: counts.reduce((s, n) => s + n, 0),
      })),
      supabase.from('contacts').select('id', { count: 'exact', head: true }).in('workspace_id', wsFilter),
      supabase.from('companies').select('id', { count: 'exact', head: true }).in('workspace_id', wsFilter),
      (() => {
        let q = supabase.from('workspace_system_log')
          .select('event_type, occurred_at')
          .in('workspace_id', wsFilter)
          .in('source', ['mcp', 'sdk', 'api']);
        if (since) q = q.gte('occurred_at', since);
        return q;
      })(),
    ]);

    // Map live-op-log rows to the {op_type, entity_type, created_at} shape.
    const opsRows = (opsRes.data || []).map(r => {
      const mapped = EVENT_TYPE_MAP[r.event_type] || { op_type: 'retrieve', entity_type: 'contact' };
      return { op_type: mapped.op_type, entity_type: mapped.entity_type, created_at: r.occurred_at };
    });
    const writeOps    = opsRows.filter(r => r.op_type === 'write').length;
    const deleteOps   = opsRows.filter(r => r.op_type === 'delete').length;
    const retrieveOps = opsRows.filter(r => r.op_type !== 'write' && r.op_type !== 'delete').length;

    // Per-entity_type breakdowns
    const writeBreakdown = {}, retrieveBreakdown = {}, deleteBreakdown = {};
    for (const r of opsRows) {
      const key = r.entity_type || 'unknown';
      if (r.op_type === 'write')   writeBreakdown[key]    = (writeBreakdown[key]    || 0) + 1;
      else if (r.op_type === 'delete') deleteBreakdown[key] = (deleteBreakdown[key] || 0) + 1;
      else                         retrieveBreakdown[key]  = (retrieveBreakdown[key] || 0) + 1;
    }

    const numDays = days === 'all' ? 30 : Math.max(1, parseInt(days));
    const dayMap = {};
    for (const r of opsRows) {
      const day = (r.created_at || '').slice(0, 10);
      if (!day) continue;
      if (!dayMap[day]) dayMap[day] = { write: 0, retrieve: 0, delete: 0 };
      if (r.op_type === 'write')       dayMap[day].write++;
      else if (r.op_type === 'delete') dayMap[day].delete++;
      else                             dayMap[day].retrieve++;
    }
    const timeSeries = [];
    for (let i = numDays - 1; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400000);
      const key = d.toISOString().slice(0, 10);
      timeSeries.push({ date: key, write: dayMap[key]?.write || 0, retrieve: dayMap[key]?.retrieve || 0, delete: dayMap[key]?.delete || 0 });
    }

    return res.json({
      totalFacts:     factsRes.count    || 0,
      totalContacts:  contactsRes.count || 0,
      totalCompanies: companiesRes.count || 0,
      writeOps,
      retrieveOps,
      deleteOps,
      totalOps: writeOps + retrieveOps + deleteOps,
      writeBreakdown,
      retrieveBreakdown,
      deleteBreakdown,
      breakdown: { ...writeBreakdown, ...retrieveBreakdown, ...deleteBreakdown },
      timeSeries,
    });
  } catch (err) {
    return res.status(500).json({ error: 'internal_error' });
  }
});
