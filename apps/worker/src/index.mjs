// Nous Worker — background signal ingestion and scheduled pollers.
//
// Runs two things:
//   1. A lightweight HTTP server for inbound webhooks (LinkedIn, Fireflies, RB2B, etc.)
//   2. Scheduled pollers using node-cron for predictable timing

import './bootEnv.mjs'; // first — normalizes APP_URL/API_URL from domains before any module reads them
import express from 'express';
import cron from 'node-cron';
import { runAutomationDailyPoll, emitDealEventsPoll, emitIcpEventsPoll, emitPeopleAddedPoll, pruneWebhookDeliveries, reconcileAfterCallWebhooks, processAccountSignals, processHubspotFieldChanges, registerStepHandler } from '@nous/core';

import { runFlagSweepCron } from './flags/sweep.mjs';
import {
  runIntelligenceBehaviorsCron,
  runIntelligenceLearningCron,
  runIntelligenceRecommendationsCron,
  runDecisionTracesCron,
} from './intelligence/index.mjs';
import { getSupabaseClient, sweepSupportAccess, registerCrmPushHandler, pushActivityToAllCrms, logWorkerRun, registerActivityHook, pipelineStageHook, crmAgentHook, registerCommitteeProvider, loadBuyingCommittee } from '@nous/core';
import { registerEvidenceLayer } from './lib/evidence/index.mjs';
import { registerRevboxStepHandlers } from './lib/revboxStepHandlers.mjs';
import { mayReadWorkspace } from './lib/creditGate.mjs';
// Gmail and Google Calendar are scheduled scans through Composio (services/gmailSync.mjs,
// services/calendarSync.mjs); their push triggers only get new items in sooner — GET-221, GET-234.
import { syncAllCalendars } from './services/calendarSync.mjs';
import { syncAllGmail } from './services/gmailSync.mjs';
import { pollAllSmtpWorkspaces } from './pollers/smtp.mjs';
import { pollAllGranolaWorkspaces } from './pollers/granola.mjs';
import { pollAllFellowWorkspaces } from './pollers/fellow.mjs';
import { pollAllRingCentralWorkspaces } from './pollers/ringcentral.mjs';
import { backfillComposioConnection } from './services/composioBackfill.mjs';
import { webhookRouter, cloudWebhookRouter } from './webhooks/index.mjs';
import { loadCloud } from './lib/cloud.mjs';
import { reprocessFireflies } from './webhooks/handlers/fireflies.mjs';
import { reprocessGranola } from './webhooks/handlers/granola.mjs';
import { reprocessFellow } from './webhooks/handlers/fellow.mjs';
import { reprocessRingCentral } from './webhooks/handlers/ringcentral.mjs';
import { processWebhookInbox } from './workers/webhookRetry.mjs';
import { deliverTriggers } from './workers/triggerDelivery.mjs';
import { deliverGithubDispatches } from './workers/githubDispatch.mjs';
import { resolveOutcomes } from './workers/mindOutcomes.mjs';
import { runActionItemClosure } from './workers/actionItemClosure.mjs';
import { runCloseRecords } from './workers/closeRecords.mjs';
import { processLeadReplies } from './workers/leadReplies.mjs';
import { processClaimJobs } from './workers/claimEngine.mjs';
import { writeHeartbeat } from './workers/heartbeat.mjs';
import { processInvariants } from './workers/invariants.mjs';
import { processBulkLeadJobs } from './workers/bulkLeadJobs.mjs';
import { processContactEnrichmentJobs } from './workers/contactEnrichmentJobs.mjs';
import { scoreIntentCron } from './intentScore.mjs';
import { runPipelineStageStats } from './workers/pipelineStageStats.mjs';
import { runInsightThemes } from './workers/insightThemes.mjs';
import { runInsightBoard } from './workers/insightBoard.mjs';
import { runEmailThreadsDaily } from './workers/emailThreadsDaily.mjs';
import { runReadLedger } from './workers/readLedger.mjs';
import { computeClaimPatternsCron } from './computeClaimPatterns.mjs';
import { campaignStatsRefreshCron } from './campaignStatsRefresh.mjs';
import { processEmbeddings } from './workers/embeddings.mjs';
import { runCrmAutoSync } from './workers/crmSync.mjs';
import { runCrmHygieneSweep } from './workers/crmHygiene.mjs';
import { runRuleChecks } from './workers/ruleChecks.mjs';
import { runStageDerivation } from './workers/stageDerivation.mjs';
import { runApiNotificationEmails } from './workers/apiNotificationEmails.mjs';
import { runAuditSweep } from './workers/auditSweep.mjs';
import { runHealthRefresh } from './workers/healthRefresh.mjs';
import { refreshCompanySummary, runCompanySummaryStageSweep } from './signals/companySummary.mjs';
import { refreshDealOverview, ACCOUNT_DEAL_ID } from './signals/dealOverview.mjs';
import { opsAlert } from './lib/opsAlert.mjs';
import { initSentry, captureException as sentryCapture } from './lib/sentry.mjs';
import { runAdoptOwnership } from './workers/adoptOwnership.mjs';
import { runListRowsRefresh } from './workers/listRowsRefresh.mjs';
import { runDealHealthRefresh } from './workers/dealHealthRefresh.mjs';
import { runApiRequestLogRetention } from './workers/apiRequestLogRetention.mjs';
initSentry('worker'); // no-op unless SENTRY_DSN is set

// Wire webhook-driven activity logging → CRM push at module load.
// Worker is where most logActivity() calls originate (Instantly/Lemlist replies,
// Fireflies/Fathom meetings, LinkedIn messages, Calendly bookings, etc.)
// CRM push is OFF — Nous is read-only. We pull the CRM into the substrate and
// never write back. Unregistered handler = notifyCrmPush() is a no-op, so every
// logActivity() call path is unchanged. Re-enable by uncommenting (same in
// apps/api/src/index.mjs).
// registerCrmPushHandler(pushActivityToAllCrms);
void registerCrmPushHandler; void pushActivityToAllCrms;

// Automation steps that need the API's connections (GET-543): a Slack step in a run that started
// here (a signal, a finished call, a deal) is posted by the API, which holds the bot token.
const viaApi = (path, failed) => async ({ supabase: _s, ...args }) => {
  const secret = process.env.WORKER_SECRET;
  if (!secret || !process.env.API_URL) return failed('not_available_here');
  const resp = await fetch(`${process.env.API_URL}/internal/automation-steps/${path}`, {
    method: 'POST',
    headers: { 'x-worker-secret': secret, 'content-type': 'application/json' },
    body: JSON.stringify(args),
  });
  return resp.ok ? resp.json() : failed(`api_${resp.status}`);
};
registerStepHandler('slack', viaApi('slack', (r) => ({ ok: false, reason: `slack_${r}` })));
registerStepHandler('gmail_draft', viaApi('gmail-draft', (r) => ({ status: 'failed', error: r })));
registerStepHandler('meter', viaApi('meter', () => ({ ok: false })));
registerStepHandler('smtp_send', viaApi('smtp-send', (r) => ({ ok: false, reason: `smtp_${r}` })));
// The daily deal pass asks before each run (GET-881): the same cached, fail-open gate extraction uses.
registerStepHandler('credit_gate', ({ workspaceId }) => mayReadWorkspace(workspaceId));
// A RevBox job run here (GET-868): its box webhooks (and every webhook step) go through the SSRF
// guard, and its account-scoped box references are read as its owner may see them.
registerRevboxStepHandlers(registerStepHandler);

