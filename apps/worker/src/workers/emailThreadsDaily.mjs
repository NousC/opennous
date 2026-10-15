// Read the day's email, every day.
//
// The CRM sync pulls each night's email into observations (HubSpot, 02:00 UTC), and the Gmail scan
// files a connected mailbox every half hour. Neither READS it: the thread reader that turns a
// conversation into account facts and tasks (noema/gmailRead.mjs) only ever ran from
// scripts/backfillGmailThreads.mjs, by hand. On a customer workspace the last read was days old, so
// days of email — new asks, promises, risks — never reached an account or the Tasks page.
//
// Twice a day and on every worker boot (GET-503), per workspace with email: every thread with a
// message in the last `days` (3 — a missed run is caught by the next) that has not
// been read since that message arrived — a new thread, or a new reply on one read before. A
// re-read replaces the thread's previous tasks (readGmailThread) and new facts pass the duplicate
// check, so reading a thread again after a reply adds what the reply said and nothing twice.
//
// Cost is O(what arrived): a quiet day reads nothing. `maxThreads` caps one night; the rest is
// newest-first and waits for the next night. Under the one-writer lock, so it never runs beside a
// backfill on the same workspace.

import { mayReadWorkspace, noteCreditsSpent } from '../lib/creditGate.mjs';
import { getSupabaseClient, getInternalEntityIds, withBackfillLock, lockHolder, LockHeldError, CREDIT_SCALE } from '@nous/core';

/** Reads between two product usages inside one batch (GET-700). */
export const RECHECK_EVERY = 10;
import { loadEmailThreads, hydrateThreadBodies, selectEmailThreads, lastAt } from '../noema/emailThreads.mjs';
import { readGmailThread, markThreadSkipped, threadSourceRef, SOURCE } from '../noema/gmailRead.mjs';

const PAGE = 1000;

async function pageAll(makeQuery) {
  const rows = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await makeQuery(from, from + PAGE - 1);
    if (error) throw error;
    rows.push(...(data ?? []));
    if (!data || data.length < PAGE) return rows;
  }
}

/** Workspaces whose email we hold: a CRM that syncs, or a connected Gmail. */
async function emailWorkspaces(supabase) {
  const ids = new Set();
  const { data: crm } = await supabase.from('crm_sync_configs').select('workspace_id').eq('auto_sync', true);
  for (const r of crm ?? []) ids.add(r.workspace_id);
  const { data: gmail } = await supabase.from('workflow_provider_connections')
    .select('workspace_id, workflow_providers!inner(name)').eq('is_verified', true).eq('workflow_providers.name', 'gmail_oauth');
  for (const r of gmail ?? []) ids.add(r.workspace_id);
  return [...ids];
}

/** When each thread was last read: its read marker, else the newest claim that cites it. */
async function lastReadAt(supabase, workspaceId) {
  const at = new Map();
  const keep = (ref, t) => { if (ref && t && (!at.has(ref) || at.get(ref) < t)) at.set(ref, t); };
  const marks = await pageAll((a, b) => supabase.from('observations')
    .select('value, observed_at').eq('workspace_id', workspaceId).eq('property', 'noema.read').eq('source', SOURCE)
    .order('id').range(a, b));
  for (const m of marks) keep(m.value?.source_ref, m.value?.read_at ?? m.observed_at);
  // Threads read before the marker existed are proven by their claims (see backfillGmailThreads).
  // A RANGE on property, never a prefix LIKE — the LIKE cannot use the index (GET-396/414).
  const claimed = await pageAll((a, b) => supabase.from('claims')
    .select('value, valid_from').eq('workspace_id', workspaceId)
    .gte('property', 'note.').lt('property', 'note/').is('invalid_at', null)
    .like('value->metadata->>source_ref', `source://${SOURCE}/%`).order('id').range(a, b));
  for (const c of claimed) keep(c.value?.metadata?.source_ref, c.valid_from);
  return at;
}

/**
 * The threads due a read in one workspace: a message in the last `days`, and none of it read yet.
 * Newest first. Reads nothing and costs nothing — the model is only called in `readWorkspace`.
 */
