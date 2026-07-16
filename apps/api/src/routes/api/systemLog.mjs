import { Router } from 'express';
import { getSupabaseClient } from '@nous/core';
import { verifySupabaseAuth } from '../../middleware/supabaseAuth.mjs';
import { ensureUserAndTeam, workspaceInTeam } from '../../lib/auth.mjs';
import { RETRIEVAL_EVENT_TYPES } from '../../lib/plans.mjs';

export const systemLogRouter = Router();

// Caller-facing surfaces. Everything else (Attio sync, LinkedIn webhook, Gmail
// poller…) is a system op. Mirrors the split the Ops page renders.
const AGENT_SOURCES = ['mcp', 'sdk', 'agent', 'api'];

// GET /api/workspace/system-log
systemLogRouter.get('/', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { workspace_id, days = '7', source, event_type, limit = '100' } = req.query;
    if (!workspace_id) return res.status(400).json({ error: 'workspace_id_required' });

    // The op log is workspace-private. Never serve a workspace the caller's team
    // does not own, even to an authenticated user.
    const { team } = await ensureUserAndTeam(req.user);
    if (!(await workspaceInTeam(supabase, workspace_id, team?.id))) {
      return res.status(403).json({ error: 'workspace_forbidden' });
    }

    const since = days === 'all' ? null : new Date(Date.now() - parseInt(days) * 86400000).toISOString();

    let query = supabase.from('workspace_system_log')
      .select('id, source, event_type, summary, contact_id, metadata, occurred_at', { count: 'exact' })
      .eq('workspace_id', workspace_id)
      .order('occurred_at', { ascending: false })
      .limit(Math.min(parseInt(limit) || 100, 200));

    if (since) query = query.gte('occurred_at', since);
    if (source && source !== 'all') query = query.eq('source', source);
    if (event_type && event_type !== 'all') query = query.eq('event_type', event_type);

    const { data, count, error } = await query;
    if (error) throw error;

    // Per-member privacy (PRIVACY_MODEL.md): the ops feed shows message-content
    // events ("LinkedIn message from X: <text>"). A viewer sees that the message
    // happened + who, but not the CONTENT of another rep's message. This is
    // ownership-based, NOT role-based — even the founder/owner does not see a
    // teammate's message text. Fail closed: a message event with no owner stamped
    // is redacted. Non-message events (pushes, scans, skips) are unaffected.
    let events = data || [];
    if (req.memberUserId) {
      const me = req.memberUserId;
      events = events.map(e => {
        const meta = e.metadata || {};
        const isMessage = e.source === 'linkedin' && (meta.type === 'message' || meta.type === 'message_sent');
        if (!isMessage) return e;
        const owned = meta.owner_user_id && meta.owner_user_id === me;
        if (owned) return e;
        // Keep the "who" part before the first ": ", drop the message text.
        const label = typeof e.summary === 'string' ? e.summary.split(': ')[0] : e.summary;
        return { ...e, summary: label };
      });
    }

    return res.json({ events, total: count || events.length || 0 });
  } catch (err) {
    return res.status(500).json({ error: 'internal_error' });
  }
});

// GET /api/workspace/system-log/stats
// The Ops page headline cards, counted in Postgres for ONE workspace. The event
// feed is paginated (200 rows), so counting it client-side undercounts any busy
// window — these counts are exact and never cross a workspace boundary.
systemLogRouter.get('/stats', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { workspace_id, days = '7', billed_only } = req.query;
    if (!workspace_id) return res.status(400).json({ error: 'workspace_id_required' });

    const { team } = await ensureUserAndTeam(req.user);
    if (!(await workspaceInTeam(supabase, workspace_id, team?.id))) {
      return res.status(403).json({ error: 'workspace_forbidden' });
    }

    const since = days === 'all' ? null : new Date(Date.now() - parseInt(days) * 86400000).toISOString();

    // One round-trip. The retrieval types and agent sources are passed in so
    // plans.mjs stays the single source of truth for both lists.
    const { data, error } = await supabase.rpc('workspace_ops_stats', {
      p_workspace_id:  workspace_id,
      p_since:         since,
      p_retrieval:     RETRIEVAL_EVENT_TYPES,
      p_agent_sources: AGENT_SOURCES,
      p_billed_only:   billed_only === 'true' || billed_only === '1',
    });
    if (error) throw error;

    const row = Array.isArray(data) ? data[0] : data;
    return res.json({
      allTime: Number(row?.all_time ?? 0),
      inRange: Number(row?.in_range ?? 0),
      failed:  Number(row?.failed ?? 0),
      agent:   Number(row?.agent ?? 0),
      system:  Number(row?.system ?? 0),
    });
  } catch (err) {
    return res.status(500).json({ error: 'internal_error' });
  }
});