// Pipeline-stage advancement + outcome resolution are a PRODUCT hook on the substrate's activity
// seam (context-graph decouple #1). MUST be registered here too — the worker logs the bulk of
// activities (webhooks, pollers), so a missing registration silently freezes stage advancement.
registerActivityHook(pipelineStageHook);
// The CRM agent (same registration as apps/api): which deal was this activity about.
// Off unless crm_sync_configs.crm_agent_enabled is true for the workspace.
registerActivityHook(crmAgentHook);
// Evidence layer — file the raw of every connector touch into the owning member's
// personal vault (accounts/ + people/). Registered here so both live webhooks/pollers
// AND the historical backfill (which all flow through logActivity) materialize evidence.
registerEvidenceLayer();
// Buying committee provider (decouple #4) — register here too so worker-side getAccountRecord
// calls also return the committee.
registerCommitteeProvider((sb, ws, eid) => loadBuyingCommittee(sb, ws, eid, 'buying_group'));

// ── Validate required env vars ────────────────────────────────────────────────
const REQUIRED = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'];
for (const key of REQUIRED) {
  if (!process.env[key]) {
    console.error(`[WORKER] Missing required env var: ${key}`);
    process.exit(1);
  }
}

// ── Process-level safety net ───────────────────────────────────────────────────
// The worker runs long-lived pollers; an unhandled rejection must not silently kill
// the loop with only docker restart to notice. Log loudly + page, don't exit on a
// rejection (individual tick catches already isolate expected failures).
process.on('unhandledRejection', (reason) => {
  console.error('[worker unhandledRejection]', reason);
  sentryCapture(reason instanceof Error ? reason : new Error(String(reason)), { kind: 'unhandledRejection' });
  opsAlert('Worker unhandledRejection', reason?.stack || String(reason), { key: 'worker-unhandledRejection' });
});
process.on('uncaughtException', (err) => {
  console.error('[worker uncaughtException]', err);
  sentryCapture(err, { kind: 'uncaughtException' });
  opsAlert('Worker uncaughtException', err?.stack || String(err), { key: 'worker-uncaughtException' });
});

// ── Shutdown: hand back the locks ────────────────────────────────────────────
// A deploy stops this container with SIGTERM, often mid-job. A lock it still held would keep that
// workspace's next run (nightly board, backfill) out for the rest of its lease — an hour. Released
// here, the next run starts straight away and picks up where this one stopped. Docker allows ten
// seconds; a handful of deletes takes well under one.
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.once(sig, async () => {
    const { releaseHeldLocks } = await import('@nous/core');
    const n = await releaseHeldLocks().catch(() => 0);
    console.log(`[WORKER] ${sig}: released ${n} lock${n === 1 ? '' : 's'}, exiting`);
    process.exit(0);
  });
}

// ── Inbound webhook server ────────────────────────────────────────────────────
const app = express();
app.use(express.json({
  limit: '5mb',
  // Preserve raw body bytes so webhook handlers can verify signatures
  // (Calendly, Stripe, etc.) against exactly what the sender hashed.
  verify: (req, _res, buf) => { req.rawBody = buf; },
}));

app.get('/health', (_req, res) => res.json({ ok: true, service: 'nous-worker' }));
app.use('/inbound', webhookRouter);

// Internal: run the history backfill for a just-connected Composio account, so a member's
// existing inbox/calendar flows in on connect, not just new events. Called by the API side
// (finalizeComposioConnection) after a connection goes ACTIVE. Secret-guarded and dormant
// unless WORKER_SECRET is set (same gate as the other internal worker routes).
// The native Google callback (GET-765, self-host) calls /internal/google/backfill: same handler,
// same scans, the connection row says which transport reads it.
const connectionBackfillHandler = async (req, res) => {
  const secret = process.env.WORKER_SECRET;
  if (!secret || req.get('x-worker-secret') !== secret) return res.status(403).json({ error: 'forbidden' });
  const connectionId = req.body?.connectionId;
  if (!connectionId) return res.status(400).json({ error: 'connection_id_required' });
  // Ack immediately; do the work fire-and-forget so a slow fetch never blocks connect.
  res.json({ ok: true, queued: true });
  try {
    const supabase = getSupabaseClient();
    const { data: conn } = await supabase
      .from('workflow_provider_connections')
      .select('id, workspace_id, owner_user_id, account_email, managed_by, composio_connection_id, workflow_providers!inner(name)')
      .eq('id', connectionId)
      .maybeSingle();
    if (!conn) { console.warn('[composio/backfill] connection not found:', connectionId); return; }
    const r = await backfillComposioConnection(supabase, conn);
    console.log(`[composio/backfill] connection=${connectionId} ok=${r.ok} logged=${r.logged ?? 0}${r.error ? ` err=${r.error}` : ''}`);
  } catch (err) {
    console.warn('[composio/backfill] failed:', err?.message || err);
  }
};
app.post('/internal/composio/backfill', connectionBackfillHandler);
app.post('/internal/google/backfill', connectionBackfillHandler);

// Internal: rewrite one account's summary now — the refresh button on the account page.
// Called by the API over the compose network (NOUS_WORKER_URL). Answers with the new text,
// because the claim it writes is projected a moment later and a re-fetch would miss it.
app.post('/internal/company-summary', async (req, res) => {
  const secret = process.env.WORKER_SECRET;
  if (!secret || req.get('x-worker-secret') !== secret) return res.status(403).json({ error: 'forbidden' });
  const { workspaceId, companyId } = req.body || {};
  if (!workspaceId || !companyId) return res.status(400).json({ error: 'workspace_and_company_required' });
  try {
    const r = await refreshCompanySummary(getSupabaseClient(), workspaceId, companyId, { reason: 'manual' });
    return res.json(r?.summary ? { summary: r.summary, generated_at: r.generated_at } : { summary: null, skipped: r?.skipped ?? null });
  } catch (err) {
    console.warn('[company-summary] failed:', err?.message || err);
    return res.status(502).json({ error: 'summary_failed' });
  }
});

// Internal: write one deal's "How to win this deal" now (GET-793) — the deal page asks on first
// open and on refresh. Same door and secret as the account summary above.
app.post('/internal/deal-overview', async (req, res) => {
  const secret = process.env.WORKER_SECRET;
  if (!secret || req.get('x-worker-secret') !== secret) return res.status(403).json({ error: 'forbidden' });
  const { workspaceId, companyId, dealId } = req.body || {};
  if (!workspaceId || !companyId || !dealId) return res.status(400).json({ error: 'workspace_company_and_deal_required' });
  if (dealId !== ACCOUNT_DEAL_ID && !/^[0-9a-f-]{36}$/i.test(String(dealId))) return res.status(400).json({ error: 'invalid_deal' });
  try {
    const r = await refreshDealOverview(getSupabaseClient(), workspaceId, companyId, dealId);
    return res.json(r?.overview ? { overview: r.overview, generated_at: r.generated_at } : { overview: null, skipped: r?.skipped ?? null });
  } catch (err) {
    console.warn('[deal-overview] failed:', err?.message || err);
    return res.status(502).json({ error: 'overview_failed' });
  }
});

