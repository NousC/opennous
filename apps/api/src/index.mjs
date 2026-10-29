import './bootEnv.mjs'; // first — normalizes APP_URL/API_URL from domains before any module reads them
import express from 'express';
import cors from 'cors';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { createHash } from 'node:crypto';
import { registerCrmPushHandler, pushActivityToAllCrms, registerStepHandler, getSupabaseClient, registerActivityHook, pipelineStageHook, crmAgentHook, registerCommitteeProvider, loadBuyingCommittee } from '@nous/core';

// CRM push is OFF. Nous is a read-only tool: we pull from the CRM into the
// substrate and never write back. Leaving the handler unregistered makes
// notifyCrmPush() a no-op — no route, worker or activity path changes.
// Re-enable by uncommenting this one line (same in apps/worker/src/index.mjs).
// registerCrmPushHandler(pushActivityToAllCrms);
void registerCrmPushHandler; void pushActivityToAllCrms;
// Automation steps that need this process's connections (GET-543). Slack posts with the bot token
// are Cloud's, registered by cloud/index.mjs (GET-754).
registerStepHandler('gmail_draft', automationGmailDraft);
registerStepHandler('gmail_send', automationGmailSend);
registerStepHandler('gmail_delete_draft', automationGmailDeleteDraft);
registerStepHandler('meter', meterAutomation);
registerStepHandler('smtp_send', automationSmtpSend);

// Pipeline-stage advancement + outcome resolution are a PRODUCT hook on the substrate's activity
// seam (context-graph decouple #1). This MUST be registered or logActivity stops advancing stages.
registerActivityHook(pipelineStageHook);
// The CRM agent: after a Nous-ingested activity lands on an account with open deals, decide
// which deal it was about — propose when there is one, ask when there are several. Runs
// after the stage hook, never instead of it. A no-op unless the workspace has switched the
// agent on (crm_sync_configs.crm_agent_enabled) and the activity is after its CRM baseline.
registerActivityHook(crmAgentHook);
// Buying committee is a product projection (decouple #4): register it onto getAccountRecord's
// seam so get_account still returns the committee. Empty if unregistered.
registerCommitteeProvider((sb, ws, eid) => loadBuyingCommittee(sb, ws, eid, 'buying_group'));

import { verifyApiKey } from './middleware/apiKey.mjs';
import { verifySupabaseAuth } from './middleware/supabaseAuth.mjs';
import { verifyAuthEither } from './middleware/authEither.mjs';
import { requireAdmin } from './middleware/requireAdmin.mjs';
import { logV2Op } from './middleware/opLogger.mjs';
import { requireFeature, requireOpsBalance, blockOnSelfHost } from './lib/access.mjs';
import { opsAlert } from './lib/opsAlert.mjs';
import { buildAuthConfig } from './lib/authConfig.mjs';
import { initSentry, captureException as sentryCapture } from './lib/sentry.mjs';
initSentry('api'); // no-op unless SENTRY_DSN is set

// v2 — Context API (evidence substrate)
import { accountsV2Router } from './routes/v2/accounts.mjs';
import { observationsV2Router } from './routes/v2/observations.mjs';
import { contextV2Router } from './routes/v2/context.mjs';
import { queryV2Router } from './routes/v2/query.mjs';
import { scoreV2Router } from './routes/v2/score.mjs';
import { scoresV2Router } from './routes/v2/scores.mjs';
import { attentionV2Router } from './routes/v2/attention.mjs';
import { campaignPerformanceV2Router } from './routes/v2/campaignPerformance.mjs';
import { pipelineIntelligenceV2Router } from './routes/v2/pipelineIntelligence.mjs';
import { dealsV2Router } from './routes/v2/deals.mjs';
import { pipelinesV2Router } from './routes/v2/pipelines.mjs';
import { auditV2Router } from './routes/v2/audit.mjs';
import { verifyV2Router } from './routes/v2/verify.mjs';
import { dedupV2Router } from './routes/v2/dedup.mjs';
import { workspaceFactsV2Router } from './routes/v2/workspaceFacts.mjs';
import { workspaceStatusV2Router } from './routes/v2/workspaceStatus.mjs';
import { foundationsV2Router } from './routes/v2/foundations.mjs';
import { insightsV2Router } from './routes/v2/insights.mjs';
import { decisionsV2Router } from './routes/v2/decisions.mjs';
import { notesV2Router } from './routes/v2/notes.mjs';
import { documentsV2Router } from './routes/v2/documents.mjs';
import { signalsV2Router } from './routes/v2/signals.mjs';
import { peopleV2Router } from './routes/v2/people.mjs';
import { leadsV2Router } from './routes/v2/leads.mjs';
import { leadListsV2Router } from './routes/v2/leadLists.mjs';
import { actionItemsV2Router } from './routes/v2/actionItems.mjs';
import { rulesV2Router } from './routes/v2/rules.mjs';
import { unresolvedV2Router } from './routes/v2/unresolved.mjs';
import { crmAgentV2Router } from './routes/v2/crmAgent.mjs';
import { draftsV2Router } from './routes/v2/drafts.mjs';
import { membersV2Router } from './routes/v2/members.mjs';
import { icpV2Router } from './routes/v2/icp.mjs';
import { usageV2Router } from './routes/v2/usage.mjs';
import { workflowsV2Router } from './routes/v2/workflows.mjs';
import { approvalsV2Router } from './routes/v2/approvals.mjs';
import { webhooksV2Router } from './routes/v2/webhooks.mjs';
import { eventsV2Router } from './routes/v2/events.mjs';

