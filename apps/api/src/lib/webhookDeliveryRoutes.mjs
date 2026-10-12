// The webhook delivery log, stats and Resend (GET-624), mounted on both outbound-webhook
// surfaces: /api/triggers (the dashboard's Webhooks page, session or key auth) and /v2/webhooks
// (the public API, key auth). One set of handlers so the two never disagree. All logic is in
// @nous/core (db/webhookDeliveries.ts); these are the HTTP shells.
import { decryptToken } from './webhookDestination.mjs';
import {
  getSupabaseClient, getTrigger, listDeliveryAttempts, deliveryStats, resendDelivery, createResendLimiter,
  deliveryPageLimit,
} from '@nous/core';
import { parseCursor, nextCursor, UUID_ID } from './keysetCursor.mjs';

// Shared by both mounts: 50 resends per subscription per minute, per API process.
const resendLimiter = createResendLimiter();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A delivery row as the API returns it: everything but the workspace id. */
export function shapeDelivery(row) {
  if (!row) return null;
  const { workspace_id: _ws, ...rest } = row;
  return rest;
}

/**
 * Mount the three routes on `router`.
 *   logPath   the per-subscription log path, e.g. '/:id/deliveries' or '/:id/attempts'
 *   label     the route prefix used in error logs
 */
export function mountWebhookDeliveryRoutes(router, { logPath = '/:id/deliveries', label = '/api/triggers' } = {}) {
  // GET <logPath>?limit=50&before=<cursor> — newest first, one row per attempt. The cursor is the
  // previous page's next_before (`<created_at>|<id>`, opaque); a bare ISO timestamp still works.
  router.get(logPath, async (req, res) => {
    const cursor = parseCursor(req.query.before, { idPattern: UUID_ID });
    if (cursor.error) {
      return res.status(400).json({ error: 'invalid_before', hint: 'Pass the next_before of the previous page.' });
    }
    try {
      const supabase = getSupabaseClient();
      if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'not_found' });
      const sub = await getTrigger(supabase, req.workspaceId, req.params.id);
      if (!sub) return res.status(404).json({ error: 'not_found' });
      const limit = deliveryPageLimit(req.query.limit);
      const rows = await listDeliveryAttempts(supabase, req.workspaceId, sub.id, {
        limit, before: cursor.at, beforeId: cursor.id,
      });
      const shaped = rows.map(shapeDelivery);
      res.json({ deliveries: shaped, next_before: nextCursor(shaped, limit, 'created_at') });
    } catch (err) {
      console.error(`[GET ${label}${logPath}]`, err);
      res.status(500).json({ error: 'internal_error' });
    }
  });

  // GET /:id/stats — { success_rate_7d, deliveries_7d, failures_7d, last_delivery_at }.
  router.get('/:id/stats', async (req, res) => {
    try {
      const supabase = getSupabaseClient();
      if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'not_found' });
      const sub = await getTrigger(supabase, req.workspaceId, req.params.id);
      if (!sub) return res.status(404).json({ error: 'not_found' });
      res.json(await deliveryStats(supabase, req.workspaceId, sub.id));
    } catch (err) {
      console.error(`[GET ${label}/:id/stats]`, err);
      res.status(500).json({ error: 'internal_error' });
    }
  });

  // POST /deliveries/:deliveryId/resend — send that event again now, through the same signed
  // send the worker uses, and return the new attempt (resent_from = the original).
  router.post('/deliveries/:deliveryId/resend', async (req, res) => {
    try {
      if (!UUID_RE.test(req.params.deliveryId)) return res.status(404).json({ error: 'not_found' });
      const out = await resendDelivery(getSupabaseClient(), req.workspaceId, req.params.deliveryId, {
        allow: (subId) => resendLimiter.allow(subId), decryptToken,
      });
      if (out.status === 'not_found') return res.status(404).json({ error: 'not_found' });
      if (out.status === 'rate_limited') return res.status(429).json({ error: 'rate_limited', retry_after_s: 60 });
      if (out.status === 'payload_gone') return res.status(410).json({ error: 'payload_gone' });
      if (out.status === 'subscription_inactive') return res.status(409).json({ error: 'subscription_inactive' });
      res.json({
        delivery: shapeDelivery(out.delivery),
        result: { ok: out.result.ok, status_code: out.result.status_code, error: out.result.error, duration_ms: out.result.duration_ms },
      });
    } catch (err) {
      console.error(`[POST ${label}/deliveries/:deliveryId/resend]`, err);
      res.status(500).json({ error: 'internal_error' });
    }
  });
}
