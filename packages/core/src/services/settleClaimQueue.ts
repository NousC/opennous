// Settle a workspace's claim queue now, instead of whenever the engine reaches it (GET-299).
//
// An import writes observations; reports, the org chart, ownership and the agent read CLAIMS. The
// engine that turns one into the other is a shared, rate-limited, one-at-a-time trickle, and on
// one large import it left only a handful of thousands of deals with a readable status for most of a
// day while the import had already logged "complete". So an import settles its own claims before it says it is done.
//
// Two rules keep this from quietly doing less than the engine would:
//
//   - Only jobs that were in the queue BEFORE a batch read its observations are deleted, and they
//     are deleted by id. An observation that lands mid-run has its own, newer job, which survives
//     for the engine.
//   - Some properties have engine-side follow-ups: a changed job title or stage re-scores the ICP
//     prediction, a stage becoming closed-won flips intent to the client axis. Settling writes the
//     claim so it is usable immediately, but LEAVES those jobs queued so the engine still does the
//     follow-up. `claimNeedsEngineFollowUp` is the one list both sides read.

import type { SupabaseClient } from '@supabase/supabase-js';
import { recomputeClaims, type ClaimTarget } from '../db/claims.js';

// Claim properties whose change can move an ICP score (engine re-scores the open prediction), plus
// pipeline_stage (engine flips a newly won account onto the client intent axis).
const SCORE_AFFECTING = new Set([
  'job_title', 'seniority', 'department', 'industry', 'employee_count',
  'size_band', 'funding_stage', 'country', 'company_type', 'what_they_do',
  'pipeline_stage',
]);

export function isScoreAffectingProperty(property: string): boolean {
  return SCORE_AFFECTING.has(property) || property.startsWith('signal.') || property.startsWith('exclusion.');
}

// The properties the flattened list actually renders — exactly the `props` array inside
// refresh_list_chunk. A claim on one of these has changed something a list column shows, so that
// row is rebuilt as soon as the claim settles (GET-347); a claim on anything else has not, and
// rebuilding for it would be work nobody can see.
//
// Two lists in two languages is the bug shape this codebase names "two places, one rule", so if
// refresh_list_chunk's `props` changes, change this with it. The test asserts they agree.
const LIST_ROW_PROPERTIES = new Set([
  'name', 'first_name', 'last_name', 'job_title', 'industry', 'icp_score',
  'deal_health_score', 'pipeline_stage', 'status', 'value', 'stage',
  'close_date', 'owner_name', 'owner_email', 'pipeline', 'pipeline_id', 'is_internal', 'location',
]);

/** Does a settled claim on this property change what a list row shows? */
export function isListRowProperty(property: string): boolean {
  // The `cs.*` family is a PREFIX, not a list: account health is an open vocabulary that grows
  // whenever a customer's ops team adds a field worth reading, and every one of them lands in the
  // `cs` bag on the account row (refresh_list_chunk). Enumerating them here would mean editing two
  // places for every new fact and a Customer Success page that quietly stops updating for the one
  // somebody forgot.
  return LIST_ROW_PROPERTIES.has(property) || property.startsWith('cs.');
}

/** A job the engine must still see after the claim is written, for its follow-up work. */
export function claimNeedsEngineFollowUp(property: string): boolean {
  return isScoreAffectingProperty(property) || property === 'pipeline_stage';
}

// What a report, a list or an org chart reads first. Settled before everything else so a large
// import is useful long before it is finished.
export const REPORT_CRITICAL_PROPERTIES = [
  'status', 'stage', 'stage_id', 'pipeline', 'pipeline_id', 'value', 'currency',
  'close_date', 'opened_date', 'lost_reason_stated', 'lost_reason_note', 'won_reason_stated',
  'owner_email', 'owner_name', 'name', 'first_name', 'last_name', 'job_title', 'company',
  'lifecycle_stage', 'pipeline_stage', 'domain', 'industry',
];

