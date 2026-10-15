import { getSupabaseClient } from '@nous/core';
import { isWorkspaceAdmin } from '../../lib/apiKeyUsage.mjs';
import { loadActivity, loadCalls, parseCallsQuery, parseWindow } from '../../lib/apiActivity.mjs';

// Settings > Workspace > API & MCP activity (GET-898). Mounted on /api/usage behind
// verifySupabaseAuth (?workspaceId=). Workspace owners and admins only: the log holds every
// member's agent calls, and a member's own keys already have their usage on the API keys page.

/** 400 / 403 for a request that may not read the workspace's activity, else null. */
export function activityGate(req) {
  if (!req.workspaceId) return { status: 400, body: { error: 'workspace_required' } };
  if (!isWorkspaceAdmin(req)) return { status: 403, body: { error: 'admin_only' } };
  return null;
}

function fail(res, where, err) {
  if (err?.code === 'activity_unavailable') {
    console.warn(`[${where}]`, err.message);
    return res.status(503).json({ error: 'activity_unavailable' });
  }
  console.error(`[${where}]`, err?.message || err);
  return res.status(500).json({ error: 'internal_error' });
}

/**
 * GET /api/usage/activity?window=24h|7d|30d|90d
 * → { window, since, bucket, totals, series, by_route, by_target, by_key, by_client } (see
 *   lib/apiActivity.mjs). 503 { error: 'activity_unavailable' } until the SQL function exists.
 */
export function makeActivityHandler({ getClient = getSupabaseClient, now = () => Date.now() } = {}) {
  return async (req, res) => {
    const gate = activityGate(req);
    if (gate) return res.status(gate.status).json(gate.body);
    try {
      return res.json(await loadActivity(getClient(), {
        workspaceId: req.workspaceId, window: parseWindow(req.query?.window), now: now(),
      }));
    } catch (err) {
      return fail(res, 'GET /api/usage/activity', err);
    }
  };
}

/**
 * GET /api/usage/activity/calls?window=&surface=mcp|rest&route=&status=ok|error&key=<uuid>&client=&q=&limit=&before=
 *   (client=(unknown) is the calls that named no client)
 * → { calls: [{ id, at, surface, route, target, about, status, latency_ms, client, key: { id, name } }],
 *     next_before }
 */
export function makeActivityCallsHandler({ getClient = getSupabaseClient, now = () => Date.now() } = {}) {
  return async (req, res) => {
    const gate = activityGate(req);
    if (gate) return res.status(gate.status).json(gate.body);
    const parsed = parseCallsQuery(req.query ?? {});
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    try {
      return res.json(await loadCalls(getClient(), { workspaceId: req.workspaceId, ...parsed, now: now() }));
    } catch (err) {
      return fail(res, 'GET /api/usage/activity/calls', err);
    }
  };
}

export const activityHandler = makeActivityHandler();
export const activityCallsHandler = makeActivityCallsHandler();
