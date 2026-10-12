// Fellow poller — the ingest path for connections that have no webhook.
//
// A Fellow workspace can have webhooks switched off (subscribe 502/503 on connect), and
// then nothing is ever pushed to us. For exactly those connections — no webhook_id on the
// stored credentials — we list recordings updated since the last run and push each
// finished one through reprocessFellow, the SAME pipeline the webhook uses. Connections
// WITH a webhook are skipped: Fellow retries a failed delivery for ~27 hours, and polling
// them too would race the webhook for the same call.
//
// Fellow's list endpoints are POST with a JSON body and cursor pagination. Recording order
// is not documented, so we collect the window first and process OLDEST first, advancing
// the cursor only past recordings we actually finished — a call still being processed by
// Fellow (no AI notes yet) holds the cursor back so it is picked up once it is ready.
//
// Rate limit is 3 req/s and 10k/day per key: calls are spaced ~400ms apart and each run
// is capped per connection. Anything left is picked up on the next tick.

import { getSupabaseClient } from '@nous/core';
import { reprocessFellow, getFellowConnections, fellowApiBase, callFromRecording, fellowAccountEmail } from '../webhooks/handlers/fellow.mjs';

const MAX_RECORDINGS_PER_RUN = 40;
const MAX_LIST_PAGES = 10;
const CALL_SPACING_MS = 400;                     // under 3 req/s
const READY_GRACE_MS = 3 * 3600000;              // no AI notes 3h after the call → take it as it is

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function fellowPost(base, apiKey, path, body) {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.status === 429) return { rateLimited: true };
  if (!res.ok) throw new Error(`fellow_${path.replace(/\W+/g, '_')}_${res.status}`);
  return res.json().catch(() => ({}));
}

async function fellowGet(base, apiKey, path) {
  const res = await fetch(`${base}${path}`, { headers: { 'X-API-KEY': apiKey } });
  if (res.status === 404 || res.status === 403) return null;
  if (!res.ok) throw new Error(`fellow_get_${res.status}`);
  return res.json().catch(() => null);
}

// A recording is ready when it has ended and Fellow has written its AI notes — or when it
// ended long enough ago that the notes are not coming (zero-day retention, no recap).
function isReady(rec) {
  if (!rec?.ended_at) return false;
  if (Array.isArray(rec.ai_notes) && rec.ai_notes.length) return true;
  return Date.now() - new Date(rec.ended_at).getTime() > READY_GRACE_MS;
}

async function pollConnection(supabase, conn) {
  const base = fellowApiBase(conn.subdomain);
  // Whose Fellow this is. Its domain is how a polled call knows which attendee ran it — the
  // REST list has no organizer field. Resolved once per connection, cached after the first run.
  const accountEmail = await fellowAccountEmail(supabase, conn);
  // First run starts at the moment the connection was made, NOT in the past: connecting
  // Fellow brings in calls from then on and imports no history (no backfill, by decision
  // 2026-09-15 — see LIVE_ONLY_ON_CONNECT in apps/api/src/lib/connectIngest.mjs).
  const since = conn.creds?.fellow_last_updated_at
    || conn.createdAt
    || new Date().toISOString();

  // 1. Collect the window.
  const recordings = [];
  let cursor = null;
  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    const d = await fellowPost(base, conn.apiKey, '/recordings', {
      pagination: { cursor, page_size: 20 },
      include:    { transcript: true, ai_notes: true },
      filters:    { updated_at_start: since },
    });
    if (d.rateLimited) { console.warn(`[FELLOW_POLL] workspace=${conn.workspaceId} rate limited — resuming next run`); break; }
    recordings.push(...(d?.recordings?.data || []));
    cursor = d?.recordings?.page_info?.cursor || null;
    if (!cursor) break;
    await sleep(CALL_SPACING_MS);
  }

  // 2. Oldest first; stop advancing at the first recording that is not ready yet.
  recordings.sort((a, b) => String(a.updated_at || '').localeCompare(String(b.updated_at || '')));
  let processed = 0;
  let newest = since;
  let blocked = false;
  const noteCache = new Map();

  for (const rec of recordings) {
    if (processed >= MAX_RECORDINGS_PER_RUN) break;
    if (!isReady(rec)) { blocked = true; continue; }

    let note = null;
    if (rec.note_id) {
      if (!noteCache.has(rec.note_id)) {
        await sleep(CALL_SPACING_MS);
        const n = await fellowGet(base, conn.apiKey, `/note/${encodeURIComponent(rec.note_id)}`).catch(() => null);
        noteCache.set(rec.note_id, n?.note ?? null);
      }
      note = noteCache.get(rec.note_id);
    }

    const call = callFromRecording(rec, note, { subdomain: conn.subdomain });

    try {
      await reprocessFellow(supabase, conn.workspaceId, { type: 'poll', call, ownerUserId: conn.ownerUserId, accountEmail });
      processed++;
    } catch (err) {
      console.warn(`[FELLOW_POLL] recording ${rec.id} failed:`, err.message);
      // Retry a fresh failure next run rather than skipping past it — but a recording that
      // keeps failing a day later must not pin the cursor forever.
      if (Date.now() - new Date(rec.ended_at).getTime() < 86400000) blocked = true;
      continue;
    }
    if (!blocked && rec.updated_at && rec.updated_at > newest) newest = rec.updated_at;
  }

  if (newest !== since) {
    const creds = { ...conn.creds, fellow_last_updated_at: newest };
    await supabase.from('workflow_provider_connections')
      .update({ encrypted_credentials: creds })
      .eq('id', conn.id);
  }

  if (processed > 0) console.log(`[FELLOW_POLL] workspace=${conn.workspaceId}: ${processed} recording(s) processed`);
  return processed;
}

export async function pollAllFellowWorkspaces() {
  const supabase = getSupabaseClient();
  const connections = (await getFellowConnections(supabase))
    .filter(c => c.isVerified && !c.webhookId);
  if (!connections.length) return 0;
  console.log(`[FELLOW_POLL] Starting — ${connections.length} connection(s) without a webhook`);

  let total = 0;
  for (const conn of connections) {
    try { total += await pollConnection(supabase, conn); }
    catch (e) { console.error(`[FELLOW_POLL] workspace=${conn.workspaceId}:`, e.message); }
  }
  console.log(`[FELLOW_POLL] Done — ${total} recording(s) processed`);
  return total;
}
