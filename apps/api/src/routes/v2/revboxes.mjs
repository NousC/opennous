// /v2/revboxes — RevBoxes over the public API (GET-868 part 4, docs/revboxes/JOB_BUILDER.md).
//
//   GET  /v2/revboxes                                     the boxes this key's member can see
//   GET  /v2/revboxes/:id                                 one box: objective, context titles, jobs
//   POST /v2/revboxes/:id/jobs/builder                    { session_id?, job_id?, message | answers }
//        -> { session_id, events, state: asking|proposed|text, questions?, proposal? }
//   POST /v2/revboxes/:id/jobs/builder                    { job_id } (no message): Edit
//        -> 201 { session_id, job_id, history, proposal }  a new session on the job, seeded with its
//           last approved chat; continue it with { session_id, message }
//   POST /v2/revboxes/:id/jobs/builder/:sessionId/approve { name? } -> { routine, enabled, reason? }
//        approving switches the job on; when a check (credits, plan limit) fails it is saved off and
//        `reason` says why
//        GET-874: `datasets` (tables created or reused) and, when the proposal named next_jobs,
//        `next_session_id` + `next_jobs`: post the next message with session_id = next_session_id
//
// The builder is the in-app Job Builder, non-streaming: the same turn, its events collected. It runs
// on our model bill, so it is Cloud's (cloud/lib/jobBuilder/); Cloud registers it at boot through
// registerJobBuilder, as it registers the routine runner for /v2/workflows. Without the Cloud layer
// (self-host) the builder routes answer 501 job_builder_unavailable; the reads still work.
//
// A RevBox belongs to a person (owner, editors, viewers), so these act as the key's member. A
// workspace-level key with no member answers 403 member_key_required.
import { Router } from 'express';
import { getSupabaseClient, listRevboxes, revboxDetails } from '@nous/core';
import { resolveTeamAndPlan } from '../../lib/access.mjs';
import { automationLimitHit } from '../api/automations.mjs';