// /api — Frontend API (Supabase JWT auth)
import { apiKeysRouter } from './routes/api/apiKeys.mjs';
import { apiKeyUsageRouter } from './routes/api/apiKeyUsage.mjs';
import { cliAuthRouter } from './routes/api/cliAuth.mjs';
import { oauthRouter, oauthConsentRouter, authorizationServerMetadataHandler } from './routes/oauth.mjs';
import { webhooksRouter } from './routes/api/webhooks.mjs';
import { meRouter } from './routes/api/me.mjs';
import { workspacesRouter } from './routes/api/workspaces.mjs';
import { teamsRouter } from './routes/api/teams.mjs';
import { usersRouter } from './routes/api/users.mjs';
import { invitationsRouter } from './routes/api/invitations.mjs';
import { instanceSetupRouter } from './routes/api/instanceSetup.mjs';
import { onboardingRouter } from './routes/api/onboarding.mjs';
import { usageRouter } from './routes/api/usage.mjs';
import { mentionsRouter } from './routes/api/mentions.mjs';
import { billingRouter } from './routes/api/billing.mjs';
import { apiNotificationsRouter } from './routes/apiNotifications.mjs';
import { detectorDraftsInternalRouter } from './routes/detectorDrafts.mjs';
import { automationStepsInternalRouter } from './routes/automationSteps.mjs';
import { automationGmailDraft, automationGmailSend, automationGmailDeleteDraft, meterAutomation, automationSmtpSend } from './lib/automationSteps.mjs';
import { integrationsRouter } from './routes/api/integrations.mjs';
import { crmRouter } from './routes/api/crm.mjs';
import { contactsApiRouter } from './routes/api/contacts.mjs';
import { foundationsApiRouter } from './routes/api/foundations.mjs';
import { imgProxyRouter } from './routes/api/img.mjs';
import { claimsApiRouter } from './routes/api/claims.mjs';
import { companiesApiRouter } from './routes/api/companies.mjs';
import { crmOwnersApiRouter } from './routes/api/crmOwners.mjs';
import { crmPipelinesApiRouter } from './routes/api/crmPipelines.mjs';
import { lifecycleApiRouter } from './routes/api/lifecycle.mjs';
import { flagsApiRouter } from './routes/api/flags.mjs';
import { conflictsApiRouter } from './routes/api/conflicts.mjs';
import { identityProposalsApiRouter } from './routes/api/identityProposals.mjs';
import { graphApiRouter } from './routes/api/graph.mjs';
import { signalsRouter, publicSignalsRouter } from './routes/api/signals.mjs';
import { skillDownloadsRouter } from './routes/public/skillDownloads.mjs';
import { installRouter } from './routes/public/install.mjs';
import { requestsRouter } from './routes/api/requests.mjs';
import { workspaceMemoriesRouter } from './routes/api/workspaceMemories.mjs';
import { personalRouter } from './routes/api/personal.mjs';
import { entityNotesRouter } from './routes/api/notes.mjs';
import { sharesRouter } from './routes/api/shares.mjs';
import { githubVaultWebhookHandler, personalSyncInternalRouter } from './routes/personalGithubSync.mjs';
import { activityStatsRouter } from './routes/api/activityStats.mjs';
import { backfillRouter } from './routes/api/backfillPreview.mjs';
import { evidenceRouter } from './routes/api/evidence.mjs';
import { docsRouter } from './routes/api/docs.mjs';
import { actionsRouter } from './routes/api/actions.mjs';
import { contextRouter } from './routes/api/context.mjs';
import { leadListsRouter } from './routes/api/leadLists.mjs';
import { campaignMessagesRouter } from './routes/api/campaignMessages.mjs';
import { triggersRouter } from './routes/api/triggers.mjs';
import { accountOverviewRouter } from './routes/api/accountOverview.mjs';
// The engine's visible_accounts and safe_fetch step handlers (registered on import).
import './lib/engineStepHandlers.mjs';
import { automationsRouter, automationsInternalRouter } from './routes/api/automations.mjs';
import { workflowProvidersRouter } from './routes/api/workflowProviders.mjs';
import { systemLogRouter } from './routes/api/systemLog.mjs';
import { connectRouter } from './routes/api/connect.mjs';
import { observationsLogRouter } from './routes/api/observationsLog.mjs';
import { connectComposioRouter } from './routes/api/connectComposio.mjs';
import { workspaceComposioRouter } from './routes/api/workspaceComposio.mjs';
import { oauthAirtableRouter } from './routes/api/oauthAirtable.mjs';
import { oauthSalesforceRouter } from './routes/api/oauthSalesforce.mjs';
import { oauthLinearRouter } from './routes/api/oauthLinear.mjs';
import { linearRouter } from './routes/api/linear.mjs';
import { oauthGoogleRouter } from './routes/api/oauthGoogle.mjs';
import { loadCloud, HAS_CLOUD } from './lib/cloud.mjs';

