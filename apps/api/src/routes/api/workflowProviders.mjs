import { Router } from 'express';
import { getSupabaseClient, getWorkspaceMemberProfiles, posthogSettings, posthogRequest, posthogEventNamesQuery, parseEventNames } from '@nous/core';
import { verifySupabaseAuth } from '../../middleware/supabaseAuth.mjs';
import { resolveTeamAndPlan } from '../../lib/access.mjs';
import { CUSTOM_ONLY_INTEGRATIONS, isSelfHosted } from '../../lib/plans.mjs';

// How a provider connects, whether its key works, and what to do about its webhook now
// all live in one place. This file used to answer those questions itself, from hardcoded
// name lists that drifted out of step with the database and with each other.
import { isKeyProvider } from '../../providers/catalogue.mjs';
import { testProviderCredentials, testNamedProvider } from '../../providers/test.mjs';
import { connectProvider, disconnectProvider } from '../../providers/connect.mjs';
import { decrypt, encryptCredentials } from '../../providers/crypto.mjs';
import { updatePostHogEvents } from '../../providers/webhooks.mjs';
import { assertPublicUrl } from '../../lib/ssrf.mjs';
import { isWorkspaceMember, isWorkspaceAdmin } from '../../lib/authz.mjs';
import { sourceScope, canSeeConnection, canManageConnection, connectForbidden } from '../../providers/sourceScope.mjs';
import { lastSyncedByConnection } from '../../providers/lastSynced.mjs';
import { syncProgressByConnection } from '../../providers/syncProgress.mjs';

export const workflowProvidersRouter = Router();

// Who is asking, for the personal/company source rule (GET-232).
async function viewerOf(supabase, workspaceId, req) {
  return {
    viewerUserId: req.internalUserId ?? null,
    viewerIsAdmin: await isWorkspaceAdmin(supabase, workspaceId, req.internalUserId),
  };
}

// A connection row + the viewer → the fields the rule reads.
const scopeOf = (conn) => sourceScope(conn.provider?.name, conn.provider?.category);

// null when the viewer may change this connection; else the response to send. A teammate's
// personal source answers 404 (it is invisible to them); a company source a non-admin can
// see answers 403 with the reason.
async function manageDenied(supabase, conn, req) {
  const scope = scopeOf(conn);
  const viewer = await viewerOf(supabase, conn.workspace_id, req);
  if (canManageConnection({ scope, ownerUserId: conn.owner_user_id, ...viewer })) return null;
  if (!canSeeConnection({ scope, ownerUserId: conn.owner_user_id, ...viewer })) {
    return { status: 404, body: { error: 'not_found' } };
  }
  return { status: 403, body: { error: 'company_source_admin_only', message: 'Only workspace owners and admins can change a company source.' } };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Is this workspace allowed to connect this provider?
 *
 * Returns null to allow, or a 402 body to refuse. Slack is the one Workspace-only connector
 * (CUSTOM_ONLY_INTEGRATIONS); HubSpot, Salesforce and the other 20+ integrations are open to
 * every plan, and self-host is the Self-serve plan (GET-576).
 *
 * Fails OPEN. A metering or lookup hiccup must never stop a customer connecting a
 * tool they are entitled to — the downside of wrongly allowing one connection is a
 * support ticket, the downside of wrongly blocking one is a churned customer.
 */
async function assertIntegrationAllowed(supabase, req, providerId) {
  try {
    const { data: provider } = await supabase
      .from('workflow_providers')
      .select('name, display_name')
      .eq('id', providerId)
      .maybeSingle();

    const name = String(provider?.name ?? '').toLowerCase();
    if (!name || !CUSTOM_ONLY_INTEGRATIONS.has(name)) return null;
    if (isSelfHosted()) {
      return {
        error: 'cloud_only_feature',
        feature: 'slack',
        provider: provider.display_name || name,
        message: `${provider.display_name || name} is available on OpenNous Cloud only.`,
      };
    }

    // Onboarding exception: connecting the CRM is the whole point of onboarding, so let a
    // workspace still being set up (onboarding not yet completed) connect its CRM regardless
    // of plan. Slack stays gated — it isn't part of the data-source step.
    const CRM_ONBOARDING = new Set(['salesforce', 'hubspot', 'attio']);
    if (CRM_ONBOARDING.has(name)) {
      const workspaceId = req.body?.workspace_id || req.query?.workspace_id || req.workspaceId || null;
      if (workspaceId) {
        const { data: ws } = await supabase
          .from('workspaces').select('onboarding_completed_at').eq('id', workspaceId).maybeSingle();
        if (ws && !ws.onboarding_completed_at) return null; // onboarding in progress → allow
      }
    }

    const { plan } = await resolveTeamAndPlan(req);
    if (plan.features?.slack) return null;

    return {
      error: 'feature_not_in_plan',
      feature: 'slack',
      provider: provider.display_name || name,
      current_plan: plan.id,
      message: `${provider.display_name || name} is available on the Workspace plan. Everything else connects on any plan.`,
      upgrade_url: '/settings?section=billing',
    };
  } catch (err) {
    console.error('[assertIntegrationAllowed] fail-open:', err?.message);
    return null;
  }
}


// GET /api/workflow-providers
workflowProvidersRouter.get('/', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { category, search } = req.query;
    let query = supabase.from('workflow_providers').select('*').eq('is_active', true).order('display_name');
    if (category) query = query.eq('category', category);
    if (search) query = query.or(`display_name.ilike.%${search}%,description.ilike.%${search}%`);
    const { data: providers, error } = await query;
    if (error) throw error;
    return res.json({ providers: (providers || []).map(p => ({ ...p, scope: sourceScope(p.name, p.category) })) });
  } catch (err) {
    return res.status(500).json({ error: 'internal_error' });
  }
});

