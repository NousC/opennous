// Starts own-plan backfills (GET-1085), each in its own process (ownBackfillRun.mjs says why). A run
// mostly waits on a person's CLI, so a few at once cost almost nothing. A process that died leaves
// its heartbeat stale, and the job is picked up again; reads are deduped, so that re-reads nothing.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getSupabaseClient } from '@nous/core';

export const MAX_RUNS = 3;
const STALE_MS = 5 * 60_000;
const RUN = fileURLToPath(new URL('../ownBackfillRun.mjs', import.meta.url));
const live = new Map();

export async function startOwnBackfills({ supabase = getSupabaseClient(), start = startRun, now = Date.now } = {}) {
  const room = MAX_RUNS - live.size;
  if (room <= 0) return;
  const stale = new Date(now() - STALE_MS).toISOString();
  const { data: jobs, error } = await supabase.from('contact_enrichment_jobs').select('job_id, status')
    .or(`status.eq.own_model_pending,and(status.eq.own_model_running,locked_at.lt.${stale})`)
    .order('created_at', { ascending: true }).limit(room);
  if (error) throw error;
  for (const job of jobs ?? []) {
    if (live.has(job.job_id)) continue;
    const { data: claimed } = await supabase.from('contact_enrichment_jobs')
      .update({ status: 'own_model_running', locked_at: new Date(now()).toISOString() })
      .eq('job_id', job.job_id).eq('status', job.status).select('job_id').maybeSingle();
    if (claimed) start(job.job_id);
  }
}

function startRun(jobId) {
  const child = spawn(process.execPath, [RUN, jobId], { stdio: 'inherit' });
  live.set(jobId, child);
  child.on('exit', () => live.delete(jobId));
}
