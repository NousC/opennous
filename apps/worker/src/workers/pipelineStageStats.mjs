// Pipeline stage medians: the denominator for "how long has this deal sat here".
//
// Nightly, per workspace: read every deal's stage history, turn it into occupancies (days per
// stage, with a deal still sitting there flagged as a lower bound), group by the deal's OWN
// pipeline, and store a Kaplan-Meier median per (pipeline, stage) wherever the sample is big
// enough to mean something. The maths and the honesty rules live in @nous/core
// (db/pipelineStageStats.ts); this file is the read-and-store loop around them.
//
// Nothing here filters on the workspace's primary pipeline: every pipeline gets its own rows
// and a reader scopes when it looks one up. Nothing is pooled across pipelines. workspace_stages
// is not touched. On a young workspace the job concludes "not enough deals" and stores nothing,
// which is what the account page then honestly shows.

import {
  getSupabaseClient, dealStageOccupanciesForStats, computePipelineStageStats,
  pipelineStageSampleSizes, replacePipelineStageStats, PIPELINE_STATS_MIN_SAMPLE,
} from '@nous/core';

const PAGE = 1000;         // PostgREST stops at 1000 rows without saying so
const DEAL_BATCH = 100;    // deals per observation query; each batch is paged on its own

export async function runPipelineStageStats() {
  const supabase = getSupabaseClient();
  const startedAt = Date.now();
  const stats = { workspaces: 0, written: 0, empty: 0, failed: 0 };

  const wsIds = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase.from('workspaces')
      .select('id').order('id').range(from, from + PAGE - 1);
    if (error) { console.error('[PIPELINE_STATS] workspace scan failed:', error.message); return; }
    if (!data?.length) break;
    wsIds.push(...data.map(w => w.id));
    if (data.length < PAGE) break;
  }

  for (const ws of wsIds) {
    stats.workspaces++;
    try {
      const outcome = await computeWorkspace(supabase, ws);
      if (outcome === 'no_table') {
        // Say it once and stop: every other workspace would hit the same wall.
        console.warn('[PIPELINE_STATS] pipeline_stage_stats table missing (apply supabase/migrations/2026_09_16_pipeline_stage_stats.sql); nothing stored');
        break;
      }
      if (outcome === 'written') stats.written++;
      else stats.empty++;
    } catch (e) {
      stats.failed++;
      console.error(`[PIPELINE_STATS] ws=${ws} failed:`, e?.message || e);
    }
  }

  console.log(
    `[PIPELINE_STATS] ${stats.workspaces} workspaces · ${stats.written} with rows · ` +
    `${stats.empty} without · ${stats.failed} failed · ${Date.now() - startedAt}ms`,
  );
}

async function allRows(build) {
  const out = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if (!data || data.length < PAGE) return out;
  }
}

// The `pipeline_id` observation's value: the CRM's pipeline id, as a trimmed string. Older
// claim-shaped values ({ value }) unwrap; anything blank means "no pipeline known".
function pipelineRefValue(v) {
  const u = v && typeof v === 'object' && 'value' in v ? v.value : v;
  return u == null ? '' : String(u).trim();
}

async function computeWorkspace(supabase, ws) {
  const now = Date.now();
  const computedAt = new Date(now).toISOString();

  const dealIds = (await allRows((from, to) => supabase.from('entities')
    .select('id').eq('workspace_id', ws).eq('type', 'deal').order('id').range(from, to)))
    .map(e => e.id);
  if (!dealIds.length) {
    // Clear rather than skip past: a workspace whose deals went away must not keep serving
    // medians the data no longer supports. A no-row replace is free.
    const res = await replacePipelineStageStats(supabase, ws, [], { computedAt });
    return res.tableMissing ? 'no_table' : 'empty';
  }

  // Every deal's dated `stage` writes (history rows and current-state rows alike; the core
  // helper collapses the re-writes) plus its `pipeline_id`. A deal moved between pipelines is
  // measured where it is now, so the LATEST pipeline_id wins.
  const byDeal = new Map(dealIds.map(id => [id, { stageObs: [], pipelineRef: null, pipelineAt: -Infinity }]));
  for (let i = 0; i < dealIds.length; i += DEAL_BATCH) {
    const batch = dealIds.slice(i, i + DEAL_BATCH);
    const rows = await allRows((from, to) => supabase.from('observations')
      .select('entity_id, property, value, observed_at, raw')
      .eq('workspace_id', ws).in('entity_id', batch).in('property', ['stage', 'pipeline_id'])
      .order('id').range(from, to));
    for (const o of rows) {
      const d = byDeal.get(o.entity_id);
      if (!d) continue;
      if (o.property === 'stage') {
        d.stageObs.push({ value: o.value, observed_at: o.observed_at, raw: o.raw });
      } else {
        const ref = pipelineRefValue(o.value);
        const at = Date.parse(o.observed_at);
        if (ref && Number.isFinite(at) && at >= d.pipelineAt) { d.pipelineRef = ref; d.pipelineAt = at; }
      }
    }
  }

  const deals = [];
  for (const d of byDeal.values()) {
    if (!d.stageObs.length) continue;
    deals.push({ pipelineRef: d.pipelineRef, occupancies: dealStageOccupanciesForStats(d.stageObs, { now }) });
  }

  const rows = computePipelineStageStats(deals, { now });
  const res = await replacePipelineStageStats(supabase, ws, rows, { computedAt });
  if (res.tableMissing) return 'no_table';

  // What was seen and what stayed silent, and why. No silent caps: a stage with no row is
  // either under the sample floor or mostly still running, and the log says which.
  const samples = pipelineStageSampleSizes(deals);
  const pipelines = [...new Set(samples.map(s => s.pipelineRef))];
  const key = (x) => JSON.stringify([x.pipelineRef, x.stageLabel]);
  const wrote = new Set(rows.map(key));
  const small = samples.filter(s => s.sampleN < PIPELINE_STATS_MIN_SAMPLE).length;
  const unresolved = samples.filter(s => s.sampleN >= PIPELINE_STATS_MIN_SAMPLE && !wrote.has(key(s))).length;
  if (deals.length) {
    console.log(
      `[PIPELINE_STATS] ws=${ws} · ${deals.length} deal(s) with stage history · ` +
      `${pipelines.length} pipeline(s) [${pipelines.map(p => p || '(none)').join(', ')}] · ` +
      `${rows.length} row(s) written · ${small} stage(s) skipped under n=${PIPELINE_STATS_MIN_SAMPLE} · ` +
      `${unresolved} stage(s) skipped with most deals still sitting there`,
    );
  }
  return rows.length ? 'written' : 'empty';
}
