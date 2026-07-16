// Thin Apify client for the HarvestAPI LinkedIn actors used by the engagement
// run. One call = run an actor synchronously and return its dataset items. No
// SDK dependency — just the run-sync-get-dataset-items endpoint.
//
// BYOK: the Apify key is resolved per-workspace from workflow_provider_connections
// (the 'apify' provider) via resolveApifyToken(). On Nous Cloud that's the ONLY
// source — pure bring-your-own-key, no shared fallback. On self-host we fall back
// to the APIFY_TOKEN env var so a single-tenant deploy works without the
// Integrations dance. hasApifyToken() still reports the env var (self-host gate).

import { decrypt } from './encryption.mjs';

const APIFY_BASE = 'https://api.apify.com/v2/acts';

export function hasApifyToken() {
  return !!process.env.APIFY_TOKEN;
}

// Resolve the Apify token for a workspace. Per-workspace BYOK key first; on
// self-host, fall back to the env var. On cloud with no connected key -> null
// (pure BYOK — the feature is off for that workspace until they connect a key).
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
  } catch { /* fall through to env / null */ }
  // Self-host: the env var is the single-tenant key.
  if (process.env.SELF_HOSTED === 'true') return process.env.APIFY_TOKEN || null;
  // Cloud is pure BYOK — EXCEPT the dogfood/pilot allowlist, which may use the
  // shared APIFY_TOKEN so our own workspace keeps running without re-keying.
  const allow = new Set((process.env.LINKEDIN_ENGAGEMENT_WORKSPACES || '')
    .split(',').map(s => s.trim()).filter(Boolean));
  if (allow.has(workspaceId)) return process.env.APIFY_TOKEN || null;
  return null;
}

// Run an actor and return its dataset items. `timeoutSecs` bounds the actor run
// server-side; we give the HTTP read a little more headroom on top. `token`
// overrides the env var (BYOK) — pass the workspace's resolved key.
export async function runActor(actor, input, { timeoutSecs = 240, token } = {}) {
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