// Internal: re-run one already-received meeting through the ingest pipeline, attached to a
// contact the agent chose (POST /v2/unresolved/:id/resolve). NOT the /inbound door: that one is
// public and signature-checked, and an internal re-fire carries no provider signature. Caddy
// proxies only /inbound/*, so /internal/* is reachable on the compose network alone — plus the
// same x-worker-secret every internal route uses.
//
// Each note-taker's reprocessor takes the id in its own shape, so the mapping lives here rather
// than in the API, which should not have to know how a handler reads its own payload.
const REINGEST = {
  fireflies: (id, entityId) => [reprocessFireflies, { meetingId: id, eventType: 'agent_resolve', resolveToEntityId: entityId }],
  granola:   (id, entityId) => [reprocessGranola,   { type: 'agent_resolve', data: { id }, resolveToEntityId: entityId }],
  fellow:    (id, entityId) => [reprocessFellow,    { type: 'resolve', noteId: id, resolveToEntityId: entityId }],
  ringcentral: (id, entityId) => [reprocessRingCentral, { type: 'resolve', callId: id, resolveToEntityId: entityId }],
};

app.post('/internal/reingest', async (req, res) => {
  const secret = process.env.WORKER_SECRET;
  if (!secret || req.get('x-worker-secret') !== secret) return res.status(403).json({ error: 'forbidden' });
  const { source, workspaceId, externalId, resolveToEntityId } = req.body || {};
  const build = REINGEST[String(source || '').toLowerCase()];
  if (!build) return res.status(400).json({ error: `unsupported_source_${source}` });
  if (!workspaceId || !externalId) return res.status(400).json({ error: 'workspace_and_external_id_required' });
  try {
    const [run, body] = build(externalId, resolveToEntityId ?? null);
    const result = await run(getSupabaseClient(), workspaceId, body);
    return res.json({ ok: true, ...(result ?? {}) });
  } catch (err) {
    console.warn(`[reingest/${source}] failed:`, err?.message || err);
    return res.status(502).json({ error: 'reingest_failed', message: err?.message || String(err) });
  }
});

// The Workspace (Cloud) layer, GET-754: src/cloud/index.mjs when this checkout has it, else
// null (the open-source build). It adds its cron jobs and inbound routes here, before the server
// listens and the public jobs below are scheduled. Its inbound routes go on the slot that sits
// ahead of the public sources and the catch-all (webhooks/index.mjs).
const cloud = await loadCloud();
cloud?.register?.({ cron, webhookRouter: cloudWebhookRouter, app });

const PORT = process.env.WORKER_PORT ?? 3001;
app.listen(PORT, () => console.log(`[WORKER] Webhook server on :${PORT}`));

// ── Support-access sweeper — every 15 minutes ────────────────────────────────
//
// Operator support access is a real, expiring workspace membership. Access we have to
// remember to remove is access nobody removes, so the clock removes it. Frequent on purpose:
// the window between expiry and sweep is time we can still read a customer's data after we
// said we would stop.
cron.schedule('3-59/15 * * * *', async () => {
  try { await sweepSupportAccess(getSupabaseClient()); } catch (e) { console.error('[WORKER] support sweep:', e?.message || e); }
});
console.log('[WORKER] Support-access sweeper — every 15 minutes');

// ── SMTP/IMAP poller — every hour ────────────────────────────────────────────
async function runSmtpPoller() {
  try { await pollAllSmtpWorkspaces(); }
  catch (err) { console.error('[WORKER] SMTP poll error:', err.message); }
}
runSmtpPoller();
cron.schedule('35 * * * *', runSmtpPoller);
console.log('[WORKER] SMTP/IMAP poller — hourly at :35');

// ── Google Calendar scan — every 30 min ───────────────────────────────────────
// The calendar is state: the scan reconciles [-1d, +30d] of every connected calendar, so moved
// and cancelled meetings land too, and a trigger only brings the next scan forward. Runs at boot
// so a deploy never leaves upcoming meetings stale. One Composio read per calendar per run.
async function runCalendarSync() {
  try { await syncAllCalendars(); }
  catch (err) { console.error('[WORKER] Calendar sync error:', err.message); }
}
runCalendarSync();
cron.schedule('6-59/30 * * * *', runCalendarSync);
console.log('[WORKER] Google Calendar scan — every 30 min, at :06 and :36');

// ── Account summaries after a stage change — every 15 min ─────────────────────
// Rewrites only the accounts whose stage moved since the last tick (GET-223). New facts
// refresh a summary from the extractor; this covers stage writers that aren't extraction.
cron.schedule('9-59/15 * * * *', () => runCompanySummaryStageSweep().catch(err =>
  console.error('[WORKER] Company summary sweep error:', err.message)));
console.log('[WORKER] Account summary stage sweep — every 15 min');

// ── Gmail scan — every 30 min ─────────────────────────────────────────────────
// Every connected mailbox, last day, received and sent. Filed only against people already in
// the graph, deduped on the message id. Offset from the calendar scan so they don't stack.
async function runGmailSync() {
  try { await syncAllGmail(); }
  catch (err) { console.error('[WORKER] Gmail sync error:', err.message); }
}
runGmailSync();
cron.schedule('15,45 * * * *', runGmailSync);
console.log('[WORKER] Gmail scan — every 30 min');

// ── Granola poller — every 15 min ─────────────────────────────────────────────
// No env gate: Granola is per-connection BYOK, so this is a cheap no-op when no
// workspace has connected it. 15-min cadence because webhooks are plan-gated and
// this is the primary ingest path for most Granola users.
async function runGranolaPoller() {
  try { await pollAllGranolaWorkspaces(); }
  catch (err) { console.error('[WORKER] Granola poll error:', err.message); }
}
runGranolaPoller();
cron.schedule('11-59/15 * * * *', runGranolaPoller);
console.log('[WORKER] Granola poller — every 15 min, offset');

// ── Fellow poller — every 15 min, offset from Granola ────────────────────────
// Only reads Fellow connections with NO webhook (webhooks switched off on their Fellow
// workspace); connections with one are fed by the webhook. No-op when there are none.
async function runFellowPoller() {
  try { await pollAllFellowWorkspaces(); }
  catch (err) { console.error('[WORKER] Fellow poll error:', err.message); }
}
cron.schedule('7-59/15 * * * *', runFellowPoller);
console.log('[WORKER] Fellow poller — every 15 min');

// ── RingCentral poller — every 5 min ─────────────────────────────────────────
// The company call log is RingCentral's only feed (no account-level "call ended" event), so this
// is the ingest path for every RingCentral connection (GET-289). No-op when there are none; a run
// that outlasts the tick is skipped, not doubled.
async function runRingCentralPoller() {
  try { await pollAllRingCentralWorkspaces(); }
  catch (err) { console.error('[WORKER] RingCentral poll error:', err.message); }
}
cron.schedule('2-59/5 * * * *', runRingCentralPoller);
console.log('[WORKER] RingCentral poller — every 5 min');

