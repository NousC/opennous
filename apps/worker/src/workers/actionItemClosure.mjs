// Close finished tasks on a schedule, not only when someone opens the page.
//
// `autoCloseActionItems` has always worked. It was only ever CALLED from GET /api/tasks, as a
// throttled background kick off a page load (apps/api/src/routes/api/tasks.mjs). The reasoning
// there is sound — nobody should wait three seconds on housekeeping to read their own task list —
// but it means closure is a function of someone visiting a screen.
//
// A workspace nobody opens never closes anything. Measured on a customer workspace: hundreds of
// action items, almost all still open — a close rate of a few percent over months of ingested mail
// and meetings, while `worker_runs` held no closure job at all because there was none. GET-357 fixed
// the join so the engine COULD close a few dozen items; nothing ever invoked it, so `would_close_now`
// stayed a dry-run number and those items stayed open.
//
// This is the sweep. The engine is unchanged and now lives in @nous/core so the page and this job
// share one implementation rather than drifting apart — the failure shape that produced GET-364,
// GET-368 and GET-376.
//
// COST. The engine is rules-first and bounded by design: rule-matched closures are free, and the
// model path is capped at MAX_JUDGED = 12 per run and skips any item with no activity after the
// promise ("don't pay for a model call to be told no"). Daily rather than hourly because a
// follow-up closing a day late costs nothing, and it keeps the ceiling at one bounded pass per
// workspace per day.

import { getSupabaseClient, logWorkerRun, autoCloseActionItems, withBackfillLock, lockHolder, LockHeldError } from '@nous/core';

// A pass the model provider could not finish is tried again, an hour later, up to three times
// (GET-904). Before, a judge that hit a 402 logged it and moved on, and the task waited a whole
// day for the next sweep, which on the day credit ran out meant it waited for a person.
export const RETRY_AFTER_MS = 60 * 60_000;
export const MAX_RETRIES = 3;

export async function runActionItemClosure({ workspaceIds: only = null, attempt = 0, schedule = setTimeout } = {}) {
  const supabase = getSupabaseClient();

  // Only workspaces that actually hold an open task. A sweep over every workspace would spend its
  // budget proving there is nothing to do.
  // A half-open range, not a prefix LIKE: the LIKE cannot use claims_ws_property_live and reads
  // every claim in the table to answer this (GET-396, GET-407).
  const { data: rows, error } = await supabase
    .from('claims')
    .select('workspace_id')
    .gte('property', 'action_item.')
    .lt('property', 'action_item/')
    .is('invalid_at', null)
    .limit(5000);
  if (error) {
    console.warn('[ACTION_ITEM_CLOSURE] could not list workspaces:', error.message);
    return;
  }

  const workspaceIds = [...new Set((rows ?? []).map(r => r.workspace_id).filter(Boolean))]
    .filter(id => !only || only.includes(id));
  if (!workspaceIds.length) return;

  let totalClosed = 0;
  const deferredIn = [];
  for (const workspaceId of workspaceIds) {
    const startedAt = new Date();
    try {
      const stats = { deferred: 0 };
      // One writer at a time (GET-412): a backfill holding the workspace skips this pass.
      const closed = await withBackfillLock(supabase, workspaceId, 'actionItemClosure', { holder: lockHolder('actionItemClosure'), leaseMinutes: 30 },
        () => autoCloseActionItems(supabase, workspaceId, { stats }));
      totalClosed += closed.length;
      if (stats.deferred) deferredIn.push(workspaceId);
      // A run that closed nothing is still a run. Recording it is what makes "the sweep is
      // working and there was nothing to close" distinguishable from "the sweep never ran" —
      // the exact ambiguity that hid this for months.
      await logWorkerRun(supabase, {
        workspaceId,
        worker: 'action_item_closure',
        status: 'success',
        summary: (closed.length
          ? `closed ${closed.length} task${closed.length === 1 ? '' : 's'}`
          : 'nothing to close') + (stats.deferred ? `; ${stats.deferred} deferred (model unavailable)` : ''),
        startedAt,
        finishedAt: new Date(),
      }).catch(() => {});
      if (closed.length) {
        console.log(`[ACTION_ITEM_CLOSURE] ${workspaceId}: closed ${closed.length}`);
      }
    } catch (err) {
      if (err instanceof LockHeldError) { console.log(`[ACTION_ITEM_CLOSURE] ${workspaceId}: skipped — ${err.message}`); continue; }
      // One workspace's failure must not stop the sweep for the rest.
      console.warn(`[ACTION_ITEM_CLOSURE] ${workspaceId} failed:`, err?.message ?? err);
      await logWorkerRun(supabase, {
        workspaceId,
        worker: 'action_item_closure',
        status: 'error',
        summary: String(err?.message ?? err).slice(0, 200),
        startedAt,
        finishedAt: new Date(),
      }).catch(() => {});
    }
  }

  console.log(`[ACTION_ITEM_CLOSURE] swept ${workspaceIds.length} workspace(s), closed ${totalClosed}`);

  if (deferredIn.length && attempt < MAX_RETRIES) {
    console.log(`[ACTION_ITEM_CLOSURE] ${deferredIn.length} workspace(s) deferred on the model; retry ${attempt + 1}/${MAX_RETRIES} in ${RETRY_AFTER_MS / 60_000} min`);
    const t = schedule(() => runActionItemClosure({ workspaceIds: deferredIn, attempt: attempt + 1, schedule })
      .catch(err => console.error('[ACTION_ITEM_CLOSURE] retry', err?.message ?? err)), RETRY_AFTER_MS);
    t?.unref?.();
  }
  return { closed: totalClosed, deferredIn };
}
