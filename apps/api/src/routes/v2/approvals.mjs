// The approvals inbox over the API (GET-713). An automation step that requires approval pauses its
// run; these list what is waiting and decide it, so an API-plan workspace's own agent or tool can be
// the human in the loop. The automation.approval_requested webhook says when something new waits.
//
// GET  /v2/approvals                       → { approvals: [{ run_id, automation, account, step, rows, … }] }
// POST /v2/approvals/:runId/approve        → runs that step and the rest of the automation
// POST /v2/approvals/:runId/reject         → ends the run as rejected
import { Router } from 'express';
import { getSupabaseClient, listAutomationApprovals, decideAutomationRun } from '@nous/core';
import { routineAccess, canSeeRoutineRuns, routineRunGuard } from '../../lib/routineAccess.mjs';

export const approvalsV2Router = Router();

// An owned routine's runs (GET-868, lib/routineAccess.mjs) only for a key whose member may see it;
// deciding one needs what its surface allows. Ordinary automations' approvals are unchanged.
const keyUser = (req) => req.memberUserId ?? req.internalUserId ?? null;
approvalsV2Router.param('runId', routineRunGuard(keyUser));

approvalsV2Router.get('/', async (req, res) => {
  try {
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 100));
    const supabase = getSupabaseClient();
    const [approvals, access] = await Promise.all([
      listAutomationApprovals(supabase, req.workspaceId, { limit }),
      routineAccess(supabase, req.workspaceId, keyUser(req)),
    ]);
    return res.json({ approvals: approvals.filter(a => canSeeRoutineRuns(access, a.automation?.id)) });
  } catch (err) {
    console.error('[GET /v2/approvals]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

for (const decision of ['approve', 'reject']) {
  approvalsV2Router.post(`/:runId/${decision}`, async (req, res) => {
    try {
      // Optional per-item decisions: { decisions: { "<step index>": { approve: true|false, tasks?: [0, 2] } } }.
      const decisions = decision === 'approve' && req.body?.decisions && typeof req.body.decisions === 'object' ? req.body.decisions : null;
      // A key cannot pick a mailbox (GET-745): an email goes from the automation's own sender.
      for (const d of Object.values(decisions ?? {})) if (d?.email && typeof d.email === 'object') delete d.email.from;
      const out = await decideAutomationRun(getSupabaseClient(), req.workspaceId, req.params.runId,
        { approve: decision === 'approve', userId: req.internalUserId ?? null, decisions });
      if (!out.ok) return res.status(out.error === 'not_found' ? 404 : 409).json(out);
      return res.json(out);
    } catch (err) {
      console.error(`[POST /v2/approvals/:runId/${decision}]`, err);
      return res.status(500).json({ error: 'internal_error' });
    }
  });
}
