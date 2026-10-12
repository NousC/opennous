/**
 * Connect Linear (GET-825).
 *
 *   GET /api/workflow-providers/linear/oauth/authorize?workspace_id=   → { authUrl }   (owner/admin)
 *   GET /api/workflow-providers/linear/oauth/callback                  ← Linear's redirect (no session)
 *
 * Mounted BEFORE the generic authed /api/workflow-providers mount (index.mjs): the callback
 * carries no session, and the authed mount would answer it with auth_required first.
 *
 * Like Slack, the callback finishes the connection itself. The state is bound to the owner or
 * admin who started the flow and the workspace they started it in, and works once.
 */

import { Router } from 'express';
import { getSupabaseClient } from '@nous/core';
import { verifySupabaseAuth } from '../../middleware/supabaseAuth.mjs';
import { connectForbidden } from '../../providers/sourceScope.mjs';
import { auditLog } from '../../lib/audit.mjs';
import {
  linearConfigured, createLinearState, consumeLinearState, buildLinearAuthUrl, completeLinearConnection,
} from '../../providers/linear.mjs';
import { appUrl } from '../../lib/linearSend.mjs';

export const oauthLinearRouter = Router();

const done = (params) => `${appUrl()}/oauth-callback.html?${new URLSearchParams(params)}`;

oauthLinearRouter.get('/authorize', verifySupabaseAuth, async (req, res) => {
  const workspaceId = req.query.workspace_id || req.query.workspaceId;
  if (!workspaceId) return res.status(400).json({ error: 'workspace_id_required' });
  if (req.workspaceId && req.workspaceId !== workspaceId) return res.status(403).json({ error: 'workspace_not_found_or_unauthorized' });
  // A company tool: owners and admins connect it (GET-232).
  const forbidden = await connectForbidden(getSupabaseClient(), { workspaceId, userId: req.internalUserId, providerName: 'linear' });
  if (forbidden) return res.status(403).json(forbidden);
  if (!linearConfigured()) return res.status(500).json({ error: 'linear_not_configured', message: 'Set LINEAR_CLIENT_ID and LINEAR_CLIENT_SECRET.' });
  const { state } = createLinearState({ workspaceId, userId: req.internalUserId, connectionName: String(req.query.connectionName || 'Linear') });
  return res.json({ authUrl: buildLinearAuthUrl({ state }) });
});

oauthLinearRouter.get('/callback', async (req, res) => {
  const { code, state, error: oauthError } = req.query;
  if (oauthError) return res.redirect(done({ oauth_error: String(oauthError) }));
  if (!code || !state) return res.redirect(done({ oauth_error: 'missing_code_or_state' }));
  const pending = consumeLinearState(state);
  if (!pending) return res.redirect(done({ oauth_error: 'invalid_state' }));
  try {
    const conn = await completeLinearConnection(getSupabaseClient(), {
      workspaceId: pending.workspaceId, userId: pending.userId, code: String(code), connectionName: pending.connectionName,
    });
    auditLog({
      actor_user_id: pending.userId ?? null, action: 'integration.connect', target_type: 'connection',
      target_id: conn.id, target_workspace_id: pending.workspaceId, metadata: { provider: 'linear' },
    });
    return res.redirect(done({ oauth_success: 'true', connection_id: conn.id }));
  } catch (err) {
    console.error('[LINEAR_OAUTH_CALLBACK]', err?.message || err);
    return res.redirect(done({ oauth_error: 'callback_failed' }));
  }
});
