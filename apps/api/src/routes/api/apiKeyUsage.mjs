import { Router } from 'express';
import { getSupabaseClient, isUUID } from '@nous/core';
import {
  loadKey, canSeeKey, loadKeyUsage, loadKeyRequests, parseRequestsQuery,
  loadUsageByKey, parseDays, rotatedFrom,
} from '../../lib/apiKeyUsage.mjs';

// Per-key usage (API plan C1, GET-623). Mounted at /api/keys behind verifySupabaseAuth, like the
// key list at /api/workspace/api-keys. Workspace-scoped (?workspaceId=), and a key's usage is
// visible to workspace owners/admins and to the person the key acts as or who minted it.
export const apiKeyUsageRouter = Router();

function fail(res, where, err) {
  console.error(`[${where}]`, err?.message || err);
  return res.status(500).json({ error: 'internal_error' });
}

// Resolves and authorises the key, or answers the request. Returns the key row or null.
async function keyFor(req, res) {
  if (!req.workspaceId) { res.status(400).json({ error: 'workspace_required' }); return null; }
  const { id } = req.params;
  if (!isUUID(id)) { res.status(400).json({ error: 'invalid_id' }); return null; }
  const key = await loadKey(getSupabaseClient(), req.workspaceId, id);
  // Not found and not yours answer the same, so a member cannot probe for other people's keys.
  if (!key || !canSeeKey(req, key)) { res.status(404).json({ error: 'not_found' }); return null; }
  return key;
}

// GET /api/keys/:id/usage
// → { key, per_day: [{day, calls}] (14 days, oldest first), by_route: [{route, surface, calls}]
//     (top 10 over 14 days), totals: { calls_7d, errors_7d }, rotated_from: [key ids] }
// History includes the keys this one replaced by rotation (rotated_from), so a rotate does not
// reset the dashboard.
apiKeyUsageRouter.get('/:id/usage', async (req, res) => {
  try {
    const key = await keyFor(req, res);
    if (!key) return undefined;
    const supabase = getSupabaseClient();
    const priorKeyIds = await rotatedFrom(supabase, req.workspaceId, key.id);
    return res.json(await loadKeyUsage(supabase, { workspaceId: req.workspaceId, key, priorKeyIds }));
  } catch (err) {
    return fail(res, 'GET /api/keys/:id/usage', err);
  }
});

// GET /api/keys/:id/requests?limit=50&before=<cursor>  (the next_before of the previous page)
// → { requests: [{at, surface, route, target, status, latency_ms, client}], next_before }
apiKeyUsageRouter.get('/:id/requests', async (req, res) => {
  try {
    const parsed = parseRequestsQuery(req.query);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    const key = await keyFor(req, res);
    if (!key) return undefined;
    const supabase = getSupabaseClient();
    const priorKeyIds = await rotatedFrom(supabase, req.workspaceId, key.id);
    return res.json(await loadKeyRequests(supabase, {
      workspaceId: req.workspaceId, keyId: key.id, keyIds: [key.id, ...priorKeyIds],
      limit: parsed.limit, before: parsed.before, beforeId: parsed.beforeId,
    }));
  } catch (err) {
    return fail(res, 'GET /api/keys/:id/requests', err);
  }
});

/**
 * GET /api/usage/by-key?days=30
 * → { days, keys: [{api_key_id, name, revoked, calls, credits: number | null}], credits_complete }
 * credits null = cannot tell (see loadUsageByKey).
 */
export async function usageByKeyHandler(req, res) {
  try {
    if (!req.workspaceId) return res.status(400).json({ error: 'workspace_required' });
    const days = parseDays(req.query.days);
    const out = await loadUsageByKey(getSupabaseClient(), { req, workspaceId: req.workspaceId, days });
    return res.json({ days, ...out });
  } catch (err) {
    return fail(res, 'GET /api/usage/by-key', err);
  }
}
