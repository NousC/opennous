// Data-quality invariants, asserted continuously.
//
// Every defect found on 2026-09-12 — forked people, unreadable company domains,
// claims describing the wrong human, an unresolved-meeting queue that was 100%
// false positives — was a violated invariant that nobody was asserting. None of
// them needed a model or a judgment call, and all of it was sitting in the
// database the day it happened. It surfaced because a human opened a record and
// saw something stupid.
//
// The checks themselves live in `run_invariants(ws)` in the database, next to the
// data they are about. This worker's whole job is to run them on a schedule and
// write down the answers, so the useful signal becomes available: not the level —
// we already know 2,500 people with no identifier is bad — but the DERIVATIVE.
// "2,500 last week, 2,520 today" says a write path is still bleeding, and that is
// the thing worth waking someone for.

import { getSupabaseClient, logWorkerRun } from '@nous/core';
import { SIGNAL_WORTHY_TYPES } from '../signals/index.mjs';

/** Run every invariant for one workspace. Returns the rows; writes unless dryRun. */
export async function runInvariants(supabase, workspaceId, { dryRun = false } = {}) {
  const { data, error } = await supabase.rpc('run_invariants', { ws: workspaceId });
  // A check that could not RUN is not a check that passed. Surfacing this as an
  // error rather than an empty result is the same lesson as the repair sweep that
  // read a dead API key as "no facts found" and deleted dozens of claims.
  if (error) throw new Error(`run_invariants(${workspaceId}): ${error.message}`);
  const rows = data ?? [];

  if (!dryRun && rows.length) {
    await supabase.from('invariant_checks').insert(
      rows.map(r => ({
        workspace_id: workspaceId,
        name:         r.name,
        violations:   Number(r.violations),
        sample:       r.sample ?? [],
        description:  r.description,
      })),
    );
  }
  return rows;
}

/**
 * The day's snapshot for one workspace (GET-201): levels that cannot be recomputed for a
 * past date later, because claims get retired and people get merged. One row per metric
 * per day; re-running a day overwrites it. Read through system_health_daily/weekly/monthly.
 */
export async function recordSnapshot(supabase, workspaceId, { day = new Date(), dryRun = false } = {}) {
  const measuredOn = day.toISOString().slice(0, 10);
  const { data, error } = await supabase.rpc('system_snapshot', {
    ws: workspaceId,
    // The worker's own definition of an extractable conversation, so SQL never keeps a
    // second copy that drifts.
    inbound_types: [...SIGNAL_WORTHY_TYPES],
    // The day the FLOW measures cover, always the same day the row is labelled with.
    // Levels are cumulative and do not care; a flow read for a different window than its
    // label is the quiet kind of wrong Noema exists to stop.
    for_day: measuredOn,
  });
  if (error) throw new Error(`system_snapshot(${workspaceId}): ${error.message}`);
  const rows = (data ?? []).map(r => ({
    measured_on:  measuredOn,
    workspace_id: workspaceId,
    metric:       r.metric,
    value:        Number(r.value),
  }));
  if (!dryRun && rows.length) {
    const { error: e } = await supabase.from('system_metrics')
      .upsert(rows, { onConflict: 'measured_on,workspace_id,metric' });
    if (e) throw new Error(`system_metrics upsert (${workspaceId}): ${e.message}`);
  }
  return rows;
}

/** The calendar day before this one, in UTC. */
function previousDay(d) {
  const x = new Date(d);
  x.setUTCDate(x.getUTCDate() - 1);
  return x;
}

/** Compare against the previous run so the log reports movement, not just level. */
async function previousCounts(supabase, workspaceId) {
  const { data } = await supabase
    .from('invariant_checks')
    .select('name, violations, ran_at')
    .eq('workspace_id', workspaceId)
    .order('ran_at', { ascending: false })
    .limit(200);
  const seen = new Map();
  for (const r of data ?? []) if (!seen.has(r.name)) seen.set(r.name, Number(r.violations));
  return seen;
}

export async function processInvariants({ dryRun = false } = {}) {
  const supabase = getSupabaseClient();
  const startedAt = new Date();
  let workspaces = 0, totalViolations = 0, regressions = 0, failed = 0, snapshots = 0, snapshotFailed = 0;

  try {
    const { data: rows } = await supabase.from('workspaces').select('id, name');
    for (const ws of rows ?? []) {
      let before;
      try {
        before = await previousCounts(supabase, ws.id);
        const results = await runInvariants(supabase, ws.id, { dryRun });
        workspaces++;
        for (const r of results) {
          const now = Number(r.violations);
          totalViolations += now;
          const then = before.get(r.name);
          // Worth a line only when it is news: a violation that just appeared, or
          // a count that grew. A large steady number is already understood; a
          // small growing one is what nobody has noticed yet.
          if (now > 0 && (then === undefined || now > then)) {
            regressions++;
            const delta = then === undefined ? 'new' : `was ${then}`;
            console.warn(`[INVARIANT] ${ws.name}: ${r.name} = ${now} (${delta}) — ${r.description}`);
          }
        }
      } catch (err) {
        failed++;
        console.error(`[INVARIANT_FAILED] ${ws.name}: ${err.message}`);
      }
      // Separate try: a snapshot that cannot be taken must not cost the invariants, and
      // the other way round.
      try {
        // YESTERDAY, not today. The sweep runs at 04:30, so "today" is four hours old: levels
        // would be near enough, and every flow measure — what was written, how much of it was
        // grounded — would cover a fraction of a day and read as a collapse. A snapshot labelled
        // with a day should describe that whole day.
        await recordSnapshot(supabase, ws.id, { day: previousDay(startedAt), dryRun });
        snapshots++;
      } catch (err) {
        snapshotFailed++;
        console.error(`[SNAPSHOT_FAILED] ${ws.name}: ${err.message}`);
      }
    }

    // `status` is NOT NULL on worker_runs. The first live run omitted it and the run
    // log insert failed — the invariant rows themselves were written, but the one
    // record that says "the sweep ran" was not. A partial sweep (some workspaces could
    // not be checked) is an error, not a success: a check that could not run must
    // never read as a clean bill of health.
    await logWorkerRun(supabase, {
      worker: 'invariants',
      status: failed || snapshotFailed ? 'error' : 'success',
      startedAt,
      summary: `${workspaces} workspace(s) · ${totalViolations} violation(s) · ${regressions} new or worsening · ${snapshots} snapshot(s)`
        + (failed ? ` · ${failed} workspace(s) could not be checked` : '')
        + (snapshotFailed ? ` · ${snapshotFailed} snapshot(s) failed` : ''),
      details: { workspaces, totalViolations, regressions, failed, snapshots, snapshotFailed },
    }).catch(() => {});
  } catch (err) {
    console.error('[INVARIANTS] sweep failed', err.message);
    await logWorkerRun(supabase, {
      worker: 'invariants', status: 'error', startedAt,
      summary: 'sweep failed before completing', error: err.message,
    }).catch(() => {});
  }
}
