// /api/backfill — what we found, and the yes.
//
// We do not cut the backfill (GET-486). Some teams are more and some are less, and
// trimming it is how a customer's first day ends up half-sized. So instead of guessing a
// size we price the whole thing, show it, and ask — every time, before anything is spent.
//
// Counting the window is a database read, so the estimate costs nothing. That buys the
// only screen in onboarding that can honestly say what is about to happen:
//
//   "We found 3,000 meetings in Fellow, 8,000 email threads across 2,000 accounts.
//    Shall we read them now?"
//
// Over the plan's ceiling the same screen says talk to us instead, which is also the
// moment a large team identifies itself — so the check qualifies as well as protects.

import { Router } from 'express';
import { getSupabaseClient } from '@nous/core';
import { verifySupabaseAuth } from '../../middleware/supabaseAuth.mjs';
import { finishOnboarding } from './onboarding.mjs';
import { AWAITING, startAwaitingBackfill, rememberStartOnPayment, workspacePlanLive, workspaceOnFree, workspacePlanCredits, backfillOwnerFor, ownerJobFilter } from '../../lib/backfillStart.mjs';

export const backfillRouter = Router();

// The job states this flow owns (AWAITING, from backfillStart.mjs). A backfill is written paused
// and stays that way until a person answers: the customer for the ordinary case, us for the big
// ones — and, since GET-549, until the workspace is paying.

/**
 * GET /api/backfill/preview?workspaceId=…
 *
 * What is waiting, what it would read, and whether the customer can start it themselves.
 * Safe to poll: it reads the job row and the counts already attached to it, and never
 * re-prices anything.
 */
