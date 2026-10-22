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

import { getSupabaseClient, sendEmail, CREDIT_SCALE, withBackfillLock, lockHolder, LockHeldError } from '@nous/core';
import { backfillCreditState, BACKFILL_CREDIT_FLOOR, CreditsExhausted } from '../utils/credits.mjs';
import { providerFailures, probeProvider, ProviderUnavailable, PROVIDER_FAIL_THRESHOLD, PROBE_EVERY_MS, providerPauseLine } from '../lib/providerHealth.mjs';
import { createMessage, modelEndpoint } from '../lib/llm.mjs';
import { apiInternalBase } from '../lib/apiInternal.mjs';

const LOCK_STALE_MS = 20 * 60_000; // a 'running' job locked longer than this is reclaimable
const MAX_ATTEMPTS = 3;
let running = false;

// Resolve the team that owns a workspace (for the credit wallet lookup).
/** Merge into a job's state without clobbering what the enricher wrote there. */
async function patchJobState(supabase, jobId, patch) {
  const { data } = await supabase.from('contact_enrichment_jobs').select('state').eq('job_id', jobId).maybeSingle();
  await supabase.from('contact_enrichment_jobs')
    .update({ state: { ...(data?.state ?? {}), ...patch }, updated_at: new Date().toISOString() })
    .eq('job_id', jobId);
}

/**
 * READ WHAT THE BACKFILL FILED (GET-557).
 *
 * The enricher files a mailbox's history into the timeline; that part is free. Reading a thread
 * into account facts and tasks is the model's work, and for email it only ran from the twice-daily
 * reader, over the last three days. So a 90-day backfill filed three months of email and read
 * three days of it: the backfill credits were never spent, and the history never became facts.
 *
 * Now the job reads the window it filed, newest first, capped at the backfill allowance (a thread
 * is one conversation, CREDIT_SCALE credits). Reads made while the job runs are backfill credits
 * on the billing page. Under the same lock as the daily reader, so the two never read one thread
 * twice; if the daily run holds it, the job says so and the next daily run catches up.
 */
async function readBackfilledEmail(supabase, job) {
  const days = job.window_days ?? 90;
  // What is LEFT of the backfill's allowance after filing (GET-699), not the whole of it: the
  // filing phase already read meetings and calls inside the same window.
  const budget = await backfillCreditState(supabase, job);
  if (budget.gated && budget.remaining <= BACKFILL_CREDIT_FLOOR) {
    await patchJobState(supabase, job.job_id, { reading: { finished: true, paused: 'backfill_allowance' } });
    console.log(`[CONTACT_ENRICH_JOB] email read job=${job.job_id} skipped — backfill allowance spent (${budget.used}/${budget.allowance})`);
    return;
  }
  const maxThreads = budget.gated ? Math.max(1, Math.floor(budget.remaining / CREDIT_SCALE)) : 5000;
  const { readWorkspace } = await import('./emailThreadsDaily.mjs');
  try {
    const stats = await withBackfillLock(supabase, job.workspace_id, 'emailThreads',
      { holder: lockHolder('backfillEmailRead'), leaseMinutes: 240 },
      () => readWorkspace(supabase, job.workspace_id, {
        days, maxThreads,
        // Backfill-window reads are not the month's (GET-515/699), so the month's allowance does
        // not size or stop this batch — only a workspace that is not paying stops it.
        countsAgainstMonth: budget.kind !== 'backfill',
        onProgress: (p) => patchJobState(supabase, job.job_id, { reading: { ...p, at: new Date().toISOString() } }),
      }));
    await patchJobState(supabase, job.job_id, { reading: { total: stats.read + stats.failed + stats.skipped, done: stats.read + stats.failed + stats.skipped, read: stats.read, failed: stats.failed, finished: true, paused: stats.paused ?? null } });
    console.log(`[CONTACT_ENRICH_JOB] email read job=${job.job_id} ${days}d ${JSON.stringify(stats)}`);
  } catch (err) {
    if (err instanceof LockHeldError) {
      await patchJobState(supabase, job.job_id, { reading: { deferred: true } });
      console.log(`[CONTACT_ENRICH_JOB] email read job=${job.job_id} deferred — ${err.message}`);
    } else {
      console.error(`[CONTACT_ENRICH_JOB] email read job=${job.job_id} failed:`, err?.message || err);
    }
  }
}

