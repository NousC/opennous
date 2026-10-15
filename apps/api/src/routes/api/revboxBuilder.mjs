// The RevBox Job Builder's chat (GET-868, docs/revboxes/JOB_BUILDER.md "Events").
//
//   POST /api/revboxes/:id/builder                     { message, job_id? }      new session, SSE
//   POST /api/revboxes/:id/builder                     { job_id } (no message)   Edit: JSON, below
//   POST /api/revboxes/:id/builder                     { builtin } (no message)  a built-in job's chat: JSON (GET-902)
//   POST /api/revboxes/:id/builder/:sessionId          { message } | { answers } | { retry: true }  continue, SSE
//   POST /api/revboxes/:id/builder/:sessionId/approve  { name? }                 -> { routine, enabled, reason?, facts?, warnings? }
//
// Open a job's chat (GET-868 polish, GET-889): `{ job_id }` with no message opens the person's own
// chat on that job: their open session on it, reused as it is (every turn so far in `history`), or,
// when they have none open, one seeded from their last chat or the job's approved setup. Answered 201
// JSON { session_id, job_id, history, proposal } (no stream, no model call). The next turn POSTs to
// /builder/:sessionId as usual, and approving it updates the same job. `{ retry: true }` runs a turn
// that got no answer (provider error, closed tab) again; its message is already saved.
//
// A built-in job's chat (GET-902): `{ builtin: key }` with no message opens the person's chat on that
// built-in in this box (reused, or a new one seeded with its card; never a routine, so approve can
// only create a new job), answered 201 JSON { session_id, builtin, history }. `{ builtin, message }`
// opens it and runs the turn in one go. The next turn POSTs to /builder/:sessionId as usual.
//
// Mounted by index.mjs (every edition, GET-905) on /api/revboxes with verifySupabaseAuth + requireFeature('revboxes'),
// after the public revboxes router, which has no /:id/builder routes and so passes these through.
//
// SSE over POST, as the playground's /chat/stream: `data: <json>\n\n` per event, flushed past
// compression, a keepalive comment every 15s. Everything that can fail with a status (bad input,
// no access, closed session) fails BEFORE the headers go out, as plain JSON.
import { Router } from 'express';
import { getSupabaseClient } from '@nous/core';
import { jobBuilder as defaultBuilder, turnInput } from '../../lib/jobBuilder/index.mjs';
import { resolveTeamAndPlan } from '../../lib/access.mjs';
import { automationLimitHit } from './automations.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const badRequest = (status, code, message) => Object.assign(new Error(message), { status, code });

/** One SSE frame. Exported for the framing test. */
export function sseFrame(event) { return `data: ${JSON.stringify(event)}\n\n`; }

// Known failures carry a status and a message written for the user; anything else is a generic 500.
function jsonError(res, err) {
  if (!err.status) console.error('[revbox-builder]', err?.message ?? 'unknown error');
  // { error: what to show, code: what it was }: the UI turns it into one error event.
  return res.status(err.status ?? 500).json(err.status
    ? { error: err.message, code: err.code ?? (err.status === 402 ? 'insufficient_credits' : 'request_failed') }
    : { error: 'The job builder hit an error.', code: 'internal_error' });
}

/** Write a turn's events as SSE. Resolves when the stream is closed. */
export async function streamEvents(res, events, { heartbeatMs = 15_000 } = {}) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const send = (event) => {
    if (res.writableEnded) return;
    res.write(sseFrame(event));
    if (typeof res.flush === 'function') res.flush();
  };
  const heartbeat = setInterval(() => {
    if (!res.writableEnded) { res.write(': keepalive\n\n'); if (typeof res.flush === 'function') res.flush(); }
  }, heartbeatMs);
  try {
    for await (const event of events) send(event);
  } catch {
    send({ type: 'error', code: 'builder_failed', message: 'The job builder hit an error.' });
    send({ type: 'done' });
  } finally {
    clearInterval(heartbeat);
    if (!res.writableEnded) res.end();
  }
}

/** Approve's answer: the routine, whether it is on, and why not. Shared with /v2. */
export function approveBody(out) {
  return {
    routine: out?.routine ?? null,
    ...(typeof out?.enabled === 'boolean' ? { enabled: out.enabled } : {}),
    ...(out?.reason ? { reason: out.reason } : {}),
    ...(Array.isArray(out?.facts) ? { facts: out.facts } : {}),
    ...(Array.isArray(out?.warnings) && out.warnings.length ? { warnings: out.warnings } : {}),
    // GET-874: the tables approve created or reused, and the session the chat goes on in for the next job.
    ...(Array.isArray(out?.datasets) && out.datasets.length ? { datasets: out.datasets } : {}),
    ...(out?.next_session_id ? { next_session_id: out.next_session_id, next_jobs: Array.isArray(out.next_jobs) ? out.next_jobs : [] } : {}),
  };
}
/** Edit's answer: the new session and the chat it continues. Shared with /v2. */
export function editBody(out, jobId) {
  return { session_id: out.session.id, job_id: out.session.job_id ?? jobId, history: out.history ?? [], proposal: out.session.proposal ?? null };
}