// ── Pipeline stage decay — daily at 03:00 UTC ────────────────────────────────
async function runPipelineDecay() {
  const supabase = getSupabaseClient();
  const startedAt = new Date();
  try {
    const { error } = await supabase.rpc('decay_pipeline_stages');
    if (error) throw error;
    console.log('[WORKER] Pipeline stage decay complete');
    await logWorkerRun(supabase, {
      worker: 'pipeline_decay',
      status: 'success',
      summary: 'pipeline stage decay complete',
      startedAt,
    });
  } catch (err) {
    console.error('[WORKER] Pipeline decay error:', err.message);
    await logWorkerRun(supabase, {
      worker: 'pipeline_decay',
      status: 'error',
      summary: 'pipeline decay failed',
      error: err.message,
      startedAt,
    });
  }
}

cron.schedule('0 3 * * *', runPipelineDecay, { timezone: 'UTC' });
console.log('[WORKER] Pipeline decay — daily at 03:00 UTC');

// ── Task closure — daily at 03:40 UTC ───────────────────────────────────────
// `autoCloseActionItems` only ever ran as a side effect of opening the Tasks page, so a workspace
// nobody opened never closed a task: one customer had nearly every task still open while worker_runs
// held no closure job at all, because there was none (GET-384). The engine was never broken — GET-357
// made it capable of closing items and nothing invoked it.
//
// Rules-first and bounded: rule closures are free, the model path caps at 12 per workspace per run
// and skips items with no activity after the promise. Daily is deliberate — a follow-up closing a
// day late costs nothing, and it keeps the ceiling at one bounded pass per workspace per day.
cron.schedule('40 3 * * *', () => runActionItemClosure().catch(err =>
  console.error('[ACTION_ITEM_CLOSURE]', err?.message ?? err)), { timezone: 'UTC' });
console.log('[WORKER] Task closure — daily at 03:40 UTC');

// ── Close records — daily at 04:10 UTC ──────────────────────────────────────
// Every deal the CRM closed gets a record of why, as a dated path of the evidence that was on
// it while it was live (GET-405). No model calls; a deal that closed today gets its record
// tomorrow. Bounded per workspace per run.
cron.schedule('10 4 * * *', () => runCloseRecords().catch(err =>
  console.error('[CLOSE_RECORDS]', err?.message ?? err)), { timezone: 'UTC' });
console.log('[WORKER] Close records — daily at 04:10 UTC');

// ── Own-people recognition — every hour at :20 ───────────────────────────────
// Which people belong to the workspace ITSELF, from the domains its seats and connected sources
// authenticate on (GET-291). Marks them internal, which is the fact `isEntityInternal` reports and
// the whole codebase already reads — team insights, message privacy, who counts as a buyer.
//
// Hourly rather than once, because the answer goes stale by being used: the count moved by one in
// the minutes between resolving one customer's staff and writing them, when live ingest met somebody
// new. Every backfill that resolves people — meetings, Gmail, the CRM import — is another chance to
// file a colleague as a customer, and this closes that gap for all of them at once instead of each
// ingest path learning it separately.
//
// Almost always a no-op: it reads seats and connections, and writes only for a person it has not
// seen before.
async function runOwnDomainSweep() {
  try {
    const { sweepOwnDomains } = await import('./services/ownDomains.mjs');
    const { workspaces, marked } = await sweepOwnDomains(getSupabaseClient());
    if (marked) console.log(`[OWN_DOMAINS] swept ${workspaces} workspace(s) — ${marked} newly internal`);
  } catch (err) {
    console.warn('[OWN_DOMAINS] sweep failed:', err?.message || err);
  }
}

cron.schedule('20 * * * *', runOwnDomainSweep);
console.log('[WORKER] Own-people recognition — hourly at :20');

// ── Outcome resolution — daily at 03:30 UTC ──────────────────────────────────
// Joins each open `icp_fit` prediction to its realized outcome — reply,
// pipeline advance, closed-won revenue, all read from observations — and
// writes a weighted outcome_value. Runs after pipeline decay so stage claims
// are fresh. See docs/compound-intelligence-mind.md (Phase 2).
async function runMindOutcomes() {
  try {
    await resolveOutcomes();
  } catch (err) {
    console.error('[WORKER] Outcome resolution error:', err.message);
  }
}

cron.schedule('30 3 * * *', runMindOutcomes, { timezone: 'UTC' });
console.log('[WORKER] Mind outcomes — daily at 03:30 UTC');

// ── Pipeline stage medians — daily at 03:45 UTC ──────────────────────────────
// How long a deal typically sits in each stage, per CRM pipeline, from the deals' own
// stage history (Kaplan-Meier, so a deal still sitting there counts as "at least this
// long"). Stored only where the sample is honest; the account page reads it as the
// denominator behind "94 days in Negotiation". Sits late in the nightly window so the
// night's CRM sync has already written the stage history it reads, and it depends on
// nothing else in this file. See workers/pipelineStageStats.mjs.
cron.schedule('45 3 * * *', () => runPipelineStageStats().catch(e => console.error('[PIPELINE_STATS]', e.message)), { timezone: 'UTC' });
console.log('[WORKER] Pipeline stage medians — daily at 03:45 UTC');

// ── Audit sweep — daily at 04:00 UTC ─────────────────────────────────────────
// Runs the data audit for every connected workspace, stores a health snapshot, and
// writes an audit_regression event to the workspace log when a check breaks since
// yesterday (a dead connector, a sharp health drop). Runs after decay + outcomes so
// it audits a settled graph. This is what makes `nous audit` self-watching instead of
// something you have to remember to run. See workers/auditSweep.mjs.
async function runAudits() {
  try {
    await runAuditSweep();
  } catch (err) {
    console.error('[WORKER] Audit sweep error:', err.message);
  }
}

cron.schedule('0 4 * * *', runAudits, { timezone: 'UTC' });
console.log('[WORKER] Audit sweep — daily at 04:00 UTC');

// ── Data-quality invariants — daily at 04:30 UTC ─────────────────────────────
// Deterministic SQL assertions over the graph: every active person has an
// identifier, every identifier is canonical, every extracted claim names its
// subject, nothing in the unresolved queue is actually resolved. Each is a number
// that should be zero, and the log reports MOVEMENT rather than level — a large
// steady count is already understood, a small growing one is what nobody has
// noticed yet. Runs after the audit sweep so a fix landing there shows up in the
// same night's counts. The checks live in run_invariants() in the database.
cron.schedule('30 4 * * *', () => processInvariants().catch(err =>
  console.error('[INVARIANTS] failed', err.message)), { timezone: 'UTC' });
console.log('[WORKER] Data-quality invariants — daily at 04:30 UTC');

// ── Insight clustering — daily at 05:00 UTC ──────────────────────────────────
// Turns the night's new insights into the themes the Insights tab shows. Routes each new
// insight into a theme that already exists (which keeps the theme's id, and therefore the
// status a founder set on it), and clusters only what fit nowhere.
//
// This used to run INSIDE the page load: opening the tab fired two LLM calls over the
// workspace's entire insight history, and one new insight invalidated the whole build. On
// 2026-09-20 one customer had over a thousand insights and zero themes — the page was falling back
// to rendering hundreds of raw cards. Clustering is a background job, not something a reader pays for.
// Runs last in the nightly window so the night's ingestion has already landed its insights.
cron.schedule('0 5 * * *', () => runInsightThemes().catch(err =>
  console.error('[INSIGHT_THEMES] failed', err.message)), { timezone: 'UTC' });
