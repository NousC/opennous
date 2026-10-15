import { Router } from 'express';
import {
  getSupabaseClient, logActivity, syncCrmProvider,
  runHygieneForConfig, listHygieneProposals, countHygieneProposals, updateHygieneProposalStatus,
  applyProposal, isApplyable, writePrimaryPipelineRef,
} from '@nous/core';
import { verifySupabaseAuth } from '../../middleware/supabaseAuth.mjs';

// Both helpers moved to lib/connectIngest.mjs, which is now the single implementation of
// "a CRM connected, pull it in" — this route and the connect path share it.
import { adoptStagesAfterSync, trainFromSyncedDeals, retryCrmImport } from '../../lib/connectIngest.mjs';
import { requireFeature } from '../../lib/access.mjs';
import { enrichContact } from '../../services/enrichment.mjs';
import { enqueueWorkspaceHistoryBackfill } from '../../lib/historyBackfill.mjs';
import { decrypt as decryptShared } from '../../providers/crypto.mjs';
import crypto from 'crypto';

export const crmRouter = Router();
const requireCrmSync = requireFeature('crmSync');

const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY
  ? Buffer.from(process.env.ENCRYPTION_KEY.slice(0, 64).padEnd(64, '0'), 'hex')
  : null;

// Decrypt a stored credential. Delegates to the SHARED crypto so it handles BOTH the CBC
// values older CRM sync-configs stored AND the GCM values the Integrations connect flow
// stores (encryptCredentials in providers/crypto.mjs). The old CBC-only version here
// returned a GCM value AS-IS — a garbage key — which is why an Attio/HubSpot connected via
// the Integrations page synced 0 records (401: "API key wrong length").
function decryptCred(encryptedValue) {
  return decryptShared(encryptedValue);
}

// Resolve a CRM token for (workspace, provider) from its sync-config connection.
export async function resolveCrmTokenForProvider(supabase, workspaceId, provider) {
  const { data: cfg } = await supabase.from('crm_sync_configs')
    .select('connection_id').eq('workspace_id', workspaceId).eq('provider', provider).maybeSingle();
  if (!cfg?.connection_id) return null;
  const { data: conn } = await supabase.from('workflow_provider_connections')
    .select('encrypted_credentials').eq('id', cfg.connection_id).maybeSingle();
  if (!conn?.encrypted_credentials) return null;
  const creds = {};
  for (const [k, v] of Object.entries(conn.encrypted_credentials)) creds[k] = decryptCred(v);
  const firstCred = Object.values(creds).find(Boolean);
  if (provider === 'hubspot')   return creds.access_token || creds.api_key || firstCred || null;
  if (provider === 'pipedrive') return creds.api_token   || creds.api_key || firstCred || null;
  return creds.api_key || creds.access_token || firstCred || null;  // attio + default
}

async function fetchHubSpotRecords(accessToken, type, search) {
  const obj = type === 'contact' ? 'contacts' : type === 'company' ? 'companies' : 'deals';
  const propsMap = {
    contacts: 'firstname,lastname,email,company,phone,hubspot_owner_id',
    companies: 'name,domain,industry,city,country,phone',
    deals: 'dealname,amount,dealstage,closedate,pipeline,hubspot_owner_id',
  };
  const params = new URLSearchParams({ limit: '100', properties: propsMap[obj] });
  if (search) params.set('query', search);
  const endpoint = search
    ? `https://api.hubapi.com/crm/v3/objects/${obj}/search`
    : `https://api.hubapi.com/crm/v3/objects/${obj}?${params}`;

  const res = search
    ? await fetch(endpoint, { method: 'POST', headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ query: search, limit: 100, properties: propsMap[obj].split(',') }) })
    : await fetch(endpoint, { headers: { Authorization: `Bearer ${accessToken}` } });

  if (!res.ok) throw new Error(`HubSpot ${res.status}`);
  const d = await res.json();
  return (d.results || []).map(r => {
    const p = r.properties || {};
    if (type === 'contact') return { id: r.id, name: [p.firstname, p.lastname].filter(Boolean).join(' ') || '(No name)', email: p.email, company: p.company, ownerName: p.hubspot_owner_id || null };
    if (type === 'company') return { id: r.id, name: p.name || '(No name)', domain: p.domain, industry: p.industry, city: p.city, country: p.country };
    return { id: r.id, name: p.dealname || '(No name)', dealValue: p.amount ? parseFloat(p.amount) : null, dealCurrency: '$', dealStage: p.dealstage, ownerName: p.hubspot_owner_id || null };
  });
}