// The Workspace (Cloud) layer, GET-754: src/cloud/index.mjs when this checkout has it, else null
// (the open-source build). Its hooks run at fixed points below; each is optional.
const cloud = await loadCloud();
const cloudDeps = { verifyApiKey, verifySupabaseAuth, verifyAuthEither, requireAdmin, requireFeature, requireOpsBalance, blockOnSelfHost, logV2Op, getSupabaseClient };
cloud?.register?.({ registerStepHandler, registerActivityHook, registerCommitteeProvider });

const app = express();

// Behind Caddy → req.ip resolves to the real client IP, not the proxy hop.
// Needed for IP-based country geolocation (see lib/geo.mjs).
app.set('trust proxy', 1);

// Default-DENY cross-origin. Previously an unset CORS_ORIGINS reflected any
// origin with credentials; now it blocks cross-origin instead of failing open.
// Set CORS_ORIGINS to the app origin(s) in the deploy env.
const allowedOrigins = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(',').map(o => o.trim())
  : false;
if (allowedOrigins === false) {
  console.warn('[cors] CORS_ORIGINS is not set — cross-origin requests are blocked. Set it to your app origin(s).');
}

// MCP OAuth endpoints (GET-762) are called cross-origin by browser-based MCP
// clients (the MCP Inspector). They carry no cookies, so any origin may call them.
app.use(['/oauth', '/.well-known'], cors({ origin: '*', credentials: false }));

app.use(cors({
  origin: allowedOrigins,
  credentials: true,
}));

// Personal-vault GitHub webhook — HMAC-verified over the raw body, so it too mounts
// before express.json(). A push to a member's connected repo ingests into their vault.
app.post('/api/personal/github/webhook/:token', express.raw({ type: 'application/json' }), githubVaultWebhookHandler);

cloud?.mountRaw?.(app, cloudDeps);

app.use(express.json({ limit: '10mb' }));

// Say which request was slow, with its route and how long it took (GET-310).
//
// "Loading is really slow" has been diagnosed three times by guessing at queries, because nothing
// records what the app actually waited for: the API logs errors, never durations. One line per slow
// request turns that into a fact. The threshold is well under PostgREST's 8s statement cap, so a
// request that is heading for a timeout shows up here first.
const SLOW_REQUEST_MS = Number(process.env.SLOW_REQUEST_MS ?? 1000);
app.use((req, res, next) => {
  const t0 = process.hrtime.bigint();
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    if (ms < SLOW_REQUEST_MS) return;
    // The MOUNTED route, not the router-relative one: `req.route.path` alone prints "/" for every
    // list endpoint in the app, which is how the first version of this line managed to be useless.
    // baseUrl + route gives "/api/companies/:id/detail" — the pattern, so no ids and no search
    // terms are logged, and two requests to the same endpoint aggregate.
    const route = (req.baseUrl || '') + (req.route?.path && req.route.path !== '/' ? req.route.path : '');
    console.warn('[SLOW] %s %s %d %dms', req.method, route || req.path, res.statusCode, Math.round(ms));
  });
  next();
});

// ── Rate limiting ─────────────────────────────────────────────────────────────
// Bucket authenticated API traffic PER API KEY, not per IP. The old per-IP-only
// keying meant the hosted MCP — which calls this API in-cluster from ONE container
// IP for every tenant — shared a single bucket, so one busy customer could throttle
// all the others (and no single key had its own ceiling). Now each pk_ key gets its
// own window; browser/JWT and anonymous traffic still key by IP (Clerk JWTs rotate
// every ~30s, so they're useless as a stable bucket key). trust proxy is set, so the
// IP fallback is the real client IP behind Caddy.
const shortHash = (s) => createHash('sha256').update(String(s)).digest('hex').slice(0, 16);
function apiKeyFromReq(req) {
  const x = req.headers['x-api-key'];
  if (x) return String(x);
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ')) {
    const t = auth.slice(7);
    if (t.startsWith('pk_') || t.startsWith('nat_')) return t; // our API keys + OAuth tokens; not Clerk JWTs
  }
  return null;
}
// Per-tenant key: the API key when present (hashed so raw keys never sit in the store),
// else the IPv6-safe client IP.
const rateKey = (req) => {
  const k = apiKeyFromReq(req);
  return k ? `k:${shortHash(k)}` : `ip:${ipKeyGenerator(req.ip)}`;
};
const generalLimiter = rateLimit({
  windowMs: 60_000,
  max: 600,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: rateKey,
  message: { error: 'rate_limited' },
});
// Tighter bucket for unauthenticated public surfaces (device-login, auth config,
// install) where abuse/enumeration is cheapest.
const publicLimiter = rateLimit({
  windowMs: 60_000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'rate_limited' },
});

