// The read ledger: one record per conversation, stamped the moment we first read it (GET-510).
//
// A credit is one conversation read, and it is consumed WHEN IT IS READ. Email always knew that
// — its reader writes a noema.read marker per thread. Meetings and calls had no such record, so
// billing counted them by the date they HAPPENED: a backfill that read a few hundred Fellow and
// HubSpot meetings from last spring consumed nothing this month, on the page.
//
// Every reader already stamps what it writes with the conversation it came from
// (`source://fellow/<id>`, `source://ringcentral/<id>`, `source://hubspot/hubspot_meetings_<id>`).
// So rather than teaching each reader to keep a ledger, this sweeps new claims every fifteen
// minutes and writes one `noema.read` per conversation the first time a claim cites it — at that
// claim's time, with its credits. The dedup key makes it once per conversation, so a re-read
// never bills twice. Email is skipped: its reader writes its own.

import { getSupabaseClient, recordObservation } from '@nous/core';

const PAGE = 1000;
const FIRST_LOOKBACK_DAYS = 60;   // a workspace's first sweep reaches back this far
const MEETING_CREDITS = 3;        // 30 minutes, the measured median, at one credit per ten
const MEETING = new Set(['fellow', 'fireflies', 'granola', 'fathom', 'otter', 'zoom', 'gong', 'chorus', 'meet']);
const CALL = new Set(['ringcentral', 'justcall', 'aircall', 'dialpad', 'openphone']);

/** What reading this conversation costs, or null when it is not a billable conversation. */
export function readCredits(sourceRef, meta = {}) {
  const m = /^source:\/\/([^/]+)\/(.+)$/.exec(String(sourceRef ?? ''));
  if (!m) return null;
  const [, system, id] = m;
  if (system === 'gmail') return null;                       // its reader keeps its own ledger
  let kind = MEETING.has(system) ? 'meeting' : CALL.has(system) ? 'call' : null;
  if (system === 'hubspot') kind = /meeting/.test(id) ? 'meeting' : /call/.test(id) ? 'call' : null;   // notes are free
  if (!kind) return null;
  if (kind === 'call') return { kind, system, credits: 1 };
  // A meeting's length when the reader recorded it (seconds or minutes), else the median.
  const raw = Number(meta.duration ?? meta.duration_minutes ?? NaN);
  const mins = Number.isFinite(raw) && raw > 0 ? (raw > 600 ? raw / 60 : raw) : null;
  return { kind, system, credits: mins ? Math.max(1, Math.ceil(mins / 10)) : MEETING_CREDITS };
}

/**
 * The ledger row for one read. `api_key_id` says which API key caused it (API plan E6, GET-620):
 * the key that wrote the claim that first cited the conversation (recordObservations stamps
 * `metadata.api_key_id` on claims written through a key), or null when that claim came from an
 * integration, the worker or the app. Always present, null included, so a read written from here
 * on is told apart from one written before keys were stamped (no field: cause unknown).
 */
export function readValue(claim, bill) {
  const key = claim?.meta?.api_key_id;
  return {
    source_ref: claim.ref, kind: bill.kind, credits: bill.credits, read_at: claim.valid_from,
    ...(bill.minutes ? { minutes: bill.minutes } : {}),
    api_key_id: typeof key === 'string' && key ? key : null,
  };
}

async function watermark(supabase, workspaceId) {
  const { data } = await supabase.from('observations').select('observed_at')
    .eq('workspace_id', workspaceId).eq('property', 'noema.read').neq('source', 'gmail')
    .order('observed_at', { ascending: false }).limit(1);
  return data?.[0]?.observed_at ?? new Date(Date.now() - FIRST_LOOKBACK_DAYS * 86400000).toISOString();
}

/**
 * How long a meeting ran, in minutes, from the meeting's own record, or null (GET-516). Fellow
 * stores `duration_minutes` on it; HubSpot an `end_time` beside the start. Narrowed by the
 * (workspace, property) index to the workspace's meetings before the raw filter.
 */
