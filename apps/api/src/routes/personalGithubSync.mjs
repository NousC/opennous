// Layer B inbound sync for the personal vault — the two ways a change in a member's
// connected GitHub repo reaches Nous without them clicking anything:
//
//   1. WEBHOOK (real-time) — GitHub POSTs here on every push. HMAC-verified against
//      the per-source secret, then the source is ingested. This is the fast path.
//   2. POLL (fallback) — the worker calls /internal/personal-sync/tick on a timer;
//      we ingest every source that has no working webhook or hasn't synced recently.
//      Covers fine-grained PATs that lack the "Webhooks" permission.
//
// Both funnel into the SAME conflict-safe ingestVault, so there's one code path and
// one place conflicts are decided.

import { Router } from 'express';
import crypto from 'node:crypto';
import { getSupabaseClient } from '@nous/core';
import { decrypt } from '../providers/crypto.mjs';
import { ingestRepoSkills } from '../lib/personalGithub.mjs';

// Ingest one source and stamp how it was triggered. Shared by webhook + poll. Pulls
// both the vault files AND any skills the member keeps in the repo (Layer D part 2).
async function ingestSource(supabase, src, via) {
  const token = src.github_token_enc ? decrypt(src.github_token_enc) : null;
  if (!token || !src.github_repo) return null;
  const cfg = { token, repo: src.github_repo, branch: src.github_branch, base_path: src.base_path, folder_map: src.folder_map };
  // Vault foundation-folder ingest RETIRED 2026-08-22 — Nous no longer reads the personal
  // vault, so there is nothing to pull in. The repo relationship is now one-way (Nous PUSHES
  // account/people evidence to nous/). Skills import stays — it's a separate feature.
  const skills = await ingestRepoSkills(supabase, src.workspace_id, src.user_id, cfg).catch(() => ({ pulled: 0, removed: 0 }));
  await supabase.from('personal_workspaces')
    .update({ last_synced_at: new Date().toISOString(), last_synced_via: via, sync_status: 'synced' })
    .eq('workspace_id', src.workspace_id).eq('user_id', src.user_id);
  return { pulled: 0, removed: 0, conflicts: 0, skills };
}

// ── Webhook receiver ──────────────────────────────────────────────────────────
// Mounted at POST /api/personal/github/webhook/:token with express.raw so the HMAC
// can be checked against the exact bytes GitHub signed. Unauthenticated by design —
// the signature IS the auth.
export async function githubVaultWebhookHandler(req, res) {
  try {
    const syncToken = req.params.token;
    if (!syncToken) return res.status(404).end();

    const supabase = getSupabaseClient();
    const { data: src } = await supabase.from('personal_workspaces')
      .select('*').eq('sync_token', syncToken).maybeSingle();
    // Always 200 on an unknown/paused source — never hand GitHub a reason to retry
    // or disable the hook.
    if (!src || !src.webhook_secret || src.source_type !== 'github') return res.status(200).json({ ok: true });

    // Verify X-Hub-Signature-256 over the raw body (req.body is a Buffer here).
    const sig = req.get('x-hub-signature-256') || '';
    const mac = 'sha256=' + crypto.createHmac('sha256', src.webhook_secret).update(req.body).digest('hex');
    const ok = sig.length === mac.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(mac));
    if (!ok) return res.status(401).json({ error: 'bad_signature' });

    // Only pushes to the tracked branch matter. GitHub's ping (no ref) is acknowledged.
    const event = req.get('x-github-event');
    const payload = JSON.parse(req.body.toString('utf8') || '{}');
    if (event !== 'push') return res.status(200).json({ ok: true, ignored: event });
    const branch = String(payload.ref || '').replace(/^refs\/heads\//, '');
    if (src.github_branch && branch && branch !== src.github_branch) return res.status(200).json({ ok: true, ignored_branch: branch });
    if (!src.auto_sync) return res.status(200).json({ ok: true, paused: true });

    // Acknowledge fast, ingest after — GitHub times deliveries out at 10s.
    res.status(202).json({ ok: true });
    ingestSource(supabase, src, 'webhook').catch((e) => console.error('[vault-webhook] ingest failed:', e.message));
  } catch (err) {
    console.error('[vault-webhook]', err);
    if (!res.headersSent) res.status(200).json({ ok: true });   // never make GitHub retry on our bug
  }
}

// ── Poll fallback ─────────────────────────────────────────────────────────────
// Ingest sources that auto-sync but can't rely on a webhook: no hook registered, or
// nothing has come in for a while. A per-source last_polled_at claim keeps overlapping
// ticks (or two workers) from ingesting the same source twice at once.
export async function syncDueSources(supabase, { pollMinutes = 10, staleMinutes = 60, limit = 50 } = {}) {
  const nowMs = Date.now();
  const claimBefore = nowMs - pollMinutes * 60_000;
  const staleBefore = nowMs - staleMinutes * 60_000;
  // Fetch the github auto-sync sources and decide "due" in JS. A PostgREST .or() with
  // an ISO-timestamp bound silently matches nothing, and the set is tiny (one source
  // per member), so a plain fetch + filter is both correct and cheap.
  const { data: all } = await supabase.from('personal_workspaces')
    .select('*').eq('source_type', 'github').eq('auto_sync', true).limit(limit);
  const due = (all ?? []).filter((s) => !s.last_polled_at || new Date(s.last_polled_at).getTime() < claimBefore);

  let synced = 0, conflicts = 0, considered = 0;
  for (const src of due) {
    // A source with a live webhook that synced recently is already covered — skip it.
    if (src.webhook_id && src.last_synced_at && new Date(src.last_synced_at).getTime() > staleBefore) continue;
    // Mark it polled. Single worker, so no compare-and-set needed; ingest is idempotent
    // (it diffs by git sha) so even a double-run is harmless.
    await supabase.from('personal_workspaces')
      .update({ last_polled_at: new Date(nowMs).toISOString() })
      .eq('workspace_id', src.workspace_id).eq('user_id', src.user_id);
    considered++;
    try {
      const r = await ingestSource(supabase, src, 'poll');
      if (r) { if (r.pulled || r.removed) synced++; conflicts += r.conflicts || 0; }
    } catch (e) { console.error('[vault-poll] source failed:', e.message); }
  }
  return { considered, synced, conflicts };
}

// Internal worker→api router. Secret-guarded, dormant unless WORKER_SECRET is set —
// the same pattern as /internal/motion.
export const personalSyncInternalRouter = Router();
personalSyncInternalRouter.use((req, res, next) => {
  const secret = process.env.WORKER_SECRET;
  if (!secret) return res.status(404).json({ error: 'not_found' });
  if (req.get('x-worker-secret') !== secret) return res.status(403).json({ error: 'forbidden' });
  next();
});
personalSyncInternalRouter.post('/tick', async (_req, res) => {
  try {
    const r = await syncDueSources(getSupabaseClient());
    return res.json(r);
  } catch (err) {
    console.error('[POST /internal/personal-sync/tick]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});