// Pause the job (not fail) and tell the operator their backfill stalled on credits.
// The in-app status (paused_no_credits + paused_reason) is the primary signal; the email
// is best-effort and no-ops without RESEND_API_KEY.
async function pauseForCredits(supabase, job, phase) {
  await supabase.from('contact_enrichment_jobs').update({
    status: 'paused_no_credits',
    paused_reason: 'no_credits',
    paused_at: new Date().toISOString(),
    ...(phase ? { processed_phase: phase } : {}),
    updated_at: new Date().toISOString(),
  }).eq('job_id', job.job_id);
  console.log(`[CONTACT_ENRICH_JOB] paused job=${job.job_id} — out of credits${phase ? ` (after ${phase})` : ''}`);
  try {
    const { data: m } = await supabase
      .from('workspace_members').select('users:user_id(email)')
      .eq('workspace_id', job.workspace_id).order('created_at', { ascending: true }).limit(1).maybeSingle();
    const to = m?.users?.email;
    if (to) {
      await sendEmail({
        to, tag: 'BACKFILL_PAUSED',
        subject: 'Your Nous history backfill paused',
        text: 'Your history backfill has read as much as your plan covers and paused. Everything it read is saved, and it resumes from where it stopped if more allowance becomes available.',
      });
    }
  } catch (e) { console.warn('[CONTACT_ENRICH_JOB] pause email failed:', e?.message || e); }
}

// The provider's name for the operator: what the reading model runs on.
function providerName() {
  try { const ep = modelEndpoint(); return ep.openRouter ? 'OpenRouter' : ep.host; } catch { return 'your AI provider'; }
}

// Pause (not fail) a backfill whose AI provider keeps failing: out of credit, a bad key, a rate
// limit or an outage (GET-852). Everything read so far is saved; the resume sweep probes the
// provider every few minutes and continues the job once it answers. Reads are deduped (email by
// noema.read, meetings by the claims that cite them), so continuing does not re-read.
async function pauseForProvider(supabase, job, err) {
  const failure = err.failure ?? { message: err.message, reason: 'outage' };
  const now = new Date().toISOString();
  await supabase.from('contact_enrichment_jobs').update({
    status: 'paused_provider',
    paused_reason: failure.reason,
    paused_at: now,
    ...(err.phase ? { processed_phase: err.phase } : {}),
    updated_at: now,
  }).eq('job_id', job.job_id);
  await patchJobState(supabase, job.job_id, {
    provider_error: { reason: failure.reason, message: failure.message, provider: providerName(), phase: err.phase, at: now },
    last_probe_at: now,
  });
  console.log(`[CONTACT_ENRICH_JOB] paused job=${job.job_id} — AI provider ${failure.reason}: ${failure.message}`);
  try {
    const { data: m } = await supabase
      .from('workspace_members').select('users:user_id(email)')
      .eq('workspace_id', job.workspace_id).order('created_at', { ascending: true }).limit(1).maybeSingle();
    const to = m?.users?.email;
    if (to) {
      await sendEmail({
        to, tag: 'BACKFILL_PAUSED_PROVIDER',
        subject: 'Your history backfill paused',
        text: `${providerPauseLine(failure.reason, providerName())} Your history backfill paused so nothing is skipped. Everything it read is saved. Fix it (for example, top up your credit) and the backfill continues by itself within a few minutes, from where it stopped.\n\nThe provider said: ${failure.message}`,
      });
    }
  } catch (e) { console.warn('[CONTACT_ENRICH_JOB] pause email failed:', e?.message || e); }
}

// Continue backfills paused on the provider once it answers again (GET-852). At most one probe a
// tick, and per job only every PROBE_EVERY_MS unless the operator pressed Resume (resume_requested).
async function resumeProviderPausedBackfills(supabase) {
  const { data: paused, error } = await supabase
    .from('contact_enrichment_jobs')
    .select('job_id, paused_at, state')
    .eq('status', 'paused_provider')
    .limit(25);
  if (error || !paused?.length) return;
  const now = Date.now();
  const due = paused.filter((j) => j.state?.resume_requested
    || now - Date.parse(j.state?.last_probe_at ?? j.paused_at ?? 0) >= PROBE_EVERY_MS);
  if (!due.length) return;
  const probe = await probeProvider(createMessage);
  const at = new Date().toISOString();
  for (const job of due) {
    if (probe.ok) {
      await supabase.from('contact_enrichment_jobs')
        .update({ status: 'pending', paused_reason: null, paused_at: null, locked_at: null, attempts: 0, updated_at: at })
        .eq('job_id', job.job_id).eq('status', 'paused_provider');
      await patchJobState(supabase, job.job_id, { provider_error: null, resume_requested: false, last_probe_at: at, provider_resumed_at: at });
      console.log(`[CONTACT_ENRICH_JOB] resumed job=${job.job_id} — AI provider answers again`);
    } else {
      await patchJobState(supabase, job.job_id, {
        resume_requested: false, last_probe_at: at,
        provider_error: { ...(job.state?.provider_error ?? {}), reason: probe.reason, message: probe.message, at },
      });
    }
  }
}