async function fetchPipedriveRecords(apiToken, type, search) {
  const endpoint = type === 'contact' ? 'persons' : type === 'company' ? 'organizations' : 'deals';
  const params = new URLSearchParams({ api_token: apiToken, limit: '100', ...(search ? { term: search } : {}) });
  const base = search
    ? `https://api.pipedrive.com/v1/${endpoint}/search?${params}`
    : `https://api.pipedrive.com/v1/${endpoint}?${params}`;
  const res = await fetch(base);
  if (!res.ok) throw new Error(`Pipedrive ${res.status}`);
  const d = await res.json();
  const items = search ? (d.data?.items || []).map(i => i.item) : (d.data || []);
  return items.map(r => {
    if (type === 'contact') return { id: String(r.id), name: r.name || '(No name)', email: r.email?.[0]?.value || r.primary_email || null, company: r.org_name || r.organization?.name || null, ownerName: r.owner_name || null };
    if (type === 'company') return { id: String(r.id), name: r.name || '(No name)', domain: r.cc_email || null, industry: null, city: r.address_city || null, country: r.address_country || null };
    return { id: String(r.id), name: r.title || '(No name)', dealValue: r.value || null, dealCurrency: r.currency || '$', dealStage: r.stage_name || r.stage?.name || null, ownerName: r.owner_name || null };
  });
}