// MCP OAuth (GET-762): Claude.ai, Grok and ChatGPT call register/token from their own
// servers, so every user of one client shares a handful of IPs. Looser than publicLimiter.
const oauthLimiter = rateLimit({
  windowMs: 60_000,
  max: 600,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'rate_limited' },
});

// ── Health ────────────────────────────────────────────────────────────────────
// /health is LIVENESS — fast, dependency-free, for the container/Caddy. It must stay
// green as long as the process is up so a transient DB blip doesn't flap the service.
import { heartbeatVerdict, staleAfterMsFromEnv } from './lib/workerHealth.mjs';

app.get('/health', (_req, res) => res.json({ ok: true }));

// /readyz is READINESS — actually checks the critical dependency (the DB). Point an
// external uptime monitor (UptimeRobot / BetterStack) at this: it returns 503 when the
// DB is unreachable, which is exactly the outage the old static /health hid.
app.get('/readyz', async (_req, res) => {
  const checks = {};
  let ok = true;
  try {
    const supabase = getSupabaseClient();
    const t0 = Date.now();
    const probe = supabase.from('subscriptions').select('team_id').limit(1);
    const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('timeout after 4000ms')), 4000));
    const { error } = await Promise.race([probe, timeout]);
    if (error) { checks.db = { ok: false, error: error.message }; ok = false; }
    else checks.db = { ok: true, ms: Date.now() - t0 };
  } catch (e) {
    checks.db = { ok: false, error: String(e?.message || e) };
    ok = false;
  }
  if (!ok) opsAlert('API readiness check failing', JSON.stringify(checks), { key: 'readyz-db' });
  res.status(ok ? 200 : 503).json({ ok, checks });
});

// /readyz/workers is the same idea for the WORKER, which /readyz cannot see: it checks the
// database, and on 2026-09-17 the database was fine while the worker had been stopped for three
// hours. Claim derivation, scoring and embeddings were all down and this service answered 200
// throughout, because nothing anywhere was watching the other process.
//
// The worker writes one unconditional heartbeat row a minute (workers/heartbeat.mjs). Reading it
// from HERE is the point: a checker inside the worker dies with the worker. Point the same
// external monitor at this as at /readyz.
//
// Tolerance is generous by default — a minute's cadence against a five-minute window survives a
// slow tick, a deploy and a restart without paging anyone, and still catches a real stop inside
// six minutes. WORKER_STALE_AFTER_MINUTES tunes it.
const WORKER_STALE_AFTER_MS = staleAfterMsFromEnv();

app.get('/readyz/workers', async (_req, res) => {
  let ok = true;
  const checks = {};
  try {
    const supabase = getSupabaseClient();
    const probe = supabase.from('worker_runs')
      .select('started_at')
      .eq('worker', 'heartbeat')
      .order('started_at', { ascending: false })
      .limit(1);
    const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('timeout after 4000ms')), 4000));
    const { data, error } = await Promise.race([probe, timeout]);
    if (error) throw error;
    checks.worker = heartbeatVerdict(data?.[0]?.started_at ?? null, Date.now(), WORKER_STALE_AFTER_MS);
    ok = checks.worker.ok;
  } catch (e) {
    // The read itself failed, so this says nothing about the worker either way. Report not-ready
    // rather than claim health we did not establish — /readyz names which of the two it is.
    checks.worker = { ok: false, error: `could not read heartbeat: ${String(e?.message || e)}` };
    ok = false;
  }
  if (!ok) opsAlert('Worker heartbeat stale', JSON.stringify(checks), { key: 'readyz-worker' });
  res.status(ok ? 200 : 503).json({ ok, checks });
});

app.use('/api/cli/auth', publicLimiter);
// Not /oauth/token-status: the MCP server calls it per request from one in-cluster IP
// (generalLimiter buckets that per token).
app.use(['/oauth/register', '/oauth/authorize', '/oauth/token', '/oauth/revoke'], oauthLimiter);
app.use('/api/auth', publicLimiter);
app.use('/install', publicLimiter);
app.use(generalLimiter);

// ── Public auth config ────────────────────────────────────────────────────────
// Read by the login/signup UI before auth. See lib/authConfig.mjs.
app.get('/api/auth/config', async (_req, res) => {
  res.json(await buildAuthConfig());
});

