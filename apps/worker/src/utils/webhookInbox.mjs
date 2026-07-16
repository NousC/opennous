// Webhook retry queue helpers.
//
// Strategy: happy path runs unchanged. If the inline processor throws, we
// record the payload to webhook_inbox so the retry worker can pick it up
// later. This gives loss-tolerance with zero overhead on successful
// webhooks.

const MAX_ATTEMPTS    = 10;
const INITIAL_BACKOFF = 60_000;       // 1 min
const MAX_BACKOFF     = 60 * 60_000;  // 1 hour

// Capture only headers we'd plausibly need on retry (sig headers, content-type).
// Avoids storing the entire header bag including transport metadata.
function captureHeaders(rawHeaders) {
  const out = {};
  for (const [k, v] of Object.entries(rawHeaders || {})) {
    const low = k.toLowerCase();
    if (low.startsWith('x-') || low.includes('signature') || low === 'content-type') {
      out[low] = typeof v === 'string' ? v : String(v);
    }
  }
  return out;
}

// Surface the failure on the Webhooks page too, not just in webhook_inbox. A delivery
// that keeps failing is exactly what a user needs to SEE, and the system log is what the
// feed reads. Fire-and-forget, mirrors logSysEvent — never blocks or throws.
async function logWebhookFailure(supabase, { workspaceId, source, err }) {
  try {
    await supabase.from('workspace_system_log').insert({
      workspace_id: workspaceId,
      source,
      event_type:  'webhook_failed',
      summary:     `Delivery failed — ${String(err?.message || err)}. Queued for retry.`,
      metadata:    { error: String(err?.message || err) },
      occurred_at: new Date().toISOString(),
    });
  } catch { /* never block the webhook response */ }
}

// Enqueue a failed delivery for retry. Returns the inbox row id (or null if
// the insert itself failed — in which case we've lost the event, but we
// at least logged the original error).
export async function enqueueForRetry(supabase, { workspaceId, source, req, err }) {
  await logWebhookFailure(supabase, { workspaceId, source, err });
  try {
    const { data, error } = await supabase.from('webhook_inbox').insert({
      workspace_id: workspaceId,
      source,
      payload: req.body,
      headers: captureHeaders(req.headers),
      status: 'pending',
      attempts: 1,
      last_error: String(err?.message || err),
      next_attempt_at: new Date(Date.now() + INITIAL_BACKOFF).toISOString(),
    }).select('id').single();
    if (error?.code === '42P01' || error?.code === 'PGRST205') {
      console.warn('[WEBHOOK_INBOX] table not yet migrated — event will not retry. Apply supabase/migrations/2026_05_19_webhook_inbox.sql.');
      return null;
    }
    if (error) throw error;
    return data?.id ?? null;
  } catch (insertErr) {
    console.error('[WEBHOOK_INBOX] failed to enqueue retry:', insertErr.message);
    return null;
  }
}

// Mark a previously-enqueued row as processed (called from the retry worker).
export async function markProcessed(supabase, id) {
  await supabase.from('webhook_inbox').update({
    status: 'processed',
    processed_at: new Date().toISOString(),
  }).eq('id', id);
}

// Schedule next retry with exponential backoff; give up after MAX_ATTEMPTS.
export async function markRetry(supabase, row, err) {
  const attempts = (row.attempts || 0) + 1;
  const backoff  = Math.min(INITIAL_BACKOFF * 2 ** (attempts - 1), MAX_BACKOFF);
  const status   = attempts >= MAX_ATTEMPTS ? 'failed' : 'pending';
  await supabase.from('webhook_inbox').update({
    attempts,
    last_error: String(err?.message || err),
    status,
    next_attempt_at: new Date(Date.now() + backoff).toISOString(),
  }).eq('id', row.id);
}
