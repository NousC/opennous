// Server-side feature gating + usage gating.
//
// `requireFeature` blocks a request if the team's current plan does not
// include the named feature. `requireOpsBalance` blocks when the month's
// included ops are exhausted. `requireEnrichmentQuota` blocks when the
// month's enrichment allowance is exhausted.
//
// Self-hosted bypass: if SELF_HOSTED=true, every gate passes. There is no
// concept of a paid plan on self-host — operators can do anything.

import { getSupabaseClient } from '@nous/core';
import { ensureUserAndTeam } from './auth.mjs';
import {
  getPlan,
  getPlanFromSubscription,
  getTeamOpsUsage,
  getTeamOpsState,
  getTeamAccountsState,
  getTeamEnrichmentUsage,
  hasFeature,
  isSelfHosted,
  OPS_GRACE_DAYS,
} from './plans.mjs';

/**
 * The team a request acts on — ONE answer for plan gates, usage and billing (GET-241).
 *
 * When the request names a workspace, it is that workspace's team. `req.workspaceId` is only
 * ever set after the auth middleware has verified membership (or by an API key, which belongs
 * to one workspace), so this never reaches a team the caller isn't in. Otherwise it is the
 * logged-in account's home team.
 *
 * The two differ when someone is a member of a workspace another team owns — an operator
 * setting a client up. Reading the home team there showed the operator's plan, meters and
 * billing inside the client's workspace.
 *
 * Returns { team, user, home }: `home` is the account's own team (null for API-key auth).
 */
export async function resolveRequestTeam(req) {
  const supabase = getSupabaseClient();
  let user = null;
  let home = null;
  if (req.user) ({ user, team: home } = await ensureUserAndTeam(req.user));

  let team = home;
  if (req.workspaceId) {
    const { data: workspace } = await supabase
      .from('workspaces').select('team_id').eq('id', req.workspaceId).maybeSingle();
    if (!workspace && !home) throw new Error('workspace_not_found');
    if (workspace?.team_id && workspace.team_id !== home?.id) {
      const { data: wsTeam } = await supabase.from('teams').select('*').eq('id', workspace.team_id).maybeSingle();
      if (wsTeam) team = wsTeam;
    }
  }
  if (!team) throw new Error('no_team_context');
  return { team, user, home };
}

/**
 * May this caller spend money for / change the billing of `team`? Your home team as before;
 * a team you're a member of through one of its workspaces only if you administer it
 * (founder/owner/admin in team_members). A workspace member of a client is not its payer.
 */
export async function canManageTeamBilling({ team, user, home }) {
  if (!team || !user) return false;
  if (home?.id === team.id) return true;
  const { data: m } = await getSupabaseClient()
    .from('team_members').select('role').eq('team_id', team.id).eq('user_id', user.id).maybeSingle();
  return ['founder', 'owner', 'admin'].includes(m?.role);
}

export async function resolveTeamAndPlan(req) {
  const supabase = getSupabaseClient();
  const { team } = await resolveRequestTeam(req);
  const { data: subscription } = await supabase
    .from('subscriptions')
    .select('*')
    .eq('team_id', team.id)
    .maybeSingle();
  return { team, subscription, plan: getPlanFromSubscription(subscription), supabase };
}

/**
 * Express middleware factory. Blocks the request when the current plan
 * does not enable `feature`. Free on self-host.
 *
 * Usage:
 *   router.post('/sync-now', verifySupabaseAuth, requireFeature('crmSync'), handler);
 */
// What self-host does NOT get.
//
// Self-host is the graph AND the Vault, uncapped and unmetered: Accounts, Activities,
// the Graph itself, the context documents, Adoption, all 20+ integrations, webhooks.
// Extraction runs on the operator's own ANTHROPIC_API_KEY, which is exactly why there
// is nothing to meter — their graph costs us nothing to fill. That is the open-source
// promise and it is the complete developer primitive.
//
// `foundations` (the Vault) and `adoption` came OFF this list on 2026-07-14. The Vault is
// the context layer, the context layer is the product, and an ICP file that syncs to the
// operator's own repo is the whole open-core promise — see get_icp / sync_icp. Blocking
// the surface that shows it contradicted the sentence directly below.
//
// The line is simple: cloud-only = runs on OUR infrastructure or OUR model bill.
// Everything that runs on the operator's own box + own API key is open on self-host.
//
//   Since GET-576 (2026-10-01) self-host is the Self-serve plan: CRM sync (HubSpot,
//   Salesforce), lead lists, webhooks and automations run on the operator's own box and keys.
//
//   What stays cloud-only is the WORKSPACE LAYER: Threads (the in-app agent), Tasks, Skills,
//   reports and the Slack connector. Runs on OUR Sonnet bill, which is the entire reason the
//   block exists, and it is a different product for a different buyer. Sales-led, on Workspace.
//
// `icpScoring` (the learned 0-100 model) is not on this list, but it is no longer open source:
// since GET-754 slice 8 the learned scorer lives in the cloud folders, so an open-source build
// does not have it. There a workspace scores its accounts with its own model and posts them to
// POST /v2/scores (GET-586); the routes that need the learned scorer answer 403
// cloud_only_feature (lib/icpScorer.mjs). The ICP file and its sync stay open.
//
// SELF-HOST = SELF-SERVE (GET-576, 2026-10-01). A self-hosted instance gets exactly what the
// Self-serve plan gets — CRM sync (HubSpot, Salesforce), lead lists, webhooks, automations — and
// nothing from the Workspace layer below. This list is that layer.
const CLOUD_ONLY_FEATURES = new Set([
  'reports',
  'inAppAgent',
  'playground',   // legacy label for the same thing
  'tasks',
  'skills',
  'slack',        // the Slack connector and agent
]);

