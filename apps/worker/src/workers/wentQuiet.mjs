// Deals that went quiet are closed (GET-1028).
//
// The decay only ever demoted the early rungs (interested and below). From discovery up nothing
// moved a deal again, so one call 121 days ago kept an account "in discovery" for good, and its
// days-in-stage and odds read as a live deal. Now an open deal from discovery up whose people have
// not answered or met with us for QUIET_DAYS is closed lost, marked `went_quiet` so it can be told
// apart from a deal someone lost. Newsletters and other bulk mail never count as an answer, and
// our own sends never do. A real reply later revives it, as for any lost deal.
//
// Only stages the funnel inferred. A stage the CRM set, or a person set by hand, is theirs to move.
import { getSupabaseClient, moveToStage } from '@nous/core';

export const QUIET_DAYS = 60;
// Closing deals by itself is new, so the nightly run only covers the workspaces listed here
// (comma-separated ids) until it has been checked on each. The script runs it anywhere on demand.
export const nightlyWorkspaces = () => String(process.env.WENT_QUIET_WORKSPACES || '').split(',').map(s => s.trim()).filter(Boolean);
const OPEN = ['discovery', 'demo', 'negotiation'];
// A sign of life: they wrote, or we met.
const ANSWERS = ['interaction.email_received', 'interaction.email_reply', 'interaction.email_replied', 'interaction.slack_message',
  'interaction.slack_dm', 'interaction.linkedin_message', 'interaction.meeting_held', 'interaction.call_held'];

/** Their answer, not ours and not a newsletter. Pure. */
export function isSignOfLife(o) {
  const raw = o?.raw ?? {};
  if (raw.is_outbound === true || raw.is_outbound === 'true') return false;
  if (raw.bulk === true || raw.bulk === 'true') return false;
  return ANSWERS.includes(o?.property);
}

/** Which deal groups went quiet: every person's last sign of life is older than the cutoff. Pure. */
export function quietGroups(groups, lastLife, cutoffIso) {
  return [...groups.entries()].filter(([, people]) =>
    people.every(p => !lastLife.get(p.id) || lastLife.get(p.id) < cutoffIso)
    && people.some(p => (p.stageSince ?? '') < cutoffIso));
}

/** The nightly job: each listed workspace in turn; none listed, nothing runs. */
export async function runWentQuietNightly({ log = console } = {}) {
  const list = nightlyWorkspaces();
  if (!list.length) return { closed: 0, skipped: 'no workspaces listed in WENT_QUIET_WORKSPACES' };
  let closed = 0;
  for (const workspaceId of list) closed += (await runWentQuiet({ workspaceId, log })).closed;
  return { closed };
}

export async function runWentQuiet({ supabase = getSupabaseClient(), now = Date.now(), dryRun = false, workspaceId = null, log = console } = {}) {
  const cutoff = new Date(now - QUIET_DAYS * 86_400_000).toISOString();
  let q = supabase.from('contacts').select('id, workspace_id, company_id, pipeline_stage').in('pipeline_stage', OPEN).limit(5000);
  if (workspaceId) q = q.eq('workspace_id', workspaceId);
  const { data: open, error } = await q;
  if (error) throw error;
  if (!open?.length) return { closed: 0 };

  // Who set the stage, and when: the newest transition per person.
  const since = new Map(), setBy = new Map();
  const ids = open.map(c => c.id);
  for (let i = 0; i < ids.length; i += 300) {
    const { data } = await supabase.from('observations').select('entity_id, source, observed_at')
      .in('entity_id', ids.slice(i, i + 300)).eq('property', 'pipeline_stage').order('observed_at', { ascending: false });
    for (const o of data ?? []) if (!since.has(o.entity_id)) { since.set(o.entity_id, o.observed_at); setBy.set(o.entity_id, o.source); }
  }
  // One deal per company (a person with none is their own); every person on it must be inferred.
  const groups = new Map();
  for (const c of open) {
    const key = `${c.workspace_id}:${c.company_id ?? c.id}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ id: c.id, workspace_id: c.workspace_id, stageSince: since.get(c.id) ?? null, inferred: (setBy.get(c.id) ?? 'system') === 'system' });
  }
  for (const [k, people] of groups) if (!people.every(p => p.inferred)) groups.delete(k);

  const lastLife = new Map();
  const groupIds = [...groups.values()].flat().map(p => p.id);
  for (let i = 0; i < groupIds.length; i += 200) {
    const { data } = await supabase.from('observations').select('entity_id, property, observed_at, raw')
      .in('entity_id', groupIds.slice(i, i + 200)).in('property', ANSWERS).gte('observed_at', cutoff).limit(5000);
    for (const o of data ?? []) {
      if (!isSignOfLife(o)) continue;
      if ((lastLife.get(o.entity_id) ?? '') < o.observed_at) lastLife.set(o.entity_id, o.observed_at);
    }
  }
  let closed = 0;
  for (const [key, people] of quietGroups(groups, lastLife, cutoff)) {
    log.log?.(`[WENT_QUIET] ${key}: no answer in ${QUIET_DAYS} days → closed_lost (${people.length} person(s))${dryRun ? ' (dry run)' : ''}`);
    if (!dryRun) for (const p of people) await moveToStage(supabase, p.workspace_id, p.id, 'closed_lost', { now, method: 'went_quiet' }).catch(() => {});
    closed++;
  }
  log.log?.(`[WENT_QUIET] ${closed} deal(s) ${dryRun ? 'would close' : 'closed'}`);
  return { closed };
}
