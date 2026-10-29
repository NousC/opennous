// Inbound for the company repo behind Knowledge (GET-1037): GitHub's push webhook, and the poll the
// worker calls when a connection has no webhook (a token without the Webhooks permission) or went
// quiet. Both read the repo into the workspace with pullContextRepo. Open source since 2026-10-29.
import { Router } from 'express';
import { getSupabaseClient } from '@nous/core';
import { pullContextRepo, signatureOk, syncDueContextRepos } from '../lib/contextRepo.mjs';
import { afterRepoChange } from './api/context.mjs';

/** POST /api/context-repo/webhook/:token, mounted raw: the signature is checked over GitHub's bytes. */
export async function contextRepoWebhookHandler(req, res) {
  try {
    const supabase = getSupabaseClient();
    const { data: cfg } = await supabase.from('workspace_context_repos').select('*').eq('sync_token', req.params.token).maybeSingle();
    // An unknown or paused connection is acknowledged, never refused: GitHub must not retry or disable the hook.
    if (!cfg?.webhook_secret) return res.status(200).json({ ok: true });
    if (!signatureOk(cfg.webhook_secret, req.body, req.get('x-hub-signature-256') || '')) return res.status(401).json({ error: 'bad_signature' });
    if (req.get('x-github-event') !== 'push') return res.status(200).json({ ok: true });
    const payload = JSON.parse(req.body.toString('utf8') || '{}');
    const branch = String(payload.ref || '').replace(/^refs\/heads\//, '');
    if (branch && branch !== cfg.github_branch) return res.status(200).json({ ok: true, ignored_branch: branch });
    if (!cfg.auto_sync) return res.status(200).json({ ok: true, paused: true });
    // Acknowledge first: GitHub gives a delivery 10 seconds.
    res.status(202).json({ ok: true });
    pullContextRepo(supabase, cfg, { via: 'webhook', afterChange: f => afterRepoChange(supabase, cfg.workspace_id, f) })
      .catch(e => console.error('[context-repo] webhook pull failed:', e?.message ?? e));
  } catch (err) {
    console.error('[context-repo] webhook', err);
    if (!res.headersSent) res.status(200).json({ ok: true });
  }
}

/** /internal/context-repo: the worker's poll, guarded by WORKER_SECRET. */
export const contextRepoInternalRouter = Router();
contextRepoInternalRouter.use((req, res, next) => {
  const secret = process.env.WORKER_SECRET;
  if (!secret) return res.status(404).json({ error: 'not_found' });
  if (req.get('x-worker-secret') !== secret) return res.status(403).json({ error: 'forbidden' });
  next();
});
contextRepoInternalRouter.post('/tick', async (_req, res) => {
  try {
    const sb = getSupabaseClient();
    res.json(await syncDueContextRepos(sb, { afterChange: (ws, f) => afterRepoChange(sb, ws, f) }));
  } catch (err) {
    console.error('[POST /internal/context-repo/tick]', err);
    res.status(500).json({ error: 'internal_error' });
  }
});

