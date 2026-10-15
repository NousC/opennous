// Granola poller — the universal ingest path.
//
// Granola webhooks are Business/Enterprise-only, so polling is how notes reach the
// graph on every other plan (and a safety net when a webhook delivery is missed).
// Each connected key is personal, so we scan per connection: list notes created since
// the last run, then push each through reprocessGranola — the SAME code the webhook
// uses, so resolution, dedup (by external_id), notes, evidence and extraction are all
// identical. A note already logged is a no-op, so an inclusive cursor boundary is safe.
//
// Rate limits (25 req / 5s burst, 5 req/s sustained): each note costs ~2 calls
// (fetch note + maybe transcript), so we space notes ~500ms apart (~4 req/s) and cap
// how many we process per connection per run. Anything left is picked up next tick.

import { getSupabaseClient } from '@nous/core';
import { reprocessGranola } from '../webhooks/handlers/granola.mjs';
import { decrypt } from '../utils/encryption.mjs';

const GRANOLA_BASE = 'https://public-api.granola.ai/v1';
const MAX_NOTES_PER_RUN = 60;         // hard cap per connection per tick
const NOTE_SPACING_MS   = 500;        // ~2 notes/s → ~4 req/s, under the 5 req/s ceiling
// A connection's first live scan starts from when it was connected. Its history is the Backfill's
// to read, inside the window the owner confirmed and behind the AI provider pause (GET-854); it
// used to be read here, 90 days back, the moment Granola connected, with nobody asked.
const FIRST_RUN_FALLBACK_MS = 86400000;
const HISTORY_PAGES = 40;              // 1,200 notes per connection per backfill

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function getGranolaConnections(supabase) {
  const { data: provider } = await supabase
    .from('workflow_providers').select('id').eq('name', 'granola').maybeSingle();
  if (!provider?.id) return [];
  const { data } = await supabase
    .from('workflow_provider_connections')
    .select('id, workspace_id, owner_user_id, encrypted_credentials, created_at')
    .eq('is_verified', true)
    .eq('provider_id', provider.id);
  return data || [];
}

/** Every page of a connection's notes created after `since`, newest page first. */
async function* listNotes(apiKey, since, maxPages) {
  let cursor = null;
  for (let page = 0; page < maxPages; page++) {
    const url = new URL(`${GRANOLA_BASE}/notes`);
    url.searchParams.set('created_after', since);
    url.searchParams.set('page_size', '30');
    if (cursor) url.searchParams.set('cursor', cursor);
    const res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
    if (res.status === 429) throw Object.assign(new Error('Granola rate limit'), { rateLimited: true });
    if (!res.ok) throw new Error(`Granola list returned ${res.status}`);
    const d = await res.json().catch(() => ({}));
    yield Array.isArray(d?.notes) ? d.notes : [];
    if (!d?.hasMore || !d?.cursor) return;
    cursor = d.cursor;
  }
}