// NOT more than 1000: PostgREST caps every response at 1000 rows without saying so. At 2000 a read
// came back with 1000, "fewer than asked" read as "last page", and the first live settle stopped
// after under two thousand fields with hundreds of thousands still pending. The pending count is what caught it.
const JOBS_PER_READ = 1000;
const TARGETS_PER_BATCH = 300;

export interface SettleProgress {
  phase: 'critical' | 'rest';
  settled: number;
  written: number;
  failed: number;
  jobsCleared: number;
}

export interface SettleResult {
  settled: number;
  /**
   * Claims actually WRITTEN, which is not the same number as `settled`.
   *
   * `recomputeClaims` returns how many it wrote, and a batch that plans nothing returns zero in
   * perfect silence — an asserted claim is left alone, and a target whose observations cannot be
   * derived from produces nothing. Counting attempts as successes hides both. It cost an hour on
   * the first account-health backfill, where "thousands settled, 0 failed" was true and meaningless
   * while over a hundred customer accounts got no claim at all.
   *
   * `settled < written` is normal (one target, one claim). `written` far below `settled` means
   * something is wrong and is worth looking at.
   */
  written: number;
  failed: number;
  jobsCleared: number;
  /** Jobs this workspace still has queued that were enqueued before the settle started. */
  pending: number;
  seconds: number;
}

/** Drain every job this workspace had queued when the call started, report-critical fields first. */
export async function settleClaimQueue(
  supabase: SupabaseClient,
  workspaceId: string,
  opts: { onProgress?: (p: SettleProgress) => void } = {},
): Promise<SettleResult> {
  const t0 = Date.now();
  const settleStart = new Date().toISOString();
  let settled = 0, written = 0, failed = 0, jobsCleared = 0;

  for (const phase of ['critical', 'rest'] as const) {
    // Keyset over (entity_id, property): copies of one target arrive together and collapse to one
    // derivation, and jobs deliberately left for the engine are stepped past, not re-read forever.
    let cursor: { entityId: string; property: string } | null = null;
    for (;;) {
      let q = supabase.from('claim_jobs')
        .select('id, entity_id, property')
        .eq('workspace_id', workspaceId)
        .is('picked_at', null)
        .lt('enqueued_at', settleStart);
      q = phase === 'critical'
        ? q.in('property', REPORT_CRITICAL_PROPERTIES)
        : q.not('property', 'in', `(${REPORT_CRITICAL_PROPERTIES.map(p => `"${p}"`).join(',')})`);
      if (cursor) {
        q = q.or(`entity_id.gt.${cursor.entityId},and(entity_id.eq.${cursor.entityId},property.gt."${cursor.property}")`);
      }
      const { data: jobs, error } = await q
        .order('entity_id', { ascending: true })
        .order('property', { ascending: true })
        .limit(JOBS_PER_READ);
      if (error) throw new Error(`failed to read claim queue: ${error.message}`);
      if (!jobs?.length) break;

      // A target's copies can straddle the read boundary. Leave the last target to the next read,
      // which starts at it, unless it is the only one in the read.
      const rows = jobs as { id: number; entity_id: string; property: string }[];
      const lastKey = `${rows[rows.length - 1].entity_id}|${rows[rows.length - 1].property}`;
      const full = rows.length === JOBS_PER_READ;
      const usable = full ? rows.filter(r => `${r.entity_id}|${r.property}` !== lastKey) : rows;
      const take = usable.length ? usable : rows;

      const byTarget = new Map<string, { target: ClaimTarget; ids: number[] }>();
      for (const r of take) {
        const key = `${r.entity_id}|${r.property}`;
        const g = byTarget.get(key) ?? { target: { entityId: r.entity_id, property: r.property }, ids: [] };
        g.ids.push(r.id);
        byTarget.set(key, g);
      }
      const groups = [...byTarget.values()];

      for (let i = 0; i < groups.length; i += TARGETS_PER_BATCH) {
        const batch = groups.slice(i, i + TARGETS_PER_BATCH);
        try {
          const result = await recomputeClaims(supabase, workspaceId, batch.map(g => g.target));
          settled += batch.length;
          written += result.written;
          const doneIds = batch.filter(g => !claimNeedsEngineFollowUp(g.target.property)).flatMap(g => g.ids);
          for (let j = 0; j < doneIds.length; j += 500) {
            const { error: delErr } = await supabase.from('claim_jobs').delete().in('id', doneIds.slice(j, j + 500));
            if (!delErr) jobsCleared += Math.min(500, doneIds.length - j);
          }
        } catch (e) {
          // The jobs stay queued; the engine retries them. A settle that fails partly is still a
          // settle that says so, never one that reports complete.
          failed += batch.length;
          console.warn('[SETTLE_CLAIMS] ws=%s batch failed: %s', workspaceId, (e as Error)?.message ?? e);
        }
      }

      const tail = take[take.length - 1];
      cursor = { entityId: tail.entity_id, property: tail.property };
      opts.onProgress?.({ phase, settled, written, failed, jobsCleared });
      if (!full) break;
    }
  }

  // Pending means "not usable yet". Jobs left queued on purpose for the engine's follow-up already
  // have their claim written, so they are not pending — counting them would call every import
  // partial.
  const followUp = [...SCORE_AFFECTING].map(p => `"${p}"`).join(',');
  const { count } = await supabase.from('claim_jobs')
    .select('id', { count: 'exact', head: true })
    .eq('workspace_id', workspaceId).is('picked_at', null).lt('enqueued_at', settleStart)
    .not('property', 'in', `(${followUp})`)
    .not('property', 'like', 'signal.%')
    .not('property', 'like', 'exclusion.%');

  return { settled, written, failed, jobsCleared, pending: count ?? 0, seconds: Math.round((Date.now() - t0) / 1000) };
}

