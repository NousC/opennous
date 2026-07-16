// Nous Worker — background signal ingestion and scheduled pollers.
//
// Runs two things:
//   1. A lightweight HTTP server for inbound webhooks (LinkedIn, Fireflies, RB2B, etc.)
//   2. Scheduled pollers using node-cron for predictable timing

import './bootEnv.mjs'; // first — normalizes APP_URL/API_URL from domains before any module reads them
import express from 'express';
import cron from 'node-cron';
import { getSupabaseClient, registerCrmPushHandler, pushActivityToAllCrms, logWorkerRun } from '@nous/core';
import { pollAllWorkspaces } from './pollers/calendar.mjs';
import { pollAllSlackWorkspaces } from './pollers/slack.mjs';
import { pollAllGmailWorkspaces } from './pollers/gmail.mjs';
import { pollAllSmtpWorkspaces } from './pollers/smtp.mjs';
import { webhookRouter } from './webhooks/index.mjs';
import { processWebhookInbox } from './workers/webhookRetry.mjs';
import { deliverTriggers } from './workers/triggerDelivery.mjs';
import { resolveOutcomes } from './workers/mindOutcomes.mjs';
import { processLeadReplies } from './workers/leadReplies.mjs';
import { runScorecardLoop } from './workers/scorecardLoop.mjs';
import { processClaimJobs } from './workers/claimEngine.mjs';
import { processBulkLeadJobs } from './workers/bulkLeadJobs.mjs';
import { scoreEntities } from './workers/scoreEntities.mjs';
import { scoreIntentCron } from './intentScore.mjs';
import { processEmbeddings } from './workers/embeddings.mjs';
import { runCrmAutoSync } from './workers/crmSync.mjs';
import { runCrmHygieneSweep } from './workers/crmHygiene.mjs';
import { runStageDerivation } from './workers/stageDerivation.mjs';
import { runOnboardingDrip } from './workers/onboardingDrip.mjs';
import { runOpsLimitEmails } from './workers/opsLimitEmails.mjs';
import { runLinkedInEngagement, runEngagementScrapeRequests } from './workers/linkedinEngagement.mjs';
import { runAuditSweep } from './workers/auditSweep.mjs';

// Wire webhook-driven activity logging → CRM push at module load.
// Worker is where most logActivity() calls originate (Instantly/Lemlist replies,
// Fireflies/Fathom meetings, LinkedIn messages, Calendly bookings, etc.)
registerCrmPushHandler(pushActivityToAllCrms);

// ── Validate required env vars ────────────────────────────────────────────────
const REQUIRED = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'];
for (const key of REQUIRED) {
  if (!process.env[key]) {
    console.error(`[WORKER] Missing required env var: ${key}`);
    process.exit(1);
  }
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

const PORT = process.env.WORKER_PORT ?? 3001;
app.listen(PORT, () => console.log(`[WORKER] Webhook server on :${PORT}`));

// ── Calendar poller — every hour ─────────────────────────────────────────────
async function runCalendarPoller() {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) return;
  try {
    await pollAllWorkspaces();
  } catch (err) {
    console.error('[WORKER] Calendar poll error:', err.message);
  }
}

// Run once on startup, then hourly
runCalendarPoller();
cron.schedule('0 * * * *', runCalendarPoller);
console.log('[WORKER] Calendar poller — every hour');

// ── Slack DM poller — every hour ─────────────────────────────────────────────
async function runSlackPoller() {
  if (!process.env.SLACK_CLIENT_ID) return;
  try { await pollAllSlackWorkspaces(); }
  catch (err) { console.error('[WORKER] Slack poll error:', err.message); }
}
cron.schedule('0 * * * *', runSlackPoller);
console.log('[WORKER] Slack poller — every hour');

// ── Gmail poller — every hour ────────────────────────────────────────────────
async function runGmailPoller() {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) return;
  try { await pollAllGmailWorkspaces(); }
  catch (err) { console.error('[WORKER] Gmail poll error:', err.message); }
}
// Run once on startup so reconnects/redeploys produce visible activity immediately
runGmailPoller();
cron.schedule('0 * * * *', runGmailPoller);
console.log('[WORKER] Gmail poller — every hour');

