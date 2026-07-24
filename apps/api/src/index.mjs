import './bootEnv.mjs'; // first — normalizes APP_URL/API_URL from domains before any module reads them
import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { registerCrmPushHandler, pushActivityToAllCrms, getSupabaseClient } from '@nous/core';
import { stripeWebhookHandler } from './routes/stripeWebhook.mjs';
import { registerLinkedInRoutes } from './services/linkedin.mjs';

// Wire activity logging → CRM push at module load time
registerCrmPushHandler(pushActivityToAllCrms);

import { verifyApiKey } from './middleware/apiKey.mjs';
import { verifySupabaseAuth } from './middleware/supabaseAuth.mjs';
import { verifyAuthEither } from './middleware/authEither.mjs';
import { requireAdmin } from './middleware/requireAdmin.mjs';
import { logV2Op } from './middleware/opLogger.mjs';
import { requireFeature, requireOpsBalance, blockOnSelfHost } from './lib/access.mjs';

// v2 — Context API (evidence substrate)
import { accountsV2Router } from './routes/v2/accounts.mjs';
import { observationsV2Router } from './routes/v2/observations.mjs';
import { contextV2Router } from './routes/v2/context.mjs';
import { queryV2Router } from './routes/v2/query.mjs';
import { scoreV2Router } from './routes/v2/score.mjs';
import { reportV2Router } from './routes/v2/report.mjs';
import { attentionV2Router } from './routes/v2/attention.mjs';
import { auditV2Router } from './routes/v2/audit.mjs';
import { verifyV2Router } from './routes/v2/verify.mjs';
import { dedupV2Router } from './routes/v2/dedup.mjs';
import { workspaceFactsV2Router } from './routes/v2/workspaceFacts.mjs';
import { workspaceStatusV2Router } from './routes/v2/workspaceStatus.mjs';
import { foundationsV2Router } from './routes/v2/foundations.mjs';
import { insightsV2Router } from './routes/v2/insights.mjs';
import { notesV2Router } from './routes/v2/notes.mjs';
import { signalsV2Router } from './routes/v2/signals.mjs';
import { peopleV2Router } from './routes/v2/people.mjs';
import { leadsV2Router } from './routes/v2/leads.mjs';
import { leadListsV2Router } from './routes/v2/leadLists.mjs';
import { actionItemsV2Router } from './routes/v2/actionItems.mjs';

// /api — Frontend API (Supabase JWT auth)
import { apiKeysRouter } from './routes/api/apiKeys.mjs';
import { cliAuthRouter } from './routes/api/cliAuth.mjs';
import { webhooksRouter } from './routes/api/webhooks.mjs';
import { meRouter } from './routes/api/me.mjs';
import { workspacesRouter } from './routes/api/workspaces.mjs';
import { teamsRouter } from './routes/api/teams.mjs';
import { usersRouter } from './routes/api/users.mjs';
import { invitationsRouter } from './routes/api/invitations.mjs';
import { onboardingRouter } from './routes/api/onboarding.mjs';
import { usageRouter } from './routes/api/usage.mjs';
import { billingRouter } from './routes/api/billing.mjs';
import { opsEmailsRouter } from './routes/opsEmails.mjs';
import { integrationsRouter } from './routes/api/integrations.mjs';
import { crmRouter } from './routes/api/crm.mjs';
import { contactsApiRouter } from './routes/api/contacts.mjs';
// Reports hidden from the Nous UI (niche-down), but the backend stays mounted —
// it's the private engine the Partner OS reuses via the API. Do not delete.
import { reportsApiRouter } from './routes/api/reports.mjs';
import { foundationsApiRouter } from './routes/api/foundations.mjs';
import { insightsApiRouter } from './routes/api/insights.mjs';
import { companiesApiRouter } from './routes/api/companies.mjs';
import { graphApiRouter } from './routes/api/graph.mjs';
import { signalsRouter, publicSignalsRouter } from './routes/api/signals.mjs';
import { skillDownloadsRouter } from './routes/public/skillDownloads.mjs';
import { installRouter } from './routes/public/install.mjs';
import { requestsRouter } from './routes/api/requests.mjs';
import { feedbackRouter } from './routes/api/feedback.mjs';
import { publicLiveRouter } from './routes/api/public/live.mjs';
import { workspaceMemoriesRouter } from './routes/api/workspaceMemories.mjs';
import { playgroundRouter } from './routes/api/playground.mjs';
import { skillsRouter } from './routes/api/skills.mjs';
import { tasksRouter } from './routes/api/tasks.mjs';
import { adoptionRouter } from './routes/api/adoption.mjs';
import { activityStatsRouter } from './routes/api/activityStats.mjs';
import { routinesRouter } from './routes/api/routines.mjs';
import { actionsRouter } from './routes/api/actions.mjs';
import { mindRouter } from './routes/api/mind.mjs';
import { leadListsRouter } from './routes/api/leadLists.mjs';
import { campaignMessagesRouter } from './routes/api/campaignMessages.mjs';
import { triggersRouter } from './routes/api/triggers.mjs';
import { workflowProvidersRouter } from './routes/api/workflowProviders.mjs';
import { linkedinRouter } from './routes/api/linkedin.mjs';
import { systemLogRouter } from './routes/api/systemLog.mjs';
import { oauthGoogleRouter } from './routes/api/oauthGoogle.mjs';
import { oauthAirtableRouter } from './routes/api/oauthAirtable.mjs';
import { oauthSlackRouter } from './routes/api/oauthSlack.mjs';
import { slackEventsHandler, slackCommandHandler } from './routes/slackEvents.mjs';
import { slackChannelsRouter } from './routes/api/slackChannels.mjs';
import { oauthSalesforceRouter } from './routes/api/oauthSalesforce.mjs';