// ── v2 — Context API (evidence substrate) ────────────────────────────────────
// Order matters: verifyApiKey populates req.workspaceId; logV2Op reads it
// after the response finishes and writes a row to workspace_system_log so
// the Ops page Live Op Log surfaces every agent/MCP/SDK call.
// requireOpsBalance sits after auth (needs req.workspaceId/req.user) and before
// logV2Op: when a team is in the RESTRICTED state it 402s here, so a blocked op
// never reaches the router and never writes an op-log row. 'grace'/'warn'/'ok'
// all pass through. These are the ACTIVE agent/MCP surfaces; inbound ingest lives
// in the worker and is never gated, so captured signal is never lost.
app.use('/v2/accounts',        verifyApiKey,     requireOpsBalance, logV2Op, accountsV2Router);
app.use('/v2/drafts',          verifyApiKey,     requireOpsBalance, logV2Op, draftsV2Router);
app.use('/v2/observations',    verifyApiKey,     requireOpsBalance, logV2Op, observationsV2Router);
app.use('/v2/context',         verifyApiKey,     requireOpsBalance, logV2Op, contextV2Router);
app.use('/v2/query',           verifyApiKey,     requireOpsBalance, logV2Op, queryV2Router);
app.use('/v2/score',           verifyApiKey,     requireOpsBalance, logV2Op, scoreV2Router);
app.use('/v2/scores',          verifyApiKey,     requireOpsBalance, logV2Op, scoresV2Router);
app.use('/v2/attention',       verifyApiKey,     requireOpsBalance, logV2Op, attentionV2Router);
// Reporting reads — reachable by API key (agents/MCP, unchanged) AND by a browser
// session (the in-app reporting surfaces). verifyAuthEither routes key-shaped auth
// through verifyApiKey and everything else through verifySupabaseAuth — the same
// dual-client pattern /v2/dedup already uses. Browser calls log as source='api'
// (no X-Nous-Client header), so Adoption's usage numbers are untouched.
app.use('/v2/campaigns',       verifyAuthEither, requireOpsBalance, logV2Op, campaignPerformanceV2Router);
app.use('/v2/pipeline',        verifyAuthEither, requireOpsBalance, logV2Op, pipelineIntelligenceV2Router);
// The revenue forecast (/v2/forecast) is Nous Cloud's, mounted by src/cloud/index.mjs (GET-843).
// Deal outlook — health + how likely each deal is to close, and why. Same auth as the forecast:
// it backs the agent's `deals` tool (key) and can back an in-app surface (session).
app.use('/v2/deals',           verifyAuthEither, requireOpsBalance, logV2Op, dealsV2Router);
app.use('/v2/pipelines',       verifyApiKey,     requireOpsBalance, logV2Op, pipelinesV2Router);
app.use('/v2/audit',           verifyApiKey,     requireOpsBalance, logV2Op, auditV2Router);
app.use('/v2/verify',          verifyApiKey,     requireOpsBalance, logV2Op, verifyV2Router);
app.use('/v2/dedup',           verifyAuthEither, requireOpsBalance, logV2Op, dedupV2Router);
app.use('/v2/workspace/facts', verifyApiKey,     requireOpsBalance, logV2Op, workspaceFactsV2Router);
// Mounted AFTER /v2/workspace/facts so the more specific facts route wins; this
// handles /v2/workspace/status (GET) and /v2/workspace/onboarding (POST).
app.use('/v2/workspace',       verifyApiKey,     requireOpsBalance, logV2Op, workspaceStatusV2Router);
app.use('/v2/foundations',       verifyApiKey,     foundationsV2Router);
// Metered logging, but NOT behind requireOpsBalance, same as /v2/decisions below: record_insight
// writes arrive from the plugin's extraction after the call happened, and an out-of-credit
// workspace would lose them for good. It was ungated before the v2 contract (GET-544).
app.use('/v2/insights',        verifyApiKey,     logV2Op, insightsV2Router);
// Rules (GET-846): a rep's own rules, guidance or checked. Same auth as the decision loop it sits
// beside (an agent's key or a signed-in member), and like it no ops metering: a rule is a
// sentence and a row, not a read of the graph.
app.use('/v2/rules',           verifyAuthEither, logV2Op, rulesV2Router);
// The decision loop. Metered logging, but deliberately NOT behind requireOpsBalance: a
// confirmation arrives AFTER the message has already gone out, and an out-of-credit
// workspace dropping it would lose the label permanently while the action stayed real.
// Same reasoning as inbound ingest — captured signal is never lost to billing state.
app.use('/v2/decisions',       verifyAuthEither, logV2Op, decisionsV2Router);
app.use('/v2/lead-lists',      verifyApiKey,     leadListsV2Router);
app.use('/v2/notes',           verifyApiKey,     requireOpsBalance, logV2Op, notesV2Router);
app.use('/v2/documents',       verifyAuthEither, requireOpsBalance, logV2Op, documentsV2Router);
app.use('/v2/signals',         verifyApiKey,     requireOpsBalance, logV2Op, signalsV2Router);
app.use('/v2/people',          verifyApiKey,     requireOpsBalance, logV2Op, peopleV2Router);
app.use('/v2/leads',           verifyApiKey,     requireOpsBalance, logV2Op, requireFeature('leadLists'), leadsV2Router);
app.use('/v2/action-items',    verifyApiKey,     requireOpsBalance, logV2Op, actionItemsV2Router);
app.use('/v2/unresolved',      verifyApiKey,     requireOpsBalance, logV2Op, unresolvedV2Router);
app.use('/v2/crm-agent',       verifyApiKey,     requireOpsBalance, logV2Op, crmAgentV2Router);
// Organization: members (invite/remove are admin-key only, in the router), the ICP in one place.
// The GTM brain's /v2/brain and /v2/brains are Cloud's, mounted by cloud/index.mjs (GET-839).
// Usage is NOT ops-gated: an out-of-ops workspace must still be able to read where it stands. Nor is the ICP: set_icp is an onboarding write, and it went through
// the ungated /v2/foundations before (GET-544). Workflows are the automation flows engine (GET-523).
app.use('/v2/members',         verifyApiKey,     requireOpsBalance, logV2Op, membersV2Router);
app.use('/v2/icp',             verifyApiKey,     logV2Op, icpV2Router);
app.use('/v2/usage',           verifyApiKey,     logV2Op, usageV2Router);
app.use('/v2/workflows',       verifyApiKey,     requireOpsBalance, logV2Op, workflowsV2Router);
app.use('/v2/approvals',       verifyApiKey,     requireOpsBalance, logV2Op, approvalsV2Router);
// Events pushed to your own stack (GET-559). Same outbox as /v2/workspace/triggers, so the
// same self-host block: a self-hosted install has no delivery worker reaching the internet.
app.use('/v2/webhooks',        verifyApiKey,     requireOpsBalance, logV2Op, webhooksV2Router);
// Every event, as Stripe lists them (GET-939): a key, or the Events page signed in. Only a key's
// calls go in the op log: the page polls, and its reads are not an agent's activity.
app.use('/v2/events',          verifyAuthEither, requireOpsBalance, (req, res, next) => (req.apiKeyId ? logV2Op(req, res, next) : next()), eventsV2Router);

