// Weekly forecast snapshots — the clock that cannot be started retroactively.
//
// The forecast recomputes from raw events on every call and keeps no memory of what it
// said. These rows are that memory: once a period closes, they are the only record of
// what was predicted while it was still open, which makes them the sole input to ever
// grading forecast accuracy or calibrating the p10/p90 band. A week without a snapshot is
// a week that can never be graded — hence "from day one", per the plan.
//
// Runs the SAME runForecast the /v2/forecast endpoint serves (one implementation in
// @nous/core), so the number graded later is the number a caller actually saw.
//
// Two snapshots per workspace per tick: the current MONTH and the current QUARTER, since
// both are periods someone commits to. Empty workspaces (no open accounts) are skipped —
// thousands of zero rows for dormant workspaces would be noise, and a workspace's first
// real snapshot marks the honest start of its history.

import { getSupabaseClient, runForecast, writeForecastSnapshot } from '@nous/core';

export async function runForecastSnapshots() {
  const supabase = getSupabaseClient();
  const startedAt = Date.now();
  const stats = { workspaces: 0, written: 0, skipped: 0, failed: 0 };

  // Every workspace, paged. No cheap pre-filter for "has pipeline" exists that is not
  // itself a full scan, so runForecast's own assembly (which exits fast on an empty
  // workspace) is the filter.
  const wsIds = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from('workspaces')
      .select('id').order('id').range(from, from + 999);
    if (error) { console.error('[FORECAST_SNAPSHOT] workspace scan failed:', error.message); return; }
    if (!data?.length) break;
    wsIds.push(...data.map(w => w.id));
    if (data.length < 1000) break;
  }

  for (const ws of wsIds) {
    stats.workspaces++;
    for (const period of ['month', 'quarter']) {
      try {
        const run = await runForecast(supabase, ws, { period: { period } });
        if (!run.dealCount) { stats.skipped++; continue; }
        const res = await writeForecastSnapshot(supabase, ws, run);
        if (res.ok) stats.written++;
        else {
          stats.failed++;
          // A silently missing week defeats the whole point — say so loudly.
          console.error(`[FORECAST_SNAPSHOT] write failed ws=${ws} period=${period}: ${res.error}`);
        }
      } catch (e) {
        stats.failed++;
        console.error(`[FORECAST_SNAPSHOT] run failed ws=${ws} period=${period}:`, e?.message || e);
      }
    }
  }

  console.log(
    `[FORECAST_SNAPSHOT] ${stats.workspaces} workspaces · ${stats.written} written · ` +
    `${stats.skipped} empty · ${stats.failed} failed · ${Date.now() - startedAt}ms`,
  );
}