console.log('[WORKER] Insight clustering — daily at 05:00 UTC');

// ── Insights board — daily at 05:30 UTC ──────────────────────────────────────
// Places each new insight under one board button with its tags and account, and refreshes the
// row summaries that grew. After clustering so both read the same night's insights. A workspace
// with nothing new costs no model call. See workers/insightBoard.mjs.
cron.schedule('30 5 * * *', () => runInsightBoard().catch(err =>
  console.error('[INSIGHT_BOARD] failed', err.message)), { timezone: 'UTC' });
console.log('[WORKER] Insights board — daily at 05:30 UTC');

// ── Lead reply classification — every 15 minutes ─────────────────────────────
// Classifies inbound replies and graduates matched leads into People.
// Decoupled from webhook ingestion. See docs/adaptive-lead-scoring.md.
async function runLeadReplies() {
  try {
    await processLeadReplies();
  } catch (err) {
    console.error('[WORKER] Lead replies error:', err.message);
  }
}

cron.schedule('13-59/15 * * * *', runLeadReplies);
console.log('[WORKER] Lead reply classification — every 15 minutes, offset');

// ── Deal-health refresh — daily at 03:40 UTC ─────────────────────────────────
// Health is a function of TIME as much as of evidence: a reply from three days ago becomes a
// 40-day silence on its own. It used to be recomputed only when someone opened the account, so
// an unvisited deal kept a stale number and the account page had no history to draw. Nightly,
// writing only the accounts whose score actually moved — so the trend carries moves, not
// heartbeats. Runs before the scorecard loop (04:00) so learning sees fresh numbers.
async function runHealthRefreshJob() {
  try {
    await runHealthRefresh();
  } catch (err) {
    console.error('[WORKER] Health refresh error:', err.message);
  }
}

cron.schedule('40 3 * * *', runHealthRefreshJob, { timezone: 'UTC' });

// A rep's own records find them (GET-284). Joining claims what is already addressed to them;
// this catches the rest — a mailbox connected later, a seat added by hand, a re-sync that brought
// in deals for somebody who joined yesterday.
// The lists every page reads, rebuilt from the facts behind them (GET-296). Hourly.
//
// This was OFF unless LIST_ROWS_REFRESH=1 (GET-301), for a reason that no longer holds: the old
// rebuild deleted a workspace's rows and re-inserted them, and a timeout between the two left the
// workspace with no rows at all. Since GET-297 the sweep upserts in chunks that fit the statement
// budget, writes only rows that changed, and resumes from a persisted cursor — a failure leaves a
// row stale, never missing. Left off, it did the opposite of safe: after one customer's import the
// lists were a one-off snapshot that nothing refreshed, while their claims kept changing
// underneath. On by default; LIST_ROWS_REFRESH=0 turns it off.
if (process.env.LIST_ROWS_REFRESH !== '0') {
  cron.schedule('25 * * * *', () => runListRowsRefresh().catch(e => console.error('[LIST_ROWS]', e.message)));
  console.log('[WORKER] List rows refresh — hourly at :25, chunked, resumable');
}

// Nous deal health on every open deal row, so a list of deals can show it without computing it.
// Twice a day, trailing each CRM auto-sync (02:00 / 14:00) by the hour-and-a-half the list sweep
// (:25) needs to land the synced deals on their rows, since the score is written onto those rows.
// There is no post-sync hook to hang this on: the sync writes claims, and the rows only follow at
// the next sweep. Bounded per run and per workspace (dealHealthRefresh.mjs).
// DEAL_HEALTH_REFRESH=0 turns it off.
if (process.env.DEAL_HEALTH_REFRESH !== '0') {
  cron.schedule('35 3,15 * * *', () => runDealHealthRefresh().catch(e => console.error('[DEAL_HEALTH]', e.message)), { timezone: 'UTC' });
  console.log('[WORKER] Deal health on open deals — 03:35 and 15:35 UTC, after each CRM sync');
}

// Per-key request log retention (GET-623): api_request_log keeps 90 days. Batched deletes.
cron.schedule('55 2 * * *', () => runApiRequestLogRetention().catch(e => console.error('[API_REQUEST_LOG]', e.message)), { timezone: 'UTC' });
console.log('[WORKER] API request log retention (90 days): daily at 02:55 UTC');

cron.schedule('50 3 * * *', () => runAdoptOwnership().catch(e => console.error('[ADOPT_OWNERSHIP]', e.message)), { timezone: 'UTC' });
console.log('[WORKER] Deal-health refresh — daily at 03:40 UTC');

// The Scorecard learning loop (daily 04:00 UTC) is the learned ICP scorer's, scheduled by
// src/cloud/index.mjs when this build has it (GET-754 slice 8).

// ── Revenue-concept graph — daily at 04:30 UTC ───────────────────────────────
// Clusters every workspace's extracted claims into typed concept nodes (pain, tool,
// competitor, objection, play, segment, …) shared across ≥2 accounts. This is what
// keeps the graph's VIEW lenses populated as claims accumulate — it was previously a
// manual script, so concepts only existed if someone ran it by hand. Cross-account by
// nature, so it's a scheduled batch, not a per-claim trigger. See computeConcepts.mjs.
async function runComputeConcepts() {
  try {
    await computeClaimPatternsCron();
  } catch (err) {
    console.error('[WORKER] Claim-pattern graph error:', err.message);
  }
}

cron.schedule('30 4 * * *', runComputeConcepts, { timezone: 'UTC' });
console.log('[WORKER] Claim-pattern graph (free, embedding-based) — daily at 04:30 UTC');

// ── Flag sweep — daily at 05:15 UTC ──────────────────────────────────────────
// The change-detection layer: turns state movement into the "accounts to re-engage"
// worklist (fit-gone-cold, fresh buying signal, went dark). Runs after deal-health /
// concepts so it reads fresh scores. See docs/accounts-flagging-brief.md.
async function runFlagSweepJob() {
  try {
    await runFlagSweepCron();
  } catch (err) {
    console.error('[WORKER] Flag sweep error:', err.message);
  }
}

// RETIRED 2026-08-07 — the Revenue Intelligence Engine now covers all four flag
// concepts (buying_signal → signals.buying, went_dark → pipeline.stall, fit_cold →
// leakage.fit_cold, cooling → leakage.cooling), and both consumers (Studio, the
// Accounts board) read the engine's recommendations. The hardcoded flag sweep is no
// longer scheduled. runFlagSweepJob is kept for a manual backfill if ever needed.
// cron.schedule('15 5 * * *', runFlagSweepJob, { timezone: 'UTC' });
console.log('[WORKER] Flag sweep — RETIRED (replaced by the Revenue Intelligence Engine)');
void runFlagSweepJob;

