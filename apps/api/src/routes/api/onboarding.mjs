import { Router } from 'express';
import { workspacePlanLive, workspaceOnFree, backfillOwnerFor, ownerJobFilter } from '../../lib/backfillStart.mjs';
import { captureProductEvent } from '../../lib/productEvents.mjs';
import { getPlanFromSubscription, isApiTier } from '../../lib/plans.mjs';
import { getSupabaseClient } from '@nous/core';
import { verifySupabaseAuth } from '../../middleware/supabaseAuth.mjs';
import { ensureUserAndTeam } from '../../lib/auth.mjs';
import { upsertNousPerson, logNousObservation } from '../../lib/dogfood.mjs';
import { hasIcp } from '../../lib/icp.mjs';
import { hasLiveWebhook } from '../../lib/webhookStatus.mjs';
import { isWorkspaceSetUp, selfServeOnboardingEnabled } from '../../lib/onboardingState.mjs';
import { crmImportStatus } from '../../lib/connectIngest.mjs';

// The onboarding reports are the in-app agent's work, which is Cloud's (cloud/lib/onboardingReports.mjs).
// Cloud registers the runner at boot (GET-754); without it POST /reports starts nothing.
let onboardingReportRunner = null;
export function registerOnboardingReportRunner(fn) { onboardingReportRunner = fn; }

export const onboardingRouter = Router();


// The blank skeleton the in-app ICP draft fills. SAME sections as the canonical
// ICP_TEMPLATE (apps/api/src/lib/icpTemplate.mjs) the coding-agent onboarding
// scaffolds, so the manual road and the agent road produce the same shape of file.
// The nous:icp learned-model block isn't drafted here — export_icp_model adds it
// after the first closed deals. Kept in sync with CANONICAL_ICP_SECTIONS.
const ICP_DRAFT_SKELETON = [
  '# ICP — <one sentence naming who this company sells to>',
  '',
  '## The buyer',
  '',
  '## Who is a fit (inclusion, highest first)',
  '',
  '## Who is NOT a fit (hard disqualifiers)',
  '',
  '## Trigger signals (reach out now)',
  '',
  '## Anchors',
].join('\n');

// Normalise a typed website into a bare domain, for logo-by-domain + storage.
const toDomain = (w) => String(w || '').trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '').replace(/^www\./i, '').split('?')[0].toLowerCase() || null;

// A timezone is valid iff Intl accepts it — the same authority resolveDuePhrase
// relies on, so nothing that passes here can poison due-date math later.
const isValidTimeZone = (tz) => {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
};

/** The workspace this user works in. */
async function resolveWorkspaceId(supabase, reqUser, fallback = null) {
  if (fallback) return fallback;
  const { user, team } = await ensureUserAndTeam(reqUser);
  const { data: wms } = await supabase
    .from('workspace_members')
    .select('workspace_id, workspaces:workspace_id(id, team_id)')
    .eq('user_id', user.id);
  const match = (wms || []).find(m => m.workspaces?.team_id === team.id);
  return match?.workspace_id || null;
}