// ── SMTP/IMAP poller — every hour ────────────────────────────────────────────
async function runSmtpPoller() {
  try { await pollAllSmtpWorkspaces(); }
  catch (err) { console.error('[WORKER] SMTP poll error:', err.message); }
}
runSmtpPoller();
cron.schedule('0 * * * *', runSmtpPoller);
console.log('[WORKER] SMTP/IMAP poller — every hour');

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

cron.schedule('*/15 * * * *', runLeadReplies);
console.log('[WORKER] Lead reply classification — every 15 minutes');

// ── Scorecard learning loop — daily at 04:00 UTC ─────────────────────────────
// Refines the Scorecard from the account record's resolved predictions:
// propose → test on a held-back split → keep only if both gates agree.
// Runs after outcome resolution (03:30). See docs/adaptive-lead-scoring.md.
async function runScorecard() {
  try {
    await runScorecardLoop();
  } catch (err) {
    console.error('[WORKER] Scorecard loop error:', err.message);
  }
}

cron.schedule('0 4 * * *', runScorecard, { timezone: 'UTC' });
console.log('[WORKER] Scorecard learning loop — daily at 04:00 UTC');

// ── LinkedIn engagement run — weekly, Monday 06:00 UTC ───────────────────────
// Scrapes engagers off each Scale workspace's own recent LinkedIn posts into the
// native "LinkedIn Engagers" lead list. No frontend trigger; ops-log only. Whole
// thing is a no-op unless APIFY_TOKEN is set. See workers/linkedinEngagement.mjs.
async function runWeeklyEngagement() {
  try {
    await runLinkedInEngagement();
  } catch (err) {
    console.error('[WORKER] LinkedIn engagement error:', err.message);
  }
}

cron.schedule('0 6 * * 1', runWeeklyEngagement, { timezone: 'UTC' });
console.log('[WORKER] LinkedIn engagement — weekly Monday 06:00 UTC');

// ── On-demand engagement scrape requests — every minute ──────────────────────
// Drains the queue filled by POST /api/linkedin/engagement/scrape (the app
// button + the scrape_engagers MCP tool). Lets a user mine engagers right now /
// backfill a wider window, instead of waiting for the weekly run. Cheap no-op
// when nothing is queued. See workers/linkedinEngagement.mjs.
async function runEngagementRequestsSafe() {
  try { await runEngagementScrapeRequests(); }
  catch (err) { console.error('[WORKER] engagement scrape requests error:', err.message); }
}
cron.schedule('* * * * *', runEngagementRequestsSafe);
console.log('[WORKER] LinkedIn engagement on-demand requests — every minute');

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

// ── Claim-derivation engine — every minute ───────────────────────────────────
// Drains claim_jobs (filled by a DB trigger on every observation insert) and
// re-derives each affected claim from its observations. The self-healing loop:
// a new observation pulls the belief back toward truth. See docs/v2-build-plan.md.
cron.schedule('* * * * *', processClaimJobs);
console.log('[WORKER] Claim-derivation engine — every minute');

// ── Bulk enrich / verify jobs — every 20 seconds ─────────────────────────────
// Drains lead_bulk_jobs (enqueued by the API for large enrich/verify selections)
// in resumable chunks, advancing `processed` so the UI shows live progress.
cron.schedule('*/20 * * * * *', processBulkLeadJobs);
console.log('[WORKER] Bulk enrich/verify jobs — every 20 seconds');

// ── Scorecard prediction-write — every 10 minutes ────────────────────────────
// Stakes an `icp_fit` prediction on every person-entity that has claims but no
// open prediction. Turns the front of the compound loop on: beliefs (claims)
// become a prediction the outcome job later grades. See workers/scoreEntities.mjs.
cron.schedule('*/10 * * * *', scoreEntities);
console.log('[WORKER] Scorecard prediction-write — every 10 minutes');

// ── Intent score — every 6 hours ─────────────────────────────────────────────
// The second axis: stakes a decaying `intent_score`/`intent_band` claim on every
// entity with recent behavioural engagement (the "reach out NOW?" signal, separate
// from ICP fit). Anti-over-prioritized so no single channel fakes readiness. See
// intentScore.mjs.
cron.schedule('15 */6 * * *', () => scoreIntentCron().catch(e => console.error('[INTENT]', e.message)));
console.log('[WORKER] Intent score — every 6 hours');

