// Apify, for the agent.
//
// The worker has had this for the engagement run (worker/src/utils/apify.mjs);
// the agent needs the same two things — resolve the workspace's key, run an
// actor — and the two apps already keep their own encryption utils, so this
// mirrors that rather than reaching across the app boundary.
//
// BYOK, always. The key comes from the workspace's verified Apify connection in
// Integrations. On self-host we fall back to the APIFY_TOKEN env var, because a
// single-tenant deploy shouldn't have to do the Integrations dance.

import { decrypt } from '../utils/encryption.js';

const APIFY_BASE = 'https://api.apify.com/v2/acts';

/** The workspace's Apify key, or null — which means "not connected", not "broken". */
export async function resolveApifyToken(supabase, workspaceId) {
  try {
    const { data: provider } = await supabase
      .from('workflow_providers').select('id').eq('name', 'apify').maybeSingle();
    if (provider?.id) {
      const { data } = await supabase
        .from('workflow_provider_connections')
        .select('encrypted_credentials')
        .eq('workspace_id', workspaceId).eq('provider_id', provider.id).eq('is_verified', true)
        .order('created_at', { ascending: false }).limit(1).maybeSingle();
      const enc = data?.encrypted_credentials?.api_key;
      if (enc) { const k = decrypt(enc); if (k) return k; }
    }
  } catch { /* fall through */ }

  if (process.env.SELF_HOSTED === 'true') return process.env.APIFY_TOKEN || null;
  // Our own workspace + pilots may use the shared key so we keep dogfooding.
  const allow = new Set((process.env.LINKEDIN_ENGAGEMENT_WORKSPACES || '')
    .split(',').map(s => s.trim()).filter(Boolean));
  if (allow.has(workspaceId)) return process.env.APIFY_TOKEN || null;
  return null;
}

/** Run an actor synchronously and return its dataset items. */
export async function runActor(actor, input, { timeoutSecs = 120, token } = {}) {
  const key = token || process.env.APIFY_TOKEN;
  if (!key) throw new Error('No Apify token (connect an Apify key in Integrations)');
  const url = `${APIFY_BASE}/${actor}/run-sync-get-dataset-items?token=${key}&timeout=${timeoutSecs}`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), (timeoutSecs + 20) * 1000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`apify ${actor} -> ${res.status} ${body.slice(0, 200)}`);
    }
    const items = await res.json();
    return Array.isArray(items) ? items : [];
  } finally {
    clearTimeout(t);
  }
}