// /api/admin — Admin routes
import { blogRouter } from './routes/api/blog.mjs';
import { adminPlanRouter } from './routes/api/adminPlan.mjs';
import { adminBlogRouter } from './routes/api/admin/blog.mjs';
import { resourcesRouter, adminResourcesRouter } from './routes/api/resources.mjs';
import { adminChangelogRouter, publicChangelogRouter } from './routes/api/admin/changelog.mjs';
import { roadmapRouter, adminRoadmapRouter } from './routes/api/admin/roadmap.mjs';
import { updatesRouter, adminUpdatesRouter } from './routes/api/admin/updates.mjs';
import { adminUsersRouter } from './routes/api/admin/users.mjs';
import { provisionRouter } from './routes/api/admin/provision.mjs';
import { assistedOnboardRouter } from './routes/api/admin/assistedOnboard.mjs';

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

app.use(cors({
  origin: allowedOrigins,
  credentials: true,
}));

// Stripe webhook MUST receive the raw body so the signature can be verified.
// Mounted before `express.json()` so that middleware never touches it.
app.post('/stripe/webhook', express.raw({ type: 'application/json' }), stripeWebhookHandler);

// Slack Events + slash command likewise verify a signature over the RAW body, so
// they too must be mounted before express.json(). Events are JSON; slash commands
// are urlencoded.
app.post('/slack/events',   express.raw({ type: 'application/json' }),                  slackEventsHandler);
app.post('/slack/commands', express.raw({ type: 'application/x-www-form-urlencoded' }), slackCommandHandler);

app.use(express.json({ limit: '10mb' }));

// ── Rate limiting ─────────────────────────────────────────────────────────────
// Generous per-IP ceiling so normal dashboard bursts are unaffected, but a single
// IP can't flood auth, LLM, enrichment, or public endpoints. trust proxy is set,
// so this keys on the real client IP behind Caddy. Health is exempt.
const generalLimiter = rateLimit({
  windowMs: 60_000,
  max: 600,
  standardHeaders: true,
  legacyHeaders: false,
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

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ ok: true }));

app.use('/api/cli/auth', publicLimiter);
app.use('/api/auth', publicLimiter);
app.use('/install', publicLimiter);
app.use(generalLimiter);