// GET /api/workflow-providers/connections — must be before /:id
workflowProvidersRouter.get('/connections', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { workspace_id, provider_id } = req.query;
    if (!workspace_id) return res.status(400).json({ error: 'workspace_id_required' });

    let query = supabase
      .from('workflow_provider_connections')
      .select(`
        id, workspace_id, provider_id, name, created_at, last_used_at,
        is_verified, last_test_at, encrypted_credentials, owner_user_id,
        provider:workflow_providers(id, name, display_name, logo_url, auth_type, auth_fields, category)
      `)
      .eq('workspace_id', workspace_id)
      .order('created_at', { ascending: false });

    if (provider_id) query = query.eq('provider_id', provider_id);
    const { data: connections, error } = await query;
    if (error) throw error;

    // A teammate's personal source is theirs alone: it is dropped here, not hidden in the
    // page, so its credential hints never leave the server.
    const viewer = await viewerOf(supabase, workspace_id, req);
    const visible = (connections || [])
      .map(conn => ({ conn, scope: scopeOf(conn) }))
      .filter(({ conn, scope }) => canSeeConnection({ scope, ownerUserId: conn.owner_user_id, ...viewer }));

    // Company sources say who connected them.
    const profiles = visible.some(v => v.conn.owner_user_id)
      ? await getWorkspaceMemberProfiles(supabase, workspace_id).catch(() => new Map())
      : new Map();
    const ownerNames = new Map([...profiles].map(([id, p]) => [id, p?.name ?? null]));

    const processed = visible.map(({ conn, scope }) => {
      const hints = {};
      if (conn.encrypted_credentials) {
        for (const [key, val] of Object.entries(conn.encrypted_credentials)) {
          const dec = decrypt(val);
          if (dec && dec.length >= 12) hints[key] = dec.slice(0, 8) + '...' + dec.slice(-4);
          else if (dec && dec.length > 4) hints[key] = dec.slice(0, 4) + '...';
          else hints[key] = '••••••••';
        }
      }
      // Non-secret status flags derived from encrypted_credentials before stripping.
      // Calendly stores subscription_uri, Cal.com stores webhook_id — either means registered.
      const webhook_registered =
        !!conn.encrypted_credentials?.webhook_subscription_uri
        || !!conn.encrypted_credentials?.webhook_id;
      const { encrypted_credentials: _, ...rest } = conn;
      return {
        ...rest, credential_hints: hints, webhook_registered,
        scope,
        owner_name: ownerNames.get(conn.owner_user_id) ?? null,
        is_mine: !!conn.owner_user_id && conn.owner_user_id === viewer.viewerUserId,
        can_manage: canManageConnection({ scope, ownerUserId: conn.owner_user_id, ...viewer }),
      };
    });

    // ?include=last_synced — the API plan's source cards show when each one last brought
    // something in (GET-631). ?include=progress — and how far a running backfill has got for
    // each source, as sync_progress { percent, done, total, label } or null (GET-620 E5). Both
    // opt-in, so the other callers don't pay for the lookups; asked together, they run in parallel.
    const include = String(req.query.include || '').split(',');
    const [synced, progress] = await Promise.all([
      include.includes('last_synced') ? lastSyncedByConnection(supabase, workspace_id, processed).catch(() => new Map()) : null,
      include.includes('progress') ? syncProgressByConnection(supabase, workspace_id, processed).catch(() => new Map()) : null,
    ]);
    if (synced) for (const c of processed) c.last_synced_at = synced.get(c.id) ?? null;
    if (progress) for (const c of processed) c.sync_progress = progress.get(c.id) ?? null;

    return res.json({ connections: processed });
  } catch (err) {
    return res.status(500).json({ error: 'internal_error' });
  }
});