// ── /api — Frontend API ───────────────────────────────────────────────────────
app.use('/me',                        meRouter); // legacy path used by AuthContext
app.use('/api/me',                    meRouter);
app.use('/api/workspaces',            workspacesRouter);
app.use('/api/teams',                 teamsRouter);
app.use('/api/users',                 usersRouter);
app.use('/api/invitations',           invitationsRouter);
// Self-host only: what nous.env has configured (Settings → Instance setup, GET-837).
app.use('/api/instance/setup',        verifySupabaseAuth, instanceSetupRouter);
app.use('/api/onboarding',            onboardingRouter);
app.use('/api/usage',                 usageRouter);
app.use('/api/mentions',              mentionsRouter);
app.use('/api/billing',               billingRouter);
app.use('/internal/api-notifications', apiNotificationsRouter);
app.use('/internal/personal-sync',    personalSyncInternalRouter);
// The detector automations' nightly drafting (GET-685). Same WORKER_SECRET guard.
app.use('/internal/detector-drafts',   detectorDraftsInternalRouter);
app.use('/internal/automation-steps', automationStepsInternalRouter);
app.use('/api/integrations',          integrationsRouter);
app.use('/api/crm',                   crmRouter);
app.use('/api/contacts',              contactsApiRouter);
app.use('/api/companies',             companiesApiRouter);
app.use('/api/crm-owners',            crmOwnersApiRouter);
app.use('/api/crm-pipelines',         crmPipelinesApiRouter);
app.use('/api/lifecycle',             lifecycleApiRouter);
app.use('/api/flags',                 flagsApiRouter);
app.use('/api/conflicts',             conflictsApiRouter);
app.use('/api/identity-proposals',    identityProposalsApiRouter);
app.use('/api/graph',                 graphApiRouter);
// publicSignalExtraction gates the authenticated setup/configuration routes.
// The public ingest endpoint stays open (its own HMAC token guards it).
// Cloud's routes that share a public prefix and must come first (cloud/index.mjs mountEarly): its
// workspace signals on /api/signals (GET-862, GET-910), and Slack OAuth before /api/workflow-providers.
cloud?.mountEarly?.(app, cloudDeps);
app.use('/api/signals',               verifySupabaseAuth, requireFeature('publicSignalExtraction'), signalsRouter);
app.use('/api/public/signals',        publicSignalsRouter);
app.use('/api/public/skill-downloads', skillDownloadsRouter);
// The `curl … | sh` front door. Mounted at both /install and the bare / of the install
// host, so get.opennous.cloud (a redirect/CNAME onto this) serves the script directly.
app.use('/install', installRouter);
app.use('/api/requests',              requestsRouter);
app.use('/api/workspace/system-log',  systemLogRouter);
app.use('/api/connect',               connectRouter);
app.use('/api/workspace/observations', observationsLogRouter);
app.use('/api/workspace/api-keys',    verifySupabaseAuth, apiKeysRouter);
// Per-key usage dashboard: GET /api/keys/:id/usage, GET /api/keys/:id/requests (GET-623).
app.use('/api/keys',                  verifySupabaseAuth, apiKeyUsageRouter);
// CLI/plugin browser-login (device-auth). start + poll are public; the router's
// approve + request routes apply verifySupabaseAuth themselves.
app.use('/api/cli/auth',              cliAuthRouter);
// MCP OAuth (GET-762): the authorization server Grok, Claude.ai and ChatGPT
// discover from the MCP server's 401. /oauth/* is public (the token endpoint
// takes form posts); the consent API behind it needs a signed-in session.
app.get('/.well-known/oauth-authorization-server', authorizationServerMetadataHandler);
app.use('/oauth',                     express.urlencoded({ extended: false }), oauthRouter);
app.use('/api/mcp-oauth',             oauthConsentRouter);
app.use('/api/workspace/memories',    verifySupabaseAuth, workspaceMemoriesRouter);
app.use('/api/personal',              verifySupabaseAuth, personalRouter);
app.use('/api/notes',                 verifySupabaseAuth, entityNotesRouter);
app.use('/api/shares',                verifySupabaseAuth, sharesRouter);
app.use('/api/evidence',              verifySupabaseAuth, evidenceRouter);
app.use('/api/docs',                  verifySupabaseAuth, docsRouter);
app.use('/api/activity-stats',        activityStatsRouter);
app.use('/api/backfill',              backfillRouter);
app.use('/api/actions',               actionsRouter);
// Settings > Knowledge, the context library (GET-875; open source since 2026-10-29). It follows the
// revboxes feature, as it did on Cloud (Workspace and up); self-host has it, like every feature.
app.use('/api/context',               verifySupabaseAuth, requireFeature('revboxes'), contextRouter);
app.use('/api/lead-lists',            verifyAuthEither, requireFeature('leadLists'), leadListsRouter);
app.use('/api/campaign-messages',     verifyAuthEither, requireFeature('leadLists'), campaignMessagesRouter);
app.use('/api/triggers',              verifyAuthEither, triggersRouter);
app.use('/api/account-overview', verifySupabaseAuth, accountOverviewRouter);
app.use('/api/automations',           verifyAuthEither, automationsRouter);
// The same router under the name the app uses since GET-1043. /api/automations stays for API keys,
// the plugin and anything already calling it.
app.use('/api/workflows',             verifyAuthEither, automationsRouter);
// Worker→API, secret-guarded: rebuild the derived ledger the deal triggers read.
app.use('/internal/automations',       automationsInternalRouter);
app.use('/api/foundations',             foundationsApiRouter);
app.use('/api/img',                   imgProxyRouter);
app.use('/api/claims',                claimsApiRouter);
app.use('/api/webhooks',              verifySupabaseAuth, webhooksRouter);
// (Cloud's Slack OAuth, which must precede /api/workflow-providers, is in mountEarly above.)
// Linear's callback carries no session, so it must precede the authed generic mount (GET-825).
app.use('/api/workflow-providers/linear/oauth',      oauthLinearRouter);
app.use('/api/workflow-providers',    verifySupabaseAuth, workflowProvidersRouter);
app.use('/api/linear',                verifySupabaseAuth, requireFeature('insights'), linearRouter);