// ── Revenue Intelligence Engine — on the calibration chain, after flags ──────
// The learning engine: extract behaviors, run learning jobs, match recommendations.
// Phase 0 is IDLE — the registries are empty, so each entrypoint returns before any
// work. It sits on the chain (behaviors -> nightly learn -> recommendations, plus
// weekly/monthly learn) so Phase 1 lights up with no scheduling change.
async function runIntelligence(fn, label) {
  try { await fn(); } catch (err) { console.error(`[WORKER] Intelligence ${label} error:`, err.message); }
}
cron.schedule('20 5 * * *',  () => runIntelligence(runIntelligenceBehaviorsCron, 'behaviors'), { timezone: 'UTC' });
cron.schedule('25 5 * * *',  () => runIntelligence(() => runIntelligenceLearningCron('nightly'), 'learn:nightly'), { timezone: 'UTC' });
cron.schedule('30 5 * * 1',  () => runIntelligence(() => runIntelligenceLearningCron('weekly'), 'learn:weekly'), { timezone: 'UTC' });
cron.schedule('35 5 1 * *',  () => runIntelligence(() => runIntelligenceLearningCron('monthly'), 'learn:monthly'), { timezone: 'UTC' });
cron.schedule('40 5 * * *',  () => runIntelligence(runIntelligenceRecommendationsCron, 'recommendations'), { timezone: 'UTC' });
cron.schedule('45 5 * * *',  () => runIntelligence(runDecisionTracesCron, 'decision-traces'), { timezone: 'UTC' });
console.log('[WORKER] Revenue Intelligence Engine — behaviors 05:20, learn 05:25 (wk Mon 05:30, mo 1st 05:35), recs 05:40, traces 05:45 UTC (idle until jobs registered)');

// ── Campaign analytics refresh — daily at 05:00 UTC ──────────────────────────
// Pulls each workspace's real campaign funnel (sent/opened/replied/opportunities)
// from Instantly so campaign_performance has true denominators. The endpoint also
// refreshes on read (24h TTL); this is the backstop for campaigns nobody queried.
async function runCampaignStatsRefresh() {
  try {
    await campaignStatsRefreshCron();
  } catch (err) {
    console.error('[WORKER] Campaign stats refresh error:', err.message);
  }
}

cron.schedule('0 5 * * *', runCampaignStatsRefresh, { timezone: 'UTC' });
console.log('[WORKER] Campaign analytics refresh — daily at 05:00 UTC');

// ── Webhook retry queue — every minute ───────────────────────────────────────
// Picks up rows from webhook_inbox whose handlers failed (DB hiccup, Haiku
// timeout, etc.) and reprocesses them with exponential backoff.
cron.schedule('* * * * *', processWebhookInbox);
console.log('[WORKER] Webhook retry queue — every minute');

// ── Triggers delivery (outbound webhooks) — every 30 seconds ────────────────
// Drains outbound_events (filled by logActivity → enqueueOutboundEvent for
// the 6 interaction trigger types). Signs each payload with HMAC-SHA256 and
// POSTs to the subscriber's URL with retry + exponential backoff. The "agent
// gets paged" surface for the Account Record.
cron.schedule('*/30 * * * * *', deliverTriggers);
console.log('[WORKER] Trigger delivery — every 30 seconds');

// ── Webhook delivery log retention (GET-624) — daily 04:40 UTC ───────────────
// webhook_deliveries keeps one row per outbound attempt for the Webhooks page; 30 days is
// enough for the 7-day stats and a month of history. The outbox (outbound_events) is untouched.
cron.schedule('40 4 * * *', async () => {
  try {
    const removed = await pruneWebhookDeliveries(getSupabaseClient());
    if (removed) console.log(`[WEBHOOK_DELIVERIES] pruned ${removed} row(s) older than 30 days`);
  } catch (e) { console.error('[WEBHOOK_DELIVERIES] prune:', e?.message ?? e); }
}, { timezone: 'UTC' });

// ── GitHub dispatch delivery (automation layer, GET-74) — every 30 seconds ───
// Drains github_dispatches (filled by logActivity → enqueueGithubDispatches for
// automation-enabled seats). POSTs repository_dispatch to each seat's repo using
// their stored fine-grained token, so their GitHub Action runs the plugin
// headlessly (the after-call / weekly runner). Retry + backoff + dead-letter.
cron.schedule('*/30 * * * * *', deliverGithubDispatches);
console.log('[WORKER] GitHub dispatch delivery — every 30 seconds');
// GET-672: "After every call" now runs through a GitHub webhook per seat. The queue above skips any
// seat that has one and only drains what was already queued; the reconcile below gives every
// enabled seat its webhook (the first run is the migration) and keeps it matching repo and token.

// ── After-call webhooks (GET-672) — every 5 minutes, and once at start ─────────
let reconcilingAfterCall = false;
async function reconcileAfterCall() {
  if (reconcilingAfterCall) return;
  reconcilingAfterCall = true;
  try {
    const r = await reconcileAfterCallWebhooks(getSupabaseClient());
    if (r.created || r.updated || r.removed) console.log(`[AFTER_CALL_WEBHOOKS] created ${r.created} · updated ${r.updated} · removed ${r.removed}`);
  } catch (e) { console.error('[AFTER_CALL_WEBHOOKS] reconcile:', e?.message ?? e); }
  finally { reconcilingAfterCall = false; }
}
cron.schedule('*/5 * * * *', reconcileAfterCall);
setTimeout(reconcileAfterCall, 15_000);
console.log('[WORKER] After-call webhook reconcile — every 5 minutes');

// ── Claim-derivation engine — every minute ───────────────────────────────────
// Drains claim_jobs (filled by a DB trigger on every observation insert) and
// re-derives each affected claim from its observations. The self-healing loop:
// a new observation pulls the belief back toward truth. See docs/v2-build-plan.md.
cron.schedule('* * * * *', processClaimJobs);
console.log('[WORKER] Claim-derivation engine — every minute');

// ── Heartbeat — every minute ─────────────────────────────────────────────────
// One unconditional row in worker_runs saying the process is alive. Every other worker logs
// only when it did something, so a quiet system reads exactly like a stopped one; this is the
// fact that tells them apart. GET /readyz/workers on the API turns it into a 503, and an
// external monitor turns that into someone finding out. See workers/heartbeat.mjs.
cron.schedule('* * * * *', writeHeartbeat);
console.log('[WORKER] Heartbeat — every minute');
writeHeartbeat();   // and once at boot, so a restart is visible immediately

// ── Bulk enrich / verify jobs — every 20 seconds ─────────────────────────────
// Drains lead_bulk_jobs (enqueued by the API for large enrich/verify selections)
// in resumable chunks, advancing `processed` so the UI shows live progress.
cron.schedule('*/20 * * * * *', processBulkLeadJobs);
console.log('[WORKER] Bulk enrich/verify jobs — every 20 seconds');

// ── Contact history backfill jobs — every 20 seconds ─────────────────────────
// Drains contact_enrichment_jobs (enqueued by the API on CSV import). Runs the
// bulk, rate-lane'd history backfill off the API request path; resumable.
cron.schedule('*/20 * * * * *', processContactEnrichmentJobs);
console.log('[WORKER] Contact enrichment jobs — every 20 seconds');

// Scorecard prediction-write (every 10 minutes) stakes the learned scorer's icp_fit
// predictions: src/cloud/index.mjs (GET-754 slice 8). Without it a workspace's accounts are
// scored only by what it posts to POST /v2/scores.

