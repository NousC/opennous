import { Router } from 'express';
import { randomBytes } from 'node:crypto';
import { getSupabaseClient, syncAfterCallWebhook } from '@nous/core';
import { encryptValue, decrypt } from '../../providers/crypto.mjs';
import { validateRepo, registerWebhook, deleteWebhook, backfillEvidenceToRepo } from '../../lib/personalGithub.mjs';
import { publicApiBase } from '../../lib/publicApiBase.mjs';

// The personal workspace — the member's connect surface for the ONE-WAY evidence lane:
// Nous PUSHES the raw of each account/people touch into their connected GitHub repo
// under nous/. Scoped to (workspace_id, user_id). There is no personal knowledge-base
// here anymore — the vault file editor, propose/search, and inbound ingest were retired;
// what remains is repo connect/disconnect (which the evidence push writes through) and
// the skills import (handled by the GitHub webhook, see personalGithubSync.mjs).
export const personalRouter = Router();

const scope = (req) => ({ workspaceId: req.workspaceId, userId: req.internalUserId });

// verifySupabaseAuth only sets req.workspaceId when the request carries a
// workspaceId param, and these calls don't. Resolve the member's workspace here so
// every handler has one (their primary membership — the source is per (workspace, user)).
personalRouter.use(async (req, res, next) => {
  try {
    if (!req.workspaceId && req.internalUserId) {
      const supabase = getSupabaseClient();
      const { data } = await supabase
        .from('workspace_members')
        .select('workspace_id')
        .eq('user_id', req.internalUserId)
        .order('created_at', { ascending: true })
        .limit(1);
      if (data?.[0]?.workspace_id) req.workspaceId = data[0].workspace_id;
    }
  } catch { /* handlers 401 if still unresolved */ }
  next();
});

// The member's source config WITH the decrypted token (server-only, never returned).
async function getSourceInternal(supabase, workspaceId, userId) {
  const { data } = await supabase
    .from('personal_workspaces')
    .select('*').eq('workspace_id', workspaceId).eq('user_id', userId).maybeSingle();
  if (!data) return null;
  const token = data.github_token_enc ? decrypt(data.github_token_enc) : null;
  return { ...data, token };
}
const sanitizeSource = (s) => s && ({
  source_type: s.source_type ?? 'none', connected: s.source_type === 'github' && !!s.github_repo,
  repo: s.github_repo ?? null, branch: s.github_branch ?? null, base_path: s.base_path ?? null,
  last_synced_at: s.last_synced_at ?? null, sync_status: s.sync_status ?? null,
  auto_sync: s.auto_sync ?? false,
  // 'webhook' = GitHub pushes flow in on their own; 'poll' = we check on a timer.
  sync_mode: s.webhook_id ? 'webhook' : 'poll',
  last_synced_via: s.last_synced_via ?? null,
  local_label: s.local_label ?? null,
});

// GET /api/personal/source  → the member's sync source config (never the token).
personalRouter.get('/source', async (req, res) => {
  try {
    const { workspaceId, userId } = scope(req);
    const supabase = getSupabaseClient();
    const src = await getSourceInternal(supabase, workspaceId, userId);
    return res.json({ source: sanitizeSource(src) ?? { source_type: 'none', connected: false } });
  } catch (err) {
    console.error('[GET /api/personal/source]', err);
    return res.status(500).json({ error: 'source_failed' });
  }
});

