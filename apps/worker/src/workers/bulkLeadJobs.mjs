// Bulk enrich / verify jobs — drains the lead_bulk_jobs queue.
//
// The API enqueues a job (kind = 'enrich' | 'verify') for large selections;
// this worker processes the captured lead_ids with bounded concurrency,
// advancing `processed` so the frontend can show a live progress bar and let
// rows fill in as results land. Resumable: each tick handles up to CHUNK leads
// from the job's current offset, so a 5,000-lead job spreads across ticks
// instead of holding one run open for minutes.
//
// Reuses the same per-record paths as the synchronous run: enrichContact
// (worker copy) and verifyLead (worker copy). Swapping in the providers' native
// bulk file APIs later is isolated to this file.

import { getSupabaseClient, logWorkerRun } from '@nous/core';
import { enrichContact } from '../utils/enrichContact.mjs';
import { getVerifier, verifyLead } from '../utils/verifyLead.mjs';

const CHUNK = 200;             // leads processed per tick (resume from `processed`)
const CONCURRENCY = 8;         // parallel provider calls within a chunk
const ENRICH_STALE_DAYS = 90;
const VERIFY_STALE_DAYS = 90;
const LOCK_STALE_MS = 5 * 60_000; // a running job whose lock is older than this is reclaimable

let running = false;

// Run an array of async thunks `limit` at a time.
async function pool(items, limit, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      try { await fn(items[idx]); } catch { /* per-item failure is non-fatal */ }
    }
  });
  await Promise.all(workers);
}

