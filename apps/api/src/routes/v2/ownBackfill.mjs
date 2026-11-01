import { Router } from 'express';
import { getSupabaseClient } from '@nous/core';
import { billingEnabled } from '../../lib/billingHooks.mjs';
import { resolveTeamAndPlan } from '../../lib/access.mjs';
import { isSelfHosted } from '../../lib/plans.mjs';
import { OWN_MODELS, DEFAULT_DAYS, ownBackfillEstimate, ownBackfillRefusal, startOwnBackfill, ownJob, leaseOwnCalls, answerOwnCall } from '../../lib/ownBackfill.mjs';

export const ownBackfillRouter = Router();

// /v2/backfill/own — what `nous backfill` talks to (GET-1085).
//
//   POST /v2/backfill/own/estimate   { days }   what it would read
//   POST /v2/backfill/own            { days }   start it, or pick up where it stopped
//   GET  /v2/backfill/own/:job/calls            the job's state, and model calls to answer
//   POST /v2/backfill/own/calls/:id  { answer, model, usage } or { error }
//
// Per person: a member key, which reads only that member's connections. A workspace key has no
// person, so it can't run one. Trial and paid plans only, asked on every call, so a plan that lapses
// mid-run stops the CLI; the job keeps its place. A read costs no credits, so ops don't apply.

ownBackfillRouter.use(async (req, res, next) => {
  if (!req.memberUserId || req.noContent) return res.status(403).json({ error: 'personal_key_required', message: 'Sign in with `nous login`: a backfill runs for one person.' });
  try {
    if (isSelfHosted() || !billingEnabled()) return next();
    const { subscription } = await resolveTeamAndPlan(req);
    const reason = ownBackfillRefusal(subscription);
    if (reason) return res.status(402).json({ error: 'plan_required', reason, message: 'Your workspace needs an active trial or plan to run a backfill. Nothing is lost: run this again once it has one.' });
    next();
  } catch (err) { next(err); }
});

const daysOf = (v) => {
  const n = Number(v ?? DEFAULT_DAYS);
  return Number.isInteger(n) && n >= 1 && n <= 730 ? n : null;
};

ownBackfillRouter.post('/estimate', async (req, res, next) => {
  try {
    const days = daysOf(req.body?.days);
    if (!days) return res.status(400).json({ error: 'invalid_days' });
    res.json(await ownBackfillEstimate(getSupabaseClient(), req.workspaceId, req.memberUserId, { days }));
  } catch (err) { next(err); }
});

ownBackfillRouter.post('/', async (req, res, next) => {
  try {
    const days = daysOf(req.body?.days);
    if (!days) return res.status(400).json({ error: 'invalid_days' });
    const started = await startOwnBackfill(getSupabaseClient(), req.workspaceId, req.memberUserId, { days });
    res.status(started.resumed ? 200 : 201).json({ ...started, models: OWN_MODELS });
  } catch (err) { next(err); }
});

ownBackfillRouter.get('/:job/calls', async (req, res, next) => {
  try {
    const supabase = getSupabaseClient();
    const job = await ownJob(supabase, req.workspaceId, req.memberUserId, req.params.job);
    if (!job) return res.status(404).json({ error: 'not_found' });
    const calls = job.status === 'own_model_running' ? await leaseOwnCalls(supabase, job.job_id, { limit: Number(req.query.limit) || undefined }) : [];
    res.json({ status: job.status, error: job.error ?? null, reading: job.state?.reading ?? null, models: OWN_MODELS, calls });
  } catch (err) { next(err); }
});

ownBackfillRouter.post('/calls/:id', async (req, res, next) => {
  try {
    const taken = await answerOwnCall(getSupabaseClient(), req.workspaceId, req.memberUserId, req.params.id, req.body ?? {});
    res.json({ taken });   // A late second answer is not an error: the first one stands.
  } catch (err) { next(err); }
});
