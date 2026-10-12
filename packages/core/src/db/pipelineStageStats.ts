// Per-pipeline stage medians: how long a deal typically sits in each stage.
//
// The denominator behind "94 days in Negotiation". A day count on its own says nothing;
// against "typically 21" it is a stall. The typical number comes from the workspace's own
// deals and their own stage history, and it is computed per CRM PIPELINE: an Expansion deal
// is measured against Expansion deals, never against the sales pipeline's. Pooling would
// make every renewal look stalled and every enterprise deal look fast.
//
// Two honesty rules, both borrowed from the forecast layer:
//   - a deal still sitting in a stage counts as "at least this long" (Kaplan-Meier), not as
//     a finished sample and not as nothing. Dropping it would make every stage look quicker
//     than it is, because the slow deals are exactly the ones still running.
//   - below PIPELINE_STATS_MIN_SAMPLE occupancies, or when more than half of them are still
//     running, there is no number. A median invented from five deals is worse than none.
//
// The nightly worker (apps/worker/src/workers/pipelineStageStats.mjs) computes the rows and
// replaces the workspace's set; readers look a (pipeline, stage) up through typicalDaysFor.
// Keys are the deal's own `pipeline_id` observation ('' when it carries none) and its `stage`
// label exactly as the observation spells it, so a lookup from a deal's observations always
// lands on the row computed from deals like it. workspace_stages is not involved.

import type { SupabaseClient } from '@supabase/supabase-js';
import { kaplanMeierMedian } from '../services/funnelTimeline.js';
import { dealStageHops, dealStageOccupancies } from '../integrations/crm/index.js';
import type { DealStageHop, DealStageObservation, DealStageOccupancy } from '../integrations/crm/index.js';

/** Fewer occupancies than this and the stage gets no median. Same floor as the intelligence layer. */
export const PIPELINE_STATS_MIN_SAMPLE = 8;

/**
 * An occupancy shorter than this is a same-day pass-through, not time in a stage: a deal
 * created into a default stage and moved seconds later, or a stage re-written by a re-sync.
 * They are dropped from the sample rather than counted as very fast deals.
 */
export const PIPELINE_STATS_MIN_OCCUPANCY_DAYS = 1;

export interface PipelineStageStat {
  pipelineRef: string;
  stageLabel: string;
  medianDays: number;
  sampleN: number;
  computedAt: string;
}

const isMissingTable = (error: { code?: string } | null | undefined): boolean =>
  error?.code === '42P01' || error?.code === 'PGRST205';   // migration not applied

const refKey = (ref: string | null | undefined): string => (ref == null ? '' : String(ref).trim());

const sameStage = (a: DealStageHop, b: DealStageHop): boolean =>
  a.stageId && b.stageId ? a.stageId === b.stageId : a.label === b.label;

/**
 * A deal's occupancies for the statistics, from its raw `stage` observations.
 *
 * dealStageHops keeps every dated write, and the CRM sync writes the CURRENT stage again on
 * every change to the deal (an amount edit, a new close date). Left alone, a deal that sat in
 * Negotiation for 30 days and had its amount edited on day 19 reads as two occupancies, 19 and
 * 11, the first of them "completed". So consecutive writes of the same stage collapse into one
 * hop at the FIRST write, which is when the deal actually entered it. A genuine return to an
 * earlier stage is not consecutive and stays two occupancies. When a later duplicate carries
 * the provider's won/lost verdict and the first did not, the verdict is kept, so the closed
 * stage still ends the timeline.
 */
export function dealStageOccupanciesForStats(
  stageObs: DealStageObservation[],
  opts: { now?: number } = {},
): DealStageOccupancy[] {
  const collapsed: DealStageHop[] = [];
  for (const hop of dealStageHops(stageObs)) {
    const prev = collapsed[collapsed.length - 1];
    if (prev && sameStage(prev, hop)) {
      if (prev.status === 'open' && hop.status !== 'open') prev.status = hop.status;
      continue;
    }
    collapsed.push({ ...hop });
  }
  return dealStageOccupancies(collapsed, opts);
}

type Sample = { days: number; censored: boolean };

/** Occupancies grouped by pipeline then stage label, with the zero-length rule applied. */
function groupSamples(
  deals: Array<{ pipelineRef: string | null; occupancies: Array<{ label: string; days: number; censored: boolean }> }>,
): Map<string, Map<string, Sample[]>> {
  const out = new Map<string, Map<string, Sample[]>>();
  for (const deal of deals) {
    const ref = refKey(deal.pipelineRef);
    for (const occ of deal.occupancies ?? []) {
      if (!occ || typeof occ.label !== 'string' || !occ.label) continue;
      if (!Number.isFinite(occ.days) || occ.days < PIPELINE_STATS_MIN_OCCUPANCY_DAYS) continue;
      const byLabel = out.get(ref) ?? out.set(ref, new Map()).get(ref)!;
      const rows = byLabel.get(occ.label) ?? byLabel.set(occ.label, []).get(occ.label)!;
      rows.push({ days: occ.days, censored: occ.censored === true });
    }
  }
  return out;
}

const byKey = <T extends { pipelineRef: string; stageLabel: string }>(a: T, b: T): number =>
  a.pipelineRef.localeCompare(b.pipelineRef) || a.stageLabel.localeCompare(b.stageLabel);

/**
 * Pure: from per-deal occupancies to the rows worth storing. Every deal is counted against its
 * OWN pipeline's population; a deal without a pipeline is counted under ''. A (pipeline, stage)
 * with fewer than `minSample` occupancies, or whose deals are mostly still sitting there (no
 * Kaplan-Meier median), produces no row: silence, not a guess.
 *
 * `now` is accepted for signature stability with the occupancy helpers; the occupancies
 * handed in already carry their days, so nothing here reads the clock.
 */