export async function threadsToRead(supabase, workspaceId, { days = 3 } = {}) {
  const since = new Date(Date.now() - days * 86400000).toISOString();
  // A month of history, so a reply is read with the thread it answers, not on its own.
  const context = new Date(Date.now() - (days + 30) * 86400000).toISOString();
  const { threads } = await loadEmailThreads(supabase, workspaceId, { since: context });
  const people = await pageAll((a, b) => supabase.from('entities')
    .select('id').eq('workspace_id', workspaceId).eq('type', 'person').eq('status', 'active')
    .order('id').range(a, b));
  const internal = await getInternalEntityIds(supabase, workspaceId).catch(() => new Set());
  const externalIds = new Set(people.map(p => p.id).filter(id => !internal.has(id)));
  const readAt = await lastReadAt(supabase, workspaceId);
  const { units, skipped, skippedThreads } = selectEmailThreads({ threads, externalIds });
  const inWindow = (u) => { const last = lastAt(u); return !!last && last >= since; };
  const due = units.filter(u => {
    const last = lastAt(u);
    if (!last || last < since) return false;
    const read = readAt.get(threadSourceRef(u));
    return !read || new Date(read).getTime() < new Date(last).getTime();
  });
  return {
    due, externalIds, skipped, reread: due.filter(u => readAt.has(threadSourceRef(u))).length,
    // The window's threads we will not read, with the rule that said so.
    skippedThreads: skippedThreads.filter(s => inWindow(s.thread)),
  };
}

