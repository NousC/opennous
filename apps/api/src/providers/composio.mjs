/**
 * Composio — the per-user OAuth + ingestion layer for Gmail and Google Calendar.
 *
 * WHY THIS EXISTS
 *
 * Connecting Gmail/Calendar used to mean our own OAuth app (oauthGoogle.mjs), our own
 * callback route, our own token storage, and two hourly pollers (pollers/gmail.mjs +
 * pollers/calendar.mjs). Six moving parts we maintained, and the box held every customer's
 * raw Google refresh token. The pollers were unreliable — hourly gaps, silent token-refresh
 * failures — so we replaced the whole native path with Composio.
 *
 * Composio's "entity → connected accounts" model is a 1:1 fit for Nous's member-scoped
 * ownership: the Composio *user id* is our member's `users.id`, so a connected account is
 * owned by exactly one member and ingestion is attributable without any email-matching hop.
 * Composio holds the token; our box holds only the connected-account id. Ingestion arrives
 * as push *triggers* → the worker's /inbound/composio handler → logActivity.
 *
 * DATA SOVEREIGNTY
 *
 * COMPOSIO_API_KEY lives on the customer's own box (data plane), never in a shared control
 * plane. Per-customer key by default; a central org key only for dogfood. COMPOSIO_BASE_URL
 * points at self-hosted Composio when set.
 *
 * ONE DOOR
 *
 * Both entry points — `nous connect gmail` (CLI) and the Integrations panel button — call
 * initiateComposioConnection() then finalizeComposioConnection(). Nothing else connects a
 * Composio provider.
 */

import { Composio } from '@composio/core';
import { decrypt } from './crypto.mjs';
import { workerBaseUrl } from './webhooks.mjs';
import { ingestOnConnect } from '../lib/connectIngest.mjs';
import { auditLog } from '../lib/audit.mjs';

/**
 * Our provider name → the Composio toolkit it maps to. v1 = Gmail + Google Calendar. Each
 * toolkit is a separate Composio auth config and a separate connected account, even though
 * both ride Google OAuth — so connecting "Google" is two connect actions. `source` is the
 * value stamped on activities so downstream sees the same source string the native pollers
 * used ('gmail' / 'google_calendar').
 *
 * triggerSlugs MUST match the trigger names in the Composio dashboard. Registration is
 * best-effort (a bad slug logs and is skipped) — so a slug drift degrades to "connected but
 * not ingesting", never a 500.
 */
export const PROVIDER_MAP = {
  gmail_oauth: {
    toolkit:       'GMAIL',
    authConfigEnv: 'COMPOSIO_AUTHCONFIG_GMAIL',
    // Both directions. GMAIL_EMAIL_SENT_TRIGGER was once removed here as "does not exist", but
    // Composio documents two Gmail triggers and one is live on a production account created
    // 2026-09-09 (GET-234). A create that fails is logged and skipped in
    // reconcileComposioTriggers. Neither trigger is load-bearing any more: the worker's
    // mailbox scan (services/gmailSync.mjs) reads received AND sent mail on a schedule, and a
    // trigger only gets a message in sooner.
    triggerSlugs:  ['GMAIL_NEW_GMAIL_MESSAGE', 'GMAIL_EMAIL_SENT_TRIGGER'],
    source:        'gmail',
  },
  google_calendar: {
    toolkit:       'GOOGLECALENDAR',
    authConfigEnv: 'COMPOSIO_AUTHCONFIG_GOOGLECALENDAR',
    triggerSlugs:  ['GOOGLECALENDAR_GOOGLE_CALENDAR_EVENT_CREATED_TRIGGER'],
    source:        'google_calendar',
  },
};

export function isComposioProvider(name) {
  return Object.prototype.hasOwnProperty.call(PROVIDER_MAP, String(name || '').toLowerCase());
}

function providerConfig(name) {
  return PROVIDER_MAP[String(name || '').toLowerCase()] || null;
}

/**
 * The Composio config for a workspace, merged from the DB row (self-serve pasted key) with
 * the COMPOSIO_* env vars as fallback (DWY-provisioned box). Same code serves both models.
 * Secrets (api key, webhook secret) are decrypted here; auth-config ids are plain.
 */
