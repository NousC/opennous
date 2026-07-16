// CRM hygiene — daily tick that runs each hygiene-enabled CRM config that's due
// per its cadence. The orchestration lives in @nous/core (runHygieneForConfig);
// this file owns scheduling + selecting due configs, injects the worker's
// enrichment function, and resolves a read-only CRM token for the reconcile
// pass. v1 is PROPOSE-ONLY — nothing is written to a CRM.
// See docs/crm-sync.md and packages/core/src/services/crmHygiene.ts.

import { getSupabaseClient, runHygieneForConfig, hygieneDue } from '@nous/core';
import { enrichContact } from '../utils/enrichContact.mjs';
import { decrypt } from '../utils/encryption.mjs';

const PROVIDERS = ['hubspot', 'pipedrive', 'attio'];

function decryptAll(encryptedCreds) {
  const out = {};
  for (const [k, v] of Object.entries(encryptedCreds || {})) {
    if (typeof v !== 'string') continue;
    try { out[k] = decrypt(v); } catch { out[k] = v; }
  }
  return out;
}

function tokenForProvider(provider, creds) {
  const firstNonEmpty = Object.values(creds).find(v => typeof v === 'string' && v.length > 0);
  if (provider === 'hubspot')   return creds.access_token || creds.api_key || firstNonEmpty || null;
  if (provider === 'pipedrive') return creds.api_token   || creds.api_key || firstNonEmpty || null;
  if (provider === 'attio')     return creds.api_key     || creds.access_token || firstNonEmpty || null;
  return firstNonEmpty || null;
}

async function resolveCrmToken(supabase, connectionId, provider) {
  if (!connectionId) return null;
  try {
    const { data: conn } = await supabase
      .from('workflow_provider_connections')
      .select('encrypted_credentials')
      .eq('id', connectionId)
      .maybeSingle();
    if (!conn?.encrypted_credentials) return null;
    return tokenForProvider(provider, decryptAll(conn.encrypted_credentials));
  } catch {
    return null;  // reconcile just skips without a token
  }
}

export async function runCrmHygieneSweep() {
  const supabase = getSupabaseClient();
  try {
    const { data: configs, error } = await supabase
      .from('crm_sync_configs')
      .select('id, workspace_id, provider, connection_id, hygiene_enabled, hygiene_cadence, hygiene_last_run_at')
      .eq('hygiene_enabled', true)
      .in('provider', PROVIDERS);

    if (error?.code === '42P01' || error?.code === 'PGRST205') return;  // schema not applied yet
    if (error) throw error;
    if (!configs?.length) return;

    const now = Date.now();
    let ran = 0;
    for (const cfg of configs) {
      if (!hygieneDue(cfg, now)) continue;
      const crmToken = await resolveCrmToken(supabase, cfg.connection_id, cfg.provider);
      try {
        await runHygieneForConfig(supabase, cfg, { enrich: enrichContact, crmToken });
        ran++;
      } catch (err) {
        console.error('[CRM_HYGIENE] config', cfg.id, 'failed:', err?.message || err);
      }
    }
    if (ran) console.log(`[CRM_HYGIENE] ran ${ran} hygiene routine(s)`);
  } catch (err) {
    console.error('[CRM_HYGIENE] sweep error:', err?.message || err);
  }
}
