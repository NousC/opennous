// CRM auto-sync — every workspace that has flipped `auto_sync` on for a
// CRM gets an incremental pull every 15 minutes. Pulls contacts + companies
// + deals via the shared syncCrmProvider helper (in @nous/core), upserts
// into the v2 substrate via the views' INSTEAD OF triggers (entities +
// identifiers + observations + claims).
//
// Quiet by design: each provider's last_synced_at moves forward only on a
// clean run; errors are logged to workspace_system_log so the UI can show
// them, never thrown.

import { getSupabaseClient, syncCrmProvider, logWorkerRun, writePrimaryPipelineRef, ensureHubspotPortal } from '@nous/core';
import { decrypt } from '../utils/encryption.mjs';

const PROVIDERS = ['hubspot', 'pipedrive', 'attio'];

function tokenForProvider(provider, creds) {
  // Each CRM stores its access key under different field names.
  const firstNonEmpty = Object.values(creds).find(v => typeof v === 'string' && v.length > 0);
  if (provider === 'hubspot')   return creds.access_token || creds.api_key || firstNonEmpty || null;
  if (provider === 'pipedrive') return creds.api_token   || creds.api_key || firstNonEmpty || null;
  if (provider === 'attio')     return creds.api_key     || creds.access_token || firstNonEmpty || null;
  return firstNonEmpty || null;
}

function decryptAll(encryptedCreds) {
  const out = {};
  for (const [k, v] of Object.entries(encryptedCreds || {})) {
    if (typeof v !== 'string') continue;
    try { out[k] = decrypt(v); } catch { out[k] = v; }
  }
  return out;
}

async function logSysEvent(supabase, workspaceId, source, eventType, summary, metadata) {
  try {
    await supabase.from('workspace_system_log').insert({
      workspace_id: workspaceId,
      source,
      event_type: eventType,
      summary,
      metadata: metadata || {},
      occurred_at: new Date().toISOString(),
    });
  } catch { /* non-critical */ }
}

