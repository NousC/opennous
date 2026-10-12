// Starting a confirmed backfill, and the one rule in front of it: a workspace pays before it
// reads (GET-549).
//
// A new signup is 'unpaid' (GET-532). Before this, "Run backfill" flipped the job to pending
// anyway, the worker found no plan, read nothing, and marked the job done — so the customer
// watched a backfill finish having bought nothing and read nothing, and paying afterwards did
// not bring it back. Now the yes is remembered on the job (`start_on_payment`) and the job
// stays waiting; the subscription webhook starts it the moment the plan is live.

import { billingEnabled } from './billingHooks.mjs';
import { planIsLive, planMayBackfill, getPlanFromSubscription } from './plans.mjs';

export const AWAITING = 'paused_awaiting_confirmation';

/**
 * Whose backfill a viewer sees (GET-571). The founder's is the WORKSPACE backfill (no owner on the
 * job): the CRM, their mail and notes. An invited member's is their own (owner_user_id = them):
 * only the connections they made. Founder = a 'founder' or 'owner' row on the workspace's team.
 */
export async function backfillOwnerFor(supabase, workspaceId, userId) {
  if (!userId) return null;
  const { data: ws } = await supabase.from('workspaces').select('team_id').eq('id', workspaceId).maybeSingle();
  if (!ws?.team_id) return null;
  const { data: m } = await supabase.from('team_members').select('role')
    .eq('team_id', ws.team_id).eq('user_id', userId).maybeSingle();
  return m && !['founder', 'owner'].includes(m.role) ? userId : null;
}

/** The latest job that is this owner's — the workspace's when owner is null. */
export function ownerJobFilter(query, ownerUserId) {
  return ownerUserId ? query.eq('state->>owner_user_id', ownerUserId) : query.is('state->>owner_user_id', null);
}

/**
 * Whether this workspace may run its history backfill: paying, or comped (GET-682). Free reads
 * new conversations but its backfill waits for a paid plan. Always true where billing is off.
 */
export async function workspacePlanLive(supabase, workspaceId) {
  if (!billingEnabled()) return true;
  const sub = await workspaceSubscription(supabase, workspaceId);
  return planMayBackfill(sub);
}

/** Whether this workspace is on the Free plan (GET-682). */
export async function workspaceOnFree(supabase, workspaceId) {
  const sub = await workspaceSubscription(supabase, workspaceId);
  return !!sub && planIsLive(sub) && !sub.is_comp && String(sub.plan_id ?? '').toLowerCase() === 'free';
}

/**
 * The credits a month this workspace's plan includes, when it is paying (GET-682) — what the
 * panel compares the last 30 days against. Null on Free, unpaid or an unlimited plan.
 */
export async function workspacePlanCredits(supabase, workspaceId) {
  const sub = await workspaceSubscription(supabase, workspaceId);
  if (!sub || !planMayBackfill(sub) || sub.is_comp) return null;
  return getPlanFromSubscription(sub)?.aiCreditsPerMonth ?? null;
}

async function workspaceSubscription(supabase, workspaceId) {
  const { data: ws } = await supabase.from('workspaces').select('team_id').eq('id', workspaceId).maybeSingle();
  if (!ws?.team_id) return null;
  const { data: sub } = await supabase.from('subscriptions').select('*').eq('team_id', ws.team_id).maybeSingle();
  return sub;
}

/**
 * Flip the workspace's waiting backfill to pending. Guarded on the status it was read in, so
 * two clicks, or a click and the webhook, cannot start two backfills.
 *
 * Returns { ok, job_id, window_days } or { ok: false, status, error, message }.
 */
export async function startAwaitingBackfill(supabase, workspaceId, { short = false, ownerUserId = null } = {}) {
  const { data: job } = await ownerJobFilter(supabase
    .from('contact_enrichment_jobs')
    .select('job_id, status, paused_reason, window_days, state')
    .eq('workspace_id', workspaceId)
    .eq('status', AWAITING), ownerUserId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!job) return { ok: false, status: 404, error: 'nothing_awaiting_confirmation' };
  if (job.paused_reason === 'over_ceiling') {
    return { ok: false, status: 409, error: 'needs_support', message: 'This import is larger than onboarding runs on its own.' };
  }
  if (job.paused_reason === 'over_allowance' && !short) {
    return { ok: false, status: 409, error: 'over_allowance', message: 'Three months is over the backfill allowance; the last 30 days fits.' };
  }
  const windowDays = short ? 30 : (job.window_days ?? 90);
  const now = new Date().toISOString();
  const { start_on_payment: _drop, ...state } = job.state ?? {};

  // `started_at` opens the backfill-credits window on the billing page: reads made while this
  // job runs are backfill credits, not the month's.
  const { data: started } = await supabase
    .from('contact_enrichment_jobs')
    .update({
      status: 'pending', paused_reason: null, paused_at: null, updated_at: now, window_days: windowDays,
      state: { ...state, started_at: now, confirmed_window_days: windowDays },
    })
    .eq('job_id', job.job_id)
    .eq('status', AWAITING)
    .select('job_id')
    .maybeSingle();

  if (!started) return { ok: false, status: 409, error: 'already_started' };
  return { ok: true, job_id: job.job_id, window_days: windowDays };
}