// GET /api/onboarding/status — drives the first-run gate, and it is the ONLY thing
// that answers "is this workspace set up". The router asks this. The setup screen asks
// this. There is no second opinion.
//
// onboarded = the workspace has an ICP **in the Vault** (a foundations row, kind='icp').
//
// It used to be `business_type`, which the agent happened to set on its way past — a
// label, where the ICP is the thing every other part of the product actually reads:
// scoring, attention, the briefs, get_foundation. A workspace with a business_type and no
// ICP is not set up, it just looks like it is.
//
// It was then briefly `workspaces.icp_text`, which was worse: that column feeds NOTHING.
// The in-app road wrote it, the gate opened on it, and the Vault, the agent and the
// scoring model all still saw an empty workspace. See lib/icp.mjs.
//
// It doesn't matter WHERE the ICP came from: an icp.md the agent found in their
// repo, one it drafted from their website, or one they typed into the app. Same
// finish line, three roads to it.
// POST /api/onboarding/reports — the payoff, written by the agent.
//
// Called by the WORKER when a backfill completes (shared-secret, not a user session): the graph
// is finally whole, so the agent writes the revenue report and the win/loss read as documents
// into their own threads. Fire-and-forget from the caller's side — two agent runs take minutes
// and the worker must not sit on an open socket for them.
onboardingRouter.post('/reports', async (req, res) => {
  const secret = process.env.WORKER_SECRET;
  if (!secret || req.get('x-worker-secret') !== secret) {
    return res.status(403).json({ error: 'forbidden' });
  }
  const { workspaceId, userId } = req.body || {};
  if (!workspaceId) return res.status(400).json({ error: 'workspaceId_required' });

  // NOT ON SELF-SERVE (GET-549). The revenue report, the win/loss read and the ICP drafted from
  // it are the in-app agent's work, and self-serve has no in-app agent: the operator works the
  // graph from their own. The backfill ends at the graph there.
  try {
    const supabase = getSupabaseClient();
    const { data: ws } = await supabase.from('workspaces').select('team_id').eq('id', workspaceId).maybeSingle();
    const { data: sub } = ws?.team_id
      ? await supabase.from('subscriptions').select('*').eq('team_id', ws.team_id).maybeSingle()
      : { data: null };
    if (isApiTier(getPlanFromSubscription(sub))) {
      console.log(`[onboarding/reports] ws=${workspaceId} self-serve — no reports`);
      return res.json({ started: false, skipped: 'self_serve' });
    }
  } catch (err) {
    console.warn('[onboarding/reports] plan check failed — skipping:', err?.message || err);
    return res.json({ started: false, skipped: 'plan_unknown' });
  }

  if (!onboardingReportRunner) return res.json({ started: false, skipped: 'not_available' });
  res.json({ started: true });
  onboardingReportRunner(workspaceId, { userId: userId ?? null })
    .catch(err => console.error('[POST /api/onboarding/reports]', err?.message || err));
});

// GET /api/onboarding/checklist?workspaceId= — which onboarding steps are done (GET-517).
//
// One answer for both flows: the API plan's Get started page ticks these off, and the Workspace
// agent reads the same state to know what to ask next. Every step is a fact about the workspace,
// not a click we remember: a CRM that is connected is connected however it got that way.
const CRM_PROVIDERS = ['hubspot', 'salesforce', 'attio', 'pipedrive'];
const MAIL_PROVIDERS = ['gmail_oauth', 'gmail', 'smtp'];
const NOTES_PROVIDERS = ['fellow', 'fireflies', 'granola', 'fathom', 'otter', 'zoom'];