// POST /api/workflow-providers/connections
//
// Takes a provider_id (the Settings modal has one; the Integrations page has a name).
// Both roads now run through connectProvider, which is what makes the webhook get
// registered no matter which screen the user happened to start from.
workflowProvidersRouter.post('/connections', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { workspace_id, provider_id, name, credentials } = req.body;
    if (!workspace_id || !provider_id) return res.status(400).json({ error: 'workspace_id and provider_id required' });

    // Salesforce, HubSpot and Slack are Custom-only. Every provider connection in the
    // product lands here, whatever route it started from, so this is the one place the
    // gate actually holds — the OAuth callbacks are unauthenticated provider redirects
    // and cannot check a plan.
    //
    // The other 20+ integrations are open on every plan, deliberately. Pipedrive, Attio
    // and Close are what a self-serve operator actually runs, and blocking those would
    // break the product for the exact audience it is built for.
    const gate = await assertIntegrationAllowed(supabase, req, provider_id);
    if (gate) return res.status(402).json(gate);

    const { data: prov } = await supabase
      .from('workflow_providers').select('name, category').eq('id', provider_id).maybeSingle();
    if (!prov?.name) return res.status(404).json({ error: 'unknown_provider' });
    const forbidden = await connectForbidden(supabase, { workspaceId: workspace_id, userId: req.internalUserId, providerName: prov.name, category: prov.category });
    if (forbidden) return res.status(403).json(forbidden);

    const result = await connectProvider({
      supabase,
      workspaceId:    workspace_id,
      providerName:   prov.name,
      credentials,
      connectionName: name,
      userId:         req.internalUserId,
    });

    if (!result.ok) {
      return res.status(result.status).json({ error: result.error, message: result.message });
    }
    return res.json({
      connection: result.connection,
      note: result.note,
      webhook_registered: result.webhookRegistered,
    });
  } catch (err) {
    console.error('[POST /api/workflow-providers/connections]', err.message, err.code);
    return res.status(500).json({ error: 'internal_error', message: err.message });
  }
});

// POST /api/workflow-providers/connections/test  (test before saving — no existing connection)
workflowProvidersRouter.post('/connections/test', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { provider_id, credentials } = req.body;
    if (!provider_id || !credentials) return res.status(400).json({ error: 'provider_id and credentials required' });

    const { data: provider } = await supabase.from('workflow_providers').select('name').eq('id', provider_id).single();
    const result = await testProviderCredentials(provider?.name, credentials);
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ verified: false, message: 'internal_error' });
  }
});

