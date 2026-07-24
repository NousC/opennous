import { Router } from 'express';
import { getSupabaseClient } from '@nous/core';
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
import { isWorkspaceMember } from '../../lib/authz.mjs';

export const workflowProvidersRouter = Router();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Is this workspace allowed to connect this provider?
 *
 * Returns null to allow, or a 402 body to refuse. Salesforce, HubSpot and Slack are
 * where GTM TEAMS live, and teams are what Custom is; the other 20+ integrations are
 * open to everyone.
 *
 * Fails OPEN. A metering or lookup hiccup must never stop a customer connecting a
 * tool they are entitled to — the downside of wrongly allowing one connection is a
 * support ticket, the downside of wrongly blocking one is a churned customer.
 */
async function assertIntegrationAllowed(supabase, req, providerId) {
  if (isSelfHosted()) return null; // no plans on self-host; operators can do anything

  try {
    const { data: provider } = await supabase
      .from('workflow_providers')
      .select('name, display_name')
      .eq('id', providerId)
      .maybeSingle();

    const name = String(provider?.name ?? '').toLowerCase();
    if (!name || !CUSTOM_ONLY_INTEGRATIONS.has(name)) return null;

    const { plan } = await resolveTeamAndPlan(req);
    if (plan.features?.enterpriseIntegrations) return null;

    return {
      error: 'feature_not_in_plan',
      feature: 'enterpriseIntegrations',
      provider: provider.display_name || name,
      current_plan: plan.id,
      message: `${provider.display_name || name} is available on the Custom plan. Everything else connects on any plan.`,
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
    return res.json({ providers: providers || [] });
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
        is_verified, last_test_at, encrypted_credentials,
        provider:workflow_providers(id, name, display_name, logo_url, auth_type, auth_fields, category)
      `)
      .eq('workspace_id', workspace_id)
      .order('created_at', { ascending: false });

    if (provider_id) query = query.eq('provider_id', provider_id);
    const { data: connections, error } = await query;
    if (error) throw error;

    const processed = (connections || []).map(conn => {
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
      return { ...rest, credential_hints: hints, webhook_registered };
    });

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
      .from('workflow_providers').select('name').eq('id', provider_id).maybeSingle();
    if (!prov?.name) return res.status(404).json({ error: 'unknown_provider' });

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
      .select('id, workspace_id, provider_id, name, is_verified, last_test_at, created_at, provider:workflow_providers(id, name, display_name, logo_url, auth_type, auth_fields, category)')
      .eq('id', id)
      .single();
    if (error || !data) return res.status(404).json({ error: 'not_found' });
    if (!(await isWorkspaceMember(supabase, data.workspace_id, req.internalUserId))) {
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
      .select('workspace_id, encrypted_credentials, provider:workflow_providers(name)')
      .eq('id', id).single();
    if (!conn) return res.status(404).json({ error: 'not_found' });
    if (!(await isWorkspaceMember(supabase, conn.workspace_id, req.internalUserId))) {
      return res.status(404).json({ error: 'not_found' });
    }

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

    const { data: existing } = await supabase.from('workflow_provider_connections').select('workspace_id, encrypted_credentials').eq('id', id).single();
    if (!existing) return res.status(404).json({ error: 'not_found' });
    if (!(await isWorkspaceMember(supabase, existing.workspace_id, req.internalUserId))) {
      return res.status(404).json({ error: 'not_found' });
    }

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
      .select('encrypted_credentials, workspace_id, provider:workflow_providers(category)')
      .eq('id', id).single();
    if (!existing) return res.status(404).json({ error: 'not_found' });
    if (!(await isWorkspaceMember(supabase, existing.workspace_id, req.internalUserId))) {
      return res.status(404).json({ error: 'not_found' });
    }

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

    const { data: existing } = await supabase.from('workflow_provider_connections').select('workspace_id').eq('id', id).single();
    if (!existing) return res.status(404).json({ error: 'not_found' });
    if (!(await isWorkspaceMember(supabase, existing.workspace_id, req.internalUserId))) {
      return res.status(404).json({ error: 'not_found' });
    }

    await disconnectProvider({ supabase, connectionId: id });
    return res.json({ ok: true });
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
      .from('workflow_providers').select('id').eq('name', name).maybeSingle();
    if (!provider?.id) return res.status(404).json({ error: `provider_not_found: ${name}` });

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
