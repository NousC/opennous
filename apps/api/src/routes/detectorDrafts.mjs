// Internal worker→api endpoint for the detector automations' nightly drafting (GET-685).
//
// Drafting is a model call plus the API's credits gate, metering and member directives, so it
// runs here and the worker only says "now" — the same shape as /internal/motion and
// /internal/routines. Mounted unauthenticated and guarded by WORKER_SECRET.
//
// POST /internal/detector-drafts/tick
//   {}                               every workspace. Answers 202 at once and runs in the
//                                    background (a pass over every workspace outlives an HTTP
//                                    timeout); one pass at a time per process.
//   { workspaceId }                  one workspace, awaited, the summary in the response.
//   { workspaceId, dryRun: true }    detect and plan only: no ledger row, no model call, no draft.
//   { only: ['deal_signal'] }        just those automations (the hourly deal-signal pass, GET-694).
//                                    Safe to run against production to see what tonight would do.
//
// Staged rollout: only workspaces listed in DETECTOR_DRAFTS_WORKSPACES (comma-separated ids, or
// "*") are drafted for; unset = none. The dry run ignores the list (it writes nothing).
// DETECTOR_DRAFTS_DISABLED=1 turns the whole thing off.

import { Router } from 'express';
import { runDetectorDrafts } from '../lib/detectorDrafts.mjs';

export const detectorDraftsInternalRouter = Router();

detectorDraftsInternalRouter.use((req, res, next) => {
  const secret = process.env.WORKER_SECRET;
  if (!secret) return res.status(404).json({ error: 'not_found' });          // feature off
  if (req.get('x-worker-secret') !== secret) return res.status(403).json({ error: 'forbidden' });
  next();
});

let running = null;

detectorDraftsInternalRouter.post('/tick', async (req, res) => {
  const off = /^(1|true|yes)$/i.test(String(process.env.DETECTOR_DRAFTS_DISABLED ?? ''));
  const dryRun = req.body?.dryRun === true;
  if (off && !dryRun) return res.json({ disabled: true });
  const workspaceId = typeof req.body?.workspaceId === 'string' && req.body.workspaceId ? req.body.workspaceId : null;
  const only = Array.isArray(req.body?.only) ? req.body.only.filter((k) => typeof k === 'string') : null;
  try {
    if (workspaceId) {
      const r = await runDetectorDrafts({ onlyWorkspace: workspaceId, dryRun, only });
      return res.json(r);
    }
    if (dryRun) return res.status(400).json({ error: 'workspaceId_required_for_dry_run' });
    if (running) return res.status(202).json({ started: false, running: true });
    running = runDetectorDrafts({ only })
      .then((r) => { console.log(`[detectorDrafts] pass: ${r.drafted} drafted across ${r.workspaces} workspaces, ${r.errors} errors`); })
      .catch((e) => { console.error('[detectorDrafts] pass failed', e?.message); })
      .finally(() => { running = null; });
    return res.status(202).json({ started: true });
  } catch (err) {
    console.error('[POST /internal/detector-drafts/tick]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});