export async function meetingMinutes(supabase, workspaceId, sourceRef) {
  const m = /^source:\/\/([^/]+)\/(.+)$/.exec(String(sourceRef ?? ''));
  if (!m) return null;
  const [, system, id] = m;
  let q = supabase.from('observations').select('observed_at, end_time:raw->>end_time, minutes:raw->>duration_minutes')
    .eq('workspace_id', workspaceId).eq('property', 'interaction.meeting_held').eq('source', system);
  if (system === 'fellow') q = q.eq('raw->>note_id', id);
  else if (system === 'hubspot') q = q.like('external_id', `${id}_%`);
  else return null;
  const { data } = await q.limit(1);
  const row = data?.[0];
  if (!row) return null;
  const mins = Number(row.minutes);
  if (Number.isFinite(mins) && mins > 0) return mins;
  const span = (Date.parse(row.end_time ?? '') - Date.parse(row.observed_at ?? '')) / 60000;
  return Number.isFinite(span) && span > 0 && span < 600 ? span : null;
}

/** Sweep one workspace's claims written since its watermark. Returns how many reads it recorded. */
export async function sweepWorkspace(supabase, workspaceId, { since = null } = {}) {
  const from = since ?? await watermark(supabase, workspaceId);
  const seen = new Set();
  let recorded = 0;
  for (let off = 0; ; off += PAGE) {
    // By WRITE time (computed_at), aliased to the valid_from readValue reads. Since GET-770 a
    // claim's valid_from is when its source was said — a backfill's facts, a thread read a day
    // late, a transcript landing after a newer call all predate the watermark and would never
    // bill. The read happened when we wrote the claim, so it is billed then.
    const { data, error } = await supabase.from('claims')
      .select('entity_id, valid_from:computed_at, ref:value->metadata->>source_ref, meta:value->metadata')
      .eq('workspace_id', workspaceId).gte('computed_at', from)
      .not('value->metadata->>source_ref', 'is', null)
      .order('computed_at').range(off, off + PAGE - 1);
    if (error) throw error;
    for (const c of data ?? []) {
      if (!c.ref || seen.has(c.ref)) continue;
      seen.add(c.ref);
      let bill = readCredits(c.ref, c.meta ?? {});
      if (!bill) continue;
      // A meeting bills by its real length when its record has one (GET-516).
      if (bill.kind === 'meeting' && !(c.meta?.duration || c.meta?.duration_minutes)) {
        const mins = await meetingMinutes(supabase, workspaceId, c.ref).catch(() => null);
        if (mins) bill = { ...bill, credits: Math.max(1, Math.ceil(mins / 10)), minutes: Math.round(mins) };
      }
      const row = await recordObservation(supabase, {
        workspaceId, entityId: c.entity_id, kind: 'state', property: 'noema.read',
        externalId: `read_${c.ref}`,
        value: readValue(c, bill),
        source: bill.system, method: 'extraction', observedAt: c.valid_from,
      }).catch(() => null);
      if (row) recorded++;
    }
    if (!data || data.length < PAGE) break;
  }
  return recorded;
}

export async function runReadLedger() {
  const supabase = getSupabaseClient();
  const { data: workspaces } = await supabase.from('workspaces').select('id');
  for (const w of workspaces ?? []) {
    try {
      const n = await sweepWorkspace(supabase, w.id);
      if (n) console.log(`[READ_LEDGER] ${w.id} ${n} read(s) recorded`);
    } catch (err) {
      console.error(`[READ_LEDGER] ${w.id} failed:`, err?.message || err);
    }
  }
}

/**
 * Re-price meeting reads recorded at the 30-minute median, now that a meeting's real length can be
 * read from its record (GET-516). Only ever moves a read to its measured length.
 */
export async function repriceMeetings(supabase, workspaceId, { since }) {
  let changed = 0;
  for (let off = 0; ; off += PAGE) {
    const { data, error } = await supabase.from('observations').select('id, value')
      .eq('workspace_id', workspaceId).eq('property', 'noema.read').neq('source', 'gmail')
      .gte('observed_at', since).order('id').range(off, off + PAGE - 1);
    if (error) throw error;
    for (const r of data ?? []) {
      if (r.value?.kind !== 'meeting' || r.value?.minutes) continue;
      const mins = await meetingMinutes(supabase, workspaceId, r.value?.source_ref).catch(() => null);
      if (!mins) continue;
      const credits = Math.max(1, Math.ceil(mins / 10));
      const { error: e } = await supabase.from('observations')
        .update({ value: { ...r.value, credits, minutes: Math.round(mins) } }).eq('id', r.id);
      if (!e) changed++;
    }
    if (!data || data.length < PAGE) break;
  }
  return changed;
}
