// RingCentral poller — the ingest path for RingCentral, every 5 minutes (GET-289).
//
// RingCentral has no account-level "a call ended" event, so the company call log IS the feed:
// read the window since the last run, hand each finished conversation to reprocessRingCentral.
//
// Three things shape it:
//
//   1. A call appears in the log only once it has ENDED, stamped with the time it STARTED, and
//      the log filters on start time. A 40-minute call that began before the last run would never
//      be seen by a window that starts where the last one ended. So every read reaches back
//      LOOKBACK_MS from now (or further, to a cursor that is still behind), and the ids already
//      filed are kept on the connection (`rc_done`) so a call is handed to the pipeline once.
//      The log returns newest first with no sort option, so a window is capped at MAX_WINDOW_MS:
//      catching up after downtime moves forward in slices instead of re-reading the newest page.
//   2. RingSense writes its transcript some minutes after the call. A recorded call on an account
//      that has RingSense waits up to INSIGHTS_GRACE_MS for it, holding the cursor; after that it is
//      filed without one rather than never.
//   3. The call log and RingSense are in RingCentral's Heavy rate group: 10 requests a minute per
//      user and app. Requests are spaced HEAVY_SPACING_MS apart, each run is capped, and a 429
//      ends the run — any request during the penalty restarts it.
//
// Live only: the first run starts at the moment the connection was made (LIVE_ONLY_ON_CONNECT in
// apps/api/src/lib/connectIngest.mjs), so connecting imports no history.

import { getSupabaseClient, ringCentralGet, callFromCallLog, isConversation } from '@nous/core';
import { reprocessRingCentral, getRingCentralConnections, fetchInsights } from '../webhooks/handlers/ringcentral.mjs';

const LOOKBACK_MS = 2 * 3600_000;
const MAX_WINDOW_MS = 6 * 3600_000;
const SETTLE_MS = 60_000;                   // a call shows up in the log 15–30s after it ends
const INSIGHTS_GRACE_MS = 60 * 60_000;
const RINGSENSE_RECHECK_MS = 24 * 3600_000;
const HEAVY_SPACING_MS = 6_500;             // under 10 req/min
const MAX_LIST_PAGES = 10;
const PER_PAGE = 100;
const MAX_CALLS_PER_RUN = 25;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * Can this JWT read RingSense insights? Asked once a day, cached on the connection. When it cannot,
 * no call waits for a transcript that is never coming.
 *
 * Two signals. The permission check says no with `successful: false` (or refuses the check
 * outright); anything else counts as yes, because the check's answer shape is thinly documented and
 * reading it too strictly would switch transcripts off for an account that has them. The insights
 * endpoint itself answering 403 is the authoritative no — see markRingSense.
 */
async function ringSenseEnabled(supabase, conn) {
  const cached = conn.creds?.rc_ringsense;
  if (cached && Date.now() - new Date(cached.checked_at).getTime() < RINGSENSE_RECHECK_MS) return !!cached.enabled;
  const r = await ringCentralGet(conn.auth, '/restapi/v1.0/account/~/extension/~/authz-profile/check', { permissionId: 'ReadRingSenseInsights' });
  if (!r.ok && r.rateLimited) return !!cached?.enabled;
  await markRingSense(supabase, conn, r.ok && r.data?.successful !== false);
  return conn.creds.rc_ringsense.enabled;
}

async function markRingSense(supabase, conn, enabled) {
  conn.creds = { ...conn.creds, rc_ringsense: { enabled, checked_at: new Date().toISOString() } };
  await supabase.from('workflow_provider_connections').update({ encrypted_credentials: conn.creds }).eq('id', conn.id);
}

