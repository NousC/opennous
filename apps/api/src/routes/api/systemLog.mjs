import { Router } from 'express';
import { getSupabaseClient, getWorkspaceMemberProfiles } from '@nous/core';
import { verifySupabaseAuth } from '../../middleware/supabaseAuth.mjs';
import { ensureUserAndTeam, workspaceInTeam } from '../../lib/auth.mjs';
import { RETRIEVAL_EVENT_TYPES } from '../../lib/plans.mjs';

export const systemLogRouter = Router();

// Caller-facing surfaces. Everything else (Attio sync, LinkedIn webhook, Gmail
// poller…) is a system op. Mirrors the split the Ops page renders.
const AGENT_SOURCES = ['mcp', 'sdk', 'agent', 'api'];

// An op "failed" when its name or detail signals an error/failure. Kept in sync
// with the same regex on the Ops page (isFailedOp) so the success rate a member
// sees in the fleet matches what the op feed flags red.
function opFailed(eventType, summary) {
  const hay = `${eventType || ''} ${summary || ''}`.toLowerCase();
  return /\b(fail|failed|error|errored|denied|rejected|exception|invalid|unauthorized)\b/.test(hay);
}

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
    // `agents` (plural) is the union of every caller-facing source — the slice the
    // Agents › Activity log renders. A specific source still filters exactly.
    if (source === 'agents') query = query.in('source', AGENT_SOURCES);
    else if (source && source !== 'all') query = query.eq('source', source);
    if (event_type && event_type !== 'all') query = query.eq('event_type', event_type);

    // The Live Op Log is a feed of what the connectors + agents DID — the actual
    // operations (MCP tool calls like agent.v2.*, GET /v2/... , syncs, enrichment). An
    // agent CHAT turn (event_type 'agent.chat', from the web app OR Slack) is the user's
    // own prompt ("what are common objections?"), not an operation — hide it from the
    // feed regardless of source. Still counted in the usage stats.
    query = query.neq('event_type', 'agent.chat');

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

// GET /api/workspace/system-log/daily — activity counts per day over the range.
// Every op-log event (all sources — the real activity, not just agent calls),
// bucketed by day, with zero-filled days so the chart has a full X axis. Powers
// the Overview "Activities" chart.
systemLogRouter.get('/daily', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { workspace_id, days = '30' } = req.query;
    if (!workspace_id) return res.status(400).json({ error: 'workspace_id_required' });

    const { team } = await ensureUserAndTeam(req.user);
    if (!(await workspaceInTeam(supabase, workspace_id, team?.id))) {
      return res.status(403).json({ error: 'workspace_forbidden' });
    }

    const n = Math.min(Math.max(parseInt(days) || 30, 1), 400);
    const since = new Date(Date.now() - n * 86400000).toISOString();

    // Aggregate in Postgres (GROUP BY day) — returns ~n rows instead of streaming
    // every op over the wire, which was the Overview's slow path on busy workspaces.
    const { data, error } = await supabase.rpc('workspace_daily_ops', {
      p_workspace_id: workspace_id,
      p_since: since,
    });
    if (error) throw error;
    const counts = new Map();
    for (const r of data || []) counts.set(String(r.day).slice(0, 10), Number(r.cnt));

    const series = [];
    for (let i = n - 1; i >= 0; i--) {
      const day = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
      series.push({ date: day, count: counts.get(day) || 0 });
    }
    return res.json({ series });
  } catch (err) {
    return res.status(500).json({ error: 'internal_error' });
  }
});