/** Exported so the frontend gate and the docs can stay in step with this list. */
export const SELF_HOST_BLOCKED = [...CLOUD_ONLY_FEATURES];

export function requireFeature(feature) {
  return async function requireFeatureMiddleware(req, res, next) {
    if (isSelfHosted()) {
      if (CLOUD_ONLY_FEATURES.has(feature)) {
        return res.status(403).json({
          error: 'cloud_only_feature',
          feature,
          message: `${feature} is available on Nous Cloud only.`,
        });
      }
      return next();
    }
    try {
      const { plan } = await resolveTeamAndPlan(req);
      req.plan = plan; // stash for downstream handlers (e.g. native-list eligibility)
      if (!hasFeature(plan.id, feature)) {
        return res.status(402).json({
          error: 'feature_not_in_plan',
          feature,
          current_plan: plan.id,
          upgrade_url: '/settings?section=billing',
        });
      }
      return next();
    } catch (err) {
      console.error('[requireFeature]', feature, err);
      return res.status(500).json({ error: 'internal_error' });
    }
  };
}

/**
 * Express middleware. Blocks a cloud-only route on SELF-HOST only; cloud always
 * passes through. Unlike requireFeature, it never resolves the team/plan, so it
 * is safe on routes that have no auth context yet (e.g. the playground) — it
 * checks isSelfHosted() against CLOUD_ONLY_FEATURES and nothing else.
 *
 * Usage:
 *   app.use('/api/reports', blockOnSelfHost('reports'), reportsApiRouter);
 */
export function blockOnSelfHost(feature) {
  return function blockOnSelfHostMiddleware(req, res, next) {
    if (isSelfHosted() && CLOUD_ONLY_FEATURES.has(feature)) {
      return res.status(403).json({
        error: 'cloud_only_feature',
        feature,
        message: `${feature} is available on Nous Cloud only.`,
      });
    }
    return next();
  };
}

/**
 * Express middleware. Blocks the request when the month's included ops are
 * exhausted. Pass-through on self-host.
 */
export async function requireOpsBalance(req, res, next) {
  if (isSelfHosted()) return next();
  try {
    const { team, subscription, plan, supabase } = await resolveTeamAndPlan(req);
    const ops = await getTeamOpsState(supabase, team.id, subscription);
    req.opsState = ops.state; // 'ok' | 'warn' | 'grace' | 'restricted'

    // Only the restricted state blocks. 'grace' still passes — the team has
    // OPS_GRACE_DAYS over the limit before anything stops. Ingest (worker webhooks/pollers) never
    // hits this guard, so captured GTM signal is never lost.
    if (ops.state === 'restricted') {
      return res.status(402).json({
        error: 'upgrade_required',
        reason: 'ops_limit_reached',
        current_plan: plan.id,
        included_per_month: ops.included,
        used: ops.used,
        grace_expired_at: ops.graceUntil,
        upgrade_url: '/settings?section=billing',
        message: `You've hit the monthly operations limit on the ${plan.name} plan and the ${OPS_GRACE_DAYS}-day grace window has ended. Upgrade to resume agent and outbound operations — your data and incoming signal are untouched.`,
      });
    }
    return next();
  } catch (err) {
    // Fail OPEN: never block a live agent op because metering hiccuped. A bug
    // here must not be able to take down customer automation.
    console.error('[requireOpsBalance] fail-open:', err?.message);
    return next();
  }
}

/**
 * The live meter: active accounts (companies we have actually had a conversation
 * with). Everything else — retrievals, records, lead imports, seats — is
 * unlimited, because everything else is free for us to serve.
 *
 * Put this ONLY on routes that PROACTIVELY create accounts: bulk adds, scraper
 * enqueues, manual creation. Never on ingest, and never on retrieval:
 *
 *   - Ingest must never be blocked. A reply from someone you already know still
 *     lands, in every state. Captured GTM signal is never lost, and a customer
 *     over their cap still sees their pipeline move.
 *   - Retrieval must never be blocked. It has no model in the path and costs us
 *     nothing, so there is nothing to protect. Blocking it would be charging for
 *     a resource we do not spend.
 *
 * Only 'restricted' blocks — a team gets OPS_GRACE_DAYS over the cap first, and can drop
 * back under any time by archiving (which loses nothing; an archived account
 * stays readable, it just stops counting).
 */