export async function loadComposioConfig(supabase, workspaceId) {
  let row = null;
  if (supabase && workspaceId) {
    try {
      const { data } = await supabase
        .from('workspace_composio_config').select('*').eq('workspace_id', workspaceId).maybeSingle();
      row = data;
    } catch { /* table absent (pre-migration) → fall back to env */ }
  }
  return {
    apiKey:        row?.encrypted_api_key ? decrypt(row.encrypted_api_key) : (process.env.COMPOSIO_API_KEY || null),
    baseUrl:       row?.base_url || process.env.COMPOSIO_BASE_URL || null,
    webhookSecret: row?.webhook_secret ? decrypt(row.webhook_secret) : (process.env.COMPOSIO_WEBHOOK_SECRET || null),
    authConfigs: {
      gmail_oauth:     row?.authconfig_gmail || process.env.COMPOSIO_AUTHCONFIG_GMAIL || null,
      google_calendar: row?.authconfig_googlecalendar || process.env.COMPOSIO_AUTHCONFIG_GOOGLECALENDAR || null,
    },
  };
}

// Clients are cached per (apiKey, baseUrl) so multiple workspaces on one box don't each
// rebuild an SDK instance every call.
const _clients = new Map();

/** Build (or reuse) a Composio client from a raw key + base URL. Throws if no key. */
export function getComposioClient(apiKey, baseUrl) {
  if (!apiKey) {
    const err = new Error('composio_not_configured');
    err.userMessage = 'Composio is not configured for this workspace (no API key set — paste one in Settings).';
    throw err;
  }
  const key = `${apiKey}|${baseUrl || ''}`;
  let client = _clients.get(key);
  if (!client) {
    client = new Composio({
      apiKey,
      ...(baseUrl ? { baseURL: baseUrl } : {}),
      // PIN THE TOOLKIT VERSION. The SDK defaults to 'latest', and manual
      // tools.execute() THROWS on 'latest' ("Toolkit version not specified") — so every
      // execute call in this codebase (the Composio backfill, the Gmail lookup, the
      // approved Gmail send) fails until a concrete version is pinned. Set once here
      // rather than at each call site, and overridable when Composio moves it on.
      toolkitVersions: process.env.COMPOSIO_TOOLKIT_VERSION || '20250909_00',
    });
    _clients.set(key, client);
  }
  return client;
}

/**
 * Start an OAuth connection for one member + one provider.
 *
 * Returns the Composio hosted-consent URL the caller opens in a browser, plus the
 * connected-account id to poll on. The connected account exists in an INITIATED state until
 * the member finishes consent; finalizeComposioConnection() promotes it.
 */
export async function initiateComposioConnection({ supabase, workspaceId, memberUserId, provider }) {
  const cfg = providerConfig(provider);
  if (!cfg) {
    return { ok: false, status: 404, error: 'unknown_provider', message: `No Composio provider named "${provider}".` };
  }
  if (!memberUserId) {
    // The Composio entity id must be a real member — an admin/legacy key with no owner
    // can't be attributed. The route resolves a fallback before calling us; if it still
    // couldn't, refuse rather than file a connection nobody owns.
    return { ok: false, status: 400, error: 'no_member', message: 'Could not resolve the connecting member.' };
  }

  const config = await loadComposioConfig(supabase, workspaceId);
  const authConfigId = config.authConfigs[String(provider).toLowerCase()];
  if (!authConfigId) {
    return { ok: false, status: 500, error: 'authconfig_missing', message: `No Composio auth config for ${provider} — connect Composio in Settings first.` };
  }

  try {
    const composio = getComposioClient(config.apiKey, config.baseUrl);
    // userId = our member's users.id → Composio entity. This is what makes ingestion
    // owner-attributable with no email lookup. allowMultiple: a member may connect more than
    // one account of the same provider (e.g. two Gmails), and Composio otherwise refuses a
    // second connect for the same (user, auth-config).
    // `link()`, not `initiate()`. Composio deprecated initiate with a Sunset header of
    // 2026-07-03 — a date that has ALREADY PASSED, so every connect this product makes is
    // running on an endpoint the vendor has said it may switch off, and the failure would
    // look like "nobody can connect Gmail any more" with nothing in our changelog to explain
    // it. Same arguments, same return shape, same allowMultiple semantics; `initiate` is kept
    // as a fallback only for an SDK old enough not to have `link`.
    const connect = typeof composio.connectedAccounts.link === 'function'
      ? composio.connectedAccounts.link.bind(composio.connectedAccounts)
      : composio.connectedAccounts.initiate.bind(composio.connectedAccounts);
    const req = await connect(String(memberUserId), authConfigId, { allowMultiple: true });
    return { ok: true, redirectUrl: req.redirectUrl, connectionRequestId: req.id };
  } catch (err) {
    console.error('[COMPOSIO/initiate]', provider, err?.message || err);
    if (err.message === 'composio_not_configured') {
      return { ok: false, status: 503, error: 'composio_not_configured', message: err.userMessage };
    }
    return { ok: false, status: 502, error: 'composio_error', message: err?.message || 'Composio initiate failed.' };
  }
}