// GET /api/workspace/system-log/agents — the fleet.
// The Agents › Overview table. Each caller-facing key (the api_key an agent
// runs on) is one "agent"; runs from that key aggregate into runs / success /
// last-active, attributed to the member who owns the key (the Owner column). Rows
// with no key stamped fall into one bucket per source (MCP / SDK / …). Admin-only
// in the UI; still workspace-scoped here so it never crosses a team boundary.
systemLogRouter.get('/agents', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { workspace_id, days = '30' } = req.query;
    if (!workspace_id) return res.status(400).json({ error: 'workspace_id_required' });

    const { team } = await ensureUserAndTeam(req.user);
    if (!(await workspaceInTeam(supabase, workspace_id, team?.id))) {
      return res.status(403).json({ error: 'workspace_forbidden' });
    }

    const since = days === 'all' ? null : new Date(Date.now() - parseInt(days) * 86400000).toISOString();

    let q = supabase.from('workspace_system_log')
      .select('source, event_type, summary, metadata, occurred_at')
      .eq('workspace_id', workspace_id)
      .in('source', AGENT_SOURCES)
      .neq('event_type', 'agent.chat')
      .order('occurred_at', { ascending: false })
      .limit(4000);
    if (since) q = q.gte('occurred_at', since);
    const { data: ops, error } = await q;
    if (error) throw error;

    // Fold the op stream into one row per key (or per source when unkeyed).
    const groups = new Map();
    for (const op of ops || []) {
      const keyId = op.metadata?.api_key_id || null;
      const groupKey = keyId || `source:${op.source}`;
      let g = groups.get(groupKey);
      if (!g) { g = { keyId, source: op.source, runs: 0, failed: 0, last: op.occurred_at }; groups.set(groupKey, g); }
      g.runs++;
      if (opFailed(op.event_type, op.summary)) g.failed++;
      if (op.occurred_at > g.last) g.last = op.occurred_at;
    }

    // Resolve keys → name + owner, owners → member display name.
    const keyIds = [...groups.values()].map(g => g.keyId).filter(Boolean);
    let keyMap = new Map();
    if (keyIds.length) {
      const { data: keys } = await supabase.from('api_keys').select('id, name, owner_user_id').in('id', keyIds);
      keyMap = new Map((keys || []).map(k => [k.id, k]));
    }
    const profiles = await getWorkspaceMemberProfiles(supabase, workspace_id);

    const SOURCE_LABEL = { mcp: 'MCP session', sdk: 'SDK client', agent: 'Agent', api: 'API client' };
    const agents = [...groups.values()].map(g => {
      const key = g.keyId ? keyMap.get(g.keyId) : null;
      const ownerId = key?.owner_user_id || null;
      const ownerName = ownerId ? (profiles.get(ownerId)?.name ?? null) : null;
      const lastMs = new Date(g.last).getTime();
      return {
        id: g.keyId || `source:${g.source}`,
        agent: key?.name || SOURCE_LABEL[g.source] || g.source,
        source: g.source,
        owner: ownerName,
        owner_user_id: ownerId,
        status: Date.now() - lastMs < 3 * 86400000 ? 'Active' : 'Idle',
        runs: g.runs,
        success: g.runs ? Math.round(((g.runs - g.failed) / g.runs) * 100) : null,
        last_active: g.last,
      };
    }).sort((a, b) => b.runs - a.runs);

    return res.json({ agents });
  } catch (err) {
    return res.status(500).json({ error: 'internal_error' });
  }
});

// GET /api/workspace/system-log/mine — this member's own activity feed.
// The /connect › Activity surface. The same event stream, filtered to the events
// THIS member owns: their own agent/key runs (metadata.api_key_id ∈ their keys)
// plus events explicitly stamped to them (metadata.owner_user_id — e.g. their
// LinkedIn messages). Provenance, not a role grant — every member sees their own.
systemLogRouter.get('/mine', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { workspace_id, days = '30', limit = '100' } = req.query;
    if (!workspace_id) return res.status(400).json({ error: 'workspace_id_required' });

    const { team } = await ensureUserAndTeam(req.user);
    if (!(await workspaceInTeam(supabase, workspace_id, team?.id))) {
      return res.status(403).json({ error: 'workspace_forbidden' });
    }
    const me = req.memberUserId;
    if (!me) return res.json({ events: [] });

    // My keys — the agents that run on my behalf.
    const { data: myKeys } = await supabase.from('api_keys').select('id').eq('owner_user_id', me);
    const myKeyIds = new Set((myKeys || []).map(k => k.id));

    const since = days === 'all' ? null : new Date(Date.now() - parseInt(days) * 86400000).toISOString();
    let q = supabase.from('workspace_system_log')
      .select('id, source, event_type, summary, contact_id, metadata, occurred_at')
      .eq('workspace_id', workspace_id)
      .neq('event_type', 'agent.chat')
      .order('occurred_at', { ascending: false })
      .limit(400);
    if (since) q = q.gte('occurred_at', since);
    const { data, error } = await q;
    if (error) throw error;

    const mine = (data || []).filter(e => {
      const meta = e.metadata || {};
      return meta.owner_user_id === me || (meta.api_key_id && myKeyIds.has(meta.api_key_id));
    }).slice(0, Math.min(parseInt(limit) || 100, 200));

    return res.json({ events: mine, total: mine.length });
  } catch (err) {
    return res.status(500).json({ error: 'internal_error' });
  }
});
