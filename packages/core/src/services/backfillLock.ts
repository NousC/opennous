// One writer at a time (GET-412).
//
// Every long-running writer — a backfill script, a --force re-read, a full-workspace settle, the
// worker's daily sweeps — takes a lock on (workspace, job) before it starts and releases it when
// it ends. A second run refuses to start and names the holder. The database it protects is
// IO-bound, and two writers at once is what turns a backfill into an outage for the app.
//
// Leases, not flags: a run that dies without releasing would otherwise block its job forever.
// `expires_at` is set from the run's own estimate of how long it takes, renewed while it works;
// a lease that has passed is taken over with a warning.
//
// '*' is the workspace-wide job. A run that touches most of a workspace (a full settle, an
// extraction backfill) takes '*', and every job checks '*' as well as its own, so "one writer"
// means one.

import type { SupabaseClient } from '@supabase/supabase-js';
import { hostname } from 'node:os';

export const WORKSPACE_WIDE_JOB = '*';

export interface BackfillLock {
  workspace_id: string;
  job: string;
  holder: string;
  acquired_at: string;
  expires_at: string;
  note: string | null;
}

export class LockHeldError extends Error {
  constructor(public readonly held: BackfillLock) {
    super(`${held.job === WORKSPACE_WIDE_JOB ? 'the workspace' : held.job} is locked by ${held.holder} since ${held.acquired_at} (lease to ${held.expires_at})${held.note ? ` — ${held.note}` : ''}`);
    this.name = 'LockHeldError';
  }
}

/** Who this process is, for the holder column: enough to find and ask. */
export function lockHolder(script: string): string {
  return `${hostname()}:${process.pid} ${script}`;
}

/** Pure: is a lock row live at `now`? A passed lease is not a lock. */
export function lockIsLive(row: Pick<BackfillLock, 'expires_at'> | null | undefined, now: Date = new Date()): boolean {
  if (!row) return false;
  const t = Date.parse(row.expires_at);
  return Number.isFinite(t) && t > now.getTime();
}

/**
 * Take the lock for (workspace, job), or throw LockHeldError naming the holder.
 *
 * Checks the job's own row AND the workspace-wide row. Takes over a stale lease with a warning.
 * A missing table (migration not applied) returns a no-op handle rather than blocking every
 * script on a fresh install: the lock is a guard for a busy production database, not a
 * precondition for running at all.
 */
export async function acquireBackfillLock(
  supabase: SupabaseClient,
  workspaceId: string,
  job: string,
  opts: { holder: string; leaseMinutes?: number; note?: string; now?: Date; warn?: (msg: string) => void },
): Promise<{ release: () => Promise<void>; renew: (minutes?: number) => Promise<void>; noop: boolean }> {
  const now = opts.now ?? new Date();
  const lease = opts.leaseMinutes ?? 120;
  const warn = opts.warn ?? ((m) => console.warn(`[BACKFILL_LOCK] ${m}`));
  const expiresAt = new Date(now.getTime() + lease * 60_000).toISOString();

  const jobs = job === WORKSPACE_WIDE_JOB ? [WORKSPACE_WIDE_JOB] : [job, WORKSPACE_WIDE_JOB];
  const { data, error } = await supabase.from('backfill_locks').select('*')
    .eq('workspace_id', workspaceId).in('job', jobs);
  if (error) {
    if (error.code === '42P01' || error.code === 'PGRST205') {
      warn('backfill_locks table is missing (migration not applied) — running without a lock');
      return { release: async () => {}, renew: async () => {}, noop: true };
    }
    throw new Error(`lock read failed: ${error.message}`);
  }
  for (const row of (data ?? []) as BackfillLock[]) {
    if (row.holder === opts.holder) continue;            // ours, re-entered
    if (lockIsLive(row, now)) throw new LockHeldError(row);
    warn(`taking over a stale ${row.job === WORKSPACE_WIDE_JOB ? 'workspace' : row.job} lock held by ${row.holder} (lease ended ${row.expires_at})`);
  }
  // When taking the workspace-wide lock, no other job may be live either.
  if (job === WORKSPACE_WIDE_JOB) {
    const { data: others } = await supabase.from('backfill_locks').select('*').eq('workspace_id', workspaceId).neq('job', WORKSPACE_WIDE_JOB);
    for (const row of (others ?? []) as BackfillLock[]) if (row.holder !== opts.holder && lockIsLive(row, now)) throw new LockHeldError(row);
  }

  const row = { workspace_id: workspaceId, job, holder: opts.holder, acquired_at: now.toISOString(), expires_at: expiresAt, note: opts.note ?? null };
  const { error: upErr } = await supabase.from('backfill_locks').upsert(row, { onConflict: 'workspace_id,job' });
  if (upErr) throw new Error(`lock write failed: ${upErr.message}`);

  const release = async () => {
    await supabase.from('backfill_locks').delete().eq('workspace_id', workspaceId).eq('job', job).eq('holder', opts.holder);
  };
  const renew = async (minutes = lease) => {
    await supabase.from('backfill_locks').update({ expires_at: new Date(Date.now() + minutes * 60_000).toISOString() })
      .eq('workspace_id', workspaceId).eq('job', job).eq('holder', opts.holder);
  };
  return { release, renew, noop: false };
}

/**
 * Run `fn` under the lock, releasing on the way out whatever happens. The shape every script
 * and sweep uses: one call, no way to forget the release.
 */
// Every lock this process holds right now, so a shutdown can hand them back (releaseHeldLocks).
const held = new Set<() => Promise<void>>();

/**
 * Release every lock this process holds. Call on SIGTERM: a deploy stops the worker mid-job, and a
 * lock left behind blocks that workspace's next run until its lease ends — an hour for the board.
 * Released, the next run (nightly, or by hand) picks up where this one stopped.
 */
export async function releaseHeldLocks(): Promise<number> {
  const all = [...held];
  await Promise.all(all.map((r) => r().catch(() => {})));
  held.clear();
  return all.length;
}

export async function withBackfillLock<T>(
  supabase: SupabaseClient,
  workspaceId: string,
  job: string,
  opts: Parameters<typeof acquireBackfillLock>[3],
  fn: (lock: { renew: (minutes?: number) => Promise<void> }) => Promise<T>,
): Promise<T> {
  const lock = await acquireBackfillLock(supabase, workspaceId, job, opts);
  held.add(lock.release);
  try {
    return await fn({ renew: lock.renew });
  } finally {
    held.delete(lock.release);
    await lock.release().catch(() => {});
  }
}