// Resume backfills that paused on credits, once the wallet has recovered (a top-up:
// purchase, auto-top-up, onboarding grant, monthly grant). Runs at the head of every tick,
// so a top-up resumes the backfill within one worker cycle — no separate cron. Idempotent.
async function resumePausedBackfills(supabase) {
  const { data: paused, error } = await supabase
    .from('contact_enrichment_jobs')
    .select('job_id, workspace_id, window_days, state')
    .eq('status', 'paused_no_credits')
    .limit(25);
  if (error) throw error;
  for (const job of paused ?? []) {
    const w = await backfillCreditState(supabase, job);
    if (!w.gated || w.remaining > BACKFILL_CREDIT_FLOOR) {
      await supabase.from('contact_enrichment_jobs')
        .update({ status: 'pending', paused_reason: null, paused_at: null, locked_at: null, updated_at: new Date().toISOString() })
        .eq('job_id', job.job_id).eq('status', 'paused_no_credits');
      console.log(`[CONTACT_ENRICH_JOB] resumed job=${job.job_id} — credits topped up`);
    }
  }
}

export async function processContactEnrichmentJobs() {
  if (running) return;
  running = true;
  const supabase = getSupabaseClient();
  try {
    await resumePausedBackfills(supabase).catch((e) => console.warn('[CONTACT_ENRICH_JOB] resume sweep:', e?.message || e));
    await resumeProviderPausedBackfills(supabase).catch((e) => console.warn('[CONTACT_ENRICH_JOB] provider resume sweep:', e?.message || e));

    const staleLock = new Date(Date.now() - LOCK_STALE_MS).toISOString();
    const { data: jobs, error } = await supabase
      .from('contact_enrichment_jobs')
      .select('job_id, workspace_id, contact_ids, contacts, status, attempts, locked_at, phase, window_days, state')
      .or(`status.eq.pending,and(status.eq.running,locked_at.lt.${staleLock})`)
      .order('created_at', { ascending: true })
      .limit(1);
    // Migration not (fully) applied yet: table missing (42P01/PGRST205) or the
    // `contacts` column missing (42703/PGRST204). No-op quietly until it's run.
    if (['42P01', 'PGRST205', '42703', 'PGRST204'].includes(error?.code)) return;
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

    // ── Credit gate (GET-699) ── A confirmed backfill spends its OWN allowance (the one the api
    // priced it against), never the month's; a job with no backfill window spends the month's,
    // asked of the api. Pre-flight: already at the floor → pause before spending anything. The
    // creditGuard re-checks between the enricher's source phases so a job stops cleanly mid-run
    // instead of overshooting. No limit (Custom) → not gated, and the guard is a no-op.
    const preflight = await backfillCreditState(supabase, job);
    if (preflight.gated && preflight.remaining <= BACKFILL_CREDIT_FLOOR) {
      await pauseForCredits(supabase, job, null);
      return;
    }
    // The provider guard (GET-852): reads that could not reach the model since this job started
    // (or last resumed). Past the threshold the job pauses with the provider's words instead of
    // skipping the rest of the history in silence.
    const providerSince = job.state?.provider_resumed_at ?? job.state?.started_at ?? new Date().toISOString();
    const providerGuard = async (phase) => {
      const f = await providerFailures(supabase, job.workspace_id, providerSince);
      if (f.count >= PROVIDER_FAIL_THRESHOLD) throw new ProviderUnavailable(phase, f.last);
    };
    const creditGuard = async (phase) => {
      const w = await backfillCreditState(supabase, job);
      if (w.gated && w.remaining <= BACKFILL_CREDIT_FLOOR) throw new CreditsExhausted(phase);
      await providerGuard(phase);
    };

    // Prefer the rich payload the import handed over ({id,email,name,...}); it's the
    // only source that covers freshly imported COLD LEADS (not yet in the contacts
    // view). Fall back to bare ids for older jobs.
    const payload = Array.isArray(job.contacts) ? job.contacts : [];
    const contactIds = Array.isArray(job.contact_ids) ? job.contact_ids : (job.contact_ids?.ids || []);
    const input = payload.length ? payload : contactIds;

    try {
      // Dynamic import isolates the heavy enricher (googleapis / imapflow / unipile)
      // from worker BOOT: a problem loading it fails THIS job, not the whole process.
      const { enrichContactHistory } = await import('../services/contactHistoryEnricher.mjs');
      const result = await enrichContactHistory(supabase, job.workspace_id, input, job.job_id, {
        windowDays: job.window_days ?? null,
        // A member's own backfill (GET-571): their connections only, no workspace watermark.
        ownerUserId: job.state?.owner_user_id ?? null,
        creditGuard,
        // A job with no contacts was enqueued deliberately: the graph is empty and a notetaker
        // is connected, so the replay discovers the accounts rather than enriching them. The
        // enqueue side is the only thing that creates such a job, so honouring it here cannot
        // resurrect the old "scan nothing, slowly" path.
        allowEmpty: input.length === 0,
      });
      // Filed; now read it (GET-557). Before the job says done, so the bar and the backfill
      // credits cover the reading, not just the filing.
      await patchJobState(supabase, job.job_id, { filed_at: new Date().toISOString() });
      await providerGuard('filing');
      await readBackfilledEmail(supabase, job);
      // Email that could not be read is left unmarked (the hourly reader retries it), but a job
      // that ran into a dead provider pauses here rather than saying done.
      await providerGuard('reading');
      await supabase.from('contact_enrichment_jobs')
        .update({ status: 'done', done: true, updated_at: new Date().toISOString() })
        .eq('job_id', job.job_id);
      // Advance the backfill watermark: history is covered up to now, so the next run only
      // fetches what's newer than this instead of re-scanning the whole window. Only on a
      // FULL completion — a paused/failed run leaves the watermark where it was.
      //
      // And only when every source READ (GET-552). A run whose Gmail threw still finishes, and it
      // used to stamp the watermark anyway: the next run started from today, so the history that
      // failed could never be read by running the backfill again.
      const failed = result?.failedSources ?? [];
      if (job.state?.owner_user_id) {
        // A member's backfill never moves the workspace watermark (GET-571).
      } else if (failed.length) {
        console.warn(`[CONTACT_ENRICH_JOB] job=${job.job_id} ${failed.join(', ')} failed — watermark not advanced, a re-run reads the whole window`);
      } else {
        await supabase.from('workspaces')
          .update({ history_backfilled_at: new Date().toISOString() })
          .eq('id', job.workspace_id)
          .then(() => {}, () => {});
      }
      console.log(`[CONTACT_ENRICH_JOB] done job=${job.job_id} contacts=${input.length}`);

      // The onboarding payoff. The graph is whole for the first time, so the AGENT writes the
      // two reports — the revenue retrospective and the win/loss read — as documents in their
      // own threads, using the same skills the plugin runs. They used to arrive as an email
      // from a separate code path with its own idea of what a revenue report is; a document in
      // the product can be opened, cited, replied to, and is still there next week.
      //
      // Fire-and-forget: the API returns immediately and runs the agent behind it. Best-effort,
      // and it must never fail the enrichment job.
      try {
        const secret = process.env.WORKER_SECRET;
        if (!secret) {
          console.warn('[CONTACT_ENRICH_JOB] onboarding reports skipped — WORKER_SECRET unset');
        } else {
          const resp = await fetch(`${apiInternalBase()}/api/onboarding/reports`, {
            method: 'POST',
            headers: { 'x-worker-secret': secret, 'content-type': 'application/json' },
            // No user on an enrichment job — the API resolves the workspace's founder as owner.
            body: JSON.stringify({ workspaceId: job.workspace_id }),
          });
          if (!resp.ok) throw new Error(`reports failed: ${resp.status}`);
          console.log(`[CONTACT_ENRICH_JOB] onboarding reports started ws=${job.workspace_id}`);
        }
      } catch (e) {
        console.error('[CONTACT_ENRICH_JOB] onboarding reports failed:', e?.message || e);
      }

      // Rebuild the revenue-concept graph for THIS workspace now that a batch of claims
      // just landed — so the graph's VIEW lenses (Pains, Objections, Stack, …) light up
      // as soon as the enrichment run finishes, not only on the nightly cron. Concept
      // building is cross-account (a concept is shared across ≥2 accounts), so it runs
      // once over the workspace here rather than per-claim. Best-effort; never fails the job.
      try {
        const { computeClaimPatterns } = await import('../computeClaimPatterns.mjs');
        await computeClaimPatterns(supabase, job.workspace_id);
      } catch (e) {
        console.error('[CONTACT_ENRICH_JOB] claim-pattern rebuild failed:', e?.message || e);
      }
    } catch (e) {
      // Out of credits mid-run is a PAUSE, not a failure — save the place and wait for a
      // top-up (the resume sweep re-queues it). Dedup makes the re-run continue, not restart.
      if (e instanceof CreditsExhausted) {
        await pauseForCredits(supabase, job, e.phase);
        return;
      }
      if (e instanceof ProviderUnavailable) {
        await pauseForProvider(supabase, job, e);
        return;
      }
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
