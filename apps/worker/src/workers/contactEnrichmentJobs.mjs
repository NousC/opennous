// Drains the contact_enrichment_jobs queue.
//
// The API enqueues a job ({ workspace_id, contact_ids }) on CSV import and returns
// immediately; this claims a pending job and runs the history backfill HERE, in the
// worker, off the API request path — a 50-account × 5-integration import is minutes
// of provider I/O that must not sit on the API event loop.
//
// Resumable: a job whose lock goes stale (the worker died mid-run) is reclaimed, and
// external_id dedup in logActivity makes the re-run free. One job per tick; the
// `running` guard skips overlapping ticks while a long job is in flight.

import { getSupabaseClient } from '@nous/core';

const LOCK_STALE_MS = 20 * 60_000; // a 'running' job locked longer than this is reclaimable
const MAX_ATTEMPTS = 3;
let running = false;

export async function processContactEnrichmentJobs() {
  if (running) return;
  running = true;
  const supabase = getSupabaseClient();
  try {
    const staleLock = new Date(Date.now() - LOCK_STALE_MS).toISOString();
    const { data: jobs, error } = await supabase
      .from('contact_enrichment_jobs')
      .select('job_id, workspace_id, contact_ids, status, attempts, locked_at')
      .or(`status.eq.pending,and(status.eq.running,locked_at.lt.${staleLock})`)
      .order('created_at', { ascending: true })
      .limit(1);
    if (error?.code === '42P01' || error?.code === 'PGRST205') return; // migration not applied yet
    if (error) throw error;
    const job = jobs?.[0];
    if (!job) return;

    // Claim it — optimistic on the status we just read, so a concurrent tick can't
    // double-run the same job.
    const attempts = (job.attempts ?? 0) + 1;
    const { data: claimed } = await supabase
      .from('contact_enrichment_jobs')
      .update({ status: 'running', locked_at: new Date().toISOString(), attempts })
      .eq('job_id', job.job_id)
      .eq('status', job.status)
      .select('job_id')
      .maybeSingle();
    if (!claimed) return;

    const contactIds = Array.isArray(job.contact_ids)
      ? job.contact_ids
      : (job.contact_ids?.ids || []);

    try {
      // Dynamic import isolates the heavy enricher (googleapis / imapflow / unipile)
      // from worker BOOT: a problem loading it fails THIS job, not the whole process.
      const { enrichContactHistory } = await import('../services/contactHistoryEnricher.mjs');
      await enrichContactHistory(supabase, job.workspace_id, contactIds, job.job_id);
      await supabase.from('contact_enrichment_jobs')
        .update({ status: 'done', done: true, updated_at: new Date().toISOString() })
        .eq('job_id', job.job_id);
      console.log(`[CONTACT_ENRICH_JOB] done job=${job.job_id} contacts=${contactIds.length}`);
    } catch (e) {
      const giveUp = attempts >= MAX_ATTEMPTS;
      console.error(`[CONTACT_ENRICH_JOB] job=${job.job_id} failed (attempt ${attempts}${giveUp ? ', giving up' : ''}):`, e?.message || e);
      await supabase.from('contact_enrichment_jobs')
        .update({
          status: giveUp ? 'failed' : 'pending',
          error: String(e?.message || e).slice(0, 500),
          updated_at: new Date().toISOString(),
        })
        .eq('job_id', job.job_id);
    }
  } catch (e) {
    console.error('[CONTACT_ENRICH_JOB]', e?.message || e);
  } finally {
    running = false;
  }
}