/**
 * Check whether the member finished consent and, if so, record the connection.
 *
 * Idempotent: safe to call on every poll. Returns { status:'pending' } until Composio
 * reports the account ACTIVE, then upserts workflow_provider_connections (managed_by
 * 'composio', no secret stored — Composio holds the token), registers push triggers, and
 * enqueues a history backfill. On the first ACTIVE call it does the work; later calls just
 * return the already-saved connection.
 */
export async function finalizeComposioConnection({ supabase, workspaceId, memberUserId, provider, connectionRequestId, userId }) {
  const cfg = providerConfig(provider);
  if (!cfg) return { ok: false, status: 404, error: 'unknown_provider' };

  const config = await loadComposioConfig(supabase, workspaceId);
  let composio, account;
  try {
    composio = getComposioClient(config.apiKey, config.baseUrl);
    account = await composio.connectedAccounts.get(connectionRequestId);
  } catch (err) {
    console.error('[COMPOSIO/finalize get]', err?.message || err);
    if (err.message === 'composio_not_configured') return { ok: false, status: 503, error: 'composio_not_configured', message: err.userMessage };
    return { ok: false, status: 502, error: 'composio_error', message: err?.message };
  }

  const state = String(account?.status || '').toUpperCase();
  if (state === 'FAILED' || state === 'EXPIRED') return { ok: true, status: 'failed' };
  if (state !== 'ACTIVE') return { ok: true, status: 'pending' };

  // Look up our provider row (the catalogue seeds workflow_providers on boot).
  const { data: prow } = await supabase
    .from('workflow_providers')
    .select('id, name, display_name')
    .eq('name', String(provider).toLowerCase())
    .maybeSingle();
  if (!prow) return { ok: false, status: 404, error: 'unknown_provider', message: `Provider ${provider} not seeded.` };

  // The mailbox/calendar this account reads. Composio's account object does not carry it
  // (every row saved so far had account_email null), so ask Gmail itself. It names the row,
  // and it is how the workspace recognises this address as one of ours.
  const accountEmail = await composioAccountEmail({ composio, provider, account, memberUserId, connectionRequestId });

  const saved = await saveComposioConnectionRow(supabase, {
    workspaceId, prow, memberUserId, userId, connectionRequestId, accountEmail,
  });
  if (saved.error) {
    console.error('[COMPOSIO/finalize save]', saved.error);
    return { ok: false, status: 500, error: 'save_failed', message: saved.error };
  }
  const connection = saved.connection;

  // Reconnecting replaces this person's Composio account. The old account's triggers would
  // keep delivering for an id no row holds any more — every one dropped as
  // 'unknown_connection' — so take them down.
  if (saved.previousConnectionId && saved.previousConnectionId !== connectionRequestId) {
    for (const id of saved.previousTriggerIds) {
      try { await composio.triggers.delete(id); } catch (err) { console.warn('[COMPOSIO/old trigger delete]', err?.message); }
    }
  }

  // Triggers are reconciled against COMPOSIO, never against what the row says. "The row
  // already lists trigger ids" is how a reconnected account ended up with none (GET-234):
  // the ids on the row belonged to the account it replaced.
  await reconcileComposioTriggers({ supabase, composio, connection: { ...connection, owner_user_id: memberUserId, composio_connection_id: connectionRequestId }, provider });

  // Backfill recent history so a member's EXISTING inbox/calendar flows in on connect, not
  // just new events. The Composio fetch → logActivity path lives in the worker (it holds the
  // Composio client + ingest), so we fire the worker's internal backfill endpoint.
  // Fire-and-forget; never slow or fail the connect. Dormant unless WORKER_SECRET is set.
  if (process.env.WORKER_SECRET) {
    fetch(`${workerBaseUrl()}/internal/composio/backfill`, {
      method: 'POST',
      headers: { 'x-worker-secret': process.env.WORKER_SECRET, 'content-type': 'application/json' },
      body: JSON.stringify({ connectionId: connection.id }),
    }).catch((err) => console.warn('[COMPOSIO/finalize backfill]', err?.message || err));
  }
  // Also run the legacy native-source history backfill (no-op for Composio-only sources).
  // Same rule as the key-based connect path: connecting a source means pulling it in now.
  ingestOnConnect(workspaceId, provider, { supabase, userId: memberUserId ?? userId })
    .catch(e => console.error('[COMPOSIO] ingest failed:', e?.message || e));

  auditLog({
    actor_user_id: memberUserId ?? null,
    action: 'integration.connect',
    target_type: 'connection',
    target_id: connection.id,
    target_workspace_id: workspaceId,
    metadata: { provider: String(provider).toLowerCase(), managed_by: 'composio' },
  });

  return { ok: true, status: 'connected', connection };
}

