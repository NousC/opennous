// Fireflies and Fathom pollers (GET-854) — the self-host ingest path.
//
// On Cloud a finished meeting arrives by webhook. A self-hosted install usually has no public
// address for Fireflies or Fathom to call (localhost, a private network), so its new meetings
// never arrived at all: only the Backfill ever read them. This polls each connection every 15
// minutes for meetings newer than the last one it read, and replays each through the same handler
// the webhook uses (reprocessFireflies / reprocessFathom) with read-once on, so a meeting that
// also arrives by webhook is never read twice.
//
// The first scan starts from when the tool was connected: history before that is the Backfill's
// to read, inside the window the owner confirmed. The cursor (the newest meeting time read) is
// kept plain on the connection's credentials, like the Granola poller's.

import { getSupabaseClient } from '@nous/core';
import { reprocessFireflies, firefliesBodyFromTranscript, FIREFLIES_TRANSCRIPT_FIELDS } from '../webhooks/handlers/fireflies.mjs';
import { reprocessFathom } from '../webhooks/handlers/fathom.mjs';
import { decrypt } from '../utils/encryption.mjs';

const PAGE_SIZE = 25;
const MAX_PAGES = 4;              // 100 meetings a connection a tick; the rest next tick
const FIRST_RUN_FALLBACK_MS = 86400000;

async function connectionsFor(supabase, name) {
  const { data: provider } = await supabase
    .from('workflow_providers').select('id').eq('name', name).maybeSingle();
  if (!provider?.id) return [];
  const { data } = await supabase
    .from('workflow_provider_connections')
    .select('id, workspace_id, encrypted_credentials, created_at')
    .eq('is_verified', true)
    .eq('provider_id', provider.id);
  return data || [];
}

function keyOf(conn) {
  try { return decrypt(conn.encrypted_credentials?.api_key) || null; } catch { return null; }
}

const ms = (v) => {
  if (v == null) return NaN;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) && n > 1e11 ? n : new Date(v).getTime();
};

/**
 * Of a newest-first list, the items strictly newer than `sinceMs`, oldest first, and whether the
 * list reached back past the cursor (so there is no need to read another page). Pure.
 */
export function newerThan(items, sinceMs, timeOf) {
  const fresh = [];
  let reachedCursor = false;
  for (const it of items) {
    const t = ms(timeOf(it));
    if (!Number.isFinite(t)) continue;
    if (t <= sinceMs) { reachedCursor = true; continue; }
    fresh.push({ it, t });
  }
  return { fresh: fresh.sort((a, b) => a.t - b.t), reachedCursor };
}

/**
 * Read a connection's meetings newer than its cursor, oldest first, then move the cursor past
 * every one read. A meeting that fails holds the cursor just before it, so it is retried next tick.
 */
async function pollOne(supabase, conn, { cursorField, listPage, timeOf, replay, label }) {
  const apiKey = keyOf(conn);
  if (!apiKey) return 0;
  const sinceMs = ms(conn.encrypted_credentials?.[cursorField])
    || ms(conn.created_at)
    || Date.now() - FIRST_RUN_FALLBACK_MS;

  const fresh = [];
  let cursor = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const { items, next } = await listPage(apiKey, page, cursor);
    const r = newerThan(items, sinceMs, timeOf);
    fresh.push(...r.fresh);
    if (r.reachedCursor || !next) break;
    cursor = next;
  }
  fresh.sort((a, b) => a.t - b.t);

  let read = 0, newest = sinceMs;
  for (const { it, t } of fresh) {
    try {
      await replay(supabase, conn.workspace_id, it);
      read++;
      newest = t;
    } catch (err) {
      console.warn(`[${label}_POLL] workspace=${conn.workspace_id} meeting failed:`, err?.message || err);
      break;
    }
  }
  if (newest > sinceMs) {
    await supabase.from('workflow_provider_connections')
      .update({ encrypted_credentials: { ...conn.encrypted_credentials, [cursorField]: new Date(newest).toISOString() } })
      .eq('id', conn.id);
  }
  if (read) console.log(`[${label}_POLL] workspace=${conn.workspace_id}: ${read} meeting(s) read`);
  return read;
}

const FIREFLIES = {
  label: 'FIREFLIES',
  cursorField: 'fireflies_last_date',
  timeOf: (t) => t?.date,
  async listPage(apiKey, page) {
    const query = `query { transcripts(limit: ${PAGE_SIZE}, skip: ${page * PAGE_SIZE}) {
        ${FIREFLIES_TRANSCRIPT_FIELDS}
      } }`;
    const res = await fetch('https://api.fireflies.ai/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ query }),
    });
    if (!res.ok) throw new Error(`Fireflies list returned ${res.status}`);
    const d = await res.json();
    if (d.errors?.length && !d.data?.transcripts) throw new Error(`Fireflies: ${JSON.stringify(d.errors).slice(0, 160)}`);
    const items = d.data?.transcripts || [];
    return { items, next: items.length === PAGE_SIZE ? page + 1 : null };
  },
  replay: (supabase, ws, t) => reprocessFireflies(supabase, ws, firefliesBodyFromTranscript(t), { onceOnly: true }),
};

const FATHOM = {
  label: 'FATHOM',
  cursorField: 'fathom_last_start',
  timeOf: (m) => m?.recording_start_time || m?.scheduled_start_time || m?.created_at,
  async listPage(apiKey, _page, cursor) {
    const url = `https://api.fathom.ai/external/v1/meetings?limit=10&include_transcript=true${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const res = await fetch(url, { headers: { 'X-Api-Key': apiKey } });
    if (!res.ok) throw new Error(`Fathom list returned ${res.status}`);
    const d = await res.json();
    return { items: d.items || [], next: d.next_cursor || null };
  },
  replay: (supabase, ws, m) => reprocessFathom(supabase, ws, m, { onceOnly: true }),
};

export async function pollNotetakers() {
  const supabase = getSupabaseClient();
  let total = 0;
  for (const [name, spec] of [['fireflies', FIREFLIES], ['fathom', FATHOM]]) {
    for (const conn of await connectionsFor(supabase, name)) {
      try { total += await pollOne(supabase, conn, spec); }
      catch (e) { console.warn(`[${spec.label}_POLL] workspace=${conn.workspace_id}:`, e?.message || e); }
    }
  }
  return total;
}
