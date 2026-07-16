// /api/adoption — how the team actually uses AI.
//
// The one question a buyer has that nobody can answer: "we deployed agents, is
// anyone using them, and for what?" Every AI tool can show you that it ran. Only
// Nous can show what it ran FOR, and across every surface at once — Claude Code,
// the SDK, and the agent in the app — because all three come through one graph.
//
// The hard part is not the query. It's refusing to count the wrong things: see
// isAgentUsage() in lib/useCases.mjs. Ingestion (a webhook firing) and bulk
// scripts (24,000 curl calls) are NOT someone using AI, and counting them would
// bury every real interaction 40-to-1.

import { Router } from 'express';
import { getSupabaseClient } from '@nous/core';
import { verifySupabaseAuth } from '../../middleware/supabaseAuth.mjs';
import { USE_CASES, isAgentUsage, USAGE_SOURCES } from '../../lib/useCases.mjs';

export const adoptionRouter = Router();

const DAY = 86_400_000;
const PAGE = 1000;   // PostgREST caps a response at 1000 rows regardless of .limit()

// Surfaces, named the way a person would say them.
const SURFACES = { mcp: 'Claude Code', sdk: 'Your agents', web: 'Threads' };

adoptionRouter.get('/', verifySupabaseAuth, async (req, res) => {
  try {
    const workspaceId = req.query.workspaceId;
    if (!workspaceId) return res.status(400).json({ error: 'workspaceId_required' });
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 90, 7), 365);
    const since = new Date(Date.now() - days * DAY).toISOString();

    const supabase = getSupabaseClient();

    // Filter to the human-driven surfaces IN THE QUERY, not afterwards.
    //
    // This was fetching every row in the window and filtering in memory, with a
    // 20k cap — and with 34,000 rows of webhooks and bulk scripts in there, the
    // cap was reached before the recent rows were ever read. The newest activity,
    // which is the entire point of the page, silently fell off the end.
    //
    // Filtering server-side means we only ever fetch the few hundred rows that
    // ARE usage, so the cap can't bite and the query is far cheaper.
    const rows = [];
    for (let from = 0; from < 20_000; from += PAGE) {
      const { data, error } = await supabase
        .from('workspace_system_log')
        .select('user_id, source, event_type, use_case, occurred_at')
        .eq('workspace_id', workspaceId)
        .in('source', [...USAGE_SOURCES])
        .gte('occurred_at', since)
        .order('occurred_at', { ascending: true })
        .range(from, from + PAGE - 1);
      if (error) throw error;
      if (!data?.length) break;
      rows.push(...data);
      if (data.length < PAGE) break;
    }

    // Still drop the pipeline events that ride on a usage source.
    const usage = rows.filter(r => isAgentUsage(r.source, r.event_type));

    // What we deliberately did not count, fetched as a count rather than by
    // dragging every excluded row across the wire.
    const { count: allRows } = await supabase
      .from('workspace_system_log')
      .select('*', { count: 'exact', head: true })
      .eq('workspace_id', workspaceId)
      .gte('occurred_at', since);

    // ── Use-case distribution ──
    const byCase = {};
    for (const r of usage) {
      const k = r.use_case || 'other';
      byCase[k] = (byCase[k] ?? 0) + 1;
    }
    const total = usage.length;
    const use_cases = Object.entries(byCase)
      .map(([key, count]) => ({
        key,
        label: USE_CASES[key] ?? 'Other',
        count,
        pct: total ? Math.round((count / total) * 1000) / 10 : 0,
      }))
      .sort((a, b) => b.count - a.count);

    // ── Trend, bucketed by week ──
    // Daily buckets on this volume are a spiky mess that reads as noise; weekly
    // shows the shape, which is what a trend is for.
    const weekOf = (iso) => {
      const d = new Date(iso);
      d.setUTCHours(0, 0, 0, 0);
      d.setUTCDate(d.getUTCDate() - d.getUTCDay());   // back to Sunday
      return d.toISOString().slice(0, 10);
    };
    const buckets = new Map();
    for (const r of usage) {
      const w = weekOf(r.occurred_at);
      if (!buckets.has(w)) buckets.set(w, { week: w, total: 0 });
      const b = buckets.get(w);
      const k = r.use_case || 'other';
      b[k] = (b[k] ?? 0) + 1;
      b.total += 1;
    }
    const trend = [...buckets.values()].sort((a, b) => a.week.localeCompare(b.week));

    // ── Surfaces ──
    const bySurface = {};
    for (const r of usage) bySurface[r.source] = (bySurface[r.source] ?? 0) + 1;
    const surfaces = Object.entries(bySurface)
      .map(([key, count]) => ({ key, label: SURFACES[key] ?? key, count }))
      .sort((a, b) => b.count - a.count);

    // ── Per member ──
    // Attribution only started recently, so a lot of history has no user. Say so
    // rather than dropping it — a table that silently omits half the ops is worse
    // than one that admits what it can't attribute.
    const byUser = new Map();
    let unattributed = 0;
    for (const r of usage) {
      if (!r.user_id) { unattributed++; continue; }
      if (!byUser.has(r.user_id)) {
        byUser.set(r.user_id, { user_id: r.user_id, ops: 0, mix: {}, last_activity: null, surfaces: {} });
      }
      const u = byUser.get(r.user_id);
      u.ops += 1;
      const k = r.use_case || 'other';
      u.mix[k] = (u.mix[k] ?? 0) + 1;
      u.surfaces[r.source] = (u.surfaces[r.source] ?? 0) + 1;
      if (!u.last_activity || r.occurred_at > u.last_activity) u.last_activity = r.occurred_at;
    }

    let members = [...byUser.values()];
    if (members.length) {
      const { data: users } = await supabase
        .from('users')
        .select('id, name, email, profile_picture_url')
        .in('id', members.map(m => m.user_id));
      const byId = new Map((users ?? []).map(u => [u.id, u]));
      members = members.map(m => {
        const u = byId.get(m.user_id);
        return {
          ...m,
          name: u?.name || u?.email?.split('@')[0] || 'Unknown',
          avatar: u?.profile_picture_url || null,
        };
      }).sort((a, b) => b.ops - a.ops);
    }

    // Everyone in the workspace who has NOT used it. The absence is the insight —
    // an adoption page that only lists the people already using it cannot tell you
    // who hasn't.
    const { data: mem } = await supabase
      .from('workspace_members').select('user_id').eq('workspace_id', workspaceId);
    const memberIds = (mem ?? []).map(m => m.user_id);
    const activeIds = new Set(members.map(m => m.user_id));
    const dormantIds = memberIds.filter(id => !activeIds.has(id));
    let dormant = [];
    if (dormantIds.length) {
      const { data: users } = await supabase
        .from('users').select('id, name, email, profile_picture_url').in('id', dormantIds);
      dormant = (users ?? []).map(u => ({
        user_id: u.id,
        name: u.name || u.email?.split('@')[0] || 'Unknown',
        avatar: u.profile_picture_url || null,
      }));
    }

    return res.json({
      days,
      total,
      use_cases,
      trend,
      surfaces,
      members,
      dormant,
      unattributed,
      // What we deliberately did not count, so the number is auditable.
      excluded: Math.max(0, (allRows ?? 0) - usage.length),
    });
  } catch (err) {
    console.error('[GET /api/adoption]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});