let jobBuilder = null;
/** Cloud's builder: { openSession, runTurn, approve, openForJob, turnInput, collectTurn }. */
export function registerJobBuilder(impl) { jobBuilder = impl; }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function makeRevboxesV2Router({ getSb = getSupabaseClient, builder = () => jobBuilder } = {}) {
  const router = Router();

  const route = (fn) => async (req, res) => {
    try {
      if (Object.values(req.params).some(id => !UUID.test(id))) return res.status(400).json({ error: 'invalid_id' });
      if (!req.memberUserId) return res.status(403).json({ error: 'member_key_required', message: 'Use an API key that belongs to a workspace member; RevBoxes are shared per person.' });
      await fn(req, res, getSb());
    } catch (err) {
      if (err.code === '42P01' || err.code === 'PGRST205') return res.status(409).json({ error: 'migration_missing' });
      if (!err.status) console.error('[v2/revboxes]', err?.message ?? 'unknown error');
      res.status(err.status ?? 500).json(err.status ? { error: err.code && typeof err.code === 'string' ? err.code : 'request_failed', message: err.message } : { error: 'internal_error' });
    }
  };
  const needBuilder = (res) => {
    const b = builder();
    if (!b) { res.status(501).json({ error: 'job_builder_unavailable', message: 'The Job Builder runs on OpenNous Cloud only.' }); return null; }
    return b;
  };

  router.get('/', route(async (req, res, sb) => {
    const boxes = await listRevboxes(sb, req.workspaceId, req.memberUserId);
    res.json({ data: boxes.map(b => ({ id: b.id, name: b.name, objective: b.objective ?? null, access: b.access, updated_at: b.updated_at ?? null })) });
  }));

  router.get('/:id', route(async (req, res, sb) => {
    const { box, context, jobs } = await revboxDetails(sb, req.workspaceId, req.memberUserId, req.params.id);
    res.json({
      id: box.id, name: box.name, objective: box.objective ?? null, blocks: box.blocks ?? [], scope: box.scope ?? null,
      delivery: box.delivery ?? [], access: box.access ?? null,
      // Titles only: a linked document's body is read with the document's own visibility, in-app.
      context: (context ?? []).map(c => ({ id: c.id, title: c.title ?? null, document_id: c.document_id ?? null })),
      jobs: (jobs ?? []).map(j => ({ id: j.id, name: j.name ?? j.title ?? null, enabled: j.enabled ?? null, state: j.state ?? null })),
    });
  }));

  router.post('/:id/jobs/builder', route(async (req, res, sb) => {
    const b = needBuilder(res); if (!b) return;
    const sessionId = req.body?.session_id ?? null;
    if (sessionId !== null && (typeof sessionId !== 'string' || !UUID.test(sessionId))) return res.status(400).json({ error: 'invalid_id' });
    const jobId = sessionId ? null : req.body?.job_id ?? null;
    if (jobId !== null && (typeof jobId !== 'string' || !UUID.test(jobId))) return res.status(400).json({ error: 'invalid_id' });
    const base = { sb, workspaceId: req.workspaceId, userId: req.memberUserId, revboxId: req.params.id };
    // Edit: the job's own chat again, as the app's POST /api/revboxes/:id/builder { job_id } does.
    if (jobId && req.body?.message === undefined && req.body?.answers === undefined) {
      if (typeof b.openForJob !== 'function') return res.status(501).json({ error: 'job_builder_unavailable', message: 'Editing a job in the builder is not available on this build.' });
      const out = await b.openForJob({ ...base, jobId });
      return res.status(201).json({ session_id: out.session.id, job_id: out.session.job_id ?? jobId, history: out.history ?? [], proposal: out.session.proposal ?? null });
    }
    const input = b.turnInput(req.body);
    if (!sessionId && (input.answers || input.retry)) return res.status(400).json({ error: 'message_required', message: 'A new session starts with a message.' });
    const opened = await b.openSession({ ...base, sessionId, jobId });
    const events = [];
    for await (const e of b.runTurn({ ...base, ...opened, ...input })) events.push(e);
    const out = b.collectTurn(events);
    out.session_id ??= opened.session.id;
    const status = !out.error ? 200 : out.error.code === 'insufficient_credits' ? 402 : ['session_conflict', 'nothing_to_retry'].includes(out.error.code) ? 409 : 502;
    res.status(status).json(out);
  }));

  router.post('/:id/jobs/builder/:sessionId/approve', route(async (req, res, sb) => {
    const b = needBuilder(res); if (!b) return;
    const name = typeof req.body?.name === 'string' ? req.body.name : null;
    // The plan's automation limit, exactly as on the app route.
    // An Edit of a job that stays on passes { excludeId } (review 6), as the enable endpoint.
    const limitHit = async (opts = {}) => automationLimitHit(sb, req.workspaceId, (await resolveTeamAndPlan(req)).plan.id, opts);
    const out = await b.approve({ sb, workspaceId: req.workspaceId, userId: req.memberUserId, revboxId: req.params.id, sessionId: req.params.sessionId, name, limitHit });
    // As the app route's approveBody (cloud/routes/api/revboxBuilder.mjs; public code cannot import it).
    res.json({
      routine: out?.routine ?? null,
      ...(typeof out?.enabled === 'boolean' ? { enabled: out.enabled } : {}),
      ...(out?.reason ? { reason: out.reason } : {}),
      ...(Array.isArray(out?.facts) ? { facts: out.facts } : {}),
      ...(Array.isArray(out?.warnings) && out.warnings.length ? { warnings: out.warnings } : {}),
      // GET-874: the tables approve created or reused, and the session the chat goes on in for the next job.
      ...(Array.isArray(out?.datasets) && out.datasets.length ? { datasets: out.datasets } : {}),
      ...(out?.next_session_id ? { next_session_id: out.next_session_id, next_jobs: Array.isArray(out.next_jobs) ? out.next_jobs : [] } : {}),
    });
  }));

  return router;
}

export const revboxesV2Router = makeRevboxesV2Router();