// GET /api/workflow-providers/connections/:id
workflowProvidersRouter.get('/connections/:id', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { id } = req.params;
    if (!UUID.test(id)) return res.status(400).json({ error: 'invalid_id' });
    const { data, error } = await supabase
      .from('workflow_provider_connections')
      .select('id, workspace_id, provider_id, name, is_verified, last_test_at, created_at, owner_user_id, provider:workflow_providers(id, name, display_name, logo_url, auth_type, auth_fields, category)')
      .eq('id', id)
      .single();
    if (error || !data) return res.status(404).json({ error: 'not_found' });
    if (!(await isWorkspaceMember(supabase, data.workspace_id, req.internalUserId))) {
      return res.status(404).json({ error: 'not_found' });
    }
    // A teammate's personal source: 404, as if it weren't there.
    if (!canSeeConnection({ scope: scopeOf(data), ownerUserId: data.owner_user_id, ...(await viewerOf(supabase, data.workspace_id, req)) })) {
      return res.status(404).json({ error: 'not_found' });
    }

    const hints = {};
    const { data: full } = await supabase.from('workflow_provider_connections').select('encrypted_credentials').eq('id', id).single();
    if (full?.encrypted_credentials) {
      for (const [key, val] of Object.entries(full.encrypted_credentials)) {
        const dec = decrypt(val);
        if (dec && dec.length >= 12) hints[key] = dec.slice(0, 8) + '...' + dec.slice(-4);
        else if (dec && dec.length > 4) hints[key] = dec.slice(0, 4) + '...';
        else hints[key] = '••••••••';
      }
    }
    return res.json({ connection: { ...data, credential_hints: hints } });
  } catch (err) {
    return res.status(500).json({ error: 'internal_error' });
  }
});

// POST /api/workflow-providers/connections/:id/test
workflowProvidersRouter.post('/connections/:id/test', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { id } = req.params;
    if (!UUID.test(id)) return res.status(400).json({ error: 'invalid_id' });
    const { data: conn } = await supabase
      .from('workflow_provider_connections')
      .select('workspace_id, encrypted_credentials, owner_user_id, provider:workflow_providers(name, category)')
      .eq('id', id).single();
    if (!conn) return res.status(404).json({ error: 'not_found' });
    if (!(await isWorkspaceMember(supabase, conn.workspace_id, req.internalUserId))) {
      return res.status(404).json({ error: 'not_found' });
    }
    const denied = await manageDenied(supabase, conn, req);
    if (denied) return res.status(denied.status).json(denied.body);

    const creds = {};
    for (const [k, v] of Object.entries(conn.encrypted_credentials || {})) {
      creds[k] = decrypt(v);
    }

    const result = await testProviderCredentials(conn.provider?.name, creds);
    await supabase.from('workflow_provider_connections')
      .update({ is_verified: result.verified, last_test_at: new Date().toISOString() })
      .eq('id', id);
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ verified: false, message: 'internal_error' });
  }
});

// PATCH /api/workflow-providers/connections/:id  (update credentials)
workflowProvidersRouter.patch('/connections/:id', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { id } = req.params;
    if (!UUID.test(id)) return res.status(400).json({ error: 'invalid_id' });
    const { credentials } = req.body;
    if (!credentials || !Object.keys(credentials).length) return res.status(400).json({ error: 'credentials required' });

    const { data: existing } = await supabase.from('workflow_provider_connections').select('workspace_id, encrypted_credentials, owner_user_id, provider:workflow_providers(name, category)').eq('id', id).single();
    if (!existing) return res.status(404).json({ error: 'not_found' });
    if (!(await isWorkspaceMember(supabase, existing.workspace_id, req.internalUserId))) {
      return res.status(404).json({ error: 'not_found' });
    }
    const denied = await manageDenied(supabase, existing, req);
    if (denied) return res.status(denied.status).json(denied.body);

    // Only overwrite the fields they actually supplied — a blank field in the edit form
    // means "leave it alone", not "erase it".
    const supplied = Object.fromEntries(Object.entries(credentials).filter(([, v]) => v));
    const merged = { ...(existing.encrypted_credentials || {}), ...encryptCredentials(supplied) };

    await supabase.from('workflow_provider_connections').update({ encrypted_credentials: merged, is_verified: false }).eq('id', id).eq('workspace_id', existing.workspace_id);
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: 'internal_error', message: err.message });
  }
});

