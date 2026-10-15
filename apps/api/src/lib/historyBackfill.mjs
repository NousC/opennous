import { randomUUID } from 'crypto';
import { checkBackfillBudget } from './backfillBudget.mjs';
import { countHistoryAtSource, monthlyCredits } from './historyCount.mjs';
import { getPlanFromSubscription, getTeamAiCredits, isSelfHosted } from './plans.mjs';
import { ownerJobFilter } from './backfillStart.mjs';
import { sendEmail } from '@nous/core';

// Enqueue a history backfill for a workspace's EXISTING accounts. Called after a new
// integration connects, so the accounts already in the graph get their past emails,
// meetings, LinkedIn threads etc. pulled from the freshly-connected source. The worker
// (contactEnrichmentJobs → enrichContactHistory) scans every connected source and dedups
// by external_id, so re-running is safe: already-scanned sources produce no duplicates,
// the new one fills in.
//
// Debounced: if a backfill is already pending/running for the workspace, we skip rather
// than stack jobs when someone connects two tools back to back. Best-effort — a failure
// here must never break the connect flow.
export async function enqueueWorkspaceHistoryBackfill(supabase, workspaceId, { limit = 2000, reason = 'integration_connected', windowDays = 90, ownerUserId = null } = {}) {
  if (!workspaceId) return null;
  try {
    // Debounce, but only against a job that hasn't started.
    //
    // A PENDING job resolves its credentials when it starts, so it will pick up the source
    // that was just connected — skipping is correct and avoids stacking duplicates. A RUNNING
    // job already resolved them, so the new source is invisible to it and would never be
    // scanned at all. That is the case that bit us: connect HubSpot, then Fireflies four
    // minutes later while the first backfill is mid-flight, and Fireflies is silently dropped
    // forever. The worker claims one job at a time, so a follow-up queues behind it rather
    // than running alongside it.
    // Per owner (GET-571): a member's backfill is not the founder's, and does not wait on it.
    const { data: inflight } = await ownerJobFilter(supabase
      .from('contact_enrichment_jobs')
      .select('job_id, status')
      .eq('workspace_id', workspaceId)
      .in('status', ['pending', 'running']), ownerUserId);
    if ((inflight ?? []).some(j => j.status === 'pending')) {
      console.log(`[BACKFILL_ON_CONNECT] ws=${workspaceId} a backfill is queued and will pick this up — skipping (${reason})`);
      return null;
    }
    if ((inflight ?? []).length) {
      console.log(`[BACKFILL_ON_CONNECT] ws=${workspaceId} a backfill is already running and cannot see this source — queueing a follow-up (${reason})`);
    }

    // Only accounts a new source can actually match: they need an email or a LinkedIn
    // handle. Newest activity first so the most relevant accounts backfill soonest.
    const { data: rows } = await supabase
      .from('contacts')
      .select('id, email, first_name, last_name, company, company_id, linkedin_url, linkedin_member_id')
      .eq('workspace_id', workspaceId)
      .or('email.not.is.null,linkedin_url.not.is.null')
      .order('last_activity_at', { ascending: false, nullsFirst: false })
      .limit(limit);

    const contacts = (rows || [])
      .filter(c => c.email || c.linkedin_url)
      .map(c => ({
        id: c.id,
        email: c.email ? String(c.email).toLowerCase().trim() : null,
        first_name: c.first_name || null,
        last_name: c.last_name || null,
        company: c.company || null,
        company_id: c.company_id || null,
        linkedin_url: c.linkedin_url || null,
        linkedin_member_id: c.linkedin_member_id || null,
      }));
    // Zero accounts is not always nothing to do.
    //
    // A notetaker replays the WHOLE workspace: scanFirefliesReplay / scanFathomReplay page
    // every meeting, resolve the room to people, and CREATE the contact when a meeting has no
    // match. That is the one path that can seed a graph from an empty workspace — and it sat
    // behind this early return, which required a graph to already exist. Connect Fireflies on
    // a new workspace and nothing happened, silently and forever.
    //
    // So when there is nothing to enrich but something that can DISCOVER, the job still goes
    // out. Every per-contact lane pools over an empty list and does nothing; only the
    // workspace-level replays run.
    if (!contacts.length) {
      const discoverer = await hasDiscoverySource(supabase, workspaceId);
      if (!discoverer) return null;
      console.log(`[BACKFILL_ON_CONNECT] ws=${workspaceId} no accounts yet — ${discoverer} can discover them (${reason})`);
    }

    // Price it before running it. Counting is a database read, not a model call, so this
    // costs nothing — and enqueue time is the last point where the bill is still hypothetical.
    const budget = await assessBackfillBudget(supabase, workspaceId, { windowDays, ownerUserId, addresses: contacts.map(c => c.email).filter(Boolean) });
    // THE SMALLER OFFER (GET-515). When three months is over the plan's backfill allowance, the
    // last thirty days often is not — so the customer is offered that, and only a history too big
    // for even that goes to us.
    const budget30 = budget?.needsSupport && windowDays > 30
      ? await assessBackfillBudget(supabase, workspaceId, { windowDays: 30, ownerUserId, addresses: contacts.map(c => c.email).filter(Boolean) })
      : null;
    const needsSupport = Boolean(budget?.needsSupport) && !(budget30 && !budget30.needsSupport);
    const overAllowance = Boolean(budget?.needsSupport) && !needsSupport;

    // NOTHING RUNS UNTIL SOMEONE SAYS YES (GET-486).
    //
    // The job is always written, always paused, holding the account list and the estimate.
    // Under the ceiling it waits for the customer to confirm a sentence that names what we
    // found; over it, it waits for us. Both are a person answering a question, which is why
    // neither resumes on its own the way the credits pause does — a wallet refills itself.
    // ONE WAITING BACKFILL PER WORKSPACE (GET-549). Each connect used to write its own job, so a
    // customer connecting a CRM, Gmail and a notetaker left three waiting and confirmed one. A
    // job nobody has said yes to yet is re-priced in place instead: same row, the newest count.
    const { data: waiting } = await ownerJobFilter(supabase
      .from('contact_enrichment_jobs')
      .select('job_id, state')
      .eq('workspace_id', workspaceId)
      .eq('status', 'paused_awaiting_confirmation'), ownerUserId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    const jobId = waiting?.job_id ?? randomUUID();
    const row = {
      contact_ids: contacts.map(c => c.id),
      contacts,
      window_days: windowDays,
      status: 'paused_awaiting_confirmation',
      paused_reason: needsSupport ? 'over_ceiling' : overAllowance ? 'over_allowance' : 'awaiting_confirmation',
      paused_at: new Date().toISOString(),
      // What the estimate card shows: the full window and, when that is over, the last 30 days.
      // A yes already given before paying (start_on_payment) survives the re-price.
      state: {
        estimate: budget ?? null, estimate_30: budget30 ?? null,
        ...(ownerUserId ? { owner_user_id: ownerUserId } : {}),
        ...(waiting?.state?.start_on_payment ? { start_on_payment: waiting.state.start_on_payment } : {}),
      },
    };
    const { error } = waiting
      ? await supabase.from('contact_enrichment_jobs').update(row).eq('job_id', jobId).eq('status', 'paused_awaiting_confirmation')
      : await supabase.from('contact_enrichment_jobs').insert({ job_id: jobId, workspace_id: workspaceId, ...row });
    if (error) {
      console.error('[BACKFILL_ON_CONNECT] enqueue failed:', error.message);
      return null;
    }
    const priced = budget
      ? `${budget.basis} $${budget.estimateUsd} / ${budget.credits} credits` +
        (budget.ceilingUsd === null ? ' (no ceiling)' : ` against a $${budget.ceilingUsd} ceiling`)
      : 'unpriced';
    if (needsSupport) {
      console.log(
        `[BACKFILL_ON_CONNECT] ws=${workspaceId} job=${jobId} needs assisted onboarding — ` +
        `${priced}, ${contacts.length} accounts (${reason})`,
      );
      await notifyAssistedOnboarding(supabase, workspaceId, budget).catch(() => {});
      return null;
    }
    console.log(
      `[BACKFILL_ON_CONNECT] ws=${workspaceId} job=${jobId} awaiting confirmation — ` +
      `${priced}, ${contacts.length} accounts (${reason})`,
    );
    return jobId;
  } catch (err) {
    console.error('[BACKFILL_ON_CONNECT] non-fatal:', err?.message || err);
    return null;
  }
}

// What this workspace's backfill would cost, and whether its plan can carry it.
//
// Two ways to price it, in order of how much we trust them:
//
//  1. COUNT the conversations already in the graph for the window. Exact, and available
//     whenever a source synced before the backfill was asked for — a second integration
//     connecting, or a re-run.
//  2. PROJECT from CRM record volume. Every first backfill lands here, because records
//     sync first and conversations arrive with the backfill itself. Deliberately sized
//     off the largest customer workspace we have, so it over-estimates a normal one:
//     an over-estimate costs a conversation with a customer, an under-estimate costs
//     money nobody agreed to spend.
//
// Fails OPEN. A workspace whose plan or counts we cannot read gets its backfill, because
// a lookup failing is not a reason to hold someone's onboarding.
/**
 * The plan a backfill is priced against. A self-hosted install has no allowance and no ceiling: it
 * reads with the operator's own keys, so it prices as Custom (no limit) whatever subscription row
 * the team carries (every team gets a `free` one at sign-up, GET-850).
 */
export function backfillPlanId(subscription, { selfHosted = isSelfHosted() } = {}) {
  if (selfHosted) return 'custom';
  return getPlanFromSubscription(subscription)?.id ?? 'custom';
}

async function assessBackfillBudget(supabase, workspaceId, { windowDays = 90, addresses = [], ownerUserId = null } = {}) {
  try {
    const { data: ws } = await supabase
      .from('workspaces').select('team_id').eq('id', workspaceId).maybeSingle();
    let planId = 'custom';
    // What earlier backfills already spent from the workspace's pool (GET-571).
    let used = 0;
    if (ws?.team_id) {
      const { data: subscription } = await supabase
        .from('subscriptions').select('*').eq('team_id', ws.team_id).maybeSingle();
      planId = backfillPlanId(subscription);
      if (!isSelfHosted()) {
        try { used = (await getTeamAiCredits(supabase, ws.team_id, subscription))?.backfill?.used ?? 0; } catch { used = 0; }
      }
    }

    const since = new Date(Date.now() - windowDays * 86400_000).toISOString();
    let counts = await countConversationsInWindow(supabase, workspaceId, since);
    // What a month of this workspace bills ongoing — the panel recommends a plan from it (GET-549).
    let monthly = null;
    // Who the note-taker's meetings will add that the graph does not hold yet (GET-788).
    let discovered = null;

    // NOTHING FILED YET (GET-549): count at the source instead of projecting from the CRM's size,
    // so the panel can say what it found and price a real number. Metadata only, no model.
    // A member's backfill is their own mailbox and notes (GET-571): what the workspace has already
    // filed is the founder's history, not theirs, so it always counts at the source.
    if (ownerUserId) counts = { email_thread: 0, call: 0, meeting: 0, note: 0 };
    // No contacts is no longer a reason to skip it (GET-788): a workspace whose only source is its
    // note-taker has meetings to count and people to meet before anyone is on the graph.
    if (!Object.values(counts).some(n => n > 0)) {
      const window = await countHistoryAtSource(supabase, workspaceId, addresses, { days: windowDays, ownerUserId });
      if (Object.keys(window.sources).length) counts = { ...counts, ...window.counts };
      discovered = window.discovered ?? null;
      const month = windowDays <= 30 ? window : await countHistoryAtSource(supabase, workspaceId, addresses, { days: 30, ownerUserId });
      if (Object.keys(month.sources).length) monthly = { credits: monthlyCredits(month), counts: month.counts };
    } else {
      const month = await countConversationsInWindow(supabase, workspaceId, new Date(Date.now() - 30 * 86400_000).toISOString());
      monthly = { credits: monthlyCredits({ counts: month, meetingCredits: (month.meeting || 0) * 6 }), counts: month };
    }

    let recordCount = 0;
    if (!Object.values(counts).some(n => n > 0)) {
      const { count } = await supabase
        .from('entities').select('id', { count: 'exact', head: true })
        .eq('workspace_id', workspaceId).eq('status', 'active');
      recordCount = count ?? 0;
    }

    const budget = checkBackfillBudget({ planId, counts, recordCount, windowDays, used });
    return budget ? { ...budget, monthly, discovered } : budget;
  } catch (err) {
    console.warn('[BACKFILL_BUDGET] could not price the backfill, letting it run:', err?.message || err);
    return null;
  }
}

// Conversations, not activities: an email thread is one read however many messages it
// holds, which is also how the pricing page bills it. We have no thread key on the
// observation, so messages are collapsed by the ratio measured on a customer workspace (roughly
// five messages for every three threads) rather than counted one for one.
//
// Calls are counted whole even though only a small share carry a recording and reach a model.
// That over-counts, on purpose: over-counting routes a borderline workspace to assisted
// onboarding, under-counting spends money nobody agreed to. Notes are not counted at all —
// they are never read, so they cannot cost anything.
const MESSAGES_PER_THREAD = 1.64;

async function countConversationsInWindow(supabase, workspaceId, since) {
  const countOf = async (properties) => {
    const { count } = await supabase
      .from('observations').select('id', { count: 'exact', head: true })
      .eq('workspace_id', workspaceId).in('property', properties).gte('observed_at', since);
    return count ?? 0;
  };
  const [emails, calls, meetings, notes] = await Promise.all([
    countOf(['interaction.email_sent', 'interaction.email_received']),
    countOf(['interaction.call_made', 'interaction.call_received']),
    countOf(['interaction.meeting_held']),
    countOf(['interaction.note_added']),
  ]);
  return {
    email_thread: Math.round(emails / MESSAGES_PER_THREAD),
    call: calls,
    meeting: meetings,
    note: notes, // counted for the record; bills as zero credits
  };
}

// The hand-off. A held backfill is not a failure and should never read like one: this
// workspace is bigger than the self-serve path is priced for, which is a good problem.
// Best-effort, like the credits pause it mirrors — no RESEND_API_KEY, no email, no harm.
async function notifyAssistedOnboarding(supabase, workspaceId, budget) {
  const { data: m } = await supabase
    .from('workspace_members').select('users:user_id(email)')
    .eq('workspace_id', workspaceId).order('created_at', { ascending: true }).limit(1).maybeSingle();
  const to = m?.users?.email;
  if (!to) return;
  await sendEmail({
    to,
    tag: 'BACKFILL_ASSISTED_ONBOARDING',
    subject: 'Your history is bigger than the standard import — let us set it up with you',
    text:
      `We looked at your last 3 months before importing it: about ${budget.credits.toLocaleString()} ` +
      `conversations to read. That is a bigger history than onboarding reads on its own, so we ` +
      `have held it rather than started something half-sized.\n\n` +
      `Reply to this email and we will set the import up with you — which window to read, which ` +
      `accounts matter first, and what your plan should be.`,
  });
}

// Sources that can put an account in the graph that wasn't there before. The notetakers
// replay every meeting in the workspace and create the contact when the room doesn't match
// anyone we know (Granola too, since GET-854). Everything else only ever ENRICHES a contact we
// already have, which is why only these can justify a job over an empty graph.
const DISCOVERY_PROVIDERS = ['fireflies', 'fathom', 'granola'];

async function hasDiscoverySource(supabase, workspaceId) {
  try {
    const { data: provs } = await supabase
      .from('workflow_providers').select('id, name').in('name', DISCOVERY_PROVIDERS);
    if (!provs?.length) return null;
    const byId = new Map(provs.map(p => [p.id, p.name]));
    const { data: conns } = await supabase
      .from('workflow_provider_connections')
      .select('provider_id')
      .eq('workspace_id', workspaceId)
      .in('provider_id', provs.map(p => p.id))
      .limit(1);
    return conns?.length ? byId.get(conns[0].provider_id) ?? null : null;
  } catch {
    return null;
  }
}