backfillRouter.get('/preview', verifySupabaseAuth, async (req, res) => {
  try {
    const workspaceId = req.query.workspaceId;
    if (!workspaceId) return res.status(400).json({ error: 'workspaceId_required' });
    const supabase = getSupabaseClient();

    // The viewer's own backfill: a member's, or the workspace's for the founder (GET-571).
    const owner = await backfillOwnerFor(supabase, workspaceId, req.internalUserId).catch(() => null);
    const { data: job } = await ownerJobFilter(supabase
      .from('contact_enrichment_jobs')
      .select('job_id, status, paused_reason, contact_ids, window_days, created_at, updated_at, done, state')
      .eq('workspace_id', workspaceId), owner)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    // No job at all is not an error — it is the state before anything connected.
    if (!job) return res.json({ state: 'none' });

    // What we found and what reading it costs — the numbers the card says out loud (GET-515).
    const shape = (e) => e ? {
      credits: e.credits, allowance: e.allowance ?? null, basis: e.basis, window_days: e.windowDays ?? null,
      conversations: Object.fromEntries(Object.entries(e.byType ?? {}).map(([k, v]) => [k, v.conversations])),
      // A month of this workspace, ongoing — what the plan recommendation is sized from (GET-549).
      monthly: e.monthly ?? null,
      // People and companies the note-taker's meetings will add that are not on the graph yet:
      // they are created and shown as "Not in CRM" (GET-788).
      discovered: e.discovered ?? null,
    } : null;
    const estimate = shape(job.state?.estimate);
    const estimate30 = shape(job.state?.estimate_30);

    if (job.status !== AWAITING) {
      // Running or done: the card and the sidebar pill say how far it has got (GET-517). Progress
      // is the share of (account × connected source) lanes the worker has finished; `read` is how
      // many conversations it has read since the customer said yes.
      const lanes = (job.state?.contacts ?? []).flatMap(c => Object.values(c?.sources ?? {}))
        .filter(src => src && src.status !== 'skipped');
      const finished = lanes.filter(src => src.status !== 'pending' && src.status !== 'running').length;
      const startedAt = job.state?.started_at ?? null;
      let read = null;
      if (startedAt) {
        const { count } = await supabase.from('observations').select('id', { count: 'exact', head: true })
          .eq('workspace_id', workspaceId).eq('property', 'noema.read').gte('observed_at', startedAt);
        read = count ?? 0;
      }
      // TWO PHASES, ONE BAR (GET-557). Filing pulls the history in (the first 30%); reading turns
      // it into facts, one conversation at a time (the other 70%). The bar used to be the share of
      // (account × source) lanes, which sat at 50% while one bulk Gmail read ran and then jumped.
      const reading = job.state?.reading ?? null;
      const filedPct = lanes.length ? finished / lanes.length : (job.state?.filed_at ? 1 : 0);
      const readPct = reading?.total ? Math.min(1, (reading.done ?? 0) / reading.total) : (reading?.finished ? 1 : 0);
      const phase = job.done ? 'done' : (job.state?.filed_at ? 'reading' : 'filing');
      const pct = job.done ? 100
        : phase === 'reading' ? Math.round(30 + 70 * readPct)
        : Math.round(30 * filedPct);
      return res.json({
        state: job.done ? 'done' : 'running', status: job.status, job_id: job.job_id,
        plan_credits: await workspacePlanCredits(supabase, workspaceId),
        window_days: job.window_days ?? null, started_at: startedAt, finished_at: job.done ? job.updated_at : null,
        estimate,
        progress: {
          finished, total: lanes.length, pct, read, phase,
          to_read: reading?.total ?? null, reading_done: reading?.done ?? null,
        },
      });
    }

    // A backfill already ran here (GET-733): the billing page does not offer another one.
    const { count: ranBefore } = await supabase.from('contact_enrichment_jobs').select('job_id', { count: 'exact', head: true })
      .eq('workspace_id', workspaceId).eq('done', true).not('state->>started_at', 'is', null);
    const state = job.paused_reason === 'over_ceiling' ? 'needs_support'
      : job.paused_reason === 'over_allowance' ? 'over_allowance'
      : 'awaiting_confirmation';
    return res.json({
      state,
      ran_before: (ranBefore ?? 0) > 0,
      // Not paying yet: the card offers the plans instead of the button (GET-549).
      plan_live: await workspacePlanLive(supabase, workspaceId),
      // On Free: the step offers "start free" beside paying now (GET-682).
      on_free: await workspaceOnFree(supabase, workspaceId),
      // What the plan includes a month, to set against the last 30 days (GET-682).
      plan_credits: await workspacePlanCredits(supabase, workspaceId),
      start_on_payment: !!job.state?.start_on_payment,
      job_id: job.job_id,
      accounts: (job.contact_ids ?? []).length,
      window_days: job.window_days ?? 90,
      estimate,
      estimate_30: estimate30,
    });
  } catch (err) {
    console.error('[GET /api/backfill/preview]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

/**
 * POST /api/backfill/confirm { workspaceId }
 *
 * The yes. Flips the waiting job to pending so the worker picks it up on its next tick.
 *
 * Refuses the over-ceiling case deliberately: that job is waiting on a conversation with
 * us, and a customer clicking through a screen that told them to get in touch is not that
 * conversation. Releasing it is an assisted-onboarding action, not a button.
 */
backfillRouter.post('/confirm', verifySupabaseAuth, async (req, res) => {
  try {
    const workspaceId = req.body?.workspaceId;
    if (!workspaceId) return res.status(400).json({ error: 'workspaceId_required' });
    const supabase = getSupabaseClient();

    const short = req.body?.window === 'last_30_days';
    const ownerUserId = await backfillOwnerFor(supabase, workspaceId, req.internalUserId).catch(() => null);

    // PAY FIRST (GET-549). An unpaid workspace's yes is remembered on the job, which keeps
    // waiting; the subscription webhook starts it the moment the plan is live. Without this the
    // worker found no plan, read nothing, and marked the job done.
    if (!(await workspacePlanLive(supabase, workspaceId))) {
      const remembered = await rememberStartOnPayment(supabase, workspaceId, { short, ownerUserId });
      if (!remembered) return res.status(404).json({ error: 'nothing_awaiting_confirmation' });
      return res.status(402).json({ error: 'needs_plan', message: 'Choose a plan and your backfill starts as soon as it is paid.' });
    }

    const r = await startAwaitingBackfill(supabase, workspaceId, { short, ownerUserId });
    if (!r.ok) {
      // Already started — by the payment webhook, usually, a second before the customer came
      // back from Checkout. That is the outcome they asked for, not an error.
      if (r.error === 'already_started' || r.error === 'nothing_awaiting_confirmation') {
        const { data: latest } = await ownerJobFilter(supabase.from('contact_enrichment_jobs')
          .select('job_id, status, window_days, state').eq('workspace_id', workspaceId), ownerUserId)
          .order('created_at', { ascending: false }).limit(1).maybeSingle();
        if (latest?.state?.started_at) {
          finishOnboarding(supabase, req.user, workspaceId).catch(() => {});
          return res.json({ ok: true, job_id: latest.job_id, status: latest.status, window_days: latest.window_days, already: true });
        }
      }
      return res.status(r.status).json({ error: r.error, ...(r.message ? { message: r.message } : {}) });
    }
    const job = { job_id: r.job_id };
    const windowDays = r.window_days;
    console.log(`[BACKFILL_CONFIRM] ws=${workspaceId} job=${job.job_id} started by the customer`);
    // Saying yes to the backfill is the end of onboarding (GET-517).
    finishOnboarding(supabase, req.user, workspaceId).catch(() => {});
    return res.json({ ok: true, job_id: job.job_id, status: 'pending', window_days: windowDays });
  } catch (err) {
    console.error('[POST /api/backfill/confirm]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});
