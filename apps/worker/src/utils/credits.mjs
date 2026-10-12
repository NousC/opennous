// Worker-side credit state for a history backfill (GET-699).
//
// A backfill is NOT the month's. Reads made while a backfill runs are backfill credits: the
// billing page shows them apart against the plan's backfill allowance and never counts them
// against the month (GET-515, getTeamAiCredits in apps/api/src/lib/plans.mjs). This used to
// gate the backfill on a hardcoded 2,000-a-month wallet and counted the backfill's own reads
// against it, so a paid backfill paused as paused_no_credits around 2,000 credits whatever the
// customer had bought, and its reads looked like the month's.
//
// Now there are two cases, and neither needs a copy of the plan table:
//
//   A confirmed backfill (state.started_at). Its allowance is the one the api priced it against
//   when it was enqueued — state.estimate.allowance, what was left of the plan's backfill pool
//   (backfillAllowanceForPlan in apps/api/src/lib/backfillBudget.mjs; null = no limit). Its use
//   is the reads inside its own window, counted the way the billing page counts them. The
//   month's reads do not touch it, and it does not touch the month.
//
//   A job with no window (a CSV import's enrichment). Its reads DO count against the month, so
//   the month's gate decides — asked of the api (lib/creditGate.mjs), which knows the real plan
//   and tier, instead of a number kept in step by hand.
//
// Fails OPEN on a transient error, as before: a balance read that hiccups must not wedge a
// backfill. The read gate in front of every conversation still applies.

import { conversationCredits } from '@nous/core';
import { mayReadWorkspace } from '../lib/creditGate.mjs';

/** A backfill window closes thirty days after it opened — the api's rule (getTeamAiCredits). */
export const BACKFILL_WINDOW_MAX_DAYS = 30;

const OPEN = Object.freeze({ gated: false, remaining: Infinity, allowance: null, used: 0, kind: null });

/** The window a confirmed job's reads count as backfill in, or null when it has none (any more). */
export function backfillWindowOf(job, now = Date.now()) {
  const from = job?.state?.started_at;
  const start = from ? Date.parse(from) : NaN;
  if (!Number.isFinite(start)) return null;
  const close = start + BACKFILL_WINDOW_MAX_DAYS * 86_400_000;
  if (now > close) return null; // past it, reads are the month's again
  return { from: new Date(start).toISOString(), to: new Date(now).toISOString() };
}

/** The allowance the api priced this job against: a number, null (no limit), or undefined (not priced). */
export function backfillAllowanceOf(job) {
  const window = job?.state?.confirmed_window_days ?? job?.window_days ?? null;
  const e = (window === 30 && job?.state?.estimate_30) ? job.state.estimate_30 : job?.state?.estimate;
  if (!e || !Object.hasOwn(e, 'allowance')) return undefined;
  return e.allowance === null ? null : Number(e.allowance);
}

/**
 * { gated, remaining, allowance, used, kind } for one enrichment job. `gated` false means do not
 * stop it on credits. `kind` is 'backfill' (its own allowance) or 'month' (the month's gate).
 */
export async function backfillCreditState(supabase, job, deps = {}) {
  const count = deps.conversationCredits ?? conversationCredits;
  const gate = deps.mayReadWorkspace ?? mayReadWorkspace;
  if (!job?.workspace_id) return { ...OPEN };
  try {
    const window = backfillWindowOf(job, deps.now ?? Date.now());
    if (window) {
      const allowance = backfillAllowanceOf(job);
      if (allowance === null) return { ...OPEN, kind: 'backfill' };     // no limit (Custom)
      if (allowance === undefined || !Number.isFinite(allowance)) {
        console.warn(`[credits.backfill] job=${job.job_id} has no priced allowance, not gating`);
        return { ...OPEN, kind: 'backfill' };
      }
      const used = (await count(supabase, [job.workspace_id], window.from, null, [window])).backfill;
      return { gated: true, remaining: Math.max(0, allowance - used), allowance, used, kind: 'backfill' };
    }
    // No window: these reads are the month's, so the month's gate (the real plan) decides.
    const g = await gate(job.workspace_id, { fresh: true });
    if (!g.allowed) return { gated: true, remaining: 0, allowance: null, used: 0, kind: 'month' };
    if (typeof g.untilStop === 'number') return { gated: true, remaining: g.untilStop, allowance: null, used: 0, kind: 'month' };
    return { ...OPEN, kind: 'month' };
  } catch (e) {
    console.warn('[credits.backfill] read failed, not gating:', e?.message || e);
    return { ...OPEN };
  }
}

// The floor at which we stop starting/continuing a backfill. A small buffer above zero
// so we don't push a wallet negative on the batch that tips it over.
export const BACKFILL_CREDIT_FLOOR = 5;

// Thrown by the credit guard mid-run so the job runner can mark the job paused (not failed).
export class CreditsExhausted extends Error {
  constructor(phase) { super('credits_exhausted'); this.name = 'CreditsExhausted'; this.phase = phase || null; }
}