/** The address a Composio account reads, or null. Gmail answers from its profile. */
async function composioAccountEmail({ composio, provider, account, memberUserId, connectionRequestId }) {
  const fromAccount = (account?.data?.email || account?.data?.profile?.email || account?.params?.email || '').trim().toLowerCase();
  if (fromAccount) return fromAccount;
  if (String(provider).toLowerCase() !== 'gmail_oauth') return null;   // the calendar scan fills its own from Google's `self` flag
  try {
    const res = await composio.tools.execute('GMAIL_GET_PROFILE', {
      userId: String(memberUserId), connectedAccountId: connectionRequestId, arguments: {},
    });
    const email = res?.data?.emailAddress || res?.data?.response_data?.emailAddress || null;
    return email ? String(email).trim().toLowerCase() : null;
  } catch (err) {
    console.warn('[COMPOSIO/profile]', err?.message || err);
    return null;
  }
}

/**
 * Save the connection row for ONE PERSON's account.
 *
 * A mailbox and a calendar are personal (catalogue SCOPE_OVERRIDES). This used to upsert on
 * (workspace, provider, name) with the name always "Gmail", because Composio never supplied
 * an email — so the second teammate to connect Gmail silently overwrote the first
 * (GET-234: one teammate's connect replaced another's mailbox, whose deliveries were then dropped).
 *
 * The row is now found by WHO it belongs to: this member's existing row for this provider is
 * updated (a reconnect), otherwise a new row is inserted. The name is the address when known,
 * so two people's rows can never collide on the (workspace, provider, name) constraint.
 */
