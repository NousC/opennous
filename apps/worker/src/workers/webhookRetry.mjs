// Webhook retry worker — runs every minute, picks up pending rows from
// webhook_inbox whose next_attempt_at has arrived, and calls the matching
// reprocessor.
//
// Reprocessors are pure functions that accept (supabase, workspaceId, body)
// and re-run the handler's processing logic from scratch. They live in the
// same files as the inbound handlers so they share helpers (resolveContact,
// logActivity, signal extraction).

import { getSupabaseClient } from '@nous/core';
import { markProcessed, markRetry } from '../utils/webhookInbox.mjs';

import { reprocessCalendly }  from '../webhooks/handlers/calendly.mjs';
import { reprocessCalCom }    from '../webhooks/handlers/calcom.mjs';
import { reprocessFireflies } from '../webhooks/handlers/fireflies.mjs';
import { reprocessFathom }    from '../webhooks/handlers/fathom.mjs';
import { reprocessInstantly } from '../webhooks/handlers/instantly.mjs';
import { reprocessEmailBison } from '../webhooks/handlers/emailbison.mjs';
import { reprocessHeyReach } from '../webhooks/handlers/heyreach.mjs';
import { reprocessSmartlead } from '../webhooks/handlers/smartlead.mjs';
import { reprocessLemlist }   from '../webhooks/handlers/lemlist.mjs';
import { reprocessLinkedIn }  from '../webhooks/handlers/linkedin.mjs';
import { reprocessRB2B }      from '../webhooks/handlers/rb2b.mjs';
import { reprocessStripe }    from '../webhooks/handlers/stripe.mjs';

const HANDLERS = {
  calendly:  reprocessCalendly,
  cal_com:   reprocessCalCom,
  fireflies: reprocessFireflies,
  fathom:    reprocessFathom,
  instantly: reprocessInstantly,
  emailbison: reprocessEmailBison,
  heyreach: reprocessHeyReach,
  smartlead: reprocessSmartlead,
  lemlist:   reprocessLemlist,
  linkedin:  reprocessLinkedIn,
  rb2b:      reprocessRB2B,
  stripe:    reprocessStripe,
};

const BATCH_SIZE = 20;

export async function processWebhookInbox() {
  const supabase = getSupabaseClient();
  let processed = 0, failed = 0;
  try {
    const { data: pending, error } = await supabase
      .from('webhook_inbox')
      .select('*')
      .eq('status', 'pending')
      .lte('next_attempt_at', new Date().toISOString())
      .order('received_at', { ascending: true })
      .limit(BATCH_SIZE);

    // Migration not yet applied — skip silently so we don't spam logs.
    // 42P01 = Postgres undefined_table. PGRST205 = PostgREST schema-cache miss.
    if (error?.code === '42P01' || error?.code === 'PGRST205') return;
    if (error) throw error;

    if (!pending?.length) return;

    for (const row of pending) {
      const handler = HANDLERS[row.source];
      if (!handler) {
        await markRetry(supabase, row, new Error(`no reprocessor for source: ${row.source}`));
        failed++;
        continue;
      }
      try {
        await handler(supabase, row.workspace_id, row.payload);
        await markProcessed(supabase, row.id);
        processed++;
      } catch (err) {
        await markRetry(supabase, row, err);
        failed++;
      }
    }
  } catch (err) {
    console.error('[WEBHOOK_RETRY] sweep error:', err.message);
    return;
  }
  if (processed || failed) {
    console.log(`[WEBHOOK_RETRY] processed=${processed} failed=${failed}`);
  }
}
