// Composio backfill — what a just-connected account brings with it.
//
// Gmail: the mailbox scan (services/gmailSync.mjs) over a wider lookback — the same read the
// 30-minute schedule runs, through the same ingestGmail as the live webhook; dedup via externalId.
//
// Google Calendar: a calendar scan over a wider lookback (services/calendarSync.mjs) — the same
// reconcile the schedule runs every 30 minutes, so there is one calendar path, not two.

import { appOwnsHistoryBackfill } from './contactHistoryEnricher.mjs';
import { syncCalendarConnection } from './calendarSync.mjs';
import { syncGmailConnection } from './gmailSync.mjs';
import { hasGoogleTransport } from '../utils/googleClient.mjs';

// Three months, the backfill's read window (GET-514).
const DEFAULT_DAYS = Number(process.env.COMPOSIO_BACKFILL_DAYS || 90);

/**
 * Backfill one connected account. `conn` must carry: id, workspace_id, owner_user_id,
 * account_email, composio_connection_id, workflow_providers.name.
 */
export async function backfillComposioConnection(supabase, conn, { days = DEFAULT_DAYS } = {}) {
  const provider = conn.workflow_providers?.name;
  // A native Google connection (GET-765) backfills through the same scans, on its own tokens.
  if (!hasGoogleTransport(conn)) return { ok: false, error: 'no composio_connection_id' };

  // API plan → the user's own agent backfills HISTORY on their tokens, so the app skips the
  // lookback. What is on the calendar from today on is not history: a calendar connected on the
  // API plan still gets its upcoming meetings immediately (GET-221).
  const ownsHistory = await appOwnsHistoryBackfill(supabase, conn.workspace_id);

  if (provider === 'google_calendar') {
    return syncCalendarConnection(supabase, conn, ownsHistory ? { lookbackDays: days } : {});
  }
  if (provider !== 'gmail_oauth') return { ok: false, error: `no backfill spec for ${provider}` };
  if (!ownsHistory) return { ok: true, logged: 0, skipped: 'api_agent_backfill' };

  // The same scan the schedule runs, over the lookback: received and sent, paged, deduped.
  return syncGmailConnection(supabase, conn, { days });
}
