// /v2/usage — what this workspace's team has used this billing period. Read-only.
//
// Mounted WITHOUT requireOpsBalance: a team that has run out must still be able to read how far
// over it is. Logged like every /v2 call.
//
//   GET /v2/usage                                        the billing panel's numbers
//   GET /v2/usage/breakdown?by=source|workflow|day&from&to   where the ops went

import { Router } from 'express';
import { getSupabaseClient } from '@nous/core';
import { resolveRequestTeam } from '../../lib/access.mjs';
import { RETRIEVAL_EVENT_TYPES } from '../../lib/plans.mjs';
import { loadTeamUsage, publicUsage } from '../../lib/usageSummary.mjs';
import { allowQueryParams } from '../../lib/v2Query.mjs';

export const usageV2Router = Router();

// GET /v2/usage — same meters as GET /api/usage (lib/usageSummary.mjs).
usageV2Router.get('/', allowQueryParams([]), async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { team } = await resolveRequestTeam(req);
    return res.json(publicUsage(await loadTeamUsage(supabase, team)));
  } catch (err) {
    console.error('[GET /v2/usage]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// ── Breakdown ────────────────────────────────────────────────────────────────
//
// Read straight off the op log (workspace_system_log), over every workspace on the team — the
// team is what is billed. Two numbers per row:
//
//   ops         SUM(billable_ops) over every logged op that carries weight (billable_ops > 0) —
//               the team_ops_used() definition of "ops".
//   billed_ops  the part of that the retrieval meter counts (event_type in RETRIEVAL_EVENT_TYPES)
//               — what GET /v2/usage reports as ops.used, so billed_total over the current period
//               equals it.
//
// by=workflow: a scheduled routine's run logs one 'routine.run' row carrying
// metadata.routine_id, so those rows are attributed to that workflow. Everything else (agent and
// SDK calls, ingest) is key null, "Not from a workflow". Event-triggered automation runs (deal
// won/lost/stage) write documents, not op-log rows, so they cost no ops and do not appear.

export const BREAKDOWN_BY = ['source', 'workflow', 'day'];
const PAGE = 1000;
const MAX_ROWS = 50_000;
const MAX_WINDOW_DAYS = 400;

const SOURCE_LABELS = {
  mcp: 'MCP', sdk: 'SDK', api: 'API', agent: 'Agent', schedule: 'Scheduled workflows',
};

function parseWhen(v) {
  if (v == null || String(v).trim() === '') return { value: null };
  const t = Date.parse(String(v));
  if (!Number.isFinite(t)) return { error: true };
  return { value: new Date(t) };
}

/** Group op-log rows. Exported for the tests. */
export function groupOps(rows, by) {
  const billed = new Set(RETRIEVAL_EVENT_TYPES);
  const acc = new Map();
  let total = 0, billedTotal = 0;
  for (const r of rows) {
    const w = Number(r.billable_ops) || 0;
    if (w <= 0) continue;
    const b = billed.has(r.event_type) ? w : 0;
    let key;
    if (by === 'source') key = r.source ?? 'unknown';
    else if (by === 'day') key = String(r.occurred_at).slice(0, 10);
    else key = (r.event_type === 'routine.run' ? (r.routine_id ?? r.metadata?.routine_id ?? null) : null);
    const e = acc.get(key) ?? { key, ops: 0, billed_ops: 0 };
    e.ops += w; e.billed_ops += b;
    acc.set(key, e);
    total += w; billedTotal += b;
  }
  const out = [...acc.values()];
  if (by === 'day') out.sort((a, b) => a.key.localeCompare(b.key));
  else out.sort((a, b) => b.ops - a.ops || String(a.key).localeCompare(String(b.key)));
  return { rows: out, total, billed_total: billedTotal };
}

usageV2Router.get('/breakdown', allowQueryParams(['by', 'from', 'to']), async (req, res) => {
  try {
    const by = req.query.by == null || req.query.by === '' ? 'source' : String(req.query.by);
    if (!BREAKDOWN_BY.includes(by)) return res.status(400).json({ error: 'invalid_by', supported: BREAKDOWN_BY });
    const f = parseWhen(req.query.from);
    const t = parseWhen(req.query.to);
    if (f.error) return res.status(400).json({ error: 'invalid_from', detail: 'from must be an ISO date or timestamp.' });
    if (t.error) return res.status(400).json({ error: 'invalid_to', detail: 'to must be an ISO date or timestamp.' });

    const supabase = getSupabaseClient();
    const { team } = await resolveRequestTeam(req);
    // The current period by default — the same start GET /v2/usage reports.
    let from = f.value;
    if (!from) {
      const u = await loadTeamUsage(supabase, team);
      from = new Date(u.ops.periodStart);
    }
    const to = t.value ?? new Date();
    if (from.getTime() > to.getTime()) return res.status(400).json({ error: 'invalid_range', detail: 'from is after to.' });
    if ((to.getTime() - from.getTime()) / 86_400_000 > MAX_WINDOW_DAYS) {
      return res.status(400).json({ error: 'range_too_large', detail: `At most ${MAX_WINDOW_DAYS} days per request.` });
    }

    const { data: workspaces } = await supabase.from('workspaces').select('id').eq('team_id', team.id);
    const wsIds = (workspaces ?? []).map(w => w.id);

    // Paged and ordered: PostgREST caps a response at 1000 rows whatever .limit() says.
    const rows = [];
    let truncated = false;
    if (wsIds.length) {
      for (let off = 0; off < MAX_ROWS; off += PAGE) {
        const { data, error } = await supabase.from('workspace_system_log')
          .select('source, event_type, billable_ops, occurred_at, routine_id:metadata->>routine_id')
          .in('workspace_id', wsIds)
          .gt('billable_ops', 0)
          .gte('occurred_at', from.toISOString())
          .lte('occurred_at', to.toISOString())
          .order('occurred_at', { ascending: true })
          .order('id', { ascending: true })
          .range(off, off + PAGE - 1);
        if (error) throw error;
        rows.push(...(data ?? []));
        if (!data || data.length < PAGE) break;
        if (off + PAGE >= MAX_ROWS) truncated = true;
      }
    }

    const grouped = groupOps(rows, by);

    // Label the rows. Workflow names come from agent_routines on the team's workspaces.
    let names = new Map();
    if (by === 'workflow') {
      const ids = grouped.rows.map(r => r.key).filter(Boolean);
      if (ids.length) {
        const { data: routines } = await supabase.from('agent_routines')
          .select('id, name').in('workspace_id', wsIds).in('id', ids);
        names = new Map((routines ?? []).map(r => [r.id, r.name]));
      }
    }
    const label = (key) => {
      if (by === 'source') return SOURCE_LABELS[key] ?? key;
      if (by === 'day') return key;
      if (key == null) return 'Not from a workflow';
      return names.get(key) ?? 'Deleted workflow';
    };

    return res.json({
      by,
      from: from.toISOString(),
      to: to.toISOString(),
      rows: grouped.rows.map(r => ({ key: r.key, label: label(r.key), ops: r.ops, billed_ops: r.billed_ops })),
      total: grouped.total,
      billed_total: grouped.billed_total,
      ...(truncated ? { truncated: true } : {}),
    });
  } catch (err) {
    console.error('[GET /v2/usage/breakdown]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});