const BUILTIN_KEY = /^[a-z_]{1,40}$/;
/** The body's built-in key, checked for shape (the box's own list decides), or null. */
function builtinKeyOf(body) {
  const key = body?.builtin;
  if (key == null) return null;
  if (typeof key !== 'string' || !BUILTIN_KEY.test(key)) throw badRequest(400, 'invalid_builtin', 'Choose a built-in job.');
  return key;
}
/** A built-in chat's answer: the session, which built-in, and the chat so far (its card first). */
export function builtinBody(out, key) {
  return { session_id: out.session.id, builtin: key, history: out.history ?? [] };
}

export function makeRevboxBuilderRouter({ builder = defaultBuilder, getSb = getSupabaseClient } = {}) {
  const router = Router();
  const guard = (req) => {
    if (!req.workspaceId || !req.internalUserId) throw badRequest(400, 'workspace_required', 'Workspace and signed-in member are required.');
    if (Object.values(req.params).some(id => !UUID.test(id))) throw badRequest(400, 'invalid_id', 'Invalid identifier.');
  };

  const turn = (fresh) => async (req, res) => {
    const abort = new AbortController();
    try {
      guard(req);
      if (fresh && isEditOpen(req.body)) return await openEdit(req, res);
      if (fresh && isBuiltinOpen(req.body)) return await openBuiltin(req, res);
      const input = turnInput(req.body);
      if (fresh && (input.answers || input.retry)) throw badRequest(400, 'message_required', 'A new session starts with a message.');
      const jobId = fresh ? req.body?.job_id ?? null : null;
      if (jobId !== null && (typeof jobId !== 'string' || !UUID.test(jobId))) throw badRequest(400, 'invalid_id', 'Invalid job identifier.');
      const sb = getSb();
      const base = { sb, workspaceId: req.workspaceId, userId: req.internalUserId, revboxId: req.params.id };
      const builtinKey = fresh ? builtinKeyOf(req.body) : null;
      if (builtinKey && jobId) throw badRequest(400, 'invalid_builtin', 'A chat is about a job or a built-in job, not both.');
      const opened = builtinKey
        ? { session: (await builder.openForBuiltin({ ...base, key: builtinKey })).session, isNew: true }
        : await builder.openSession({ ...base, sessionId: fresh ? null : req.params.sessionId, jobId });
      // They closed the tab: stop the loop between rounds (the transcript is still saved).
      res.on('close', () => { if (!res.writableFinished) abort.abort(); });
      await streamEvents(res, builder.runTurn({ ...base, ...opened, ...input, signal: abort.signal }));
    } catch (err) {
      if (res.headersSent) { if (!res.writableEnded) res.end(); return; }
      return jsonError(res, err);
    }
  };

  /** Edit: { job_id } and nothing to say yet. */
  const isEditOpen = (body) => !!body && body.job_id != null && body.message === undefined && body.answers === undefined;
  async function openEdit(req, res) {
    const jobId = req.body.job_id;
    if (typeof jobId !== 'string' || !UUID.test(jobId)) throw badRequest(400, 'invalid_id', 'Invalid job identifier.');
    const out = await builder.openForJob({ sb: getSb(), workspaceId: req.workspaceId, userId: req.internalUserId, revboxId: req.params.id, jobId });
    res.status(201).json(editBody(out, jobId));
  }

  /** A built-in job's chat (GET-902): { builtin } and nothing to say yet. */
  const isBuiltinOpen = (body) => !!body && body.builtin != null && body.message === undefined && body.answers === undefined && body.job_id == null;
  async function openBuiltin(req, res) {
    const key = builtinKeyOf(req.body);
    const out = await builder.openForBuiltin({ sb: getSb(), workspaceId: req.workspaceId, userId: req.internalUserId, revboxId: req.params.id, key });
    res.status(201).json(builtinBody(out, key));
  }

  router.post('/:id/builder', turn(true));
  router.post('/:id/builder/:sessionId', turn(false));
  router.post('/:id/builder/:sessionId/approve', async (req, res) => {
    try {
      guard(req);
      const name = req.body?.name;
      if (name !== undefined && name !== null && typeof name !== 'string') throw badRequest(400, 'invalid_name', 'name must be text.');
      const sb = getSb();
      // { excludeId } for an Edit of a job that stays on, as the enable endpoint (review 6).
      const limitHit = async (opts = {}) => automationLimitHit(sb, req.workspaceId, (await resolveTeamAndPlan(req)).plan.id, opts);
      const out = await builder.approve({ sb, workspaceId: req.workspaceId, userId: req.internalUserId, revboxId: req.params.id, sessionId: req.params.sessionId, name, limitHit });
      res.json(approveBody(out));
    } catch (err) { return jsonError(res, err); }
  });
  return router;
}

export const revboxBuilderRouter = makeRevboxBuilderRouter();