// PATCH /api/workflow-providers/connections/:id/enrichment-toggle
workflowProvidersRouter.patch('/connections/:id/enrichment-toggle', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { id } = req.params;
    if (!UUID.test(id)) return res.status(400).json({ error: 'invalid_id' });
    const { enabled, workspace_id } = req.body;

    const { data: existing } = await supabase
      .from('workflow_provider_connections')
      .select('encrypted_credentials, workspace_id, owner_user_id, provider:workflow_providers(name, category)')
      .eq('id', id).single();
    if (!existing) return res.status(404).json({ error: 'not_found' });
    if (!(await isWorkspaceMember(supabase, existing.workspace_id, req.internalUserId))) {
      return res.status(404).json({ error: 'not_found' });
    }
    const denied = await manageDenied(supabase, existing, req);
    if (denied) return res.status(denied.status).json(denied.body);

    // If enabling an enrichment provider, disable all other enrichment connections in this workspace
    if (enabled && existing.provider?.category === 'enrichment') {
      // Pin to the (membership-verified) connection's own workspace — never a
      // caller-supplied workspace_id, or a member of A could disable B's enrichment.
      const wid = existing.workspace_id;
      const { data: others } = await supabase
        .from('workflow_provider_connections')
        .select('id, encrypted_credentials')
        .eq('workspace_id', wid)
        .neq('id', id)
        .eq('provider.category', 'enrichment');
      for (const other of others || []) {
        if (other.encrypted_credentials?.use_for_enrichment) {
          await supabase.from('workflow_provider_connections')
            .update({ encrypted_credentials: { ...other.encrypted_credentials, use_for_enrichment: false } })
            .eq('id', other.id);
        }
      }
    }

    const updated = { ...(existing.encrypted_credentials || {}), use_for_enrichment: !!enabled };
    await supabase.from('workflow_provider_connections').update({ encrypted_credentials: updated }).eq('id', id).eq('workspace_id', existing.workspace_id);
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: 'internal_error', message: err.message });
  }
});

// DELETE /api/workflow-providers/connections/:id
//
// Tears down whatever webhook we registered on connect before dropping the row, so we
// don't leave a live subscription in the customer's Calendly (or Lemlist, or Instantly…)
// pointing at a URL that will reject it forever. Which provider needs what is the
// registry's problem now, not this route's.
workflowProvidersRouter.delete('/connections/:id', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { id } = req.params;
    if (!UUID.test(id)) return res.status(400).json({ error: 'invalid_id' });

    const { data: existing } = await supabase.from('workflow_provider_connections').select('workspace_id, name, owner_user_id, provider:workflow_providers(name, category)').eq('id', id).single();
    if (!existing) return res.status(404).json({ error: 'not_found' });
    if (!(await isWorkspaceMember(supabase, existing.workspace_id, req.internalUserId))) {
      return res.status(404).json({ error: 'not_found' });
    }
    const denied = await manageDenied(supabase, existing, req);
    if (denied) return res.status(denied.status).json(denied.body);

    // The audit row (who, from where, which provider) is written by disconnectProvider (GET-901).
    await disconnectProvider({ supabase, connectionId: id, via: 'disconnect_route',
      actor: { user_id: req.internalUserId ?? null, email: req.user?.email ?? null, ip: req.ip ?? null } });
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: 'internal_error' });
  }
});

// ── PostHog events (GET-751): which events the destination sends, changed without a reconnect ──

async function loadPostHogConnection(supabase, id, req) {
  if (!UUID.test(id)) return { status: 400, body: { error: 'invalid_id' } };
  const { data: conn } = await supabase.from('workflow_provider_connections')
    .select('id, workspace_id, name, owner_user_id, encrypted_credentials, provider:workflow_providers(name, category)').eq('id', id).maybeSingle();
  if (!conn || conn.provider?.name !== 'posthog') return { status: 404, body: { error: 'not_found' } };
  if (!(await isWorkspaceMember(supabase, conn.workspace_id, req.internalUserId))) return { status: 404, body: { error: 'not_found' } };
  return { conn };
}