/** Read one workspace's due threads. Returns counts. */
export async function readWorkspace(supabase, workspaceId, { days = 3, maxThreads = 400, concurrency = 4, dryRun = false, markSkipsOnly = false, onProgress = null, countsAgainstMonth = true, deps = {} } = {}) {
  const gateFor = deps.mayReadWorkspace ?? mayReadWorkspace;
  const spent = deps.noteCreditsSpent ?? noteCreditsSpent;
  const readThread = deps.readGmailThread ?? readGmailThread;
  const load = deps.threadsToRead ?? threadsToRead;
  const hydrate = deps.hydrateThreadBodies ?? hydrateThreadBodies;
  const select = deps.selectEmailThreads ?? selectEmailThreads;
  const markSkip = deps.markThreadSkipped ?? markThreadSkipped;
  // THE CREDIT GATE (GET-531), for the workspace rather than once per thread. Threads it holds
  // back are left UNMARKED — not skipped — so they are read in full the moment a plan is chosen,
  // instead of being lost to the watermark while someone was over their allowance.
  //
  // A BACKFILL'S READS ARE NOT THE MONTH'S (GET-699): the caller passes countsAgainstMonth false
  // and sizes the batch from the backfill's own allowance. The month's allowance then neither
  // sizes nor stops it; only a workspace that is not paying at all ('no_plan') stops it.
  const monthGate = async (opts) => {
    const g = await gateFor(workspaceId, opts);
    if (countsAgainstMonth) return g;
    return { allowed: g.allowed || g.reason !== 'no_plan', reason: g.allowed || g.reason !== 'no_plan' ? null : g.reason, hardCap: false, untilStop: null };
  };
  let gate = await monthGate();
  // A hard cap is asked again, fresh: the batch is about to be sized from it (GET-700).
  if (gate.allowed && gate.hardCap) gate = await monthGate({ fresh: true });
  if (!gate.allowed) {
    return { due: 0, reread: 0, read: 0, facts: 0, tasks: 0, failed: 0, skipped: 0, deferred: 0, paused: gate.reason };
  }
  // INSIDE THE BATCH (GET-700). One yes used to buy the whole batch — up to 400 threads, 800
  // credits, against Free's 500. Now the batch is sized to what is left before reading stops,
  // each read is spent down from the gate's answer, and the gate is asked again every few reads,
  // so anything else spending (a meeting being read) is counted too. One thread is CREDIT_SCALE.
  const threadsLeft = (g) => (typeof g.untilStop === 'number' ? Math.floor(g.untilStop / CREDIT_SCALE) : Infinity);
  let budget = threadsLeft(gate);

  const { due, externalIds, reread, skippedThreads } = await load(supabase, workspaceId, { days });
  const batch = due.slice(0, Math.min(maxThreads, budget));
  const cappedByCredits = budget < Math.min(maxThreads, due.length);
  const stats = { due: due.length, reread, read: 0, facts: 0, tasks: 0, failed: 0, skipped: skippedThreads.length, deferred: Math.max(0, due.length - batch.length) };
  if (dryRun) return stats;
  // Record what was skipped and why. Database writes only; nothing is billed for these.
  const markSkipped = async (list) => {
    for (const { thread, why } of list) await markSkip(supabase, workspaceId, thread, why).catch(() => {});
  };
  await markSkipped(skippedThreads);
  if (cappedByCredits) stats.paused = 'over_credit_limit';
  if (!batch.length) return stats;
  await hydrate(supabase, workspaceId, batch);
  // The rule that needs a body is judged again now that there is one.
  const second = select({ threads: new Map(batch.map(u => [u.key, u])), externalIds });
  const { units } = second;
  stats.skipped += second.skippedThreads.length;
  await markSkipped(second.skippedThreads);
  // Record why threads were passed over, and read nothing: for windows a backfill read before
  // skips were recorded, which otherwise show as "Waiting" on the Activity page. No model call.
  if (markSkipsOnly) return stats;
  const queue = [...units];
  // How far along, for a caller that shows it (the backfill's progress, GET-557). Throttled: a
  // progress write per thread would cost more than the thread.
  let done = 0, lastReport = 0;
  const report = async (force = false) => {
    if (!onProgress || (!force && Date.now() - lastReport < 5000)) return;
    lastReport = Date.now();
    await Promise.resolve(onProgress({ total: units.length, done, read: stats.read, failed: stats.failed })).catch(() => {});
  };
  await report(true);
  let inFlight = 0, sinceCheck = 0, stopped = null;
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, async () => {
    for (;;) {
      if (stopped) break;
      if (sinceCheck >= RECHECK_EVERY) {
        sinceCheck = 0;
        const g = await monthGate();
        if (!g.allowed) { stopped = g.reason ?? 'over_credit_limit'; break; }
        // What the gate says is left, less what is being read right now.
        budget = threadsLeft(g) - inFlight;
      }
      if (budget <= 0) { stopped = 'over_credit_limit'; break; }
      const u = queue.shift();
      if (!u) break;
      budget--; inFlight++; sinceCheck++;
      try {
        const r = await readThread({ supabase, workspaceId, thread: u });
        if (r.skipped) { budget++; stats.skipped++; await markSkip(supabase, workspaceId, u, r.skipped).catch(() => {}); done++; await report(); continue; }
        stats.read++; stats.facts += r.facts.length; stats.tasks += r.commitments.length;
        if (countsAgainstMonth) spent(workspaceId, CREDIT_SCALE);
      } catch (err) {
        // Not marked read, so the next run takes it again — a failure is retried, never dropped.
        budget++;
        stats.failed++;
        console.error(`[EMAIL_DAILY] ${workspaceId} thread ${u.key} failed:`, err?.message || err);
      } finally {
        inFlight--;
      }
      done++;
      await report();
    }
  }));
  if (stopped) {
    // Held back, unmarked: read in full once there is allowance again.
    stats.deferred += queue.length;
    stats.paused = stopped;
  }
  await report(true);
  return stats;
}

/** Every email workspace, one at a time, each under its lock. */
export async function runEmailThreadsDaily({ workspaceId = null, ...opts } = {}) {
  const supabase = getSupabaseClient();
  const workspaces = workspaceId ? [workspaceId] : await emailWorkspaces(supabase);
  for (const ws of workspaces) {
    try {
      const stats = await withBackfillLock(supabase, ws, 'emailThreads', { holder: lockHolder('emailThreadsDaily'), leaseMinutes: 120 },
        () => readWorkspace(supabase, ws, opts));
      console.log(`[EMAIL_DAILY] ${ws} ${JSON.stringify(stats)}`);
    } catch (err) {
      if (err instanceof LockHeldError) console.log(`[EMAIL_DAILY] ${ws} skipped — ${err.message}`);
      else console.error(`[EMAIL_DAILY] ${ws} failed:`, err?.message || err);
    }
  }
}