// POST /api/personal/source/github  { token, repo, branch?, base_path? }
// Validate the token+repo, store it encrypted, set up the skills-import webhook, and
// backfill existing account/people evidence into the repo. This is the connect that the
// one-way evidence push (worker) writes through.
personalRouter.post('/source/github', async (req, res) => {
  try {
    const { workspaceId, userId } = scope(req);
    if (!workspaceId || !userId) return res.status(401).json({ error: 'unauthorized' });
    const token = String(req.body?.token ?? '').trim();
    const repo = String(req.body?.repo ?? '').trim().replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '');
    const base_path = (req.body?.base_path ?? '').toString().trim().replace(/^\/+|\/+$/g, '') || null;
    if (!token || !/^[^/]+\/[^/]+$/.test(repo)) return res.status(400).json({ error: 'token_and_repo_required', detail: 'repo must be owner/name' });

    let meta;
    try { meta = await validateRepo(token, repo); }
    catch (e) { return res.status(400).json({ error: 'github_rejected', detail: e.message }); }
    const branch = String(req.body?.branch ?? '').trim() || meta.default_branch || 'main';
    const finalRepo = meta.full_name || repo;

    // A per-source token + HMAC secret, and — best-effort — a GitHub push webhook so the
    // member's repo skills import on their own. A fine-grained PAT without the "Webhooks"
    // permission just returns no hook id; the poll fallback carries it instead.
    const syncToken = randomBytes(24).toString('hex');
    const webhookSecret = randomBytes(24).toString('hex');
    const apiBase = publicApiBase();
    let webhookId = null;
    if (/^https:\/\//.test(apiBase)) {
      webhookId = await registerWebhook(token, finalRepo, `${apiBase}/api/personal/github/webhook/${syncToken}`, webhookSecret);
    }

    const supabase = getSupabaseClient();
    await supabase.from('personal_workspaces').upsert({
      workspace_id: workspaceId, user_id: userId,
      source_type: 'github', github_repo: finalRepo, github_branch: branch, base_path,
      github_token_enc: encryptValue(token), sync_status: 'connected',
      sync_token: syncToken, webhook_secret: webhookSecret, webhook_id: webhookId, auto_sync: true,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'workspace_id,user_id' });

    // If "After every call" is on, its webhook now points at this repo with this token (GET-672).
    try { await syncAfterCallWebhook(supabase, workspaceId, userId); }
    catch (e) { console.warn('[personal] after-call webhook sync failed:', e.message); }

    // Backfill: push ALL existing account/people evidence into the freshly connected repo
    // in one commit, so the history lands immediately (the live push is write-triggered, so
    // without this a late connect would never send what's already in Nous). Fire-and-forget.
    backfillEvidenceToRepo(supabase, { token, repo: finalRepo, branch, base_path }, workspaceId, userId)
      .then((r) => { if (r?.pushed) console.log(`[personal] backfilled ${r.pushed} evidence files to ${finalRepo}`); })
      .catch((e) => console.warn('[personal] evidence backfill failed:', e.message));

    return res.json({ source: sanitizeSource(await getSourceInternal(supabase, workspaceId, userId)) });
  } catch (err) {
    console.error('[POST /api/personal/source/github]', err);
    return res.status(500).json({ error: 'connect_failed' });
  }
});

// DELETE /api/personal/source  → disconnect (drop the token + config; keep evidence rows).
personalRouter.delete('/source', async (req, res) => {
  try {
    const { workspaceId, userId } = scope(req);
    const supabase = getSupabaseClient();
    // Tear down the GitHub webhook first (best-effort) so we don't orphan a hook.
    const src = await getSourceInternal(supabase, workspaceId, userId);
    if (src?.token && src.github_repo && src.webhook_id) await deleteWebhook(src.token, src.github_repo, src.webhook_id);
    await supabase.from('personal_workspaces').update({
      source_type: 'none', github_repo: null, github_branch: null, base_path: null,
      github_token_enc: null, sync_status: null,
      sync_token: null, webhook_id: null, webhook_secret: null, auto_sync: false, last_synced_via: null,
      updated_at: new Date().toISOString(),
    }).eq('workspace_id', workspaceId).eq('user_id', userId);
    // No repo, no after-call webhook (GET-672). The toggle keeps its intent for the next connect.
    try { await syncAfterCallWebhook(supabase, workspaceId, userId); }
    catch (e) { console.warn('[personal] after-call webhook sync failed:', e.message); }
    // The evidence rows stay, but they're no longer mirrored to a repo — clear git shas.
    await supabase.from('personal_files').update({ git_sha: null })
      .eq('workspace_id', workspaceId).eq('user_id', userId);
    // Repo-synced skills become the member's own editable skills rather than vanishing.
    await supabase.from('workspace_skills').update({ source: 'manual', git_sha: null })
      .eq('workspace_id', workspaceId).eq('created_by', userId).eq('source', 'git');
    return res.json({ ok: true });
  } catch (err) {
    console.error('[DELETE /api/personal/source]', err);
    return res.status(500).json({ error: 'disconnect_failed' });
  }
});
