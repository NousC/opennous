// The history sync as the app sees it (GET-1087): the top-right button's "Syncing…" and the
// Sync done pop-up. Read from the sync's job rows; what landed is counted from the graph, so the
// numbers are what the workspace actually holds, not what one job reported.
import { ownerJobFilter } from './backfillStart.mjs';
import { countConversationsInWindow, countMeetingsInWindow, SYNC_WINDOW_DAYS } from './historyBackfill.mjs';

const ACTIVE = new Set(['pending', 'running']);

/** Running, done or failed, from the job rows, newest first. Pure. */
export function syncStateOf(jobs) {
  if (!jobs?.length) return 'none';
  if (jobs.some(j => ACTIVE.has(j.status))) return 'running';
  if (jobs.some(j => j.status === 'paused_trial_ended')) return 'stopped';
  return jobs.some(j => j.status === 'done') ? 'done' : 'failed';
}

async function syncJobs(supabase, workspaceId, ownerUserId) {
  const { data } = await ownerJobFilter(supabase.from('contact_enrichment_jobs')
    .select('job_id, status, updated_at, sync_seen_at:state->>sync_seen_at, sync_finished_at:state->>sync_finished_at')
    .eq('workspace_id', workspaceId)
    .eq('state->>sync_only', 'true'), ownerUserId)
    .order('created_at', { ascending: false })
    .limit(20);
  return data ?? [];
}

export async function syncStatus(supabase, workspaceId, ownerUserId = null) {
  const jobs = await syncJobs(supabase, workspaceId, ownerUserId);
  const state = syncStateOf(jobs);
  if (state === 'none') return { state, counts: null, seen: false, finished_at: null };

  const since = new Date(Date.now() - SYNC_WINDOW_DAYS * 86400_000).toISOString();
  const [{ count: accounts }, { count: people }, conv, meetings] = await Promise.all([
    supabase.from('entities').select('id', { count: 'exact', head: true })
      .eq('workspace_id', workspaceId).eq('type', 'company').eq('status', 'active'),
    supabase.from('contacts').select('id', { count: 'exact', head: true }).eq('workspace_id', workspaceId),
    countConversationsInWindow(supabase, workspaceId, since),
    countMeetingsInWindow(supabase, workspaceId, since),
  ]);
  return {
    state,
    counts: { accounts: accounts ?? 0, people: people ?? 0, conversations: (conv.email_thread ?? 0) + (conv.call ?? 0) + meetings },
    // Seen once is seen: a tool connected later re-syncs without a second pop-up.
    seen: jobs.some(j => j.sync_seen_at),
    finished_at: jobs.find(j => j.sync_finished_at)?.sync_finished_at ?? null,
  };
}

export async function markSyncSeen(supabase, workspaceId, ownerUserId = null) {
  const job = (await syncJobs(supabase, workspaceId, ownerUserId)).find(j => j.status === 'done');
  if (!job) return false;
  const { data: row } = await supabase.from('contact_enrichment_jobs').select('state').eq('job_id', job.job_id).maybeSingle();
  await supabase.from('contact_enrichment_jobs')
    .update({ state: { ...(row?.state ?? {}), sync_seen_at: new Date().toISOString() } })
    .eq('job_id', job.job_id);
  return true;
}