async function pollConnection(supabase, conn) {
  let apiKey = null;
  try { apiKey = decrypt(conn.encrypted_credentials?.api_key); } catch { /* skip */ }
  if (!apiKey) return 0;

  // Cursor = the created_at of the newest note we've processed for this connection,
  // stored (plain) on the connection creds. First run reaches back a bounded window.
  const since = conn.encrypted_credentials?.granola_last_created_at
    || conn.created_at
    || new Date(Date.now() - FIRST_RUN_FALLBACK_MS).toISOString();

  let cursor = null;
  let processed = 0;
  let newest = since;
  let failedAt = null;
  let stop = false;

  for (let page = 0; page < 20 && !stop; page++) {
    const url = new URL(`${GRANOLA_BASE}/notes`);
    url.searchParams.set('created_after', since);
    url.searchParams.set('page_size', '30');
    if (cursor) url.searchParams.set('cursor', cursor);

    const res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
    if (res.status === 429) {           // rate limited — bail, next tick resumes from cursor
      console.warn(`[GRANOLA_POLL] workspace=${conn.workspace_id} rate limited — pausing until next run`);
      break;
    }
    if (!res.ok) {
      console.warn(`[GRANOLA_POLL] workspace=${conn.workspace_id} list returned ${res.status}`);
      break;
    }

    const d = await res.json().catch(() => ({}));
    const notes = Array.isArray(d?.notes) ? d.notes : [];
    for (const n of notes) {
      if (!n?.id) continue;
      try {
        await reprocessGranola(supabase, conn.workspace_id, { type: 'poll', data: { id: n.id } });
        processed++;
      } catch (err) {
        // The cursor must not pass a note that failed (GET-444): it used to, and the note was
        // never looked at again. Hold it at the earliest failure; dedup makes the retry safe.
        console.warn(`[GRANOLA_POLL] note ${n.id} failed:`, err.message);
        if (n.created_at && (!failedAt || n.created_at < failedAt)) failedAt = n.created_at;
        continue;
      }
      if (n.created_at && n.created_at > newest) newest = n.created_at;
      if (processed >= MAX_NOTES_PER_RUN) { stop = true; break; }
      await sleep(NOTE_SPACING_MS);
    }

    if (!d?.hasMore || !d?.cursor) break;
    cursor = d.cursor;
  }

  // Advance the cursor so next run only sees newer notes (dedup still protects the
  // boundary note if the timestamp is inclusive).
  if (failedAt && failedAt < newest) newest = failedAt > since ? failedAt : since;
  if (newest !== since) {
    const creds = { ...conn.encrypted_credentials, granola_last_created_at: newest };
    await supabase.from('workflow_provider_connections')
      .update({ encrypted_credentials: creds })
      .eq('id', conn.id);
  }

  if (processed > 0) {
    console.log(`[GRANOLA_POLL] workspace=${conn.workspace_id}: ${processed} note(s) processed`);
  }
  return processed;
}

/**
 * Granola's history for the Backfill (GET-854): every note of every Granola connection in the
 * workspace created inside the window, through reprocessGranola like the live poll. Already-read
 * notes are no-ops (external_id dedup), so a resumed or re-run backfill pays only for new ones.
 * `guard` runs between notes so the job can stop (credits, AI provider) mid-history.
 */
export async function replayGranolaHistory(supabase, workspaceId, { sinceIso, guard = async () => {} } = {}) {
  const connections = (await getGranolaConnections(supabase)).filter(c => c.workspace_id === workspaceId);
  let read = 0, seen = 0;
  for (const conn of connections) {
    let apiKey = null;
    try { apiKey = decrypt(conn.encrypted_credentials?.api_key); } catch { /* skip */ }
    if (!apiKey) continue;
    try {
      for await (const notes of listNotes(apiKey, sinceIso, HISTORY_PAGES)) {
        for (const n of notes) {
          if (!n?.id) continue;
          try {
            const r = await reprocessGranola(supabase, workspaceId, { type: 'poll', data: { id: n.id } });
            if (!r?.deduped) read++;
          } catch (err) {
            console.warn(`[GRANOLA_HISTORY] note ${n.id} failed:`, err.message);
          }
          if (++seen % 10 === 0) await guard('granola');
          await sleep(NOTE_SPACING_MS);
        }
      }
    } catch (err) {
      if (err?.name === 'ProviderUnavailable' || err?.name === 'CreditsExhausted') throw err;   // the job pauses
      console.warn(`[GRANOLA_HISTORY] workspace=${workspaceId}:`, err.message);
    }
  }
  console.log(`[GRANOLA_HISTORY] workspace=${workspaceId}: ${read} note(s) read since ${sinceIso}`);
  return read;
}

export async function pollAllGranolaWorkspaces() {
  const supabase = getSupabaseClient();
  const connections = await getGranolaConnections(supabase);
  if (!connections.length) return 0;
  console.log(`[GRANOLA_POLL] Starting — ${connections.length} connection(s)`);

  let total = 0;
  for (const conn of connections) {
    try { total += await pollConnection(supabase, conn); }
    catch (e) { console.error(`[GRANOLA_POLL] workspace=${conn.workspace_id}:`, e.message); }
  }

  console.log(`[GRANOLA_POLL] Done — ${total} note(s) processed`);
  return total;
}
