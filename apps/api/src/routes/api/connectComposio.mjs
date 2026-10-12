/**
 * Composio connect — one data-plane door, two callers.
 *
 *   CLI   `nous connect gmail`  → Authorization: Bearer pk_…   (verifyApiKey)
 *   Integrations panel  Connect → Authorization: Bearer <clerk> (verifySupabaseAuth)
 *
 * verifyAuthEither routes to the right one and both attach req.workspaceId + a viewer
 * identity, so the handlers don't care which door was used. The CLI needs NO device-code
 * dance (unlike `nous login`) — it already holds a member key, so it just starts a Composio
 * consent and polls status.
 *
 *   POST /start   { provider }                         → { redirect_url, connection_request_id }
 *   GET  /status  ?provider=&connection_request_id=    → { status: pending|connected|failed }
 */

import { Router } from 'express';
import { getSupabaseClient } from '@nous/core';
import { verifyAuthEither } from '../../middleware/authEither.mjs';
import {
  isComposioProvider,
  initiateComposioConnection,
  finalizeComposioConnection,
} from '../../providers/composio.mjs';

export const connectComposioRouter = Router();

connectComposioRouter.use(verifyAuthEither);

/**
 * Who is connecting? The Composio entity id must be a real member.
 *  - member pk_ key  → req.memberUserId (key owner)
 *  - clerk session   → req.memberUserId / req.internalUserId (the logged-in user)
 *  - admin/legacy pk_ key with no owner → fall back to a workspace owner/admin so a
 *    single-operator dogfood box still connects instead of 400ing.
 */
async function resolveActingMember(supabase, req) {
  if (req.memberUserId) return req.memberUserId;
  if (req.internalUserId) return req.internalUserId;
  if (!req.workspaceId) return null;
  const { data: owner } = await supabase
    .from('workspace_members')
    .select('user_id, role')
    .eq('workspace_id', req.workspaceId)
    .in('role', ['owner', 'admin'])
    .order('role', { ascending: true })
    .limit(1)
    .maybeSingle();
  return owner?.user_id ?? null;
}

connectComposioRouter.post('/start', async (req, res) => {
  try {
    const provider = String(req.body?.provider || '').toLowerCase();
    if (!isComposioProvider(provider)) {
      return res.status(400).json({ error: 'unknown_provider', message: `"${provider}" is not a Composio provider.` });
    }
    const workspaceId = req.workspaceId;
    if (!workspaceId) return res.status(400).json({ error: 'workspace_required' });

    const supabase = getSupabaseClient();
    const memberUserId = await resolveActingMember(supabase, req);

    const result = await initiateComposioConnection({ supabase, workspaceId, memberUserId, provider });
    if (!result.ok) return res.status(result.status).json({ error: result.error, message: result.message });

    return res.json({
      provider,
      redirect_url: result.redirectUrl,
      connection_request_id: result.connectionRequestId,
    });
  } catch (err) {
    console.error('[POST /api/connect/composio/start]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

connectComposioRouter.get('/status', async (req, res) => {
  try {
    const provider = String(req.query?.provider || '').toLowerCase();
    const connectionRequestId = req.query?.connection_request_id;
    if (!isComposioProvider(provider)) return res.status(400).json({ error: 'unknown_provider' });
    if (!connectionRequestId) return res.status(400).json({ error: 'connection_request_id_required' });

    const workspaceId = req.workspaceId;
    if (!workspaceId) return res.status(400).json({ error: 'workspace_required' });

    const supabase = getSupabaseClient();
    const memberUserId = await resolveActingMember(supabase, req);

    const result = await finalizeComposioConnection({
      supabase, workspaceId, memberUserId, provider,
      connectionRequestId, userId: req.internalUserId ?? memberUserId,
    });
    if (!result.ok) return res.status(result.status).json({ error: result.error, message: result.message });

    return res.json({ status: result.status, connection: result.connection ?? null });
  } catch (err) {
    console.error('[GET /api/connect/composio/status]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});
