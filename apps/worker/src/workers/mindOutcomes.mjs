// The compound loop — outcome resolution (v2), nightly backstop.
//
// Resolution is now event-driven: the moment a won/lost activity lands,
// logActivity() calls resolveEntityPredictions() and the prediction closes
// immediately. This nightly job is the BACKSTOP — it sweeps any open
// predictions that no event will ever fire for (accounts that went quiet past
// their resolution window → 'no_opportunity', or qualified-but-stalled → lost),
// and runs the late-revenue upgrade pass. The actual resolution logic lives in
// one place — @nous/core resolveOpenPredictions() — so the disposition rules
// never fork between the event path and this one.
//
// Idempotent — it only ever touches predictions whose state has changed.

import { getSupabaseClient, logWorkerRun, resolveOpenPredictions } from '@nous/core';

export async function resolveOutcomes() {
  const supabase = getSupabaseClient();
  const startedAt = new Date();

  const result = await resolveOpenPredictions(supabase);
  // Migration / tables not yet applied — skip silently so we don't spam logs.
  if (result.skipped) return;

  const { resolved, upgraded, openScanned, perWorkspace } = result;
  if (resolved || upgraded) {
    console.log(`[MIND_OUTCOMES] resolved=${resolved} upgraded=${upgraded}`);
  }

  // Write one worker_runs row per workspace that had activity, plus a
  // system-wide row so the nightly heartbeat is always visible — even when
  // there was nothing to resolve. The summary distinguishes the two zero
  // cases that look the same but mean different things:
  //   "no predictions to watch"     — nobody has been scored yet
  //   "N open, none ready yet"      — predictions exist but await their
  //                                   window or a revenue signal (most now
  //                                   resolve on the event before reaching here)
  if (perWorkspace.size === 0) {
    const summary = openScanned === 0
      ? 'no predictions to watch — Scorecard hasn\'t staked any yet'
      : `${openScanned} open prediction${openScanned === 1 ? '' : 's'}, none ready (waiting on revenue or window)`;
    await logWorkerRun(supabase, {
      worker: 'mind_outcomes',
      status: 'no_op',
      summary,
      details: { resolved: 0, upgraded: 0, open_pending: openScanned },
      startedAt,
    });
  } else {
    for (const [workspaceId, counts] of perWorkspace) {
      await logWorkerRun(supabase, {
        worker: 'mind_outcomes',
        workspaceId,
        status: 'success',
        summary: `resolved ${counts.resolved}${counts.upgraded ? `, upgraded ${counts.upgraded}` : ''}`,
        details: counts,
        startedAt,
      });
    }
  }
}