async function syncOneConfig(supabase, cfg) {
  const provider = cfg.provider;
  if (!PROVIDERS.includes(provider)) return;

  // Resolve credentials from the connection row
  const { data: conn } = await supabase
    .from('workflow_provider_connections')
    .select('encrypted_credentials')
    .eq('id', cfg.connection_id)
    .maybeSingle();
  if (!conn?.encrypted_credentials) {
    await logSysEvent(supabase, cfg.workspace_id, provider, 'sync_failed',
      `${provider}: no credentials on connection`, { trigger: 'auto' });
    return;
  }
  const creds = decryptAll(conn.encrypted_credentials);
  const token = tokenForProvider(provider, creds);
  if (!token) {
    await logSysEvent(supabase, cfg.workspace_id, provider, 'sync_failed',
      `${provider}: credential field missing`, { trigger: 'auto' });
    return;
  }

  // "Open in HubSpot" needs the portal id and its UI domain; learn them once per connection.
  // Best-effort and read-only against HubSpot: it never delays or fails the sync.
  if (provider === 'hubspot') await ensureHubspotPortal(supabase, cfg.id, token).catch(() => null);

  const startedAt = new Date().toISOString();
  let result;
  try {
    result = await syncCrmProvider(
      supabase,
      cfg.workspace_id,
      provider,
      token,
      cfg.last_synced_at,   // null on the first run → full backfill (capped by MAX_PAGES)
    );
  } catch (err) {
    await logSysEvent(supabase, cfg.workspace_id, provider, 'sync_failed',
      `${provider}: ${err?.message || err}`,
      { trigger: 'auto', error: String(err?.message || err) });
    return;
  }

  const totalNew = result.contacts.inserted + result.companies.inserted + result.deals.inserted;
  const totalUp  = result.contacts.updated  + result.companies.updated  + result.deals.updated;
  const totalFetched = result.contacts.fetched + result.companies.fetched + result.deals.fetched;

  // Advance the sync cursor only on a clean run; if any sub-fetch errored,
  // we'll retry next tick with the same `since` so nothing is missed.
  //
  // A run that hit the page cap is not clean either: advancing to startedAt would skip
  // every record past the cap forever (next tick only asks for records modified after
  // now). Resume from the newest record actually seen, or hold the cursor if the provider
  // can't tell us where that is.
  const patch = {
    contacts_synced: (cfg.contacts_synced || 0) + result.contacts.inserted + result.companies.inserted,
    updated_at:      new Date().toISOString(),
  };
  const truncated = result.truncated?.length > 0;
  if (result.errors.length === 0) {
    if (!truncated)             patch.last_synced_at = startedAt;
    else if (result.resumeFrom) patch.last_synced_at = result.resumeFrom;
  }

  const { error: patchErr } = await supabase.from('crm_sync_configs').update(patch).eq('id', cfg.id);
  if (patchErr) {
    // A silently failed patch means the cursor never advances and every tick re-pulls the same
    // window while still logging success. Surface it rather than dropping it.
    await logSysEvent(supabase, cfg.workspace_id, provider, 'sync_partial',
      `${provider}: sync config not updated — ${patchErr.message}`, { trigger: 'auto', error: patchErr.message });
  }

  // The primary pipeline goes in its OWN write, after the cursor has landed: the column comes
  // from a hand-applied migration, and PostgREST rejects a whole body that names a column it
  // does not know. Losing the ref costs one unscoped funnel; losing the cursor stalls the sync.
  await writePrimaryPipelineRef(supabase, cfg.workspace_id, provider, result.primaryPipelineRef);

  // Deals that resolved to no account are reported explicitly. An unlinked deal still
  // syncs, but its amount is unreachable from the account, so it contributes nothing to the
  // forecast — a silent zero is exactly the failure worth surfacing here. A run where every
  // deal is unlinked means the provider's association lookup is not working.
  const unlinked = result.deals?.unlinked ?? 0;
  const summary =
    `${provider} sync — fetched ${totalFetched} (c:${result.contacts.fetched} co:${result.companies.fetched} d:${result.deals.fetched}), ` +
    `${totalNew} new, ${totalUp} updated` +
    ((result.deals?.history || result.contacts?.history)
      ? ` · history: ${result.deals.history} deal + ${result.contacts.history} contact change(s)` : '') +
    (unlinked ? ` · ${unlinked} deal(s) not linked to an account` : '') +
    (Object.keys(result.engagements ?? {}).length
      ? ` · engagements: ${Object.entries(result.engagements).map(([k, v]) => `${k} ${v.logged}/${v.fetched}`).join(', ')}` : '') +
    (truncated ? ` · hit page cap on ${result.truncated.join(', ')}, resumes next tick` : '') +
    (result.warnings?.length ? ` · warnings: ${result.warnings.length}` : '') +
    (result.errors.length ? ` · errors: ${result.errors.length}` : '');
  await logSysEvent(supabase, cfg.workspace_id, provider,
    result.errors.length ? 'sync_partial' : 'sync_complete',
    summary,
    { trigger: 'auto', ...result });
}

export async function runCrmAutoSync() {
  const supabase = getSupabaseClient();
  try {
    const { data: configs, error } = await supabase
      .from('crm_sync_configs')
      .select('id, workspace_id, provider, connection_id, last_synced_at, contacts_synced, auto_sync')
      .eq('auto_sync', true)
      .in('provider', PROVIDERS);

    // Schema not applied yet — skip silently.
    if (error?.code === '42P01' || error?.code === 'PGRST205') return;
    if (error) throw error;
    if (!configs?.length) return;

    let ran = 0;
    for (const cfg of configs) {
      const cfgStart = new Date();
      try {
        await syncOneConfig(supabase, cfg);
        ran++;
        await logWorkerRun(supabase, {
          worker: 'crm_sync',
          workspaceId: cfg.workspace_id,
          status: 'success',
          summary: `${cfg.provider} auto-sync`,
          details: { provider: cfg.provider, config_id: cfg.id },
          startedAt: cfgStart,
        });
      } catch (err) {
        console.error('[CRM_SYNC] config', cfg.id, 'failed:', err?.message || err);
        await logWorkerRun(supabase, {
          worker: 'crm_sync',
          workspaceId: cfg.workspace_id,
          status: 'error',
          summary: `${cfg.provider} auto-sync failed`,
          details: { provider: cfg.provider, config_id: cfg.id },
          error: err?.message || String(err),
          startedAt: cfgStart,
        });
      }
    }
    if (ran) console.log(`[CRM_SYNC] ran ${ran} auto-sync(s)`);
  } catch (err) {
    console.error('[CRM_SYNC] sweep error:', err?.message || err);
  }
}