// ── Embedding worker — every 2 minutes ───────────────────────────────────────
// Fills claim embeddings so semantic search (the Context API retrieve step)
// works. No-op without OPENAI_API_KEY.
cron.schedule('*/2 * * * *', processEmbeddings);
console.log('[WORKER] Embedding worker — every 2 minutes');

// ── CRM auto-sync — daily at 02:00 UTC ───────────────────────────────────────
// For every workspace with auto_sync=true on a CRM config, pulls new/updated
// contacts + companies + deals incrementally (since last_synced_at) and
// upserts into the v2 substrate. Runs BEFORE pipeline decay (03:00) so the
// calibration chain (decay → outcomes → scorecard) sees fresh CRM state.
// Users can always trigger an on-demand pull via the "Sync now" button.
// See workers/crmSync.mjs.
cron.schedule('0 2 * * *', runCrmAutoSync, { timezone: 'UTC' });
console.log('[WORKER] CRM auto-sync — daily at 02:00 UTC');

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
async function runStageDerivationSafe() {
  try { await runStageDerivation(); }
  catch (err) { console.error('[WORKER] stage derivation error:', err.message); }
}
runStageDerivationSafe();
cron.schedule('15 * * * *', runStageDerivationSafe);
console.log('[WORKER] Pipeline-stage derivation — hourly at :15');

// ── Onboarding drip — hourly at :45 ──────────────────────────────────────────
// Dogfood follow-up sequence for our own signups. Reads the observation
// substrate (welcome sent, replies, conversions) and sends the next due nudge
// from DRIP, recording each send as an observation so it shows on the timeline.
// Cloud-only: no-op unless NOUS_DOGFOOD_WORKSPACE_ID is set. See
// workers/onboardingDrip.mjs.
async function runOnboardingDripSafe() {
  try { await runOnboardingDrip(); }
  catch (err) { console.error('[WORKER] onboarding drip error:', err.message); }
}
cron.schedule('45 * * * *', runOnboardingDripSafe);
console.log('[WORKER] Onboarding drip — hourly at :45');

// ── Ops-limit warning emails — hourly at :50 ─────────────────────────────────
// Asks the api which teams are due an ops email (80% / over-limit / grace-
// expiring) and sends them. Dormant unless WORKER_INTERNAL_SECRET is set. See
// workers/opsLimitEmails.mjs.
async function runOpsLimitEmailsSafe() {
  try { await runOpsLimitEmails(); }
  catch (err) { console.error('[WORKER] ops-limit emails error:', err.message); }
}
cron.schedule('50 * * * *', runOpsLimitEmailsSafe);
console.log('[WORKER] Ops-limit emails — hourly at :50');

console.log('[WORKER] Started');


// ── Agent routines — every 5 minutes ────────────────────────────────────────
// The scheduler for work the agent does unasked: the Monday pipeline review, the
// brief that lands an hour before a call.
//
// The agent itself lives in the API (one agent, one place — a scheduled brief must
// be the same assistant you talk to on Home, not a copy that drifts from it), so
// the worker's job is purely to say "now". Every occurrence is claimed through a
// unique index on the runs table, so a slow tick overlapping the next one, or two
// workers running at once, still briefs you exactly once.
//
// Five minutes is the resolution: a brief set for "1 hour before" lands between 55
// and 60 minutes ahead, which is what anyone means by an hour's warning.
async function runRoutineTickSafe() {
  const secret = process.env.WORKER_SECRET;
  if (!secret) {
    console.warn('[WORKER] routines: WORKER_SECRET unset — scheduler disabled');
    return;
  }
  try {
    const resp = await fetch(`${process.env.API_URL}/api/routines/tick`, {
      method: 'POST',
      headers: { 'x-worker-secret': secret, 'content-type': 'application/json' },
    });
    if (!resp.ok) throw new Error(`tick failed: ${resp.status}`);
    const r = await resp.json();
    if (r.clock || r.meetings || r.errors) {
      console.log(`[WORKER] routines — ${r.clock} scheduled, ${r.meetings} meeting briefs, ${r.errors} errors`);
    }
  } catch (err) {
    console.error('[WORKER] routines tick:', err.message);
  }
}
cron.schedule('*/5 * * * *', runRoutineTickSafe);
console.log('[WORKER] Agent routines — every 5 minutes');