export async function processBulkLeadJobs() {
  if (running) return;
  running = true;
  const supabase = getSupabaseClient();
  const startedAt = new Date();
  try {
    // Pick the oldest actionable job: pending, or running with a stale lock
    // (the previous tick died mid-job). One job per tick keeps it simple.
    const staleLock = new Date(Date.now() - LOCK_STALE_MS).toISOString();
    const { data: jobs, error } = await supabase
      .from('lead_bulk_jobs')
      .select('*')
      .or(`status.eq.pending,and(status.eq.running,locked_at.lt.${staleLock})`)
      .order('created_at', { ascending: true })
      .limit(1);
    if (error?.code === '42P01' || error?.code === 'PGRST205') return; // migration not applied yet
    if (error) throw error;
    const job = jobs?.[0];
    if (!job) return;

    // Claim it (set running + refresh lock heartbeat).
    await supabase.from('lead_bulk_jobs')
      .update({ status: 'running', locked_at: new Date().toISOString(), started_at: job.started_at || new Date().toISOString() })
      .eq('id', job.id);

    // Resolve the verifier once per job (verify only).
    let verifier = null;
    if (job.kind === 'verify') {
      verifier = await getVerifier(supabase, job.workspace_id, job.provider);
      if (!verifier) {
        await supabase.from('lead_bulk_jobs')
          .update({ status: 'failed', error: 'no_verifier_connected', finished_at: new Date().toISOString() })
          .eq('id', job.id);
        return;
      }
    }

    const allIds = job.lead_ids || [];
    const total = job.total || allIds.length;
    const cols = job.kind === 'verify'
      ? 'id, workspace_id, email, name'
      : 'id, workspace_id, email, linkedin_url, name, company, domain, email_status';
    const method = job.kind === 'verify' ? 'verification' : 'enrichment';
    const staleBefore = Date.now() - (job.kind === 'verify' ? VERIFY_STALE_DAYS : ENRICH_STALE_DAYS) * 86400000;
    const tally = job.result || {};
    const bump = (k) => { tally[k] = (tally[k] || 0) + 1; };

    // Process every remaining chunk in THIS invocation. The module-level
    // `running` guard stops the 20s cron from overlapping; if the process dies
    // mid-job the stale-lock pickup resumes from the persisted `processed`.
    // Progress is written after each chunk so the UI advances live.
    let processed = job.processed || 0;
    while (processed < total) {
      const slice = allIds.slice(processed, processed + CHUNK);
      if (slice.length === 0) break;

      const { data: leads } = await supabase
        .from('leads').select(cols)
        .eq('workspace_id', job.workspace_id).eq('lead_list_id', job.lead_list_id).in('id', slice);

      // Reuse-gate: skip leads already enriched/verified within the stale window.
      const lastRun = new Map();
      if ((leads || []).length) {
        const { data: obs } = await supabase
          .from('observations').select('entity_id, observed_at')
          .eq('workspace_id', job.workspace_id).eq('method', method)
          .in('entity_id', (leads || []).map(l => l.id))
          .order('observed_at', { ascending: false });
        for (const o of obs || []) if (!lastRun.has(o.entity_id)) lastRun.set(o.entity_id, o.observed_at);
      }

      await pool(leads || [], CONCURRENCY, async (l) => {
        const lr = lastRun.get(l.id);
        const fresh = lr && new Date(lr).getTime() >= staleBefore;
        if (job.kind === 'verify') {
          if (!l.email) { bump('no_email'); return; }
          if (fresh) { bump('reused'); return; }
          const status = await verifyLead(supabase, verifier, l);
          if (status === 'VERIFIED') bump('deliverable');
          else if (status === 'RISKY') bump('risky');
          else if (status === 'UNAVAILABLE') bump('undeliverable');
          else bump('inconclusive');
        } else {
          if (!l.email && !l.linkedin_url) { bump('no_identifier'); return; }
          if (l.email && l.email_status && fresh) { bump('reused'); return; }
          const [first, ...rest] = (l.name || '').trim().split(' ');
          await enrichContact(supabase, {
            id: l.id, workspace_id: l.workspace_id, email: l.email, linkedin_url: l.linkedin_url,
            first_name: first || null, last_name: rest.join(' ') || null,
            company: l.company || null, domain: l.domain || null,
          });
          bump('enriched');
        }
      });

      processed += slice.length;
      // Persist progress + refresh the lock heartbeat after each chunk.
      await supabase.from('lead_bulk_jobs')
        .update({ processed, result: tally, locked_at: new Date().toISOString() })
        .eq('id', job.id);
    }

    await supabase.from('lead_bulk_jobs').update({
      status: 'complete', processed, result: tally, finished_at: new Date().toISOString(),
    }).eq('id', job.id);
    await writeRunLog(supabase, job, tally);

    await logWorkerRun(supabase, {
      worker: 'bulk_lead_jobs', workspaceId: job.workspace_id, status: 'success', startedAt,
      summary: `${job.kind} job ${job.id.slice(0, 8)} — ${processed}/${total} (complete)`,
      details: { job_id: job.id, kind: job.kind, processed, total },
    });
  } catch (err) {
    console.error('[WORKER] bulkLeadJobs error:', err.message);
    await logWorkerRun(supabase, { worker: 'bulk_lead_jobs', status: 'error', startedAt, error: err.message });
  } finally {
    running = false;
  }
}

// One run-level ops row tagged to the list, mirroring the synchronous run.
async function writeRunLog(supabase, job, tally) {
  const t = tally || {};
  const summary = job.kind === 'verify'
    ? `Verified ${(t.deliverable || 0) + (t.risky || 0) + (t.undeliverable || 0)} emails `
      + `(${t.deliverable || 0} deliverable · ${t.risky || 0} risky · ${t.undeliverable || 0} undeliverable)`
      + (t.reused ? ` · reused ${t.reused} (no charge)` : '')
    : `Enriched ${t.enriched || 0} leads` + (t.reused ? ` · reused ${t.reused} (no charge)` : '');
  await supabase.from('workspace_system_log').insert({
    workspace_id: job.workspace_id, source: job.provider || (job.kind === 'verify' ? 'verification' : 'enrichment'),
    event_type: job.kind === 'verify' ? 'verification_run' : 'enrichment_run',
    summary, metadata: { lead_list_id: job.lead_list_id, category: job.kind, bulk_job_id: job.id, ...t },
    billable_ops: 0, occurred_at: new Date().toISOString(),
  }).then(() => {}, () => {});
}