// ── OAuth callbacks — no auth middleware (redirects from external providers) ──
//
// The catalogue builds every authorize URL as
//   /api/workflow-providers/:name/oauth/authorize
// so a provider marked auth_type='oauth2' is connectable the moment its router is
// mounted there, with nothing to add on the frontend. Mount new OAuth providers
// on that path and the Connect button works.
//
// Slack and Google predate the convention and their callback URLs are already
// registered on Slack's and Google's side under /api/oauth/*, which we cannot
// change without editing those app registrations. So Slack keeps the old mount
// (its callback keeps working) and ALSO gets the conventional one (its authorize
// button starts working). Slack's authorize was unreachable for exactly this
// reason: the button called the convention, the router only answered the legacy
// path, and every click 404'd. Both Slack mounts are Cloud's (cloud/index.mjs, GET-754).
//
// Google (Gmail + Calendar) connects through Composio on Cloud. Composio connect is one door for
// both the CLI (pk_ key) and the Integrations panel (clerk session); workspace/composio is
// the self-serve "paste your Composio key" config surface (admin-guarded inside the router).
app.use('/api/connect/composio',                     connectComposioRouter);
app.use('/api/workspace/composio',                   verifySupabaseAuth, workspaceComposioRouter);
// A self-hosted install can connect Google with its own OAuth app instead (GET-765): set
// GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_OAUTH_REDIRECT_URI and leave Composio
// unconfigured. Mounted on open-source builds only, so Cloud's route table does not change; the
// Integrations page asks /mode and falls back to Composio when it 404s.
if (!HAS_CLOUD) app.use('/api/oauth/google',         oauthGoogleRouter);
app.use('/api/workflow-providers/airtable/oauth',    oauthAirtableRouter);
app.use('/api/workflow-providers/salesforce/oauth',  oauthSalesforceRouter);

