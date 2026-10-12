// Nightly deal-health refresh — the clock the score was missing.
//
// Deal health is a function of TIME as much as of evidence: "replied 3 days ago" becomes
// "quiet for 40 days" on its own, and engagement cools without anyone doing anything. But the
// score was only ever recomputed when a human opened the account page, so a deal nobody
// visited kept yesterday's number forever — only about one in-touch account in ten had been
// recomputed in the last 30 days, and the account page drew one flat line because there was nothing to plot.
//
// This job recomputes every in-touch account once a night with the SAME core function the
// account page and the `deals` tool use, and writes only when the number actually changed. The
// companies view's write trigger records each change as a state observation, so a real history
// accumulates and the trend line becomes a measurement rather than a decoration.
//
// The same pass stores the day's ACCOUNT health snapshot (GET-804), which the account page's
// trend reads alongside its backfilled points.

import { getSupabaseClient, computeDealHealth, loadHealthInputs, loadAccountHealthTrend } from '@nous/core';

const CONCURRENCY = 4;

async function mapLimit(items, limit, fn) {
  let next = 0;
  const worker = async () => { while (next < items.length) await fn(items[next++]); };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/** One workspace: recompute every in-touch company, persist the ones that moved. */
export async function refreshWorkspaceHealth(supabase, workspaceId) {
  // In-touch = has at least one contact; the same definition the batch endpoint uses.
  const { data: rows } = await supabase.from('contacts')
    .select('company_id').eq('workspace_id', workspaceId).not('company_id', 'is', null);
  const companyIds = [...new Set((rows || []).map(r => r.company_id).filter(Boolean))];
  if (!companyIds.length) return { scanned: 0, changed: 0 };

  let changed = 0;
  await mapLimit(companyIds, CONCURRENCY, async (id) => {
    try {
      const { data: company } = await supabase.from('companies')
        .select('id, deal_health_score').eq('workspace_id', workspaceId).eq('id', id).maybeSingle();
      if (!company) return;
      const inputs = await loadHealthInputs(supabase, workspaceId, id);
      const dh = computeDealHealth({ company, ...inputs });
      // Account health's daily snapshot (GET-804): one `account_health_score` state observation a
      // day, so the account page's trend has a measured point for every day, visited or not. Keyed
      // by the day, so a page view that already stored today's is left alone.
      await loadAccountHealthTrend(supabase, workspaceId, id, { backfill: false, persist: true })
        .catch(err => console.error(`[HEALTH_REFRESH] account health ${id}:`, err.message));
      // Unchanged means no write: a no-op update would stamp a new observation every night and
      // turn the history into noise. The trend must carry moves, not heartbeats.
      if (dh.score == null || dh.score === company.deal_health_score) return;
      await supabase.from('companies')
        .update({ deal_health_score: dh.score, deal_health_computed_at: new Date().toISOString() })
        .eq('id', id);
      changed++;
    } catch (err) {
      console.error(`[HEALTH_REFRESH] company ${id}:`, err.message);
    }
  });
  return { scanned: companyIds.length, changed };
}

export async function runHealthRefresh() {
  const supabase = getSupabaseClient();
  const { data: workspaces } = await supabase.from('workspaces').select('id');
  let scanned = 0, changed = 0;
  for (const ws of workspaces || []) {
    try {
      const r = await refreshWorkspaceHealth(supabase, ws.id);
      scanned += r.scanned; changed += r.changed;
    } catch (err) {
      console.error(`[HEALTH_REFRESH] workspace ${ws.id}:`, err.message);
    }
  }
  console.log(`[HEALTH_REFRESH] done — ${scanned} accounts scanned, ${changed} scores moved`);
  return { scanned, changed };
}