async function saveComposioConnectionRow(supabase, { workspaceId, prow, memberUserId, userId, connectionRequestId, accountEmail }) {
  const cols = 'id, workspace_id, provider_id, name, created_at, is_verified, composio_trigger_ids, composio_connection_id, owner_user_id';

  // Already recorded under this exact account (a repeat poll) → done.
  const { data: sameAccount } = await supabase.from('workflow_provider_connections').select(cols)
    .eq('workspace_id', workspaceId).eq('composio_connection_id', connectionRequestId).maybeSingle();

  // This member reconnecting the SAME address (or, with no address to go on, their row that
  // never had one). A member may hold several accounts of one provider (initiate passes
  // allowMultiple), so a second, different mailbox must insert — never replace the first.
  let mine = null;
  if (!sameAccount) {
    let q = supabase.from('workflow_provider_connections').select(cols)
      .eq('workspace_id', workspaceId).eq('provider_id', prow.id).eq('managed_by', 'composio')
      .eq('owner_user_id', memberUserId);
    q = accountEmail ? q.eq('account_email', accountEmail) : q.is('account_email', null);
    ({ data: mine } = await q.order('created_at', { ascending: false }).limit(1).maybeSingle());
  }

  const target = sameAccount || mine || null;
  const values = {
    encrypted_credentials:  {},                 // Composio holds the token; we store none.
    managed_by:             'composio',
    composio_connection_id: connectionRequestId,
    owner_user_id:          memberUserId,
    is_verified:            true,
    last_test_at:           new Date().toISOString(),
    ...(accountEmail ? { account_email: accountEmail, name: accountEmail } : {}),
  };

  if (target) {
    const { data, error } = await supabase.from('workflow_provider_connections')
      .update(values).eq('id', target.id).select(cols).single();
    if (error) return { error: error.message };
    return {
      connection: data,
      previousConnectionId: target.composio_connection_id,
      previousTriggerIds: Array.isArray(target.composio_trigger_ids) ? target.composio_trigger_ids : [],
    };
  }

  // A name nobody else in the workspace holds for this provider. The address when we have
  // it; otherwise the display name qualified by the member, then a counter as a last resort.
  const base = accountEmail || `${prow.display_name || prow.name} · ${String(memberUserId || "member").slice(0, 8)}`;
  for (let n = 1; n <= 5; n++) {
    const name = n === 1 ? base : `${base} (${n})`;
    const { data, error } = await supabase.from('workflow_provider_connections').insert({
      ...values,
      workspace_id: workspaceId,
      provider_id:  prow.id,
      name,
      created_by:   userId ?? memberUserId,
      account_email: accountEmail,
    }).select(cols).single();
    if (!error) return { connection: data, previousConnectionId: null, previousTriggerIds: [] };
    if (error.code !== '23505') return { error: error.message };
  }
  return { error: 'could not find a free connection name' };
}

/**
 * Make Composio hold exactly the triggers this provider needs on this connection's account,
 * and make the row list the ids Composio actually has. Idempotent: safe on every connect and
 * from scripts/reconcile-composio-triggers.mjs. Best-effort per slug — a failed create logs
 * and the connection still ingests, because the worker's scan does not depend on triggers.
 */
export async function reconcileComposioTriggers({ supabase, composio, connection, provider }) {
  const cfg = providerConfig(provider);
  if (!cfg || !connection?.composio_connection_id) return { ids: [], created: [] };
  const ca = connection.composio_connection_id;

  let active = [];
  try {
    const list = await composio.triggers.listActive({ connectedAccountIds: [ca] });
    active = (list?.items || list?.data || []).filter(t => (t.connectedAccountId || t.connected_account_id || ca) === ca);
  } catch (err) {
    console.warn('[COMPOSIO/trigger list]', err?.message || err);
  }
  const slugOf = (t) => String(t.triggerName || t.trigger_slug || t.triggerSlug || '').toUpperCase();
  const have = new Map(active.map(t => [slugOf(t), t.id]));

  const created = [];
  for (const slug of cfg.triggerSlugs) {
    if (have.has(slug)) continue;
    try {
      const res = await composio.triggers.create(String(connection.owner_user_id), slug, { connectedAccountId: ca });
      const id = res?.triggerId || res?.id;
      if (id) { have.set(slug, id); created.push(slug); }
    } catch (err) {
      console.error(`[COMPOSIO/trigger ${slug}]`, err?.message || err);
    }
  }

  const ids = [...have.values()].filter(Boolean);
  if (connection.id) {
    await supabase.from('workflow_provider_connections').update({ composio_trigger_ids: ids }).eq('id', connection.id);
  }
  return { ids, created };
}

/**
 * Tear down a Composio connection: delete its triggers and the connected account at
 * Composio, then let the caller drop our row. Best-effort — a provider-side failure must
 * not block removing the connection on our side.
 */
export async function disconnectComposioConnection({ supabase, connection }) {
  if (!connection?.composio_connection_id) return { ok: true };
  let composio;
  try {
    const config = await loadComposioConfig(supabase, connection.workspace_id);
    composio = getComposioClient(config.apiKey, config.baseUrl);
  } catch { return { ok: true }; } // not configured → nothing to revoke

  for (const id of (connection.composio_trigger_ids || [])) {
    try { await composio.triggers.delete(id); } catch (err) { console.warn('[COMPOSIO/trigger delete]', err?.message); }
  }
  try { await composio.connectedAccounts.delete(connection.composio_connection_id); }
  catch (err) { console.warn('[COMPOSIO/account delete]', err?.message); }
  return { ok: true };
}
