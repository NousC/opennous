// Email verification (worker copy) — MillionVerifier / NeverBounce, BYOK.
// Mirrors apps/api/src/services/verification.mjs, using the worker's own
// decrypt + activity helpers (same way enrichContact is duplicated worker-side).
// Used by workers/bulkLeadJobs.mjs to drain async bulk-verify jobs.

import { recordVerificationObservation } from '@nous/core';
import { logActivity } from './activity.mjs';
import { decrypt } from './encryption.mjs';

const VERIFIED = 'VERIFIED';
const RISKY = 'RISKY';
const UNAVAILABLE = 'UNAVAILABLE';

async function getProviderApiKey(supabase, workspaceId, providerName) {
  const { data: provider } = await supabase
    .from('workflow_providers').select('id').eq('name', providerName).maybeSingle();
  if (!provider?.id) return null;
  const { data } = await supabase
    .from('workflow_provider_connections')
    .select('encrypted_credentials')
    .eq('workspace_id', workspaceId).eq('provider_id', provider.id).eq('is_verified', true)
    .order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (!data?.encrypted_credentials) return null;
  try { return decrypt(data.encrypted_credentials.api_key) || null; } catch { return null; }
}

async function verifyViaMillionVerifier(email, apiKey) {
  const url = `https://api.millionverifier.com/api/v3/?api=${encodeURIComponent(apiKey)}&email=${encodeURIComponent(email)}&timeout=10`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`MillionVerifier ${res.status}`);
  const body = await res.json();
  const r = String(body.result || '').toLowerCase();
  const status = r === 'ok' ? VERIFIED
    : r === 'catch_all' || r === 'unknown' ? RISKY
    : r === 'invalid' || r === 'disposable' ? UNAVAILABLE : null;
  return { status, raw: body };
}

async function verifyViaNeverBounce(email, apiKey) {
  const url = `https://api.neverbounce.com/v4/single/check?key=${encodeURIComponent(apiKey)}&email=${encodeURIComponent(email)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`NeverBounce ${res.status}`);
  const body = await res.json();
  if (body.status && body.status !== 'success') throw new Error(`NeverBounce ${body.status}`);
  const r = String(body.result || '').toLowerCase();
  const status = r === 'valid' ? VERIFIED
    : r === 'catchall' || r === 'unknown' ? RISKY
    : r === 'invalid' || r === 'disposable' ? UNAVAILABLE : null;
  return { status, raw: body };
}

const RUNNERS = { millionverifier: verifyViaMillionVerifier, neverbounce: verifyViaNeverBounce };

// Resolve the verifier to run with — honour `preferred`, else MillionVerifier → NeverBounce.
export async function getVerifier(supabase, workspaceId, preferred) {
  if (preferred && RUNNERS[preferred]) {
    const key = await getProviderApiKey(supabase, workspaceId, preferred);
    if (key) return { provider: preferred, apiKey: key, run: RUNNERS[preferred] };
  }
  const mv = await getProviderApiKey(supabase, workspaceId, 'millionverifier');
  if (mv) return { provider: 'millionverifier', apiKey: mv, run: verifyViaMillionVerifier };
  const nb = await getProviderApiKey(supabase, workspaceId, 'neverbounce');
  if (nb) return { provider: 'neverbounce', apiKey: nb, run: verifyViaNeverBounce };
  return null;
}

// Verify one lead's email; persist the verdict + activity entry; return status.
export async function verifyLead(supabase, verifier, lead) {
  const { status, raw } = await verifier.run(lead.email, verifier.apiKey);
  if (status) await recordVerificationObservation(supabase, lead.workspace_id, lead.id, verifier.provider, status);
  const label = { [VERIFIED]: 'Verified', [RISKY]: 'Risky', [UNAVAILABLE]: 'Unavailable' }[status] || 'Inconclusive';
  await logActivity(supabase, {
    workspaceId: lead.workspace_id, contactId: lead.id,
    type: 'verification_run', source: verifier.provider,
    externalId: `verify_${verifier.provider}_${lead.id}_${Date.now()}`,
    occurredAt: new Date().toISOString(),
    description: `Email verified via ${verifier.provider === 'millionverifier' ? 'MillionVerifier' : 'NeverBounce'}`,
    summary: `${lead.email} — ${label}`,
    rawData: { provider: verifier.provider, email: lead.email, email_status: status, result: raw?.result || null },
  }).catch(() => {});
  return status;
}