async function pollConnection(supabase, conn) {
  const now = Date.now();
  const end = now - SETTLE_MS;
  const createdAt = new Date(conn.createdAt || now).getTime();
  // Everything that started before the cursor has been filed (or given up on).
  // Normalised: created_at arrives as `…+00:00`, RingCentral stamps `…Z`, and these compare as strings.
  const cursor = new Date(conn.creds?.rc_cursor || createdAt).toISOString();
  const startMs = Math.max(createdAt, Math.min(Date.parse(cursor), end - LOOKBACK_MS));
  const dateFrom = new Date(startMs).toISOString();
  const dateTo = new Date(Math.min(end, startMs + MAX_WINDOW_MS)).toISOString();
  if (dateFrom >= dateTo) return 0;

  // 1. The window, every page.
  const records = [];
  let next = null;
  let rateLimited = false;
  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    const r = next
      ? await ringCentralGet(conn.auth, next)
      : await ringCentralGet(conn.auth, '/restapi/v1.0/account/~/call-log', {
          view: 'Detailed', type: 'Voice', dateFrom, dateTo, perPage: PER_PAGE,
        });
    if (!r.ok) {
      if (r.rateLimited) { rateLimited = true; break; }
      throw new Error(`call_log_${r.status}: ${r.message}`);
    }
    records.push(...(r.data?.records || []));
    next = r.data?.navigation?.nextPage?.uri || null;
    if (!next) break;
    await sleep(HEAVY_SPACING_MS);
  }
  if (rateLimited && !records.length) {
    console.warn(`[RINGCENTRAL_POLL] workspace=${conn.workspaceId} rate limited — resuming next run`);
    return 0;
  }

  // 2. Oldest first. The cursor moves to dateTo unless something holds it back.
  const done = { ...(conn.creds?.rc_done || {}) };
  const conversations = records
    .filter(r => isConversation(r) && !done[r.id])
    .sort((a, b) => String(a.startTime).localeCompare(String(b.startTime)));

  const ringsense = conversations.some(r => callFromCallLog(r).recordingId)
    ? await ringSenseEnabled(supabase, conn).catch(() => false)
    : false;

  let ringsenseOn = ringsense;
  let processed = 0;
  let holdAt = (rateLimited || next) ? dateFrom : null;   // an unread page holds the cursor
  for (const record of conversations) {
    if (processed >= MAX_CALLS_PER_RUN) { holdAt = holdAt && holdAt < record.startTime ? holdAt : record.startTime; break; }
    const call = callFromCallLog(record);
    const endedAgo = now - (new Date(call.startTime).getTime() + call.durationSec * 1000);

    let insights = null;
    if (ringsenseOn && call.recordingId && call.telephonySessionId) {
      await sleep(HEAVY_SPACING_MS);
      const got = await fetchInsights(conn, call.telephonySessionId).catch(() => ({ records: null }));
      if (got.rateLimited) { holdAt = holdAt && holdAt < record.startTime ? holdAt : record.startTime; break; }
      if (got.status === 403) {
        // No RingSense on this account (or this JWT may not read it): stop waiting for transcripts.
        ringsenseOn = false;
        await markRingSense(supabase, conn, false).catch(() => {});
      }
      insights = got.records;
      if (!insights && ringsenseOn && endedAgo < INSIGHTS_GRACE_MS) {
        // RingSense is probably still writing it. Leave this call for a later run.
        if (!holdAt || record.startTime < holdAt) holdAt = record.startTime;
        continue;
      }
    }

    try {
      await reprocessRingCentral(supabase, conn.workspaceId, { type: 'poll', record, insights, conn });
      done[record.id] = record.startTime;
      processed++;
    } catch (err) {
      console.warn(`[RINGCENTRAL_POLL] call ${record.id} failed:`, err.message);
      // Retry a fresh failure next run; a call still failing after a day must not pin the cursor.
      if (endedAgo < 86400000) { if (!holdAt || record.startTime < holdAt) holdAt = record.startTime; }
      else done[record.id] = record.startTime;
    }
  }

  // 3. Save the cursor and forget ids that have fallen out of every future lookback.
  const newCursor = holdAt && holdAt < dateTo ? holdAt : dateTo;
  const cursorForward = newCursor > cursor ? newCursor : cursor;
  // An id is safe to forget once no future window can start before it: windows never reach
  // earlier than the cursor or LOOKBACK_MS before now, whichever is earlier.
  const floor = new Date(Math.min(new Date(cursorForward).getTime(), end - LOOKBACK_MS) - 3600_000).toISOString();
  for (const [id, startedAt] of Object.entries(done)) if (startedAt < floor) delete done[id];

  conn.creds = { ...conn.creds, rc_cursor: cursorForward, rc_done: done, rc_last_poll_at: new Date(now).toISOString() };
  await supabase.from('workflow_provider_connections')
    .update({ encrypted_credentials: conn.creds })
    .eq('id', conn.id);

  if (processed > 0) console.log(`[RINGCENTRAL_POLL] workspace=${conn.workspaceId}: ${processed} call(s) filed`);
  return processed;
}

let running = false;

export async function pollAllRingCentralWorkspaces() {
  // A run can outlast the 5-minute tick on a busy account (every request is spaced for the rate
  // limit). Two overlapping runs would read the same window and race on the cursor.
  if (running) return 0;
  running = true;
  try {
    const supabase = getSupabaseClient();
    const connections = (await getRingCentralConnections(supabase)).filter(c => c.isVerified);
    if (!connections.length) return 0;

    let total = 0;
    for (const conn of connections) {
      try { total += await pollConnection(supabase, conn); }
      catch (e) { console.error(`[RINGCENTRAL_POLL] workspace=${conn.workspaceId}:`, e.message); }
    }
    return total;
  } finally {
    running = false;
  }
}