// ── Intent score — every 6 hours ─────────────────────────────────────────────
// The second axis: stakes a decaying `intent_score`/`intent_band` claim on every
// entity with recent behavioural engagement (the "reach out NOW?" signal, separate
// from ICP fit). Anti-over-prioritized so no single channel fakes readiness. See
// intentScore.mjs.
cron.schedule('15 */6 * * *', () => scoreIntentCron().catch(e => console.error('[INTENT]', e.message)));
console.log('[WORKER] Intent score — every 6 hours');

// Win-model fit (weekly, Monday 05:00 UTC, before the snapshot below) is Cloud's: it refits
// the forecast's coefficients on a workspace's closed deals (src/cloud/index.mjs, GET-754
// slice 8). Without it the forecast runs on the default coefficients.

// Forecast snapshots (weekly, Monday 06:00 UTC, after the fit) are Cloud's too, with the revenue
// forecast they record (src/cloud/index.mjs, GET-843).

// ── Embedding worker — every 2 minutes, OFF unless switched on ───────────────
// Fills claim and observation embeddings so semantic search (the Context API retrieve step)
// works. No-op without OPENAI_API_KEY.
//
// OFF BY DEFAULT since 2026-09-21. This worker took production down twice over: it ran every
// two minutes with no overlap guard, each sweep asked a question no index could answer, and a
// single run reached nearly three minutes. Three would stack and all three would die on the
// statement timeout, while the Accounts page queued behind them. The hour after the 02:00 CRM sync
// spent almost all of its time here, against a baseline of a few minutes.
//
// Both faults are fixed (an overlap guard in the worker, partial queue indexes in
// 2026_09_21_embedding_queue_indexes.sql), but the flag stays default-off so that turning it
// back on is a deliberate act taken in the right order:
//
//   1. apply 2026_09_21_embedding_queue_indexes.sql   (CONCURRENTLY, safe on a live database)
//   2. deploy this worker                             (still off — nothing changes)
//   3. set EMBEDDINGS_ENABLED=true, restart the worker
//   4. watch worker_runs for `embeddings`: sub-second durations, no errors
//
// Flipping it on before step 1 reintroduces a scan of up to minutes on every tick.
if (process.env.EMBEDDINGS_ENABLED === 'true') {
  cron.schedule('*/2 * * * *', processEmbeddings);
  console.log('[WORKER] Embedding worker — every 2 minutes');
} else {
  console.log('[WORKER] Embedding worker — DISABLED (set EMBEDDINGS_ENABLED=true to enable; see 2026_09_21_embedding_queue_indexes.sql first)');
}

// ── CRM auto-sync — daily at 02:00 UTC ───────────────────────────────────────
// For every workspace with auto_sync=true on a CRM config, pulls new/updated
// contacts + companies + deals incrementally (since last_synced_at) and
// upserts into the v2 substrate. Runs BEFORE pipeline decay (03:00) so the
// calibration chain (decay → outcomes → scorecard) sees fresh CRM state.
// Users can always trigger an on-demand pull via the "Sync now" button.
// See workers/crmSync.mjs.
// Twice a day (GET-503): once a day meant an email sent at 09:00 reached an account the next
// morning. 14:00 UTC is mid-morning in North America, so the day's first replies land by lunch.
cron.schedule('0 2,14 * * *', runCrmAutoSync, { timezone: 'UTC' });
console.log('[WORKER] CRM auto-sync — twice daily at 02:00 and 14:00 UTC');

// ── Email threads read — daily at 02:45 UTC ──────────────────────────────────
// The CRM sync above pulls the day's email; this READS it — each new thread, and each thread with
// a reply since it was last read — into account facts and tasks. Before this, reading email only
// ever happened from a backfill script by hand. After the sync so it reads the night's mail, and
// before the health refresh (03:40) and the summaries so accounts reflect it by morning.
// See workers/emailThreadsDaily.mjs.
// Hourly since GET-557: filing no longer extracts, so this is when new email is read.
cron.schedule('45 * * * *', () => runEmailThreadsDaily().catch(err =>
  console.error('[EMAIL_DAILY] failed', err.message)), { timezone: 'UTC' });
// A run the worker was down for is not lost: every boot reads what is due ten minutes later. A
// deploy at 02:44 used to skip the night. Nothing due costs one read of the thread list, no model.
setTimeout(() => runEmailThreadsDaily().catch(err => console.error('[EMAIL_DAILY] boot run failed', err.message)), 10 * 60 * 1000);
console.log('[WORKER] Email threads read — hourly at :45 UTC, and 10 min after boot');

// ── Read ledger — every 15 minutes ───────────────────────────────────────────
// One noema.read per meeting or call, stamped when a claim first cites it, so a credit is
// consumed when the conversation is READ, not on the day it happened (GET-510). Billing sums
// these. Email writes its own. See workers/readLedger.mjs.
cron.schedule('8-59/15 * * * *', () => runReadLedger().catch(err => console.error('[READ_LEDGER] failed', err.message)));
console.log('[WORKER] Read ledger — every 15 minutes');

// ── CRM hygiene — daily tick at 08:00 UTC, runs configs due per their cadence ─
// Propose-only reconciliation: enriches + scores net-new CRM records and queues
// ICP write-backs as proposals for human approval. Per-workspace weekly/monthly
// cadence is enforced inside the sweep (hygiene_last_run_at). Runs after the
// 02:00 pull so it sees fresh CRM state. See workers/crmHygiene.mjs.
cron.schedule('0 8 * * *', runCrmHygieneSweep, { timezone: 'UTC' });
console.log('[WORKER] CRM hygiene — daily tick at 08:00 UTC (per-workspace cadence)');

// ── Pipeline-stage derivation — hourly at :15 ────────────────────────────────
// Walks active person entities and advances pipeline_stage based on observed
// activity (meeting/proposal → evaluating; replies → interested; connect →
// aware). Only promotes — never downgrades; the daily decay worker owns
// regression. Writes a state observation per advancement, so the claim engine
// re-derives the pipeline_stage claim downstream. See workers/stageDerivation.mjs.
// ── Rules — hourly at :25 (GET-846) ───────────────────────────────────────────
// A rep's checked rules against what the graph holds: a broken rule opens a flag and a task on
// the account, a met one resolves them. After the stage derivation (:15), so a stage that just
// moved is read fresh. See workers/ruleChecks.mjs.
async function runRuleChecksSafe() {
  try { await runRuleChecks(); }
  catch (err) { console.error('[WORKER] rule checks error:', err.message); }
}
cron.schedule('25 * * * *', runRuleChecksSafe);
console.log('[WORKER] Rules — hourly at :25');

async function runStageDerivationSafe() {
  try { await runStageDerivation(); }
  catch (err) { console.error('[WORKER] stage derivation error:', err.message); }
}
runStageDerivationSafe();
cron.schedule('15 * * * *', runStageDerivationSafe);
console.log('[WORKER] Pipeline-stage derivation — hourly at :15');

// ── API-plan notifications (GET-635) ─────────────────────────────────────────
// Webhook failures every 15 min, keys expiring daily (credits running low is Cloud's, in cloud/index.mjs). The api
// decides who is due one and de-duplicates; this only sends. Dormant unless
// WORKER_INTERNAL_SECRET is set. See workers/apiNotificationEmails.mjs.
const runApiNotify = (kinds) => () => runApiNotificationEmails(kinds)
  .catch((err) => console.error('[WORKER] api notifications error:', err?.message));