const postHogEventsOf = (creds) => {
  const read = posthogSettings(Object.fromEntries(['host', 'project_id', 'signup_event', 'key_events', 'posthog_api_base', 'posthog_project_id']
    .map(k => [k, decrypt(creds?.[k])])));
  return read.ok ? { signup_event: read.settings.signupEvent, key_events: read.settings.keyEvents, destination: !!creds?.hog_function_id } : null;
};

workflowProvidersRouter.get('/connections/:id/posthog-events', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const got = await loadPostHogConnection(supabase, req.params.id, req);
    if (!got.conn) return res.status(got.status).json(got.body);
    const creds = got.conn.encrypted_credentials ?? {};
    const events = postHogEventsOf(creds);
    if (!events) return res.status(409).json({ error: 'posthog_settings_unreadable' });
    // What the project actually sends, to tick instead of type. Never fails the read.
    let available = [];
    try {
      const read = posthogSettings(Object.fromEntries(['host', 'project_id', 'posthog_api_base', 'posthog_project_id'].map(k => [k, decrypt(creds[k])])));
      if (read.ok) {
        const { apiBase, projectId } = read.settings;
        if (!apiBase.endsWith('.posthog.com')) await assertPublicUrl(apiBase);
        const r = await posthogRequest(decrypt(creds.api_key), apiBase, `/api/projects/${projectId}/query/`, {
          method: 'POST', timeoutMs: 15_000,
          body: { query: { kind: 'HogQLQuery', query: posthogEventNamesQuery() }, name: 'opennous_event_names' },
        });
        available = parseEventNames(r?.results);
      }
    } catch (err) {
      console.warn('[posthog-events] event names:', err.message);
    }
    return res.json({ ...events, available });
  } catch (err) {
    return res.status(500).json({ error: 'internal_error' });
  }
});

workflowProvidersRouter.patch('/connections/:id/posthog-events', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const got = await loadPostHogConnection(supabase, req.params.id, req);
    if (!got.conn) return res.status(got.status).json(got.body);
    const denied = await manageDenied(supabase, got.conn, req);
    if (denied) return res.status(denied.status).json(denied.body);
    const creds = got.conn.encrypted_credentials ?? {};
    const plain = Object.fromEntries(['host', 'project_id', 'posthog_api_base', 'posthog_project_id', 'hog_function_id'].map(k => [k, decrypt(creds[k])]));
    let out;
    try {
      out = await updatePostHogEvents(decrypt(creds.api_key), plain, {
        signupEvent: req.body?.signup_event ?? null, keyEvents: req.body?.key_events ?? '',
      });
    } catch (err) {
      return res.status(502).json({ error: 'posthog_update_failed', message: `PostHog answered ${err.status ?? 'an error'}: ${err.message}` });
    }
    if (!out.ok) return res.status(400).json({ error: out.error });
    await supabase.from('workflow_provider_connections').update({
      encrypted_credentials: { ...creds, signup_event: out.signupEvent, key_events: out.keyEvents.join(', ') },
    }).eq('id', got.conn.id);
    return res.json({ signup_event: out.signupEvent, key_events: out.keyEvents, destination: out.destination });
  } catch (err) {
    return res.status(500).json({ error: 'internal_error' });
  }
});

