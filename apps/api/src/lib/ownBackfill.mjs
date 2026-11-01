// A person's history, read on their own Claude or ChatGPT plan (GET-1085). This is the server half
// of `nous backfill`: it starts the job and hands out the model calls the worker is waiting on.
// Nothing here decides what gets read; that stays in the worker's production read.

import { randomUUID } from 'node:crypto';
import { OWN_BACKFILL_OPEN } from '@nous/core';
import { countHistoryToRead } from './historyBackfill.mjs';
import { isNoCardTrial, planMayBackfill, notLiveReason, trialHasEnded } from './plans.mjs';

export const DEFAULT_DAYS = 180;
export const MAX_CONTACTS = 2000;
export const LEASE_MS = 10 * 60_000;
export const MAX_CALLS = 8;

// Chosen by evals (35 cases, 2026-10-30), and sent from here so a new model needs no CLI release.
// A model joins this list only by matching the current pick on the same eval.
export const OWN_MODELS = {
  claude: { model: 'claude-haiku-5-5', effort: 'low' },
  codex: { model: 'gpt-6.1-sol', effort: 'low' },
};

/**
 * Why this subscription can't run a backfill, or null when it can: paid or comped, or on a trial
 * that hasn't ended. A hosted read waits for a payment on a trial (planMayBackfill); this one spends
 * nothing of ours, so a trial may run it. When a trial has ended is trialHasEnded's to say, the same
 * answer planIsLive and the worker get. Free waits for a paid plan, as it does for a hosted backfill. Pure.
 */
export function ownBackfillRefusal(subscription, now = Date.now()) {
  if (trialHasEnded(subscription, now)) return 'trial_ended';
  if (isNoCardTrial(subscription)) return null;
  if (planMayBackfill(subscription)) return null;
  return notLiveReason(subscription) ?? 'needs_plan';
}

/** This person's unfinished own-plan job, or null. */
async function openJob(supabase, workspaceId, ownerUserId) {
  const { data } = await supabase.from('contact_enrichment_jobs')
    .select('job_id, status').eq('workspace_id', workspaceId).in('status', OWN_BACKFILL_OPEN)
    .eq('state->own_model->>owner_user_id', ownerUserId).limit(1).maybeSingle();
  return data ?? null;
}

async function accountsWithEmail(supabase, workspaceId) {
  const { data } = await supabase.from('contacts')
    .select('id, email, first_name, last_name, company, company_id, linkedin_url, linkedin_member_id')
    .eq('workspace_id', workspaceId).not('email', 'is', null).limit(MAX_CONTACTS);
  return (data ?? []).map(c => ({ ...c, email: String(c.email).toLowerCase().trim() }));
}

/** What a backfill would read for this person. Counts only; it reads and spends nothing. */
export async function ownBackfillEstimate(supabase, workspaceId, ownerUserId, { days = DEFAULT_DAYS, count = countHistoryToRead } = {}) {
  const contacts = await accountsWithEmail(supabase, workspaceId);
  const found = await count(supabase, workspaceId, contacts.map(c => c.email), { days, ownerUserId });
  return { days, counts: found.counts, sources: found.sources ?? {} };
}

/** Start this person's backfill, or pick up the one they left. Always their own connections. */
export async function startOwnBackfill(supabase, workspaceId, ownerUserId, { days = DEFAULT_DAYS } = {}) {
  const open = await openJob(supabase, workspaceId, ownerUserId);
  if (open) {
    // Whoever held these is gone: this is the same person starting again. They shouldn't wait out a lease.
    await supabase.from('own_model_calls').update({ status: 'pending', leased_until: null })
      .eq('job_id', open.job_id).eq('status', 'leased');
    if (open.status === 'paused_own_model') {
      await supabase.from('contact_enrichment_jobs')
        .update({ status: 'own_model_pending', paused_reason: null, paused_at: null, updated_at: new Date().toISOString() })
        .eq('job_id', open.job_id).eq('status', 'paused_own_model');
    }
    return { job_id: open.job_id, resumed: true };
  }
  const now = new Date().toISOString();
  const job_id = randomUUID();
  const contacts = await accountsWithEmail(supabase, workspaceId);
  const { error } = await supabase.from('contact_enrichment_jobs').insert({
    job_id, workspace_id: workspaceId, contacts, contact_ids: contacts.map(c => c.id), status: 'own_model_pending',
    phase: 'deep', window_days: days,
    // Not `state.started_at`: that opens a backfill credit window, and reads on this person's own
    // plan aren't credits of any kind, while a teammate's reads meanwhile are still the month's.
    state: { owner_user_id: ownerUserId, confirmed_window_days: days, own_model: { owner_user_id: ownerUserId, started_at: now } },
  });
  if (error) throw error;
  return { job_id, resumed: false };
}

/** The job, if it is this person's. */
export async function ownJob(supabase, workspaceId, ownerUserId, jobId) {
  const { data } = await supabase.from('contact_enrichment_jobs')
    .select('job_id, status, error, state').eq('job_id', jobId).eq('workspace_id', workspaceId).maybeSingle();
  return data?.state?.own_model?.owner_user_id === ownerUserId ? data : null;
}

/** Lease the calls waiting on this person's CLI. A lease that ran out is handed out again. */
export async function leaseOwnCalls(supabase, jobId, { limit = MAX_CALLS, now = Date.now } = {}) {
  const at = new Date(now()).toISOString();
  const { data: rows } = await supabase.from('own_model_calls').select('id, status, feature, request')
    .eq('job_id', jobId).in('status', ['pending', 'leased']).or(`leased_until.is.null,leased_until.lt.${at}`)
    .order('created_at', { ascending: true }).limit(Math.min(limit, MAX_CALLS));
  const calls = [];
  for (const row of rows ?? []) {
    const { data: got } = await supabase.from('own_model_calls')
      .update({ status: 'leased', leased_until: new Date(now() + LEASE_MS).toISOString() })
      .eq('id', row.id).eq('status', row.status).select('id').maybeSingle();
    if (got) calls.push({ id: row.id, feature: row.feature, ...row.request });
  }
  return calls;
}

/** Take an answer, once. Only the person whose call it is can answer it. */
export async function answerOwnCall(supabase, workspaceId, ownerUserId, callId, { answer, model = null, usage = null, error = null }) {
  const failed = !!error || typeof answer !== 'string';
  const { data } = await supabase.from('own_model_calls')
    .update(failed
      ? { status: 'failed', error: String(error ?? 'no answer').slice(0, 500) }
      : { status: 'done', answer, model, usage })
    .eq('id', callId).eq('workspace_id', workspaceId).eq('owner_user_id', ownerUserId).eq('status', 'leased')
    .select('id').maybeSingle();
  return !!data;
}