export async function requireAccountsBalance(req, res, next) {
  if (isSelfHosted()) return next();
  try {
    const { team, subscription, plan, supabase } = await resolveTeamAndPlan(req);
    const accounts = await getTeamAccountsState(supabase, team.id, subscription);
    req.accountsState = accounts.state; // 'ok' | 'warn' | 'grace' | 'restricted'

    if (accounts.state === 'restricted') {
      return res.status(402).json({
        error: 'upgrade_required',
        reason: 'active_accounts_limit_reached',
        current_plan: plan.id,
        included: accounts.included,
        used: accounts.used,
        grace_expired_at: accounts.graceUntil,
        upgrade_url: '/settings?section=billing',
        message: `You're at the ${accounts.included} active-account limit on the ${plan.name} plan and the ${OPS_GRACE_DAYS}-day grace window has ended. Upgrade, or archive accounts you're no longer working — archived accounts keep all their history and stop counting. Your existing data and incoming signal are untouched.`,
      });
    }
    return next();
  } catch (err) {
    // Fail OPEN, same reasoning as above: a metering bug must never be able to
    // stop a customer from working.
    console.error('[requireAccountsBalance] fail-open:', err?.message);
    return next();
  }
}

/**
 * Express middleware. Blocks the request when the month's enrichment
 * allowance is exhausted. Pass-through on self-host.
 */
export async function requireEnrichmentQuota(req, res, next) {
  if (isSelfHosted()) return next();
  try {
    const { team, subscription, plan, supabase } = await resolveTeamAndPlan(req);
    // Bring-your-own-keys model: a plan with no managed enrichment allowance
    // (enrichmentsPerMonth === 0) runs enrichment on the workspace's own provider
    // keys, so it is unmetered — pass through, uncapped. Metering only kicks in if
    // a future plan re-introduces a managed allowance (> 0).
    if (!plan.enrichmentsPerMonth) {
      req.enrichRemaining = Infinity;
      return next();
    }
    const enrich = await getTeamEnrichmentUsage(supabase, team.id, subscription);
    if (enrich.remaining <= 0) {
      return res.status(402).json({
        error: 'enrichment_quota_exhausted',
        current_plan: plan.id,
        included_per_month: enrich.included,
        upgrade_url: '/settings?section=billing',
      });
    }
    req.enrichRemaining = enrich.remaining; // so bulk enrich can cap to the allowance
    return next();
  } catch (err) {
    console.error('[requireEnrichmentQuota]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
}

/**
 * LinkedIn connect gate. Given a workspace, resolve its team's plan and report
 * whether another LinkedIn account may be connected (used < plan.linkedinProfiles).
 * This is the ONE count-gated resource — LinkedIn accounts cost real money/risk,
 * so the number per workspace is the plan lever. Self-host bypasses (unlimited).
 *
 * Returns { allowed, limit, used, plan, planName } — callers 402 on !allowed.
 */
export async function checkLinkedinSlot(supabase, workspaceId) {
  if (isSelfHosted()) return { allowed: true, limit: Infinity, used: 0, plan: 'self_hosted', planName: 'Self-hosted' };
  const { data: ws } = await supabase
    .from('workspaces')
    .select('team_id')
    .eq('id', workspaceId)
    .maybeSingle();
  // Unknown workspace — don't block here; downstream auth will reject it.
  if (!ws) return { allowed: true, limit: 0, used: 0, plan: 'api', planName: 'API' };
  const { data: subscription } = await supabase
    .from('subscriptions')
    .select('*')
    .eq('team_id', ws.team_id)
    .maybeSingle();
  const plan = getPlanFromSubscription(subscription);
  const limit = plan.linkedinProfiles ?? 0;
  const { count } = await supabase
    .from('workspace_linkedin_connections')
    .select('id', { count: 'exact', head: true })
    .eq('workspace_id', workspaceId);
  const used = count ?? 0;
  return { allowed: used < limit, limit, used, plan: plan.id, planName: plan.name };
}

/**
 * Throw if the current plan doesn't include the feature.
 * For use inside route handlers that already resolved the team. Mirrors the
 * middleware shape for parity.
 */
export function assertFeature(planId, feature) {
  if (isSelfHosted()) {
    if (CLOUD_ONLY_FEATURES.has(feature)) {
      const err = new Error(`cloud_only_feature:${feature}`);
      err.code = 'cloud_only_feature';
      err.feature = feature;
      throw err;
    }
    return;
  }
  if (!hasFeature(planId, feature)) {
    const err = new Error(`feature_not_in_plan:${feature}`);
    err.code = 'feature_not_in_plan';
    err.feature = feature;
    err.plan = planId;
    throw err;
  }
}

export { getPlan, hasFeature, isSelfHosted };
