// ============================================================
// Email verification — MillionVerifier (default) or NeverBounce
// BYOK: runs on the workspace's own verifier key. Distinct from enrichment:
// enrichment FINDS an email (and guesses a status); verification independently
// VALIDATES the deliverability of an email we already hold, and the result
// upgrades the `email_status` shown on a lead.
// ============================================================

import { logActivity, recordVerificationObservation } from '@nous/core';
import { getProviderApiKey } from './enrichment.mjs';

// Our canonical reachability vocabulary, shared with enrichment so the
// email_status column + filters keep working unchanged.
//   VERIFIED — safe to send
//   RISKY       — catch-all / unknown, send at your own risk
//   UNAVAILABLE — invalid / disposable, do not send
// VERIFIED (not "DELIVERABLE") matches the value Prospeo enrichment already
// writes, so enrich + verify share one email_status vocabulary.
const VERIFIED = 'VERIFIED';
const RISKY = 'RISKY';
const UNAVAILABLE = 'UNAVAILABLE';

async function logSysEvent(supabase, workspaceId, source, eventType, summary, contactId, metadata) {
  try {
    await supabase.from('workspace_system_log').insert({
      workspace_id: workspaceId, source, event_type: eventType,
      summary: summary || null, contact_id: contactId || null,
      metadata: metadata || {}, occurred_at: new Date().toISOString(),
    });
  } catch { /* non-critical */ }
}

// ── MillionVerifier ───────────────────────────────────────────────────────────
// GET https://api.millionverifier.com/api/v3/?api=KEY&email=...
// result: ok | catch_all | unknown | disposable | invalid | error
async function verifyViaMillionVerifier(email, apiKey) {
  const url = `https://api.millionverifier.com/api/v3/?api=${encodeURIComponent(apiKey)}&email=${encodeURIComponent(email)}&timeout=10`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`MillionVerifier ${res.status}: ${await res.text().catch(() => '')}`);
  const body = await res.json();
  const result = String(body.result || '').toLowerCase();
  const status =
    result === 'ok'                                  ? VERIFIED :
    result === 'catch_all' || result === 'unknown'   ? RISKY :
    result === 'invalid' || result === 'disposable'  ? UNAVAILABLE :
    null; // 'error' or unexpected — treat as inconclusive, don't overwrite
  return { status, raw: body };
}

// ── NeverBounce ────────────────────────────────────────────────────────────────
// GET https://api.neverbounce.com/v4/single/check?key=KEY&email=...
// result: valid | invalid | disposable | catchall | unknown
async function verifyViaNeverBounce(email, apiKey) {
  const url = `https://api.neverbounce.com/v4/single/check?key=${encodeURIComponent(apiKey)}&email=${encodeURIComponent(email)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`NeverBounce ${res.status}: ${await res.text().catch(() => '')}`);
  const body = await res.json();
  if (body.status && body.status !== 'success') {
    throw new Error(`NeverBounce ${body.status}: ${body.message || ''}`);
  }
  const result = String(body.result || '').toLowerCase();
  const status =
    result === 'valid'                                ? VERIFIED :
    result === 'catchall' || result === 'unknown'     ? RISKY :
    result === 'invalid' || result === 'disposable'   ? UNAVAILABLE :
    null;
  return { status, raw: body };
}

const RUNNERS = { millionverifier: verifyViaMillionVerifier, neverbounce: verifyViaNeverBounce };

// Returns the workspace's connected verifier. When `preferred` is given and that
// provider is connected, it's used; otherwise prefer MillionVerifier, else
// NeverBounce. null when neither is connected — the caller surfaces a
// "connect a verifier" prompt instead of silently doing nothing.
export async function getVerifier(supabase, workspaceId, preferred) {
  if (preferred && RUNNERS[preferred]) {
    const key = await getProviderApiKey(supabase, workspaceId, preferred);
    if (key) return { provider: preferred, apiKey: key, run: RUNNERS[preferred] };
  }
  const mvKey = await getProviderApiKey(supabase, workspaceId, 'millionverifier');
  if (mvKey) return { provider: 'millionverifier', apiKey: mvKey, run: verifyViaMillionVerifier };
  const nbKey = await getProviderApiKey(supabase, workspaceId, 'neverbounce');
  if (nbKey) return { provider: 'neverbounce', apiKey: nbKey, run: verifyViaNeverBounce };
  return null;
}

// Which verifiers the workspace has connected, for the Verify modal's provider
// picker. Order = display preference (MillionVerifier first).
export async function listConnectedVerifiers(supabase, workspaceId) {
  const out = [];
  if (await getProviderApiKey(supabase, workspaceId, 'millionverifier')) out.push('millionverifier');
  if (await getProviderApiKey(supabase, workspaceId, 'neverbounce')) out.push('neverbounce');
  return out;
}

// Verify a single lead's email with the given (already-resolved) verifier,
// persist the result as a reachability_status observation + activity-tab entry,
// and return the normalized status. `lead` = { id, workspace_id, email, name }.
export async function verifyLead(supabase, verifier, lead) {
  const { status, raw } = await verifier.run(lead.email, verifier.apiKey);

  if (status) {
    await recordVerificationObservation(supabase, lead.workspace_id, lead.id, verifier.provider, status);
  }

  const label = { [VERIFIED]: 'Verified', [RISKY]: 'Risky', [UNAVAILABLE]: 'Unavailable' }[status] || 'Inconclusive';
  await logActivity(supabase, {
    workspaceId: lead.workspace_id, contactId: lead.id,
    type: 'verification_run', source: verifier.provider,
    // Unique per run so the timeline ACCUMULATES every verification (the
    // append-only deliverability history), mirroring enrichment_run.
    externalId: `verify_${verifier.provider}_${lead.id}_${Date.now()}`,
    occurredAt: new Date().toISOString(),
    description: `Email verified via ${verifier.provider === 'millionverifier' ? 'MillionVerifier' : 'NeverBounce'}`,
    summary: `${lead.email} — ${label}`,
    rawData: { provider: verifier.provider, email: lead.email, email_status: status, result: raw?.result || null },
  }).catch(() => {});
  logSysEvent(supabase, lead.workspace_id, verifier.provider, 'verification_run',
    `Verified ${lead.email}: ${label}`, lead.id, { status, result: raw?.result || null }
  ).catch(() => {});

  return status;
}
