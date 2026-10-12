// Internal sweep endpoint for the API-plan notifications (GET-635). Mounted at
// /internal/api-notifications, guarded like /internal/ops-emails: 404 unless
// WORKER_INTERNAL_SECRET is set, 403 unless the caller presents it. The logic and the
// de-duplication live in lib/apiNotifications.mjs; the worker sends what this returns.

import { Router } from 'express';
import { getSupabaseClient } from '@nous/core';
import { API_ALERT_KEYS, supabaseDb, sweepApiNotifications } from '../lib/apiNotifications.mjs';

export const apiNotificationsRouter = Router();

apiNotificationsRouter.use((req, res, next) => {
  const secret = process.env.WORKER_INTERNAL_SECRET;
  if (!secret) return res.status(404).json({ error: 'not_found' }); // feature off
  if (req.get('X-Internal-Secret') !== secret) return res.status(403).json({ error: 'forbidden' });
  next();
});

// POST /internal/api-notifications/sweep   body { kinds?: ['webhook_failures'|'key_expiring'|'credits_low'] }
// → { queued: [{ kind, to[], ... }] }
apiNotificationsRouter.post('/sweep', async (req, res) => {
  try {
    const asked = Array.isArray(req.body?.kinds) ? req.body.kinds : API_ALERT_KEYS;
    const queued = await sweepApiNotifications(supabaseDb(getSupabaseClient()), { kinds: asked });
    return res.json({ queued });
  } catch (err) {
    console.error('[api-notifications/sweep]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});
