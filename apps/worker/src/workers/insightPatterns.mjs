// The insight engine, hourly (GET-971): rebuild each workspace's insights from what is counted.
//
// Code groups and counts (packages/core/src/db/insightEngine.ts); the model writes only the title
// of an insight over its bar, and again at every 5 more accounts. A workspace is rebuilt when
// something new landed since its last rebuild, and at least once a day so the 30-day windows and
// the trend move with the calendar. It fires insight.emerged and insight.rising (emitEvent).
//
//   node apps/worker/src/workers/insightPatterns.mjs [--workspace=UUID]   (one run, by hand)

import { getSupabaseClient, rebuildInsightPatterns, emitEvent, insightBoardModel, INSIGHT_TYPES, withBackfillLock, lockHolder, LockHeldError } from '@nous/core';
import { read, acceptsObject } from '../noema/read.mjs';

const PAGE = 1000;
const DAY_MS = 86_400_000;
const ACCOUNT_CATEGORIES = INSIGHT_TYPES.map(t => t.accountCategory).filter(Boolean);

/** Rebuild now: never rebuilt, something new since, or a day old. */
export async function due(supabase, workspaceId, now = Date.now()) {
  const { data: last, error } = await supabase.from('insight_patterns').select('updated_at')
    .eq('workspace_id', workspaceId).order('updated_at', { ascending: false }).limit(1).maybeSingle();
  if (error) {
    if (error.code === '42P01' || /does not exist/i.test(String(error.message))) return { due: false, reason: 'not_set_up' };
    throw error;
  }
  const since = last?.updated_at ?? null;
  if (since && now - Date.parse(since) >= DAY_MS) return { due: true, reason: 'daily' };
  let about = supabase.from('about_us_claims').select('id', { count: 'exact', head: true }).eq('workspace_id', workspaceId);
  let claims = supabase.from('claims').select('id', { count: 'exact', head: true }).eq('workspace_id', workspaceId)
    .in('value->>category', ACCOUNT_CATEGORIES).gte('property', 'note.').lt('property', 'note/');
  if (since) { about = about.gt('created_at', since); claims = claims.gt('computed_at', since); }
  const [ra, rc] = await Promise.all([about, claims]);
  // A count that failed is not "nothing new": rebuild rather than miss what landed.
  if (ra.error || rc.error) return { due: true, reason: 'unknown' };
  const a = ra.count, c = rc.count;
  if (!since) return { due: (a ?? 0) + (c ?? 0) > 0, reason: 'first' };
  return { due: (a ?? 0) + (c ?? 0) > 0, reason: 'new' };
}

let running = false;

export async function runInsightPatterns(opts = {}) {
  // One run at a time in this process; across processes, a lock per workspace (below).
  if (running && !opts.workspaceId) { console.warn('[INSIGHT_PATTERNS] previous run still going — skipped'); return null; }
  running = true;
  try { return await runAll(opts); } finally { running = false; }
}

async function runAll(opts) {
  const supabase = getSupabaseClient();
  const started = Date.now();
  const stats = { workspaces: 0, patterns: 0, atBar: 0, titled: 0, emerged: 0, rising: 0, failed: 0 };
  const wsIds = opts.workspaceId ? [opts.workspaceId] : [];
  if (!opts.workspaceId) {
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await supabase.from('workspaces').select('id').order('id').range(from, from + PAGE - 1);
      if (error) { console.error('[INSIGHT_PATTERNS] workspace scan failed:', error.message); return stats; }
      wsIds.push(...(data ?? []).map(w => w.id));
      if (!data || data.length < PAGE) break;
    }
  }
  for (const ws of wsIds) {
    try {
      const d = opts.workspaceId ? { due: true } : await due(supabase, ws);
      if (d.reason === 'not_set_up') { console.warn('[INSIGHT_PATTERNS] insight_patterns missing — apply supabase/migrations/2026_10_21_insight_patterns.sql'); break; }
      if (!d.due) continue;
      const ask = async (prompt) => {
        const res = await read({ supabase, workspaceId: ws, feature: 'insight-pattern-title', meterAs: 'insight-board', accept: acceptsObject, parse: (t) => t, maxTokens: 400, prompt, model: insightBoardModel() });
        return res.ok ? res.value : '';
      };
      const emit = (e) => emitEvent(supabase, e);
      const r = await withBackfillLock(supabase, ws, 'insightPatterns', { holder: lockHolder('insightPatterns'), leaseMinutes: 30 },
        () => rebuildInsightPatterns(supabase, ws, { ask, emit }));
      if (r.status === 'not_set_up') { console.warn('[INSIGHT_PATTERNS] tables missing — nothing rebuilt'); break; }
      stats.workspaces++;
      for (const k of ['patterns', 'atBar', 'titled', 'emerged', 'rising']) stats[k] += r[k];
    } catch (err) {
      if (err instanceof LockHeldError) { console.warn(`[INSIGHT_PATTERNS] ${ws}: ${err.message}`); continue; }
      stats.failed++;
      console.error(`[INSIGHT_PATTERNS] ${ws}:`, err?.message || err);
    }
  }
  console.log(`[INSIGHT_PATTERNS] ${stats.workspaces} workspaces · ${stats.patterns} groups · ${stats.atBar} over the bar · ${stats.titled} titled · ` +
    `${stats.emerged} emerged · ${stats.rising} rising · ${stats.failed} failed · ${Date.now() - started}ms`);
  return stats;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const ws = (process.argv.find(a => a.startsWith('--workspace=')) || '').split('=')[1] || null;
  await runInsightPatterns({ workspaceId: ws });
  process.exit(0);
}