// ── Public auth config ────────────────────────────────────────────────────────
// Read by the login/signup UI before auth. Lets a self-host hide the
// "Create account" path (DISABLE_SIGNUPS) and the Google button when Google
// OAuth isn't configured. Even with DISABLE_SIGNUPS=true, registration stays
// OPEN until the first user (the owner) exists, so the owner can still sign up;
// it closes once an account exists. Mirrors the server gate in ensureUserAndTeam.
app.get('/api/auth/config', async (_req, res) => {
  let signupsDisabled = false;
  if (process.env.DISABLE_SIGNUPS === 'true') {
    try {
      const { count } = await getSupabaseClient()
        .from('users')
        .select('id', { count: 'exact', head: true });
      signupsDisabled = (count ?? 0) > 0;
    } catch {
      signupsDisabled = false; // on error, don't lock the owner out
    }
  }
  res.json({
    signupsDisabled,
    googleEnabled: Boolean(process.env.GOOGLE_CLIENT_ID),
  });
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
app.use('/v2/observations',    verifyApiKey,     requireOpsBalance, logV2Op, observationsV2Router);
app.use('/v2/context',         verifyApiKey,     requireOpsBalance, logV2Op, contextV2Router);
app.use('/v2/query',           verifyApiKey,     requireOpsBalance, logV2Op, queryV2Router);
app.use('/v2/score',           verifyApiKey,     requireOpsBalance, logV2Op, scoreV2Router);
app.use('/v2/report',          verifyApiKey,     blockOnSelfHost('reports'), requireOpsBalance, logV2Op, reportV2Router);
app.use('/v2/attention',       verifyApiKey,     requireOpsBalance, logV2Op, attentionV2Router);
app.use('/v2/audit',           verifyApiKey,     requireOpsBalance, logV2Op, auditV2Router);
app.use('/v2/verify',          verifyApiKey,     requireOpsBalance, logV2Op, verifyV2Router);
app.use('/v2/dedup',           verifyAuthEither, requireOpsBalance, logV2Op, dedupV2Router);
app.use('/v2/workspace/facts', verifyApiKey,     requireOpsBalance, logV2Op, workspaceFactsV2Router);
// Event triggers (set_trigger / list_triggers) are a Cloud-only feature — block
// them on self-host. Mounted BEFORE the general /v2/workspace router so this more
// specific path runs first; on cloud it falls through to the real handler.
app.use('/v2/workspace/triggers', blockOnSelfHost('triggers'));
// Mounted AFTER /v2/workspace/facts so the more specific facts route wins; this
// handles /v2/workspace/status (GET) and /v2/workspace/onboarding (POST).
app.use('/v2/workspace',       verifyApiKey,     requireOpsBalance, logV2Op, workspaceStatusV2Router);
app.use('/v2/foundations',       verifyApiKey,     foundationsV2Router);
app.use('/v2/insights',        verifyApiKey,     insightsV2Router);
app.use('/v2/lead-lists',      verifyApiKey,     leadListsV2Router);
app.use('/v2/notes',           verifyApiKey,     requireOpsBalance, logV2Op, notesV2Router);
app.use('/v2/signals',         verifyApiKey,     requireOpsBalance, logV2Op, signalsV2Router);
app.use('/v2/people',          verifyApiKey,     requireOpsBalance, logV2Op, peopleV2Router);
app.use('/v2/leads',           verifyApiKey,     requireOpsBalance, logV2Op, requireFeature('leadLists'), leadsV2Router);
app.use('/v2/action-items',    verifyApiKey,     requireOpsBalance, logV2Op, actionItemsV2Router);

// ── /api — Frontend API ───────────────────────────────────────────────────────
app.use('/me',                        meRouter); // legacy path used by AuthContext
app.use('/api/me',                    meRouter);
app.use('/api/workspaces',            workspacesRouter);
app.use('/api/teams',                 teamsRouter);
app.use('/api/users',                 usersRouter);
app.use('/api/invitations',           invitationsRouter);
app.use('/api/onboarding',            onboardingRouter);
app.use('/api/usage',                 usageRouter);
app.use('/api/billing',               billingRouter);
// Internal worker→api endpoint (secret-guarded, dormant unless WORKER_INTERNAL_SECRET set).
app.use('/internal/ops-emails',       opsEmailsRouter);
app.use('/api/integrations',          integrationsRouter);
app.use('/api/crm',                   crmRouter);
app.use('/api/contacts',              contactsApiRouter);
app.use('/api/companies',             companiesApiRouter);
app.use('/api/graph',                 graphApiRouter);
// publicSignalExtraction gates the authenticated setup/configuration routes.
// The public ingest endpoint stays open (its own HMAC token guards it).
app.use('/api/signals',               verifySupabaseAuth, requireFeature('publicSignalExtraction'), signalsRouter);
app.use('/api/public/signals',        publicSignalsRouter);
app.use('/api/public/skill-downloads', skillDownloadsRouter);
// The `curl … | sh` front door. Mounted at both /install and the bare / of the install
// host, so get.opennous.cloud (a redirect/CNAME onto this) serves the script directly.
app.use('/install', installRouter);
app.use('/api/requests',              requestsRouter);
app.use('/api/feedback',              feedbackRouter);
app.use('/api/public/live',           publicLiveRouter);
app.use('/api/workspace/system-log',  systemLogRouter);
app.use('/api/workspace/api-keys',    verifySupabaseAuth, apiKeysRouter);
// CLI/plugin browser-login (device-auth). start + poll are public; the router's
// approve + request routes apply verifySupabaseAuth themselves.
app.use('/api/cli/auth',              cliAuthRouter);
app.use('/api/workspace/memories',    verifySupabaseAuth, workspaceMemoriesRouter);
// ── The team layer (Custom only) ────────────────────────────────────────────
//
// This is where the money goes. The in-app agent runs Sonnet, and it is the ONE
// expensive surface we ship — by far the largest line on our model bill, while a
// full month of normal graph use runs on cheap Haiku.
//
// So the gate is not a tier gate, it is an audience gate. Operators on
// Free/Start/Pro live in Claude Code — they already have an agent and they pay
// their own tokens, and they never come here. Teams on Custom do NOT have an
// agent, and that is precisely what they are buying.
//
// requireFeature is the real boundary. Hiding the nav item is a courtesy; this is
// what stops a Start customer from POSTing to /api/playground and running up our
// Sonnet bill.
//
// verifySupabaseAuth is repeated here because requireFeature resolves the team from
// req.user, and these routers apply their auth INTERNALLY — so without it the gate
// runs before anyone is logged in, resolveTeamAndPlan throws, and every request
// 500s. The routers re-verify; a second JWT check is cheap and the alternative is a
// gate that fails open on an unauthenticated request.
app.use('/api/playground',            blockOnSelfHost('playground'), verifySupabaseAuth, requireFeature('inAppAgent'), playgroundRouter);
app.use('/api/routines',              verifySupabaseAuth, requireFeature('inAppAgent'), routinesRouter);
app.use('/api/skills',                verifySupabaseAuth, requireFeature('skills'), skillsRouter);
app.use('/api/tasks',                 verifySupabaseAuth, requireFeature('tasks'), tasksRouter);
app.use('/api/adoption',              verifySupabaseAuth, requireFeature('adoption'), adoptionRouter);
app.use('/api/activity-stats',        activityStatsRouter);
app.use('/api/actions',               actionsRouter);
app.use('/api/mind',                  verifySupabaseAuth, mindRouter);
app.use('/api/lead-lists',            verifyAuthEither, requireFeature('leadLists'), leadListsRouter);
app.use('/api/campaign-messages',     verifyAuthEither, requireFeature('leadLists'), campaignMessagesRouter);
app.use('/api/triggers',              verifyAuthEither, blockOnSelfHost('triggers'), triggersRouter);
app.use('/api/reports',               blockOnSelfHost('reports'), reportsApiRouter);
app.use('/api/foundations',             foundationsApiRouter);
app.use('/api/insights',              insightsApiRouter);
app.use('/api/webhooks',              verifySupabaseAuth, webhooksRouter);
// Slack OAuth MUST be mounted BEFORE the generic /api/workflow-providers mount.
// Slack's callback redirect carries no JWT; if the authed generic mount matched
// first, verifySupabaseAuth would short-circuit with auth_required and the
// callback handler would never run. Registration order decides the match.
app.use('/api/workflow-providers/slack/oauth', oauthSlackRouter);
app.use('/api/workflow-providers',    verifySupabaseAuth, workflowProvidersRouter);
// LinkedIn action endpoints — invite/message/sync (Supabase JWT, workspaceId in body),
// send-invite/send-message/post-comment (API key or Supabase JWT), and the
// Unipile OAuth callback (no auth, redirected from Unipile).
//
// MUST be registered BEFORE the /api/linkedin app.use mount below. Otherwise the
// mount's verifySupabaseAuth runs first for every /api/linkedin/* request and
// short-circuits non-JWT calls with auth_required, never reaching these handlers.
// Express resolves routes in registration order — these app.post('/api/linkedin/...')
// declarations match exact path+method before the prefix mount runs.
registerLinkedInRoutes(app, getSupabaseClient(), verifySupabaseAuth, verifyAuthEither);
app.use('/api/linkedin',              verifySupabaseAuth, linkedinRouter);

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
// path, and every click 404'd.
//
// Google is the one provider the frontend still special-cases, because its
// authorize is /gmail/authorize rather than /authorize — one router, two Google
// products. Mounting it on the convention would answer /callback but not the
// authorize the button actually calls, so it stays explicit.
app.use('/api/oauth/google',                         oauthGoogleRouter);
app.use('/api/oauth/slack',                          oauthSlackRouter);
// (the conventional /api/workflow-providers/slack/oauth mount is registered
//  earlier, before the authed generic mount — see above)
app.use('/api/slack/channels',                       slackChannelsRouter);
app.use('/api/workflow-providers/airtable/oauth',    oauthAirtableRouter);
app.use('/api/workflow-providers/salesforce/oauth',  oauthSalesforceRouter);

// ── /api/roadmap, /api/updates, /api/blog, /api/changelog — Public ───────────
app.use('/api/roadmap',           roadmapRouter);
app.use('/api/updates',           updatesRouter);
app.use('/api/blog',              blogRouter);
app.use('/api/resources',         resourcesRouter);
app.use('/api/changelog/entries', publicChangelogRouter);

// ── /api/admin — Admin (auth + admin check applied at mount) ──────────────────
// Put a team on Custom after a sales call. This is the ONLY way onto Custom —
// there is no self-serve path, on purpose.
app.use('/api/admin/plan',      verifySupabaseAuth, requireAdmin, adminPlanRouter);
app.use('/api/admin/blog',      verifySupabaseAuth, requireAdmin, adminBlogRouter);
app.use('/api/admin/resources', verifySupabaseAuth, requireAdmin, adminResourcesRouter);
app.use('/api/changelog/entries', verifySupabaseAuth, requireAdmin, adminChangelogRouter);
app.use('/api/admin/roadmap',   verifySupabaseAuth, requireAdmin, adminRoadmapRouter);
app.use('/api/admin/updates',   verifySupabaseAuth, requireAdmin, adminUpdatesRouter);
app.use('/api/admin/users',     verifySupabaseAuth, requireAdmin, adminUsersRouter);
// Assisted onboarding — the sales-led Custom setup. An admin runs runOnboardingAgent for a
// Custom workspace after the call. Admin-session auth, unlike /provision's shared secret.
app.use('/api/admin/assisted-onboard', verifySupabaseAuth, requireAdmin, assistedOnboardRouter);
// Partner OS provisioning — service-to-service (shared secret inside the router),
// NOT user-session auth. Dead (503) unless PARTNER_PROVISION_SECRET is set.
app.use('/api/admin/provision', provisionRouter);

// ── 404 catch-all ─────────────────────────────────────────────────────────────
app.use((_req, res) => res.status(404).json({ error: 'not_found' }));

// ── Error handler ─────────────────────────────────────────────────────────────
app.use((err, _req, res, _next) => {
  console.error('[UNHANDLED]', err);
  res.status(500).json({
    error: 'internal_error',
    ...(process.env.NODE_ENV !== 'production' && { detail: err.message }),
  });
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
    await syncCatalogueToDb(getSupabaseClient());
  } catch (err) {
    console.error('[BOOTSTRAP] provider catalogue sync failed:', err.message);
  }

  // The built-in skills are files in this repo (src/skills/<name>/SKILL.md).
  // Mirroring them into the DB on every boot means shipping a skill is shipping a
  // file, while workspace-written skills live in the same table and load the same
  // way. Never fatal: an agent with no skills still answers questions.
  try {
    const { seedBuiltinSkills } = await import('./lib/skills.mjs');
    await seedBuiltinSkills(getSupabaseClient());
  } catch (err) {
    console.warn('[BOOTSTRAP] skill seed skipped:', err.message);
  }
}

// Only start the server when run directly, not when imported by tests
import { fileURLToPath } from 'url';
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const PORT = process.env.PORT ?? 3000;
  bootstrapProviders();
  app.listen(PORT, () => console.log(`Nous API running on :${PORT}`));
}