onboardingRouter.get('/checklist', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const workspaceId = await resolveWorkspaceId(supabase, req.user, req.workspaceId);
    if (!workspaceId) return res.status(400).json({ error: 'workspaceId_required' });
    // An invited member onboards their own mail, notes and backfill, not the CRM (GET-571).
    const owner = await backfillOwnerFor(supabase, workspaceId, req.internalUserId).catch(() => null);
    const [{ data: conns }, { data: crmSync }, { count: accounts }, { data: job }, { data: keys }] = await Promise.all([
      supabase.from('workflow_provider_connections')
        .select('owner_user_id, provider:workflow_providers(name)').eq('workspace_id', workspaceId),
      supabase.from('crm_sync_configs').select('provider, last_synced_at').eq('workspace_id', workspaceId),
      supabase.from('entities').select('id', { count: 'exact', head: true })
        .eq('workspace_id', workspaceId).eq('type', 'company').eq('status', 'active'),
      ownerJobFilter(supabase.from('contact_enrichment_jobs').select('status, done, state, updated_at')
        .eq('workspace_id', workspaceId), owner).order('created_at', { ascending: false }).limit(1).maybeSingle(),
      supabase.from('api_keys').select('last_used_at').eq('workspace_id', workspaceId).is('revoked_at', null),
    ]);
    const names = (conns ?? []).map(c => c?.provider?.name).filter(Boolean);
    const mine = (conns ?? []).filter(c => c.owner_user_id === req.internalUserId).map(c => c?.provider?.name).filter(Boolean);
    const crm = (crmSync ?? [])[0] ?? null;
    const crmConnected = !!crm || names.some(n => CRM_PROVIDERS.includes(n));
    const crmProvider = crm?.provider ?? names.find(n => CRM_PROVIDERS.includes(n)) ?? null;
    // The connect-time import as a job: running, failed (with why) or done (GET-853).
    const crmImport = crmConnected ? await crmImportStatus(supabase, workspaceId, crmProvider).catch(() => null) : null;
    const backfill = !job ? 'none'
      : job.status === 'paused_awaiting_confirmation' ? 'waiting'
      : job.done ? 'done' : 'running';
    return res.json({
      crm: { done: crmConnected, provider: crmProvider, imported: !!crm?.last_synced_at, accounts: accounts ?? 0, import: crmImport },
      // Email and meeting notes are personal: THIS person's own connection is what the step asks.
      // Which ones, so the panel can show their logos (GET-549).
      mail: { done: mine.some(n => MAIL_PROVIDERS.includes(n)), workspace: names.some(n => MAIL_PROVIDERS.includes(n)), providers: [...new Set(mine.filter(n => MAIL_PROVIDERS.includes(n)))] },
      notes: { done: mine.some(n => NOTES_PROVIDERS.includes(n)), workspace: names.some(n => NOTES_PROVIDERS.includes(n)), providers: [...new Set(mine.filter(n => NOTES_PROVIDERS.includes(n)))] },
      backfill: { state: backfill, started: !!job?.state?.started_at, start_on_payment: !!job?.state?.start_on_payment },
      seat: owner ? 'member' : 'founder',
      // Paying yet? The backfill step asks for a plan before it runs (GET-549).
      plan: { live: await workspacePlanLive(supabase, workspaceId), free: await workspaceOnFree(supabase, workspaceId) },
      api_key: { created: (keys ?? []).length > 0, used: (keys ?? []).some(k => !!k.last_used_at) },
    });
  } catch (err) {
    console.error('[GET /api/onboarding/checklist]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

onboardingRouter.get('/status', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const workspaceId = await resolveWorkspaceId(supabase, req.user, req.workspaceId);
    if (!workspaceId) return res.json({ connected: false, onboarded: false, hasIcp: false });

    const [{ data: ws }, { data: seat }, { data: keys }, { count: sources }, { count: linkedinSources }, { count: accounts }, { count: trainedDeals }, { count: crmConfigs }, webhookLive, { data: repoRow }, icpPresent, { count: priorThreads }] = await Promise.all([
      supabase.from('workspaces').select('website, tour_completed_at, onboarding_activated_at, onboarding_completed_at, business_type').eq('id', workspaceId).maybeSingle(),
      // THIS seat's own state. Onboarding is per person now — see the note on `activated`.
      supabase.from('workspace_members')
        .select('role, onboarded_at').eq('workspace_id', workspaceId).eq('user_id', req.internalUserId ?? null)
        .maybeSingle()
        .then(r => r, () => ({ data: null })),
      supabase.from('api_keys').select('last_used_at').eq('workspace_id', workspaceId).is('revoked_at', null),
      supabase.from('workflow_provider_connections')
        .select('id', { count: 'exact', head: true }).eq('workspace_id', workspaceId),
      // LinkedIn lives in its OWN table (not workflow_provider_connections), so count
      // it too — otherwise the guided tour's "connect 3 (email, notetaker, LinkedIn)"
      // never counts the LinkedIn one. Degrade to 0 on failure like the extras below.
      supabase.from('workspace_linkedin_connections')
        .select('id', { count: 'exact', head: true }).eq('workspace_id', workspaceId)
        .then(r => r, () => ({ count: 0 })),
      // Accounts in the graph — the "import your accounts" checkpoint of the guided tour.
      // These two are guided-tour extras, not the gate, so they degrade to a zero count on
      // any failure rather than rejecting Promise.all and 500-ing the whole gate.
      supabase.from('contacts')
        .select('id', { count: 'exact', head: true }).eq('workspace_id', workspaceId)
        .then(r => r, () => ({ count: 0 })),
      // Closed deals fed to the ICP model — the "build your ICP model" checkpoint. A resolved
      // prediction carrying a won/lost disposition is training signal, however it got there
      // (the Add-deals import, or an organic resolution).
      supabase.from('predictions')
        .select('id', { count: 'exact', head: true })
        .eq('workspace_id', workspaceId)
        .not('resolved_at', 'is', null)
        .in('outcome_value->>disposition', ['won', 'lost'])
        .then(r => r, () => ({ count: 0 })),
      // A configured CRM sync is a data source even before its first pull lands, so the
      // wizard's step 1 can be satisfied by "CRM connected" as well as "contacts imported".
      supabase.from('crm_sync_configs')
        .select('id', { count: 'exact', head: true }).eq('workspace_id', workspaceId)
        .then(r => r, () => ({ count: 0 })),
      // Setup-checklist step 2: a webhook is actually in play. Same answer the Webhooks
      // page badges "Live" with — see lib/webhookStatus.mjs for why this can't be a count
      // of workspace_webhook_subscriptions rows.
      hasLiveWebhook(supabase, workspaceId),
      // Setup-checklist step 3: THIS member has connected a git repo for the raw-evidence
      // push (per (workspace, user), same source the Repo settings pane reads).
      supabase.from('personal_workspaces')
        .select('source_type, github_repo').eq('workspace_id', workspaceId).eq('user_id', req.internalUserId).maybeSingle()
        .then(r => r, () => ({ data: null })),
      // The foundation row, and only the foundation row. This is the ICP gate (legacy).
      hasIcp(supabase, workspaceId),
      // Has this person ever had a conversation here? The greeting is a FIRST-SESSION thing,
      // and "first session" is not the same as "empty thread" — every new chat is an empty
      // thread. Keying on the thread alone meant someone who never finished setup got greeted
      // again every time they pressed New chat, which is the product forgetting it has met you.
      supabase.from('playground_threads')
        .select('id', { count: 'exact', head: true })
        .eq('workspace_id', workspaceId).eq('user_id', req.internalUserId ?? null)
        .then(r => r, () => ({ count: 0 })),
    ]);

    // The new gate. The app unlocks when the connect wizard is finished and the user
    // clicks Get Started (onboarding_activated_at) — BEFORE the ICP exists, because the
    // in-app agent writes the ICP after entry. We also treat a workspace that already has
    // an ICP as activated so nothing regresses during rollout (and for any row the
    // backfill missed). `skipped` still works client-side as an escape hatch.
    // Per SEAT, not per workspace. The workspace being set up says nothing about whether
    // THIS person has been introduced to it — and the second rep on a running workspace is
    // exactly the case the old workspace-level answer got wrong: they walked into a product
    // nobody had shown them, and were never asked for their own notetaker, which is the one
    // thing only they can connect.
    //
    // The workspace answer still counts for the founder: a workspace that was activated
    // before this column existed keeps its owner out of a setup conversation they finished.
    const seatDone = !!seat?.onboarded_at;
    const isOwner = seat?.role === 'owner' || seat?.role === 'admin';
    // The SHARED expression (lib/onboardingState.mjs) — the same one `whoami` gives the plugin,
    // so a workspace onboarded on one surface is never told by the other that it isn't set up.
    const activated = seatDone || (isOwner && isWorkspaceSetUp({
      activatedAt: ws?.onboarding_activated_at, hasIcp: icpPresent, accounts,
    }));
    const completed = !!ws?.onboarding_completed_at;
    const totalSources = (sources ?? 0) + (linkedinSources ?? 0);
    // Step 1 of the wizard: a data source is connected. A CRM sync config OR any imported
    // account counts.
    const hasDataSource = (crmConfigs ?? 0) > 0 || (accounts ?? 0) > 0;
    // The three setup-checklist steps (Install page + app-wide banner).
    const hasWebhook = webhookLive;
    const hasRepo = repoRow?.source_type === 'github' && !!repoRow?.github_repo;

    // Which wizard step the user is on. Derived so the frontend routes off one source of
    // truth. `>=3 total sources` (CRM/CSV counts as #1) is the bar to reach Get Started.
    let onboardingStep;
    if (activated) onboardingStep = completed ? 'complete' : 'agent_setup';
    else if (hasDataSource && totalSources >= 3) onboardingStep = 'welcome';
    else if (hasDataSource) onboardingStep = 'integrations';
    else onboardingStep = 'data_source';

    return res.json({
      // NEW gate: has the user finished the connect wizard and entered the app.
      activated,
      completed,
      onboardingStep,
      hasDataSource,
      // Legacy: does the workspace have an ICP. No longer the entry gate, but still true
      // "is the ICP set up" for anything that reads it.
      onboarded: icpPresent,
      hasIcp: icpPresent,
      // The MCP has actually called in at least once — i.e. their agent is live.
      connected: (keys || []).some(k => k.last_used_at),
      // Something is feeding the graph. Without this the ICP is set and nothing
      // ever arrives, which is a lonelier failure than not being set up at all.
      hasSource: ((sources ?? 0) + (linkedinSources ?? 0)) > 0,
      // Setup checklist: has a webhook subscription · has connected a raw-evidence repo.
      hasWebhook,
      hasRepo,
      // How MANY sources are connected, across BOTH connection tables (workflow
      // providers like Gmail/Fireflies + LinkedIn). The guided tour's integration
      // step wants at least three (email, notetaker, LinkedIn) before import makes
      // sense — one source alone leaves the graph nearly empty.
      sourceCount: (sources ?? 0) + (linkedinSources ?? 0),
      // Guided-tour checkpoints. Additive — the gate above reads none of these.
      // V1: company setup is done for the customer by an operator, so the app must not offer
      // to run it. But a SEAT is different and is never gated — whoever built the company
      // graph could not connect this person's notetaker or mailbox, only they can.
      //
      // The server answers "should this person be greeted" outright rather than shipping the
      // rule to the frontend, so there is one place it can be wrong.
      selfServe: selfServeOnboardingEnabled(),
      // Greet a seat's FIRST session only — not onboarded AND no prior conversation. The
      // second half is what stops "New chat" re-greeting someone forever.
      shouldGreet: !seatDone && (priorThreads ?? 0) === 0 && (isOwner ? selfServeOnboardingEnabled() : true),
      accountCount: accounts ?? 0,
      icpTrained: (trainedDeals ?? 0) > 0,
      // The one-time guided TOUR has been completed/dismissed for this workspace. Server
      // truth so it never re-shows on a new browser/device, only localStorage-cached.
      tourCompleted: !!ws?.tour_completed_at,
      website: ws?.website ?? null,
    });
  } catch (err) {
    console.error('[GET /api/onboarding/status]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

async function firstCompletionSideEffects(supabase, { user, team, workspace, name, company_name, website, icp_description }) {
  const isFirstCompletion = !user.onboarding_completed_at;
  if (!isFirstCompletion) return;

  await supabase.from('users').update({ onboarding_completed_at: new Date().toISOString() }).eq('id', user.id);

  // Guarantee the team has a subscription. ensureUserAndTeam puts new signups on Free on
  // first auth; this is the belt-and-suspenders if that ever missed. It only fires when NO
  // row exists (ignoreDuplicates leaves any existing paid row untouched).
  try {
    const now = new Date();
    await supabase.from('subscriptions').upsert({
      team_id: team.id,
      plan_id: 'free',
      plan_name: 'free',
      status: 'active',
      current_period_start: now.toISOString(),
    }, { onConflict: 'team_id', ignoreDuplicates: true });
  } catch (e) {
    console.warn('[onboarding] free-plan upsert:', e?.message || e);
  }

  const fullName = (typeof name === 'string' && name.trim()) || user.name || '';
  const [firstName, ...rest] = fullName.split(/\s+/);
  const lastName = rest.join(' ') || null;
  const recipientEmail = user.email || null;
  const finalCompany = (typeof company_name === 'string' && company_name.trim()) || workspace?.name || null;
  const signupStage = workspace?.default_signup_stage
    || (workspace?.business_type === 'service' ? 'Lead' : 'Free User');

  (async () => {
    // No welcome email: onboarding sends no email at all (GET-517, product decision 2026-09-28).

    // 2. Upsert this new user as a person in our own Nous workspace
    if (recipientEmail) {
      await upsertNousPerson({
        email: recipientEmail,
        first_name: firstName || null,
        last_name: lastName,
        company: finalCompany,
        stage: signupStage,
      });

      // 3. Log signup on their timeline. Also write state.pipeline_stage so the contact
      // detail view's Pipeline Stage field flips off the default 'identified' onto
      // whatever the founder named their signup stage in onboarding.
      await logNousObservation(recipientEmail, [
        { kind: 'event', property: 'interaction.signed_up',
          value: {
            source: 'app.opennous.cloud',
            plan: 'free',
            business_type: workspace?.business_type || null,
            website: (typeof website === 'string' && website.trim()) || null,
            icp_description: (typeof icp_description === 'string' && icp_description.trim()) || null,
            at: new Date().toISOString(),
          } },
        { kind: 'state', property: 'stage', value: signupStage },
        { kind: 'state', property: 'pipeline_stage', value: signupStage },
        ...(finalCompany ? [{ kind: 'state', property: 'company', value: finalCompany }] : []),
      ]);
    }
  })().catch(err => console.error('[onboarding] first-completion side effects error:', err.message));
}

// Resolve the caller's user, team and workspace row in one place.
async function resolveUserTeamWorkspace(supabase, reqUser) {
  const { user, team } = await ensureUserAndTeam(reqUser);
  const { data: wms } = await supabase.from('workspace_members')
    .select('workspace_id, workspaces:workspace_id(*)').eq('user_id', user.id);
  const match = wms?.find(m => m.workspaces?.team_id === team.id);
  return { user, team, workspace: match?.workspaces || null };
}

// THE MOMENT ONBOARDING FINISHES (GET-517): the customer said yes to the backfill. The one-time
// side effects that used to hang off the retired wizard's /activate run here: the user is marked
// onboarded and the signup is filed in our own workspace. No email is sent.
export async function finishOnboarding(supabase, reqUser, workspaceId) {
  try {
    const { user, team, workspace } = await resolveUserTeamWorkspace(supabase, reqUser);
    await firstCompletionSideEffects(supabase, { user, team, workspace });
    if (workspaceId) {
      const { data: done } = await supabase.from('workspaces')
        .update({ onboarding_completed_at: new Date().toISOString(), onboarding_activated_at: new Date().toISOString() })
        .eq('id', workspaceId).is('onboarding_completed_at', null).select('id');
      // Once per workspace: only the update that actually stamped it.
      if (done?.length && user?.id) captureProductEvent({ distinctId: user.id, event: 'onboarding_completed', workspaceId });
    }
  } catch (err) {
    console.warn('[onboarding] finish failed:', err?.message || err);
  }
}