cloud?.mount?.(app, cloudDeps);

// An open-source build has no Workspace layer, so these paths are not mounted at all. Answer
// 403 cloud_only_feature (what CLOUD_ONLY_FEATURES promises) instead of a bare 404 not_found,
// so an API client or agent knows the feature lives on Nous Cloud rather than guessing a typo.
if (!HAS_CLOUD) {
  for (const [path, feature] of [
    ['/api/tasks', 'tasks'],
    ['/api/skills', 'skills'],
    ['/api/routines', 'inAppAgent'],
    ['/api/playground', 'playground'],
    ['/api/reports', 'reports'],
    ['/v2/report', 'reports'],
    ['/v2/forecast', 'forecasting'],
    ['/api/revboxes', 'revboxes'],
    ['/v2/revboxes', 'revboxes'],
    ['/hooks/revboxes', 'revboxes'],
    ['/api/slack', 'slack'],
    ['/api/oauth/slack', 'slack'],
    ['/api/workflow-providers/slack/oauth', 'slack'],
  ]) app.use(path, blockOnSelfHost(feature));
}

// ── 404 catch-all ─────────────────────────────────────────────────────────────
app.use((_req, res) => res.status(404).json({ error: 'not_found' }));

// ── Error handler ─────────────────────────────────────────────────────────────
app.use((err, req, res, _next) => {
  console.error('[UNHANDLED]', err);
  // Sentry gets the full grouped/searchable exception; opsAlert pages Slack (throttled so
  // a 500 storm pages once, not thousands of times, keyed by route).
  sentryCapture(err, { method: req?.method, path: req?.path });
  opsAlert(`API 500 on ${req?.method || '?'} ${req?.path || '?'}`, err?.stack || err?.message || String(err), { key: `500:${req?.path || '?'}` });
  res.status(500).json({
    error: 'internal_error',
    ...(process.env.NODE_ENV !== 'production' && { detail: err.message }),
  });
});

// ── Process-level safety net ───────────────────────────────────────────────────
// Without these, an unhandled promise rejection can terminate the process on modern
// Node with nothing but docker's restart to catch it. Log loudly + page, and DON'T
// exit on a rejection (a single bad async path shouldn't take the API down).
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
  sentryCapture(reason instanceof Error ? reason : new Error(String(reason)), { kind: 'unhandledRejection' });
  opsAlert('API unhandledRejection', reason?.stack || String(reason), { key: 'unhandledRejection' });
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
  sentryCapture(err, { kind: 'uncaughtException' });
  opsAlert('API uncaughtException', err?.stack || String(err), { key: 'uncaughtException' });
});

export { app };

// Push the provider catalogue into the database on every boot.
//
// src/providers/catalogue.mjs is the single source of truth for how each integration
// connects, where its API key lives, and what happens to its webhook. The table is a
// projection of that file, and every surface — the Integrations page, the Settings modal,
// the MCP agent — reads the table. Nothing branches on a provider's name any more.
//
// This overwrites on conflict, deliberately: a value hand-edited in the database is meant
// to lose to the file. It also throws (loudly, before serving traffic) if the catalogue
// claims something untrue, like a provider whose webhook is 'auto' with no handler to
// register it, or an OAuth provider with no mounted router — both of which shipped.
async function bootstrapProviders() {
  try {
    const { getSupabaseClient } = await import('@nous/core');
    const { syncCatalogueToDb } = await import('./providers/catalogue.mjs');
    // A branch API run locally against the production database must not rewrite production's
    // catalogue with the branch's copy — that ships a provider change before the merge does.
    if (process.env.SKIP_CATALOGUE_SYNC === '1') console.log('[CATALOGUE] sync skipped (SKIP_CATALOGUE_SYNC)');
    else await syncCatalogueToDb(getSupabaseClient());
  } catch (err) {
    console.error('[BOOTSTRAP] provider catalogue sync failed:', err.message);
  }

  // Cloud's boot work (seeding the agent's built-in skills), only when serving — GET-754.
  await cloud?.bootstrap?.({ getSupabaseClient });
}

// Only start the server when run directly, not when imported by tests
import { fileURLToPath } from 'url';
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const PORT = process.env.PORT ?? 3000;
  bootstrapProviders();
  // Cloud's own workers that run with the server (cloud/index.mjs start, GET-910).
  cloud?.start?.({ getSupabaseClient });
  app.listen(PORT, () => console.log(`Nous API running on :${PORT}`));
}