// Salesforce uses SOQL against the org-specific `instance_url` returned at OAuth time.
async function fetchSalesforceRecords(creds, type, search) {
  const accessToken = creds.access_token;
  const instanceUrl = creds.instance_url;
  if (!accessToken || !instanceUrl) throw new Error('Salesforce credentials missing access_token or instance_url');

  const base = instanceUrl.replace(/\/$/, '');
  const apiVersion = 'v59.0';

  // Light SOQL-injection guard: escape single quotes
  const esc = (s) => String(s || '').replace(/'/g, "\\'");

  const queries = {
    contact: search
      ? `SELECT Id, FirstName, LastName, Email, Phone, Account.Name, Owner.Name FROM Contact WHERE Name LIKE '%${esc(search)}%' OR Email LIKE '%${esc(search)}%' LIMIT 100`
      : `SELECT Id, FirstName, LastName, Email, Phone, Account.Name, Owner.Name FROM Contact ORDER BY LastModifiedDate DESC LIMIT 100`,
    company: search
      ? `SELECT Id, Name, Website, Industry, BillingCity, BillingCountry, Phone FROM Account WHERE Name LIKE '%${esc(search)}%' LIMIT 100`
      : `SELECT Id, Name, Website, Industry, BillingCity, BillingCountry, Phone FROM Account ORDER BY LastModifiedDate DESC LIMIT 100`,
    deal: search
      ? `SELECT Id, Name, Amount, StageName, CloseDate, Owner.Name FROM Opportunity WHERE Name LIKE '%${esc(search)}%' LIMIT 100`
      : `SELECT Id, Name, Amount, StageName, CloseDate, Owner.Name FROM Opportunity ORDER BY LastModifiedDate DESC LIMIT 100`,
  };
  const soql = queries[type];
  if (!soql) throw new Error(`Unsupported Salesforce record type: ${type}`);

  const url = `${base}/services/data/${apiVersion}/query?q=${encodeURIComponent(soql)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) {
    // Surface token expiry distinctly so callers can refresh
    if (res.status === 401) throw new Error('Salesforce 401 — token expired or revoked');
    throw new Error(`Salesforce ${res.status}`);
  }
  const d = await res.json();
  return (d.records || []).map(r => {
    if (type === 'contact') return {
      id: r.Id,
      name: [r.FirstName, r.LastName].filter(Boolean).join(' ') || '(No name)',
      email: r.Email || null,
      company: r.Account?.Name || null,
      ownerName: r.Owner?.Name || null,
    };
    if (type === 'company') return {
      id: r.Id,
      name: r.Name || '(No name)',
      domain: r.Website || null,
      industry: r.Industry || null,
      city: r.BillingCity || null,
      country: r.BillingCountry || null,
    };
    return {
      id: r.Id,
      name: r.Name || '(No name)',
      dealValue: r.Amount != null ? Number(r.Amount) : null,
      dealCurrency: '$',
      dealStage: r.StageName || null,
      ownerName: r.Owner?.Name || null,
    };
  });
}

async function fetchAttioRecords(apiKey, type, search) {
  const obj = type === 'contact' ? 'people' : type === 'company' ? 'companies' : 'deals';
  const body = { limit: 100, ...(search ? { filter: { any: [{ name: { $contains: search } }] } } : {}) };
  const res = await fetch(`https://api.attio.com/v2/objects/${obj}/records/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Attio ${res.status}`);
  const d = await res.json();
  return (d.data || []).map(r => {
    const v = (field) => r.values?.[field]?.[0]?.value ?? r.values?.[field]?.[0]?.target?.record?.record_id ?? null;
    const str = (field) => { const val = r.values?.[field]?.[0]; return val?.value || val?.first_name || null; };
    if (type === 'contact') {
      const first = r.values?.name?.[0]?.first_name || '';
      const last = r.values?.name?.[0]?.last_name || '';
      return { id: r.id?.record_id || r.id, name: [first, last].filter(Boolean).join(' ') || '(No name)', email: r.values?.email_addresses?.[0]?.email_address || null, company: r.values?.primary_affiliation?.[0]?.target?.record?.record_id || null, ownerName: null };
    }
    if (type === 'company') return { id: r.id?.record_id || r.id, name: r.values?.name?.[0]?.value || '(No name)', domain: r.values?.domains?.[0]?.domain || null, industry: r.values?.categories?.[0]?.value || null, city: null, country: null };
    return { id: r.id?.record_id || r.id, name: r.values?.name?.[0]?.value || '(No name)', dealValue: r.values?.value?.[0]?.value?.amount || null, dealCurrency: r.values?.value?.[0]?.value?.currency_code || '$', dealStage: r.values?.stage?.[0]?.value || null, ownerName: null };
  });
}

// ── Import helpers ────────────────────────────────────────────────────────────

async function fetchDealContactEmails(provider, creds, dealId) {
  const token = creds.access_token || creds.api_key || creds.api_token || Object.values(creds).find(Boolean);
  if (!token) return [];

  if (provider === 'hubspot') {
    const assocRes = await fetch(
      `https://api.hubapi.com/crm/v3/objects/deals/${dealId}/associations/contacts`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!assocRes.ok) return [];
    const assocData = await assocRes.json();
    const contactIds = (assocData.results || []).map(r => r.id).slice(0, 5);
    const emails = [];
    for (const cid of contactIds) {
      const r = await fetch(
        `https://api.hubapi.com/crm/v3/objects/contacts/${cid}?properties=email,firstname,lastname`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (!r.ok) continue;
      const c = await r.json();
      const p = c.properties || {};
      if (p.email) emails.push({ email: p.email, name: [p.firstname, p.lastname].filter(Boolean).join(' ') });
    }
    return emails;
  }

  if (provider === 'pipedrive') {
    const r = await fetch(`https://api.pipedrive.com/v1/deals/${dealId}/persons?api_token=${token}`);
    if (!r.ok) return [];
    const d = await r.json();
    return (d.data || []).flatMap(p => {
      const email = p.email?.find(e => e.primary)?.value || p.email?.[0]?.value;
      return email ? [{ email, name: p.name || '' }] : [];
    });
  }

  if (provider === 'salesforce') {
    const access = creds.access_token;
    const inst = creds.instance_url;
    if (!access || !inst) return [];
    const soql = `SELECT Contact.Id, Contact.FirstName, Contact.LastName, Contact.Email FROM OpportunityContactRole WHERE OpportunityId = '${String(dealId).replace(/'/g, "\\'")}' LIMIT 25`;
    const r = await fetch(`${inst.replace(/\/$/, '')}/services/data/v59.0/query?q=${encodeURIComponent(soql)}`, {
      headers: { Authorization: `Bearer ${access}` },
    });
    if (!r.ok) return [];
    const d = await r.json();
    return (d.records || []).flatMap(row => {
      const c = row.Contact || {};
      return c.Email ? [{ email: c.Email, name: [c.FirstName, c.LastName].filter(Boolean).join(' ') }] : [];
    });
  }

  return [];
}

async function upsertContactForImport(supabase, workspaceId, provider, { email, name, company }) {
  if (!email) return null;
  const normalizedEmail = email.toLowerCase().trim();
  const nameParts = (name || '').trim().split(/\s+/);
  const firstName = nameParts[0] || null;
  const lastName = nameParts.slice(1).join(' ') || null;

  const { data: existing } = await supabase
    .from('contacts')
    .select('id, company_id')
    .eq('workspace_id', workspaceId)
    .eq('email', normalizedEmail)
    .maybeSingle();

  if (existing) return existing;

  const { data: created, error } = await supabase
    .from('contacts')
    .insert({
      workspace_id: workspaceId,
      email: normalizedEmail,
      first_name: firstName,
      last_name: lastName,
      company: company || null,
      source: provider,
      pipeline_stage: 'identified',
    })
    .select('id, company_id')
    .single();

  if (error) throw error;
  return created;
}

// GET /api/crm/sync-config
crmRouter.get('/sync-config', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { workspaceId, provider } = req.query;
    if (!workspaceId || !provider) return res.status(400).json({ error: 'workspaceId and provider required' });
    const { data } = await supabase.from('crm_sync_configs').select('*').eq('workspace_id', workspaceId).eq('provider', provider).maybeSingle();
    return res.json({ config: data || null });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/crm/sync-config
crmRouter.post('/sync-config', verifySupabaseAuth, requireCrmSync, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { workspaceId, connectionId, provider, autoSync, pushActivities,
            createInCrm, createTrigger, createRequireIcpFit, createIcpThreshold,
            hygieneEnabled, hygieneCadence } = req.body;
    if (!workspaceId || !connectionId || !provider) return res.status(400).json({ error: 'missing fields' });

    const CREATE_TRIGGERS = ['any_reply_or_meeting', 'positive_reply_or_meeting', 'meeting_only', 'interested_stage'];
    const HYGIENE_CADENCES = ['weekly', 'monthly'];

    // Fetch existing so we only overwrite fields that were actually sent
    const { data: existing } = await supabase.from('crm_sync_configs')
      .select('auto_sync, push_activities, create_in_crm, create_trigger, create_require_icp_fit, create_icp_threshold, hygiene_enabled, hygiene_cadence')
      .eq('workspace_id', workspaceId).eq('provider', provider).maybeSingle();

    const payload = {
      workspace_id:    workspaceId,
      connection_id:   connectionId,
      provider,
      auto_sync:       typeof autoSync       === 'boolean' ? autoSync       : (existing?.auto_sync       ?? false),
      push_activities: typeof pushActivities === 'boolean' ? pushActivities : (existing?.push_activities ?? true),
      // Create policy — only overwrite fields that were actually sent.
      create_in_crm:          typeof createInCrm          === 'boolean' ? createInCrm          : (existing?.create_in_crm          ?? true),
      create_trigger:         CREATE_TRIGGERS.includes(createTrigger)   ? createTrigger        : (existing?.create_trigger         ?? 'positive_reply_or_meeting'),
      create_require_icp_fit: typeof createRequireIcpFit  === 'boolean' ? createRequireIcpFit  : (existing?.create_require_icp_fit ?? true),
      create_icp_threshold:   Number.isFinite(createIcpThreshold)       ? Math.max(0, Math.min(100, Math.round(createIcpThreshold))) : (existing?.create_icp_threshold ?? 70),
      hygiene_enabled: typeof hygieneEnabled === 'boolean' ? hygieneEnabled : (existing?.hygiene_enabled ?? true),
      hygiene_cadence: HYGIENE_CADENCES.includes(hygieneCadence) ? hygieneCadence : (existing?.hygiene_cadence ?? 'weekly'),
      updated_at:      new Date().toISOString(),
    };

    const { data, error } = await supabase.from('crm_sync_configs').upsert(payload, {
      onConflict: 'workspace_id,provider',
    }).select().single();
    if (error) throw error;
    return res.json({ ok: true, config: data });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/crm/onboarding-sync  { workspaceId, provider }
//
// The wizard calls this right after a CRM connects. It sets up the sync config (so the
// onboarding gate's data-source check flips immediately) and kicks off the first pull —
// contacts, companies and deals — in the BACKGROUND, so connect returns instantly and the
// records stream in while the user keeps going. When records land it enqueues the history
// backfill (→ the revenue report). Only the v2-sync providers; Salesforce isn't supported
// on this path yet.
crmRouter.post('/onboarding-sync', verifySupabaseAuth, requireCrmSync, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { workspaceId, provider } = req.body;
    if (!workspaceId || !provider) return res.status(400).json({ error: 'workspaceId and provider required' });
    if (!['hubspot', 'pipedrive', 'attio'].includes(provider)) {
      return res.status(400).json({ error: 'unsupported_provider', message: `${provider} auto-sync isn't supported yet.` });
    }

    // Find the connection the user just made for this provider.
    const { data: prov } = await supabase.from('workflow_providers').select('id').eq('name', provider).maybeSingle();
    if (!prov?.id) return res.status(404).json({ error: 'unknown_provider' });
    const { data: conn } = await supabase.from('workflow_provider_connections')
      .select('id, encrypted_credentials')
      .eq('workspace_id', workspaceId).eq('provider_id', prov.id)
      .order('created_at', { ascending: false }).limit(1).maybeSingle();
    if (!conn?.id) return res.status(404).json({ error: 'not_connected' });

    // Ensure a sync config exists (this is what the onboarding data-source check reads, so
    // it flips true the instant the CRM is connected — before the first pull finishes).
    await supabase.from('crm_sync_configs').upsert({
      workspace_id: workspaceId, connection_id: conn.id, provider,
      auto_sync: true, updated_at: new Date().toISOString(),
    }, { onConflict: 'workspace_id,provider' }).then(() => {}, () => {});

    // Decrypt the token (same resolution as sync-now).
    const creds = {};
    for (const [k, v] of Object.entries(conn.encrypted_credentials || {})) creds[k] = decryptCred(v);
    const firstCred = Object.values(creds).find(Boolean);
    let token;
    if (provider === 'hubspot')        token = creds.access_token || creds.api_key || firstCred;
    else if (provider === 'pipedrive') token = creds.api_token || creds.api_key || firstCred;
    else if (provider === 'attio')     token = creds.api_key || creds.access_token || firstCred;
    if (!token) return res.status(400).json({ error: 'missing_credentials' });

    // Fire-and-forget: pull contacts + companies + deals, then enqueue the backfill. The
    // API is a long-running process, so this keeps running after the response is sent.
    (async () => {
      const startedAt = new Date().toISOString();
      try {
        // Stages first, so the board already speaks their language when the records land.
        await adoptStagesAfterSync(supabase, workspaceId, provider, token, 'onboarding');
        const result = await syncCrmProvider(supabase, workspaceId, provider, token, null);
        // Same rule as sync-now: a run that hit the page cap resumes from the newest record
        // it saw, never from "now" — otherwise the rest of the portal is skipped forever.
        const cursorAt = !result.truncated?.length ? startedAt : (result.resumeFrom ?? null);
        await supabase.from('crm_sync_configs').update({
          ...(cursorAt ? { last_synced_at: cursorAt } : {}),
          contacts_synced: result.contacts.inserted + result.companies.inserted,
        }).eq('workspace_id', workspaceId).eq('provider', provider).then(() => {}, () => {});
        // Which pipeline is "the pipeline" here, in its own write: the column arrives by a
        // hand-applied migration, and naming an unknown one would reject the cursor update above.
        await writePrimaryPipelineRef(supabase, workspaceId, provider, result.primaryPipelineRef);
        // The CRM agent's cutover: the moment the first COMPLETE pull finished. Everything
        // the CRM held before this is taken on trust; only activity after it is asked about.
        // Stamped once (never moved by a later sync) and only on a clean, untruncated run.
        if (!result.errors.length && !result.truncated?.length) {
          await supabase.from('crm_sync_configs').update({ baseline_completed_at: new Date().toISOString() })
            .eq('workspace_id', workspaceId).eq('provider', provider).is('baseline_completed_at', null)
            .then(() => {}, () => {});   // column absent until the crm_agent migration is applied
        }

        const totalNew = result.contacts.inserted + result.companies.inserted + result.deals.inserted;
        await supabase.from('workspace_system_log').insert({
          workspace_id: workspaceId, source: provider,
          event_type: result.errors.length ? 'sync_partial' : 'sync_complete',
          summary: `Onboarding pull from ${provider}: ${totalNew} new (c:${result.contacts.fetched} co:${result.companies.fetched} d:${result.deals.fetched})`,
          metadata: { trigger: 'onboarding', ...result },
        }).then(() => {}, () => {});

        trainFromSyncedDeals(supabase, workspaceId, result, 'onboarding').catch(() => {});
        if (totalNew > 0) {
          await enqueueWorkspaceHistoryBackfill(supabase, workspaceId, { reason: 'crm_onboarding_sync' });
        }
      } catch (e) {
        console.error('[crm/onboarding-sync bg]', provider, e.message);
        await supabase.from('workspace_system_log').insert({
          workspace_id: workspaceId, source: provider, event_type: 'sync_failed',
          summary: `${provider} onboarding sync failed — ${e.message}`,
          metadata: { trigger: 'onboarding', error: e.message },
        }).then(() => {}, () => {});
      }
    })();

    return res.json({ ok: true, syncing: true });
  } catch (err) {
    console.error('[POST /api/crm/onboarding-sync]', err);
    return res.status(500).json({ error: 'internal_error', message: err.message });
  }
});

// ── CRM hygiene (propose-only) ───────────────────────────────────────────────

// POST /api/crm/hygiene/run — run hygiene now for one CRM, on demand. Same
// orchestrator the worker's daily tick uses; bypasses the cadence check.
crmRouter.post('/hygiene/run', verifySupabaseAuth, requireCrmSync, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { workspaceId, provider } = req.body;
    if (!workspaceId || !provider) return res.status(400).json({ error: 'workspaceId and provider required' });

    const { data: cfg } = await supabase.from('crm_sync_configs')
      .select('id, workspace_id, provider, connection_id, hygiene_cadence, hygiene_last_run_at')
      .eq('workspace_id', workspaceId).eq('provider', provider).maybeSingle();
    if (!cfg) return res.status(404).json({ error: 'no sync config for this provider' });

    // Resolve a read-only CRM token so the reconcile pass can read current field
    // values. Best-effort — without it, net-new + ICP still run.
    let crmToken = null;
    if (cfg.connection_id) {
      const { data: conn } = await supabase.from('workflow_provider_connections')
        .select('encrypted_credentials').eq('id', cfg.connection_id).maybeSingle();
      if (conn?.encrypted_credentials) {
        const creds = {};
        for (const [k, v] of Object.entries(conn.encrypted_credentials)) creds[k] = decryptCred(v);
        const firstCred = Object.values(creds).find(Boolean);
        crmToken = provider === 'hubspot' ? (creds.access_token || creds.api_key || firstCred)
          : provider === 'pipedrive' ? (creds.api_token || creds.api_key || firstCred)
          : (creds.api_key || creds.access_token || firstCred);
      }
    }

    const result = await runHygieneForConfig(supabase, cfg, { enrich: enrichContact, crmToken });
    return res.json({ ok: true, ...result });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/crm/hygiene/proposals — the hygiene report.
crmRouter.get('/hygiene/proposals', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { workspaceId, status, provider, limit } = req.query;
    if (!workspaceId) return res.status(400).json({ error: 'workspaceId required' });
    const proposals = await listHygieneProposals(supabase, workspaceId, {
      status: status || undefined,
      provider: provider || undefined,
      limit: limit ? Math.min(Number(limit), 200) : 100,
    });

    // Attach the contact each proposal targets so the report identifies the record.
    const entityIds = [...new Set(proposals.map(p => p.entity_id).filter(Boolean))];
    const contactById = {};
    if (entityIds.length) {
      const { data: contacts } = await supabase.from('contacts')
        .select('id, first_name, last_name, email, company')
        .in('id', entityIds);
      for (const c of contacts || []) {
        contactById[c.id] = {
          name: [c.first_name, c.last_name].filter(Boolean).join(' ') || null,
          email: c.email || null,
          company: c.company || null,
        };
      }
    }
    const enriched = proposals.map(p => ({ ...p, contact: p.entity_id ? contactById[p.entity_id] ?? null : null }));

    const openCount = await countHygieneProposals(supabase, workspaceId, 'proposed');
    return res.json({ proposals: enriched, openCount });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/crm/hygiene/proposals/:id — approve or dismiss a proposal. v1 records
// the decision only; applying approved proposals to the CRM is Phase 2.
crmRouter.post('/hygiene/proposals/:id', verifySupabaseAuth, requireCrmSync, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { workspaceId, status } = req.body;
    if (!workspaceId) return res.status(400).json({ error: 'workspaceId required' });
    if (!['approved', 'dismissed'].includes(status)) return res.status(400).json({ error: 'status must be approved or dismissed' });
    const row = await updateHygieneProposalStatus(supabase, workspaceId, req.params.id, status);
    if (!row) return res.status(404).json({ error: 'proposal not found' });

    const logEvent = (eventType, summary) => supabase.from('workspace_system_log').insert({
      workspace_id: workspaceId, source: row.provider, event_type: eventType, summary,
      contact_id: row.entity_id || null, metadata: { proposal_id: row.id, kind: row.kind, field: row.field },
    }).then(() => {}, () => {});

    const what = row.field
      ? `${row.field} → ${typeof row.proposed_value === 'object' ? JSON.stringify(row.proposed_value) : row.proposed_value}`
      : row.kind;

    // Dismiss, or approve a kind we don't write yet → record the decision only.
    if (status === 'dismissed') { await logEvent('proposal_dismissed', `Dismissed ${row.kind} — ${what}`); return res.json({ ok: true, proposal: row }); }
    if (!isApplyable(row.kind)) { await logEvent('proposal_approved', `Approved ${row.kind} — ${what} (write-back pending)`); return res.json({ ok: true, proposal: row }); }

    // Approve an applyable proposal → write it to the CRM (Phase 2).
    const token = await resolveCrmTokenForProvider(supabase, workspaceId, row.provider);
    const result = await applyProposal(supabase, row, token);
    const final = await updateHygieneProposalStatus(supabase, workspaceId, req.params.id, result.status);
    if (result.applied) {
      await logEvent('proposal_applied', `Applied ${row.kind} to ${row.provider} — ${what}`);
    } else {
      await logEvent('proposal_apply_failed', `Apply failed for ${row.kind} — ${result.reason}`);
    }
    return res.json({ ok: true, proposal: final || row, applied: result.applied, reason: result.reason });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/crm/import/retry — run the connect-time import again after it failed or was
// interrupted (GET-853). Owners and admins; returns at once, and the Backfill card follows the
// import through the onboarding checklist.
crmRouter.post('/import/retry', verifySupabaseAuth, requireCrmSync, async (req, res) => {
  try {
    if (!(req.workspaceRole === 'owner' || req.workspaceRole === 'admin')) return res.status(403).json({ error: 'admin_required' });
    const workspaceId = req.workspaceId ?? req.body?.workspaceId;
    if (!workspaceId) return res.status(400).json({ error: 'workspaceId_required' });
    const r = await retryCrmImport(getSupabaseClient(), workspaceId);
    if (r.error === 'no_crm') return res.status(404).json({ error: 'no_crm', message: 'No CRM is connected.' });
    if (r.error === 'already_running') return res.status(409).json({ error: 'already_running', message: 'The import is already running.' });
    return res.json(r);
  } catch (err) {
    console.error('[POST /api/crm/import/retry]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// POST /api/crm/sync-now — manual incremental pull. Same code path the worker
// cron uses (syncCrmProvider) so manual and auto-sync stay in sync.
crmRouter.post('/sync-now', verifySupabaseAuth, requireCrmSync, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { workspaceId, provider = 'hubspot', full = false } = req.body;
    if (!workspaceId) return res.status(400).json({ error: 'workspaceId required' });

    const { data: cfg } = await supabase.from('crm_sync_configs')
      .select('*').eq('workspace_id', workspaceId).eq('provider', provider).maybeSingle();
    if (!cfg) return res.status(404).json({ error: 'Sync not configured' });

    const { data: conn } = await supabase.from('workflow_provider_connections')
      .select('encrypted_credentials').eq('id', cfg.connection_id).single();
    if (!conn) return res.status(404).json({ error: 'Connection not found' });

    const creds = {};
    for (const [k, v] of Object.entries(conn.encrypted_credentials || {})) {
      creds[k] = decryptCred(v);
    }
    const firstCred = Object.values(creds).find(Boolean);

    let token;
    if (provider === 'hubspot')   token = creds.access_token || creds.api_key || firstCred;
    else if (provider === 'pipedrive') token = creds.api_token || creds.api_key || firstCred;
    else if (provider === 'attio')     token = creds.api_key || creds.access_token || firstCred;
    else if (provider === 'salesforce') {
      // Salesforce pull stays on the legacy path until the shared module covers it.
      return res.status(400).json({ error: 'salesforce_not_yet_supported_in_v2_sync' });
    } else {
      return res.status(400).json({ error: `unsupported_provider: ${provider}` });
    }
    if (!token) return res.status(400).json({ error: 'missing_credentials' });

    const startedAt = new Date().toISOString();
    // `full=true` ignores last_synced_at and re-fetches everything (capped by
    // MAX_PAGES_PER_RUN inside the shared helper).
    const since = full ? null : (cfg.last_synced_at || null);

    let result;
    try {
      result = await syncCrmProvider(supabase, workspaceId, provider, token, since);
    } catch (err) {
      return res.status(502).json({ error: 'provider_fetch_failed', message: err.message });
    }

    // Refresh a CRM-sourced stage set (never a hand-edited one) so renamed or added stages
    // follow through. Not awaited: it must not delay or fail the sync response.
    adoptStagesAfterSync(supabase, workspaceId, provider, token, 'manual').catch(() => {});

    // Advance the cursor only on a clean run — otherwise next call retries
    // the same window (no missed records). A run that hit the page cap resumes from the
    // newest record it saw rather than from "now", or holds the cursor if it can't say;
    // see SyncRunResult.truncated in @nous/core.
    const patch = {
      contacts_synced: (cfg.contacts_synced || 0) + result.contacts.inserted + result.companies.inserted,
      updated_at:      new Date().toISOString(),
    };
    if (result.errors.length === 0) {
      if (!result.truncated?.length) patch.last_synced_at = startedAt;
      else if (result.resumeFrom)    patch.last_synced_at = result.resumeFrom;
    }
    await supabase.from('crm_sync_configs').update(patch).eq('id', cfg.id);
    // Separate write, so an un-migrated column can never reject the sync cursor above.
    await writePrimaryPipelineRef(supabase, workspaceId, provider, result.primaryPipelineRef);

    const totalFetched = result.contacts.fetched + result.companies.fetched + result.deals.fetched;
    const totalNew     = result.contacts.inserted + result.companies.inserted + result.deals.inserted;
    const totalUp      = result.contacts.updated  + result.companies.updated  + result.deals.updated;
    const providerLabel = provider.charAt(0).toUpperCase() + provider.slice(1);
    await supabase.from('workspace_system_log').insert({
      workspace_id: workspaceId,
      source: provider,
      event_type: result.errors.length ? 'sync_partial' : 'sync_complete',
      summary:
        `Pulled ${totalFetched} from ${providerLabel} (c:${result.contacts.fetched} ` +
        `co:${result.companies.fetched} d:${result.deals.fetched}) — ` +
        `${totalNew} new, ${totalUp} updated` +
        ((result.deals?.history || result.contacts?.history)
          ? ` · history: ${result.deals.history} deal + ${result.contacts.history} contact change(s)` : '') +
        (Object.keys(result.engagements ?? {}).length
          ? ` · engagements: ${Object.entries(result.engagements).map(([k, v]) => `${k} ${v.logged}/${v.fetched}`).join(', ')}` : '') +
        (result.warnings?.length ? ` · warnings: ${result.warnings.length}` : '') +
        (result.errors.length ? ` · errors: ${result.errors.length}` : ''),
      metadata: { trigger: 'manual', ...result },
    }).then(() => {}, () => {});

    // Parity with CSV import: once new records land from the CRM, enrich their history from
    // every connected source — which, on completion, generates the revenue report. Without
    // this, CRM-sourced accounts never got the backfill + report that CSV imports did.
    // Fire-and-forget + debounced, so it never blocks or duplicates the sync.
    trainFromSyncedDeals(supabase, workspaceId, result, 'manual').catch(() => {});
    if (totalNew > 0) {
      enqueueWorkspaceHistoryBackfill(supabase, workspaceId, { reason: 'crm_sync' })
        .catch(() => {});
    }

    return res.json({ ok: true, ...result });
  } catch (err) {
    console.error('[POST /api/crm/sync-now]', err);
    try {
      const supabase2 = getSupabaseClient();
      const provider2 = req.body?.provider || 'unknown';
      await supabase2.from('workspace_system_log').insert({
        workspace_id: req.body?.workspaceId,
        source: provider2,
        event_type: 'sync_failed',
        summary: `${provider2} sync failed — ${err.message}`,
        metadata: { error: err.message, trigger: 'manual' },
      });
    } catch {}
    return res.status(500).json({ error: 'internal_error', message: err.message });
  }
});

// GET /api/crm/records
crmRouter.get('/records', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { provider, type, connectionId, workspaceId, search } = req.query;
    if (!provider || !type || !connectionId || !workspaceId) return res.status(400).json({ error: 'provider, type, connectionId, workspaceId required' });

    const { data: connection } = await supabase.from('workflow_provider_connections').select('encrypted_credentials').eq('id', connectionId).eq('workspace_id', workspaceId).single();
    if (!connection) return res.status(404).json({ error: 'connection_not_found' });

    const creds = {};
    for (const [k, v] of Object.entries(connection.encrypted_credentials || {})) {
      creds[k] = decryptCred(v);
    }

    const firstCred = Object.values(creds).find(Boolean);

    let records = [];
    if (provider === 'hubspot') {
      const token = creds.access_token || creds.api_key || firstCred;
      if (!token) return res.status(400).json({ error: 'missing_credentials' });
      records = await fetchHubSpotRecords(token, type, search);
    } else if (provider === 'pipedrive') {
      const token = creds.api_token || creds.api_key || firstCred;
      if (!token) return res.status(400).json({ error: 'missing_credentials' });
      records = await fetchPipedriveRecords(token, type, search);
    } else if (provider === 'attio') {
      const token = creds.api_key || creds.access_token || firstCred;
      if (!token) return res.status(400).json({ error: 'missing_credentials' });
      records = await fetchAttioRecords(token, type, search);
    } else if (provider === 'salesforce') {
      if (!creds.access_token || !creds.instance_url) return res.status(400).json({ error: 'missing_credentials' });
      records = await fetchSalesforceRecords(creds, type, search);
    }

    return res.json({ records });
  } catch (err) {
    return res.status(500).json({ error: 'internal_error' });
  }
});

// POST /api/crm/import — import selected records into Nous contacts + log deal signals
crmRouter.post('/import', verifySupabaseAuth, requireCrmSync, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { workspaceId, provider, connectionId, records } = req.body;
    if (!workspaceId || !provider || !connectionId || !Array.isArray(records) || records.length === 0) {
      return res.status(400).json({ error: 'workspaceId, provider, connectionId, and records required' });
    }

    const { data: connection } = await supabase
      .from('workflow_provider_connections')
      .select('encrypted_credentials')
      .eq('id', connectionId)
      .eq('workspace_id', workspaceId)
      .single();
    if (!connection) return res.status(404).json({ error: 'connection_not_found' });

    const creds = {};
    for (const [k, v] of Object.entries(connection.encrypted_credentials || {})) {
      creds[k] = decryptCred(v);
    }

    let imported = 0;
    let skipped = 0;
    const errors = [];

    for (const record of records) {
      try {
        if (record.type === 'contact') {
          const contact = await upsertContactForImport(supabase, workspaceId, provider, {
            email: record.email,
            name: record.name,
            company: record.company,
          });
          if (contact) imported++; else skipped++;

        } else if (record.type === 'company') {
          if (!record.name?.trim()) { skipped++; continue; }
          const { data: existing } = await supabase.from('companies').select('id').eq('workspace_id', workspaceId).ilike('name', record.name.trim()).maybeSingle();
          if (!existing) {
            await supabase.from('companies').insert({ workspace_id: workspaceId, name: record.name.trim(), domain: record.domain || null });
          }
          imported++;

        } else if (record.type === 'deal') {
          const contacts = await fetchDealContactEmails(provider, creds, record.id);
          if (contacts.length === 0) { skipped++; continue; }
          const isWon = /won|closed[\s-]?won/i.test(record.dealStage || '');
          for (const { email, name } of contacts) {
            const contact = await upsertContactForImport(supabase, workspaceId, provider, { email, name });
            if (!contact) continue;
            await logActivity(supabase, {
              workspaceId,
              contactId: contact.id,
              companyId: contact.company_id || null,
              type: isWon ? 'deal_won' : 'deal_created',
              source: provider,
              externalId: `${provider}_deal_${record.id}`,
              occurredAt: new Date().toISOString(),
              description: record.name || 'CRM deal',
              rawData: { deal_name: record.name, deal_value: record.dealValue, deal_stage: record.dealStage },
            });
          }
          imported++;
        }
      } catch (err) {
        errors.push({ id: record.id, error: err.message });
      }
    }

    return res.json({ imported, skipped, errors });
  } catch (err) {
    console.error('[POST /api/crm/import]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});