/**
 * Settle the claims a caller's own observation writes just queued, now rather than on the engine's
 * next minute: the page that wrote a task reads it straight back, and a job still queued for the
 * observation that created or moved a task would re-derive the claim a minute later and put an old
 * status back. Same rule as settleClaimQueue, scoped to these targets: read the jobs first,
 * recompute, then delete only those jobs, by id, once the recompute has succeeded. A job enqueued
 * after the read belongs to a newer observation and survives for the engine.
 */
export async function settleClaimTargets(
  supabase: SupabaseClient,
  workspaceId: string,
  targets: ClaimTarget[],
): Promise<{ written: number; cleared: number }> {
  const seen = new Map<string, ClaimTarget>();
  for (const t of targets ?? []) if (t?.entityId && t?.property) seen.set(`${t.entityId}|${t.property}`, t);
  const uniq = [...seen.values()];
  if (!uniq.length) return { written: 0, cleared: 0 };
  const jobIds: string[] = [];
  for (let i = 0; i < uniq.length; i += 50) {
    const slice = uniq.slice(i, i + 50);
    const { data, error } = await supabase.from('claim_jobs').select('id, entity_id, property')
      .eq('workspace_id', workspaceId).is('picked_at', null)
      .in('entity_id', [...new Set(slice.map((t) => t.entityId))])
      .in('property', [...new Set(slice.map((t) => t.property))]);
    if (error) break; // no queue to clear is not a reason to skip the recompute
    for (const j of (data ?? []) as { id: string; entity_id: string; property: string }[]) {
      if (seen.has(`${j.entity_id}|${j.property}`)) jobIds.push(j.id);
    }
  }
  const { written } = await recomputeClaims(supabase, workspaceId, uniq);
  let cleared = 0;
  for (let i = 0; i < jobIds.length; i += 500) {
    const { error } = await supabase.from('claim_jobs').delete().in('id', jobIds.slice(i, i + 500));
    if (!error) cleared += Math.min(500, jobIds.length - i);
  }
  return { written, cleared };
}
