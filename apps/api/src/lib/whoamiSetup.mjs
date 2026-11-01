// What's set up inside the app, in one call (GET-1087): the `setup` block of GET /v2/workspace/whoami,
// which the /start skill opens with. Each piece reuses the read that already answers it elsewhere,
// and a piece that fails is left out rather than failing whoami.
//
// SCOPE. A member key sees the workspace's connections and its own, never a teammate's personal
// mailbox, and the sync it gets is its own. Admin and workspace keys see the workspace.
// SECRETS. Provider names, booleans and counts only: no account address, no credential, no member
// name or email, no webhook URL. The selects below are the guarantee: nothing else is read.
//
// LEFT OUT because they cost: whether a webhook is really delivering (hasLiveWebhook), CRM hygiene
// proposals, the ICP file's drift against the model, which ICP sections are missing (needs the
// document) and counts at the source (live Gmail and notetaker calls). /v2/workspace/status has
// them, except the source counts.

import { isNoCardTrial } from '@nous/core';
import { backfillOwnerFor } from './backfillStart.mjs';
import { syncStatus } from './syncStatus.mjs';
import { planName } from './plans.mjs';
import { routinesInPool, workspaceAutomationLimit } from '../routes/api/automations.mjs';
import { CRM_PROVIDERS, MAIL_PROVIDERS, NOTES_PROVIDERS } from '../routes/api/onboarding.mjs';

// The foundations /v2/workspace/status tracks. ICP only since 2026-08-22.
const FOUNDATION_KINDS = ['icp'];

/** The connections this key may know about. Pure. */
export function visibleConnections(conns, { scope, memberUserId }) {
  if (scope !== 'member') return conns ?? [];
  return (conns ?? []).filter(c => !c.owner_user_id || c.owner_user_id === memberUserId);
}

/** The block, from what was read. Pure. */
export function setupBlock({ conns, crmConfigs, foundationKinds, sync, webhooks, revPlays, personalRevPlays = 0, revPlayLimit, members, plan, subscription, creditsLeft }, key) {
  const names = [...new Set(visibleConnections(conns, key).map(c => c?.provider?.name).filter(Boolean))].sort();
  const has = (list) => names.some(n => list.includes(n));
  const kinds = foundationKinds ?? [];
  return {
    integrations: names,
    email_connected: has(MAIL_PROVIDERS),
    notetaker_connected: has(NOTES_PROVIDERS),
    crm_connected: (crmConfigs ?? []).length > 0 || has(CRM_PROVIDERS),
    sync: sync ? { state: sync.state, counts: sync.counts, finished_at: sync.finished_at } : null,
    foundations: { done: FOUNDATION_KINDS.filter(k => kinds.includes(k)), missing: FOUNDATION_KINDS.filter(k => !kinds.includes(k)) },
    webhooks,
    rev_plays: { used: revPlays, used_personal: personalRevPlays, limit: revPlayLimit },
    members,
    plan: plan ? { name: planName(plan.id), trial_ends_at: isNoCardTrial(subscription) ? subscription.trial_ends_at : null, credits_left: creditsLeft ?? null } : null,
  };
}

const counted = async (q) => (await q).count ?? null;

/** Read it all, cheaply, in parallel. `usage` is what whoami already loaded for its budget line. */
export async function loadWhoamiSetup(supabase, { workspaceId, scope, memberUserId, usage = null, teamUsage = null }) {
  const head = { count: 'exact', head: true };
  const owner = memberUserId ? await backfillOwnerFor(supabase, workspaceId, memberUserId).catch(() => null) : null;
  const [{ data: conns }, { data: crmConfigs }, { data: found }, sync, webhooks, revPlays, mine, members] = await Promise.all([
    supabase.from('workflow_provider_connections').select('owner_user_id, provider:workflow_providers(name)').eq('workspace_id', workspaceId),
    supabase.from('crm_sync_configs').select('provider').eq('workspace_id', workspaceId),
    supabase.from('foundations').select('kind').eq('workspace_id', workspaceId),
    syncStatus(supabase, workspaceId, owner).catch(() => null),
    counted(supabase.from('workspace_webhook_subscriptions').select('id', head).eq('workspace_id', workspaceId)),
    routinesInPool(supabase, workspaceId),
    memberUserId ? routinesInPool(supabase, workspaceId, { personalOf: memberUserId }) : 0,
    counted(supabase.from('workspace_members').select('user_id', head).eq('workspace_id', workspaceId)),
  ]);
  const plan = teamUsage?.plan ?? null;
  return setupBlock({
    conns, crmConfigs, foundationKinds: (found ?? []).map(f => f.kind), sync, webhooks, revPlays, personalRevPlays: mine, members,
    revPlayLimit: plan ? workspaceAutomationLimit(workspaceId, plan.id) : null,
    plan, subscription: teamUsage?.subscription ?? null, creditsLeft: usage?.credits_left,
  }, { scope, memberUserId });
}