/** Remember the yes on the waiting job, so paying starts it without asking again. */
export async function rememberStartOnPayment(supabase, workspaceId, { short = false, ownerUserId = null } = {}) {
  const { data: job } = await ownerJobFilter(supabase
    .from('contact_enrichment_jobs')
    .select('job_id, state')
    .eq('workspace_id', workspaceId)
    .eq('status', AWAITING), ownerUserId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!job) return false;
  await supabase.from('contact_enrichment_jobs')
    .update({ state: { ...(job.state ?? {}), start_on_payment: { short, at: new Date().toISOString() } } })
    .eq('job_id', job.job_id)
    .eq('status', AWAITING);
  return true;
}

/**
 * A PAYMENT STARTS THE BACKFILL (GET-549, GET-682). Called from the subscription webhook.
 *
 *   firstPayment  the team just became paying (from Free, unpaid or canceled). Every backfill
 *                 waiting on this team starts — the founder's and each member's — whether or not
 *                 they clicked "start free", and a workspace with tools connected whose backfill
 *                 never ran gets one made and started. Paying is the yes.
 *   otherwise     a renewal or a bundle change: only a backfill explicitly parked for the payment
 *                 (start_on_payment) starts. Nothing else re-runs.
 *
 * Every one is RE-COUNTED first: a Free workspace can wait months, and both the backfill-credit
 * check and the plan-fit numbers the panel shows must be today's. Over the pool, it reads the
 * last 30 days (the panel's own fallback) and says so; over the ceiling, it waits for us.
 * Never throws — a webhook that fails here would be retried and re-sync the subscription for nothing.
 */
export async function startBackfillsOnPayment(supabase, teamId, { firstPayment = false, enqueue = null } = {}) {
  try {
    // `enqueue` is injectable so the tests can run this without the whole pricing path.
    const enqueueWorkspaceHistoryBackfill = enqueue ?? (await import('./historyBackfill.mjs')).enqueueWorkspaceHistoryBackfill;
    const { data: wss } = await supabase.from('workspaces').select('id').eq('team_id', teamId);
    for (const { id } of wss ?? []) {
      const { data: waiting } = await supabase.from('contact_enrichment_jobs')
        .select('job_id, state, paused_reason').eq('workspace_id', id).eq('status', AWAITING);
      const owners = [...new Set((waiting ?? []).map(j => j.state?.owner_user_id ?? null))];
      if (firstPayment && !owners.includes(null)) {
        const { count } = await supabase.from('contact_enrichment_jobs')
          .select('job_id', { count: 'exact', head: true })
          .eq('workspace_id', id).is('state->>owner_user_id', null).not('state->>started_at', 'is', null);
        if (!count) owners.push(null);   // never backfilled: make it now
      }
      for (const owner of owners) {
        const parked = (waiting ?? []).find(j => (j.state?.owner_user_id ?? null) === owner);
        if (!firstPayment && !parked?.state?.start_on_payment) continue;
        // Today's numbers: re-prices the waiting job in place, or makes it.
        await enqueueWorkspaceHistoryBackfill(supabase, id, { ownerUserId: owner, reason: 'payment' });
        const { data: fresh } = await ownerJobFilter(supabase.from('contact_enrichment_jobs')
          .select('job_id, state, paused_reason').eq('workspace_id', id).eq('status', AWAITING), owner)
          .order('created_at', { ascending: false }).limit(1).maybeSingle();
        if (!fresh) continue;
        if (fresh.paused_reason === 'over_ceiling') {
          console.log(`[BACKFILL_ON_PAYMENT] ws=${id} owner=${owner ?? 'workspace'} too big for self-serve — waiting for us`);
          continue;
        }
        const short = fresh.paused_reason === 'over_allowance' || !!parked?.state?.start_on_payment?.short;
        const r = await startAwaitingBackfill(supabase, id, { short, ownerUserId: owner });
        if (!r.ok) continue;
        console.log(`[BACKFILL_ON_PAYMENT] ws=${id} owner=${owner ?? 'workspace'} job=${r.job_id} started (${r.window_days}d)${short ? ' — over the backfill credits, last 30 days' : ''}`);
        if (!owner) {
          await supabase.from('workspaces')
            .update({ onboarding_completed_at: new Date().toISOString(), onboarding_activated_at: new Date().toISOString() })
            .eq('id', id).is('onboarding_completed_at', null);
        }
      }
    }
  } catch (err) {
    console.warn('[BACKFILL_ON_PAYMENT] failed:', err?.message || err);
  }
}