export function computePipelineStageStats(
  deals: Array<{ pipelineRef: string | null; occupancies: Array<{ label: string; days: number; censored: boolean }> }>,
  opts: { minSample?: number; now?: number } = {},
): Array<Omit<PipelineStageStat, 'computedAt'>> {
  const minSample = opts.minSample ?? PIPELINE_STATS_MIN_SAMPLE;
  const out: Array<Omit<PipelineStageStat, 'computedAt'>> = [];
  for (const [pipelineRef, byLabel] of groupSamples(deals)) {
    for (const [stageLabel, rows] of byLabel) {
      if (rows.length < minSample) continue;
      const medianDays = kaplanMeierMedian(rows);
      if (medianDays == null) continue;
      out.push({ pipelineRef, stageLabel, medianDays, sampleN: rows.length });
    }
  }
  return out.sort(byKey);
}

/**
 * Pure: how many occupancies each (pipeline, stage) has after the zero-length rule, whether or
 * not it earned a row. The job logs this next to what it wrote, so "no typical for Negotiation"
 * can be read as "only five deals" rather than as a bug.
 */
export function pipelineStageSampleSizes(
  deals: Array<{ pipelineRef: string | null; occupancies: Array<{ label: string; days: number; censored: boolean }> }>,
): Array<{ pipelineRef: string; stageLabel: string; sampleN: number }> {
  const out: Array<{ pipelineRef: string; stageLabel: string; sampleN: number }> = [];
  for (const [pipelineRef, byLabel] of groupSamples(deals)) {
    for (const [stageLabel, rows] of byLabel) out.push({ pipelineRef, stageLabel, sampleN: rows.length });
  }
  return out.sort(byKey);
}

/**
 * The stored stats for a workspace. Outer key = pipelineRef ('' = unknown pipeline), inner key =
 * stage label exactly as the deal's `stage` observation spells it. Empty when the table has not
 * been created yet; that is the same answer as "nothing computed", which is what it means.
 */
export async function getPipelineStageStats(
  supabase: SupabaseClient,
  workspaceId: string,
): Promise<Map<string, Map<string, PipelineStageStat>>> {
  const out = new Map<string, Map<string, PipelineStageStat>>();
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase.from('pipeline_stage_stats')
      .select('pipeline_ref, stage_label, median_days, sample_n, computed_at')
      .eq('workspace_id', workspaceId)
      .order('pipeline_ref', { ascending: true })
      .order('stage_label', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) {
      if (isMissingTable(error)) return out;
      throw new Error(error.message);
    }
    for (const r of data ?? []) {
      const medianDays = Number(r.median_days);
      const sampleN = Number(r.sample_n);
      if (!Number.isFinite(medianDays) || !Number.isFinite(sampleN)) continue;
      const ref = refKey(r.pipeline_ref);
      const byLabel = out.get(ref) ?? out.set(ref, new Map()).get(ref)!;
      byLabel.set(String(r.stage_label), {
        pipelineRef: ref, stageLabel: String(r.stage_label), medianDays, sampleN,
        computedAt: String(r.computed_at ?? ''),
      });
    }
    if (!data || data.length < PAGE) break;
  }
  return out;
}

/**
 * The typical days for one deal's (pipeline, stage), or null when there is no honest number:
 * no row, or a row whose sample is under the floor. A deal with no pipeline looks up ''.
 */
export function typicalDaysFor(
  stats: Map<string, Map<string, PipelineStageStat>>,
  pipelineRef: string | null | undefined,
  stageLabel: string | null | undefined,
): { medianDays: number; sampleN: number } | null {
  if (!stats || stageLabel == null || stageLabel === '') return null;
  const row = stats.get(refKey(pipelineRef))?.get(stageLabel);
  if (!row) return null;
  if (!Number.isFinite(row.medianDays) || !(row.sampleN >= PIPELINE_STATS_MIN_SAMPLE)) return null;
  return { medianDays: row.medianDays, sampleN: row.sampleN };
}

/**
 * Replace a workspace's stored set with `rows`, stamped `computedAt`. Upserts the new rows
 * first and only then deletes rows older than the stamp, so a reader never sees an empty table
 * between the two: the old set or the new one, never neither. A stage that no longer qualifies
 * is simply not in `rows` and goes with the stale ones. A missing table (migration not yet
 * applied) is reported, not thrown, so the nightly job can say so once and move on.
 */
export async function replacePipelineStageStats(
  supabase: SupabaseClient,
  workspaceId: string,
  rows: Array<Omit<PipelineStageStat, 'computedAt'>>,
  opts: { computedAt?: string } = {},
): Promise<{ written: number; tableMissing: boolean }> {
  const computedAt = opts.computedAt ?? new Date().toISOString();
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK).map(r => ({
      workspace_id: workspaceId,
      pipeline_ref: refKey(r.pipelineRef),
      stage_label: r.stageLabel,
      median_days: r.medianDays,
      sample_n: r.sampleN,
      computed_at: computedAt,
    }));
    const { error } = await supabase.from('pipeline_stage_stats')
      .upsert(chunk, { onConflict: 'workspace_id,pipeline_ref,stage_label' });
    if (error) {
      if (isMissingTable(error)) return { written: 0, tableMissing: true };
      throw new Error(error.message);
    }
  }
  const { error } = await supabase.from('pipeline_stage_stats')
    .delete().eq('workspace_id', workspaceId).lt('computed_at', computedAt);
  if (error) {
    if (isMissingTable(error)) return { written: 0, tableMissing: true };
    throw new Error(error.message);
  }
  return { written: rows.length, tableMissing: false };
}
