// The lock a script takes before it writes (GET-412). See packages/core backfillLock.ts.
//
// Scripts here exit with process.exit at a dozen points each, and a lock released only on a
// clean return would leak on every one of them. So the handle carries an `exit(code)` that
// releases first, and the scripts call that instead once the lock is held. SIGINT / SIGTERM
// release too, so a Ctrl-C or a container stop does not leave a lease that the next run has to
// take over with a warning.

import { acquireBackfillLock, lockHolder, LockHeldError, WORKSPACE_WIDE_JOB } from '@nous/core';

export { WORKSPACE_WIDE_JOB };

/**
 * Take the lock or exit(3) with the holder's name. `job` is the script's name, or '*' for a
 * run that touches most of a workspace (an extraction backfill, a settle): '*' waits for every
 * other job, and every other job waits for '*'.
 */
export async function lockScript(supabase, workspaceId, job, { leaseMinutes = 180, note = null } = {}) {
  const holder = lockHolder(job === WORKSPACE_WIDE_JOB ? (note ?? 'workspace-wide') : job);
  let lock;
  try {
    lock = await acquireBackfillLock(supabase, workspaceId, job, { holder, leaseMinutes, note });
  } catch (err) {
    if (err instanceof LockHeldError) {
      console.error(`[BACKFILL_LOCK] refusing to start: ${err.message}`);
      console.error('[BACKFILL_LOCK] one writer at a time. Wait for it, or ask the holder. A stale lease is taken over on its own once it expires.');
      process.exit(3);
    }
    throw err;
  }
  const release = () => lock.release().catch(() => {});
  const exit = async (code = 0) => { await release(); process.exit(code); };
  for (const sig of ['SIGINT', 'SIGTERM']) process.once(sig, () => { release().finally(() => process.exit(130)); });
  if (!lock.noop) console.log(`[BACKFILL_LOCK] ${job === WORKSPACE_WIDE_JOB ? 'workspace' : job} lock taken by ${holder} (lease ${leaseMinutes} min)`);
  return { release, exit, renew: lock.renew, noop: lock.noop };
}