// GET /api/workflow-providers/slack/channels  — list channels for a saved Slack connection
workflowProvidersRouter.get('/slack/channels', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { connection_id } = req.query;
    if (!connection_id) return res.status(400).json({ error: 'connection_id_required' });

    const { data: conn } = await supabase
      .from('workflow_provider_connections')
      .select('workspace_id, encrypted_credentials')
      .eq('id', connection_id)
      .single();
    if (!conn) return res.status(404).json({ error: 'not_found' });
    if (!(await isWorkspaceMember(supabase, conn.workspace_id, req.internalUserId))) {
      return res.status(404).json({ error: 'not_found' });
    }

    const token = decrypt(conn.encrypted_credentials?.bot_token || conn.encrypted_credentials?.access_token || conn.encrypted_credentials?.token || '');
    if (!token) return res.status(400).json({ error: 'no_token' });

    const slackRes = await fetch('https://slack.com/api/conversations.list?types=public_channel,private_channel&exclude_archived=true&limit=200', {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await slackRes.json();
    if (!data.ok) return res.status(400).json({ error: data.error || 'slack_error' });

    const channels = (data.channels || []).map(c => ({ id: c.id, name: c.name, is_private: c.is_private }));
    return res.json({ channels });
  } catch (err) {
    return res.status(500).json({ error: 'internal_error' });
  }
});


// POST /api/workflow-providers/:name/test
//
// Gated on the catalogue, not on a list of names kept in this file. That list is why
// aiark, blitz and leadmagic — real providers, wired into the leads pipeline — 404'd
// when anyone clicked Connect on them: nobody remembered to add them to it.
workflowProvidersRouter.post('/:name/test', verifySupabaseAuth, async (req, res) => {
  const { name } = req.params;
  if (!isKeyProvider(name)) return res.status(404).json({ error: 'not_found' });
  try {
    const { api_key } = req.body;
    const result = await testNamedProvider(name, api_key);
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ verified: false, message: err.message || 'internal_error' });
  }
});

// POST /api/workflow-providers/:name/connect
//
// The paste-one-key door. Everything it used to do inline — encrypt, subscribe the
// webhook, upsert — now happens in connectProvider, which is the same code the Settings
// modal and the MCP agent run. That is the whole point: there is no longer a "good" door
// and two doors that quietly skip the webhook.
//
// Two behaviours changed here, both deliberately:
//   - the key is now TESTED before it is saved. This route used to write is_verified:true
//     without ever checking, so a typo'd key showed as Connected forever.
//   - the Custom-plan gate now runs. It only lived on /connections, so this route was a
//     way around it.
workflowProvidersRouter.post('/:name/connect', verifySupabaseAuth, async (req, res) => {
  const { name } = req.params;
  if (!isKeyProvider(name)) return res.status(404).json({ error: 'not_found' });
  try {
    const supabase = getSupabaseClient();
    const { workspace_id, name: connName, api_key } = req.body;
    if (!workspace_id || !api_key) return res.status(400).json({ error: 'workspace_id and api_key required' });

    const { data: provider } = await supabase
      .from('workflow_providers').select('id, category').eq('name', name).maybeSingle();
    if (!provider?.id) return res.status(404).json({ error: `provider_not_found: ${name}` });
    const forbidden = await connectForbidden(supabase, { workspaceId: workspace_id, userId: req.internalUserId, providerName: name, category: provider.category });
    if (forbidden) return res.status(403).json(forbidden);

    const gate = await assertIntegrationAllowed(supabase, req, provider.id);
    if (gate) return res.status(402).json(gate);

    const result = await connectProvider({
      supabase,
      workspaceId:    workspace_id,
      providerName:   name,
      credentials:    { api_key },
      connectionName: connName,
      userId:         req.internalUserId,
    });

    if (!result.ok) {
      return res.status(result.status).json({ error: result.error, message: result.message });
    }
    return res.json({
      connection: result.connection,
      note: result.note,
      webhook_registered: result.webhookRegistered,
    });
  } catch (err) {
    console.error(`[POST /:name/connect ${req.params.name}]`, err.message, err.code);
    return res.status(500).json({ error: 'internal_error', message: err.message });
  }
});

// GET /api/workflow-providers/:id
workflowProvidersRouter.get('/:id', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { id } = req.params;
    const { data, error } = await supabase.from('workflow_providers').select('*').eq('id', id).single();
    if (error) return res.status(404).json({ error: 'not_found' });
    return res.json({ provider: data });
  } catch (err) {
    return res.status(500).json({ error: 'internal_error' });
  }
});

