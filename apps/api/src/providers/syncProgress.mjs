/**
 * How far is each connection's running sync? (GET-620, E5)
 *
 * The API plan's source cards say "Syncing n%" with a thin bar while a source is being pulled
 * in. The only sync in Nous with a measurable denominator is the history backfill
 * (contact_enrichment_jobs, the same row /api/backfill/preview and the sidebar's Backfill pill
 * read), and it is measurable per source:
 *
 *   filing   state.contacts[].sources[<source>] is one lane per (account × source), each
 *            pending → scanning → done | failed (skipped when the source is not connected).
 *            A source's progress is its finished lanes over its lanes.
 *   reading  after filing (state.filed_at), the job reads the email it filed;
 *            state.reading = { total, done } counts threads. That is the email sources' progress.
 *
 * CRM pulls (syncCrmProvider) page through the CRM without knowing the total, and the 15-minute
 * auto-sync has no running flag, so a CRM card has no progress to show and gets null. Never a
 * made-up number: no running job, a stale one (no heartbeat for STALE_MS), a source with no
 * lanes, or a source whose part is finished all read null.
 *
 * A member's own backfill (state.owner_user_id) covers their personal connections; the
 * workspace's (no owner) covers shared ones, and a personal one when its owner has no job.
 * One read, under the same deadline as last_synced. A miss is an empty map, never an error.
 */
import { sourceKeyFor, withDeadline } from './lastSynced.mjs';

/** A running job whose row has not moved for this long is not running (the worker heartbeats every few seconds). */
export const STALE_MS = 30 * 60 * 1000;

/** The sources whose history the reading phase reads. */
const EMAIL_SOURCES = new Set(['gmail', 'smtp']);
const FINISHED = new Set(['done', 'failed']);

const progress = (done, total, label) => {
  if (!(total > 0) || !(done >= 0) || done >= total) return null;
  return { percent: Math.min(99, Math.floor((done / total) * 100)), done, total, label };
};

/**
 * One connection's progress from the running jobs, or null. Pure.
 * `jobs` are contact_enrichment_jobs rows ({ status, done, updated_at, state }).
 */
export function progressForConnection(conn, jobs, now = Date.now()) {
  const key = sourceKeyFor(conn?.provider?.name);
  if (!key || !jobs?.length) return null;
  const live = jobs.filter((j) => j && j.status === 'running' && !j.done
    && Number.isFinite(Date.parse(j.updated_at)) && now - Date.parse(j.updated_at) < STALE_MS);
  const ownerOf = (j) => j.state?.owner_user_id ?? null;
  const job = conn.scope === 'personal'
    ? (live.find((j) => conn.owner_user_id && ownerOf(j) === conn.owner_user_id) ?? live.find((j) => ownerOf(j) === null))
    : live.find((j) => ownerOf(j) === null);
  if (!job) return null;
  const state = job.state ?? {};

  if (!state.filed_at) {
    const lanes = (state.contacts ?? []).map((c) => c?.sources?.[key]).filter((s) => s && s.status !== 'skipped');
    return progress(lanes.filter((s) => FINISHED.has(s.status)).length, lanes.length, 'Importing history');
  }
  if (!EMAIL_SOURCES.has(key)) return null;
  const r = state.reading;
  if (!r || r.finished || r.deferred) return null;
  return progress(Number(r.done) || 0, Number(r.total) || 0, 'Reading email');
}

/** Map connection id → { percent, done, total, label } | null. */
export async function syncProgressByConnection(supabase, workspaceId, conns, { deadlineMs = 1500, now = Date.now() } = {}) {
  const out = new Map();
  if (!conns?.length) return out;
  for (const c of conns) out.set(c.id, null);
  const res = await withDeadline(
    supabase.from('contact_enrichment_jobs')
      .select('job_id, status, done, updated_at, state')
      .eq('workspace_id', workspaceId)
      .eq('status', 'running')
      .order('created_at', { ascending: false })
      .limit(10),
    deadlineMs,
  );
  if (!res || res.error) {
    if (res?.error) console.warn('[sync_progress] job read failed:', res.error.message);
    return out;
  }
  const jobs = res.data ?? [];
  if (!jobs.length) return out;
  for (const c of conns) out.set(c.id, progressForConnection(c, jobs, now));
  return out;
}