cron.schedule('8-59/15 * * * *', runApiNotify(['webhook_failures']));
cron.schedule('10 8 * * *', runApiNotify(['key_expiring']), { timezone: 'UTC' });
console.log('[WORKER] API-plan notifications — webhooks every 15 min, keys daily 08:10 UTC');

// The automation engine's daily pass (GET-426). Turns a deal changing stage into the
// artifact somebody asked for and sends it where they asked. A poll rather than a webhook
// for now — see automations/dailyPoll.mjs for why, and for the seam a webhook would use.
async function runAutomationPollSafe() {
  try { await runAutomationDailyPoll(); }
  catch (err) { console.error('[WORKER] automation poll error:', err.message); }
}
// THE LEDGER THE DEAL TRIGGERS READ HAS TO BE FRESH, and nothing was refreshing it.
// deal_outcomes is derived, and buildOutcomeLedger was reached only from the revenue report
// and the ICP evidence route — so the table sat as it was left on 2026-09-22 and a deal
// closing tomorrow would never appear in it. Rebuilt at 06:30, half an hour before the poll
// reads it. Same seam as the agent routines: the worker says "now", the API does the work,
// because the builder lives in apps/api and this image does not contain apps/api.
async function runLedgerRebuildSafe() {
  const secret = process.env.WORKER_SECRET;
  if (!secret) {
    console.warn('[WORKER] outcome ledger: WORKER_SECRET unset — rebuild disabled');
    return;
  }
  try {
    const resp = await fetch(`${process.env.API_URL}/internal/automations/rebuild-ledger`, {
      method: 'POST',
      headers: { 'x-worker-secret': secret, 'content-type': 'application/json' },
    });
    const body = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(`${resp.status} ${JSON.stringify(body).slice(0, 200)}`);
    console.log(`[WORKER] outcome ledger rebuilt for ${body.workspaces ?? 0} workspace(s)`);
  } catch (err) {
    // Never throws into the scheduler. A failed rebuild means the poll reads yesterday's
    // ledger, which is stale rather than wrong.
    console.error('[WORKER] outcome ledger rebuild error:', err.message);
  }
}
cron.schedule('30 6 * * *', runLedgerRebuildSafe, { timezone: 'UTC' });
console.log('[WORKER] Outcome ledger — daily at 06:30 UTC');

// 07:30 in New York, when the people it emails are starting their day. The ledger rebuild at
// 06:30 UTC lands well before it in every season.
cron.schedule('30 7 * * *', runAutomationPollSafe, { timezone: 'America/New_York' });
console.log('[WORKER] Automations — daily at 07:30 America/New_York');

// Deal events (GET-559) — won, lost and stage moves pushed to the workspaces subscribed to them.
// Hourly: a close is news the hour the ledger learns of it. Dedupe keys are permanent, so the
// same close read again next hour queues nothing.
cron.schedule('17 * * * *', () => emitDealEventsPoll().catch(err =>
  console.error('[WORKER] deal events error:', err.message)));
console.log('[WORKER] Deal events — hourly at :17');

// ICP events (GET-588) — icp.score_changed / icp.tier_changed for the workspaces subscribed to them,
// from any scorer (Nous's own, or a workspace's own via /v2/scores). Hourly, off the deal pass.
cron.schedule('37 * * * *', () => emitIcpEventsPoll().catch(err =>
  console.error('[WORKER] ICP events error:', err.message)));
console.log('[WORKER] ICP events — hourly at :37');

// People added (GET-588) — one batched event per workspace for the hour that just ended.
// Account signals (GET-686) — objections, competitors, stakeholders, budget, next steps,
// expansion and churn risk, as the claim trigger records them: sent to webhooks and to the
// automations that listen for them, every few minutes.
cron.schedule('2-59/5 * * * *', () => processAccountSignals().catch(err =>
  console.error('[WORKER] account signals error:', err.message)));
console.log('[WORKER] Account signals — every 5 minutes');

// When a HubSpot field changes (GET-781): the watched fields' recent history, every 5 minutes.
cron.schedule('4-59/5 * * * *', () => processHubspotFieldChanges().catch(err =>
  console.error('[WORKER] hubspot field changes error:', err.message)));
console.log('[WORKER] HubSpot field changes — every 5 minutes');

cron.schedule('7 * * * *', () => emitPeopleAddedPoll().catch(err =>
  console.error('[WORKER] people.added error:', err.message)));
console.log('[WORKER] People added — hourly at :07');

console.log('[WORKER] Started');


// The detector automations draft their follow-ups (GET-685): Stale deal detection, Deal risk
// detection and Expansion signals, nightly at 06:10 UTC (after the health refreshes and the
// intelligence pass, before a US morning). Api-owned like the ticks above: the drafting is a
// model call behind the api's credits gate. The api answers at once and runs the pass itself.
async function runDetectorDraftsTickSafe(body = {}) {
  const secret = process.env.WORKER_SECRET;
  if (!secret) return;
  try {
    const resp = await fetch(`${process.env.API_URL}/internal/detector-drafts/tick`, {
      method: 'POST',
      headers: { 'x-worker-secret': secret, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!resp.ok) throw new Error(`detector drafts tick failed: ${resp.status}`);
  } catch (err) {
    console.error('[WORKER] detector drafts tick:', err.message);
  }
}
cron.schedule('10 6 * * *', () => runDetectorDraftsTickSafe(), { timezone: 'UTC' });
console.log('[WORKER] Detector automation drafts — daily 06:10 UTC');
// Deal signals (GET-694) draft within the hour, not overnight: an objection or a champion leaving
// is answered while the call is fresh, the way a follow-up after a meeting is. Same gates and caps.
cron.schedule('25 * * * *', () => runDetectorDraftsTickSafe({ only: ['deal_signal'] }));
console.log('[WORKER] Deal signal drafts — hourly at :25');

// Personal-vault poll fallback — every 10 minutes. Ingests connected GitHub sources
// that can't rely on a push webhook (a PAT without the Webhooks permission) or that
// have gone quiet. Sources WITH a live webhook that synced recently are skipped api-side.
// Same api-owned + WORKER_SECRET pattern as the ticks above.
async function runVaultSyncTickSafe() {
  const secret = process.env.WORKER_SECRET;
  if (!secret) return;
  try {
    const resp = await fetch(`${process.env.API_URL}/internal/personal-sync/tick`, {
      method: 'POST',
      headers: { 'x-worker-secret': secret, 'content-type': 'application/json' },
    });
    if (!resp.ok) throw new Error(`vault sync tick failed: ${resp.status}`);
    const r = await resp.json();
    if (r.synced || r.conflicts) {
      console.log(`[WORKER] vault sync — ${r.synced} synced, ${r.conflicts} conflicts (${r.considered} considered)`);
    }
  } catch (err) {
    console.error('[WORKER] vault sync tick:', err.message);
  }
}
cron.schedule('*/10 * * * *', runVaultSyncTickSafe);
console.log('[WORKER] Vault sync (personal) — every 10 minutes');
