// Webhook test sends, shared by the dashboard (/api/triggers/:id/test, sent now and answered
// with the result) and the public API (/v2/webhooks/:id/test, queued through the outbox). One
// body builder and one rate limit, so the two surfaces send the same thing and neither can be
// used to hammer a customer's URL.
import { decryptToken } from './webhookDestination.mjs';
import {
  getSupabaseClient, buildEventRecord, eventEnvelope, sendTestDelivery, createResendLimiter, TEST_EVENT_TYPE,
} from '@nous/core';
import { shapeDelivery } from './webhookDeliveryRoutes.mjs';

// 50 test sends per webhook per minute, per API process — the same budget as Resend.
export const testSendLimiter = createResendLimiter();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The test body: the real envelope, built against a real account — the one named, else the
 * workspace's most recently active — so the receiver sees the exact shape real events have.
 */
export async function buildTestPayload(supabase, workspaceId, accountId = null) {
  let account = accountId ? String(accountId) : null;
  if (!account) {
    const { data, error } = await supabase.from('entity_list_rows').select('entity_id')
      .eq('workspace_id', workspaceId).eq('kind', 'account')
      .order('last_activity_at', { ascending: false, nullsFirst: false }).limit(1).maybeSingle();
    if (error) console.warn('[webhook test] account lookup failed:', error.message);
    account = data?.entity_id ?? null;
  }
  const record = await buildEventRecord(supabase, workspaceId, { accountId: account });
  const payload = eventEnvelope({
    type: TEST_EVENT_TYPE, workspaceId, occurredAt: new Date().toISOString(), record,
    data: { note: 'A test send. Real events carry the same envelope; data holds what happened.' },
  });
  return { payload, accountId: account, accountName: record.account?.name ?? null };
}

/** POST /:id/test on the dashboard router: send now, answer with the attempt. */
export function mountWebhookTestRoute(router, { label = '/api/triggers' } = {}) {
  router.post('/:id/test', async (req, res) => {
    try {
      if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'not_found' });
      const supabase = getSupabaseClient();
      const { payload, accountId, accountName } = await buildTestPayload(supabase, req.workspaceId, req.body?.account_id);
      const out = await sendTestDelivery(supabase, req.workspaceId, req.params.id, {
        payload, entityId: accountId, allow: (subId) => testSendLimiter.allow(subId), decryptToken,
      });
      if (out.status === 'not_found') return res.status(404).json({ error: 'not_found' });
      if (out.status === 'rate_limited') return res.status(429).json({ error: 'rate_limited', retry_after_s: 60 });
      if (out.status === 'subscription_inactive') return res.status(409).json({ error: 'subscription_inactive' });
      res.json({
        event_id: out.event_id,
        account: accountName,
        delivery: shapeDelivery(out.delivery),
        result: { ok: out.result.ok, status_code: out.result.status_code, error: out.result.error, duration_ms: out.result.duration_ms },
      });
    } catch (err) {
      console.error(`[POST ${label}/:id/test]`, err);
      res.status(500).json({ error: 'internal_error' });
    }
  });
}
