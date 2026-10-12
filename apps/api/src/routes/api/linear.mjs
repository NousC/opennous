/**
 * Linear from the app (GET-825). Session auth (verifySupabaseAuth, mounted in index.mjs).
 *
 *   GET  /api/linear/settings?workspaceId=                  the connected Linear workspace, its teams,
 *                                                            the default team (never a token)
 *   PUT  /api/linear/settings?workspaceId= { default_team_id }   owner/admin: where new issues go
 *   POST /api/linear/topics/:key/send?workspaceId= { team_id? }  send one Insights topic to Linear
 *
 * The API plan reaches the same send through POST /v2/insights/topics/:key/linear.
 */

import { Router } from 'express';
import { getSupabaseClient } from '@nous/core';
import { connectForbidden } from '../../providers/sourceScope.mjs';
import { linearConnectionSummary, setLinearDefaultTeam } from '../../providers/linear.mjs';
import { sendTopic } from '../../lib/linearSend.mjs';

export const linearRouter = Router();

const wsOf = (req) => req.query.workspaceId || req.query.workspace_id || req.body?.workspaceId || req.body?.workspace_id;

function sameWorkspace(req, res) {
  const workspaceId = wsOf(req);
  if (!workspaceId) { res.status(400).json({ error: 'workspace_id_required' }); return null; }
  if (req.workspaceId !== workspaceId) { res.status(403).json({ error: 'workspace_not_found_or_unauthorized' }); return null; }
  return workspaceId;
}

linearRouter.get('/settings', async (req, res) => {
  try {
    const workspaceId = sameWorkspace(req, res);
    if (!workspaceId) return;
    const summary = await linearConnectionSummary(getSupabaseClient(), workspaceId);
    return res.json(summary ? { connected: true, ...summary } : { connected: false });
  } catch (err) {
    console.error('[GET /api/linear/settings]', err?.message || err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

linearRouter.put('/settings', async (req, res) => {
  try {
    const workspaceId = sameWorkspace(req, res);
    if (!workspaceId) return;
    const supabase = getSupabaseClient();
    // Changing where issues go is changing the company connection: owners and admins.
    const forbidden = await connectForbidden(supabase, { workspaceId, userId: req.internalUserId, providerName: 'linear' });
    if (forbidden) return res.status(403).json(forbidden);
    const teamId = req.body?.default_team_id;
    if (typeof teamId !== 'string' || !teamId) return res.status(400).json({ error: 'default_team_id_required' });
    try {
      return res.json(await setLinearDefaultTeam(supabase, { workspaceId, teamId }));
    } catch (e) {
      if (e?.code === 'unknown_team') return res.status(400).json({ error: 'unknown_team' });
      if (e?.code === 'linear_not_connected') return res.status(409).json({ error: 'linear_not_connected' });
      throw e;
    }
  } catch (err) {
    console.error('[PUT /api/linear/settings]', err?.message || err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

linearRouter.post('/topics/:key/send', async (req, res) => {
  try {
    const workspaceId = sameWorkspace(req, res);
    if (!workspaceId) return;
    const { status, body } = await sendTopic({
      supabase: getSupabaseClient(), workspaceId, topicKey: req.params.key,
      teamId: typeof req.body?.team_id === 'string' ? req.body.team_id : null, userId: req.internalUserId ?? null,
      viewerId: req.memberUserId ?? req.internalUserId ?? null, isAdmin: req.viewerScope === 'admin',
    });
    return res.status(status).json(body);
  } catch (err) {
    console.error('[POST /api/linear/topics/:key/send]', err?.message || err);
    return res.status(500).json({ error: 'internal_error' });
  }
});
