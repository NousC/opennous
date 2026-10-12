/**
 * Composio configuration for a workspace — the self-serve "paste your key" surface.
 *
 * An admin pastes their own Composio project API key; the box then auto-provisions against
 * it: creates the Gmail + Calendar auth configs (reuse if present) and points the project
 * webhook at THIS box's own /inbound/composio. Key + webhook secret are encrypted and stored
 * on the customer's own Supabase (data plane).
 *
 *   GET    /api/workspace/composio   → status (never returns the key/secret)
 *   POST   /api/workspace/composio   → { api_key, base_url?, webhook_secret? } → save + auto-provision
 *   DELETE /api/workspace/composio   → remove the config
 *
 * Mounted under verifySupabaseAuth; writes are admin-only.
 */

import { Router } from 'express';
import { getSupabaseClient } from '@nous/core';
import { getComposioClient } from '../../providers/composio.mjs';
import { encryptValue } from '../../providers/crypto.mjs';
import { workerBaseUrl } from '../../providers/webhooks.mjs';
import { auditFromReq } from '../../lib/audit.mjs';
import { publicApiBase } from '../../lib/publicApiBase.mjs';

export const workspaceComposioRouter = Router();

// Toolkit → the config column its auth-config id lands in.
const TOOLKITS = [
  { slug: 'gmail',          column: 'authconfig_gmail' },
  { slug: 'googlecalendar', column: 'authconfig_googlecalendar' },
];

function isAdmin(req) {
  return req.workspaceRole === 'owner' || req.workspaceRole === 'admin';
}

// GET — status only. Never leaks the key or secret.
workspaceComposioRouter.get('/', async (req, res) => {
  try {
    if (!req.workspaceId) return res.status(400).json({ error: 'workspace_required' });
    const supabase = getSupabaseClient();
    const { data: row } = await supabase
      .from('workspace_composio_config').select('*').eq('workspace_id', req.workspaceId).maybeSingle();
    const envFallback = !!process.env.COMPOSIO_API_KEY;
    return res.json({
      configured:       !!row?.encrypted_api_key || envFallback,
      source:           row?.encrypted_api_key ? 'workspace' : (envFallback ? 'env' : 'none'),
      base_url:         row?.base_url || process.env.COMPOSIO_BASE_URL || null,
      authconfig_gmail:          !!(row?.authconfig_gmail || process.env.COMPOSIO_AUTHCONFIG_GMAIL),
      authconfig_googlecalendar: !!(row?.authconfig_googlecalendar || process.env.COMPOSIO_AUTHCONFIG_GOOGLECALENDAR),
      webhook_set:      !!(row?.webhook_secret || process.env.COMPOSIO_WEBHOOK_SECRET),
      webhook_url:      `${publicApiBase()}/inbound/composio`,
    });
  } catch (err) {
    console.error('[GET /api/workspace/composio]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// POST — save the key and auto-provision auth configs + webhook.
workspaceComposioRouter.post('/', async (req, res) => {
  try {
    if (!req.workspaceId) return res.status(400).json({ error: 'workspace_required' });
    if (!isAdmin(req)) return res.status(403).json({ error: 'admin_required' });

    const apiKey = String(req.body?.api_key || '').trim();
    const baseUrl = req.body?.base_url ? String(req.body.base_url).trim() : null;
    let webhookSecret = req.body?.webhook_secret ? String(req.body.webhook_secret).trim() : null;

    // Webhook-secret-only update: the key is already saved and the admin is just supplying
    // the Composio signing secret (auto-registration didn't return one). No need to re-paste
    // the API key or re-provision the auth configs.
    if (!apiKey && webhookSecret) {
      const supabase = getSupabaseClient();
      const { data: existingRow } = await supabase
        .from('workspace_composio_config').select('workspace_id').eq('workspace_id', req.workspaceId).maybeSingle();
      if (!existingRow) return res.status(400).json({ error: 'api_key_required' });
      const { error } = await supabase.from('workspace_composio_config')
        .update({ webhook_secret: encryptValue(webhookSecret), updated_at: new Date().toISOString() })
        .eq('workspace_id', req.workspaceId);
      if (error) return res.status(500).json({ error: 'save_failed', message: error.message });
      auditFromReq(req, { action: 'composio.webhook_secret_set', target_type: 'workspace', target_id: req.workspaceId, target_workspace_id: req.workspaceId });
      return res.json({ ok: true, webhook_set: true, webhook_url: `${publicApiBase()}/inbound/composio` });
    }
    if (!apiKey) return res.status(400).json({ error: 'api_key_required' });

    // Validate the key + build the client.
    let composio;
    try { composio = getComposioClient(apiKey, baseUrl); }
    catch (e) { return res.status(400).json({ error: 'composio_error', message: e.message }); }

    // Auth configs — reuse an existing one per toolkit, else create with managed auth.
    let existing = [];
    try { const l = await composio.authConfigs.list(); existing = l?.items || l?.data || []; }
    catch (e) { return res.status(502).json({ error: 'composio_error', message: `Couldn't reach Composio with that key: ${e.message}` }); }

    const authIds = {};
    for (const { slug, column } of TOOLKITS) {
      const found = existing.find((i) => (i.toolkit?.slug || i.toolkitSlug) === slug);
      if (found) { authIds[column] = found.id || found.nanoId; continue; }
      try {
        const cfg = await composio.authConfigs.create(slug, { name: `nous-${slug}`, type: 'use_composio_managed_auth' });
        authIds[column] = cfg?.id || cfg?.nanoId || cfg?.authConfigId || null;
      } catch (e) {
        console.error(`[composio config] create ${slug} failed:`, e.message);
        return res.status(502).json({ error: 'authconfig_failed', message: `Couldn't create the ${slug} auth config: ${e.message}` });
      }
    }

    // Webhook → this box's own public /inbound/composio. Capture the secret if Composio
    // returns one; else keep any pasted secret; else null (verification will warn until set).
    const webhookUrl = `${publicApiBase()}/inbound/composio`;
    let webhookSet = false;
    try {
      const wh = await composio.triggers.setWebhookSubscription({ webhookUrl });
      webhookSecret = wh?.webhookSecret || wh?.secret || webhookSecret;
      webhookSet = true;
    } catch (e) {
      console.warn('[composio config] setWebhookSubscription failed:', e.message);
      // Non-fatal: admin can set the webhook in the dashboard + paste the secret.
    }

    const supabase = getSupabaseClient();
    const { error } = await supabase.from('workspace_composio_config').upsert({
      workspace_id:              req.workspaceId,
      encrypted_api_key:         encryptValue(apiKey),
      base_url:                  baseUrl,
      webhook_secret:            webhookSecret ? encryptValue(webhookSecret) : null,
      authconfig_gmail:          authIds.authconfig_gmail || null,
      authconfig_googlecalendar: authIds.authconfig_googlecalendar || null,
      updated_at:                new Date().toISOString(),
    }, { onConflict: 'workspace_id' });
    if (error) return res.status(500).json({ error: 'save_failed', message: error.message });

    auditFromReq(req, {
      action: 'composio.configured',
      target_type: 'workspace',
      target_id: req.workspaceId,
      target_workspace_id: req.workspaceId,
      metadata: { webhook_set: webhookSet, base_url: baseUrl || null },
    });

    return res.json({
      ok: true,
      authconfig_gmail:          !!authIds.authconfig_gmail,
      authconfig_googlecalendar: !!authIds.authconfig_googlecalendar,
      webhook_set:               webhookSet,
      webhook_url:               webhookUrl,
      webhook_secret_captured:   !!webhookSecret,
    });
  } catch (err) {
    console.error('[POST /api/workspace/composio]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// DELETE — remove the workspace's Composio config (falls back to env, if any).
workspaceComposioRouter.delete('/', async (req, res) => {
  try {
    if (!req.workspaceId) return res.status(400).json({ error: 'workspace_required' });
    if (!isAdmin(req)) return res.status(403).json({ error: 'admin_required' });
    const supabase = getSupabaseClient();
    await supabase.from('workspace_composio_config').delete().eq('workspace_id', req.workspaceId);
    auditFromReq(req, { action: 'composio.removed', target_type: 'workspace', target_id: req.workspaceId, target_workspace_id: req.workspaceId });
    return res.json({ ok: true });
  } catch (err) {
    console.error('[DELETE /api/workspace/composio]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});
