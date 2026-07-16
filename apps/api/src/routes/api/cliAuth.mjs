import { Router } from 'express';
import crypto from 'crypto';
import { getSupabaseClient } from '@nous/core';
import { verifySupabaseAuth } from '../../middleware/supabaseAuth.mjs';
import { apiKeyScopeFor } from '../../lib/apiKeyScope.mjs';

// CLI / plugin browser-login — an OAuth-style device-authorization flow so a
// user signs in with their browser and the CLI receives a freshly minted API
// key, no copy-paste. start + poll are public (the CLI has no key yet);
// approve + request require a logged-in web session.
export const cliAuthRouter = Router();

const TTL_MS = 10 * 60 * 1000; // 10 minutes
const INTERVAL_S = 4;

function appUrl() {
  return process.env.APP_URL || 'https://app.opennous.cloud';
}

// POST /api/cli/auth/start — begin a request. Returns the codes + the URL the CLI opens.
cliAuthRouter.post('/start', async (_req, res) => {
  try {
    const supabase = getSupabaseClient();
    const device_code = `dc_${crypto.randomBytes(32).toString('hex')}`;
    const user_code = crypto.randomBytes(9).toString('base64url'); // ~12 url-safe chars
    const expires_at = new Date(Date.now() + TTL_MS).toISOString();

    const { error } = await supabase
      .from('cli_auth_requests')
      .insert({ device_code, user_code, status: 'pending', expires_at });
    if (error) throw error;

    const verification_uri = `${appUrl()}/cli-login`;
    return res.json({
      device_code,
      user_code,
      verification_uri,
      verification_uri_complete: `${verification_uri}?code=${encodeURIComponent(user_code)}`,
      interval: INTERVAL_S,
      expires_in: Math.floor(TTL_MS / 1000),
    });
  } catch (err) {
    console.error('[POST /api/cli/auth/start]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// POST /api/cli/auth/poll — the CLI polls with its device_code until approved.
cliAuthRouter.post('/poll', async (req, res) => {
  try {
    const { device_code } = req.body || {};
    if (!device_code) return res.status(400).json({ error: 'device_code_required' });
    const supabase = getSupabaseClient();
    const { data: row } = await supabase
      .from('cli_auth_requests').select('*').eq('device_code', device_code).maybeSingle();
    if (!row) return res.status(404).json({ error: 'unknown_device_code' });
    if (new Date(row.expires_at) < new Date()) return res.json({ status: 'expired' });

    if (row.status === 'approved') {
      // Hand the key back exactly once, then consume the request.
      await supabase.from('cli_auth_requests')
        .update({ status: 'consumed', raw_key: null }).eq('id', row.id);
      return res.json({ status: 'approved', api_key: row.raw_key, workspace_id: row.workspace_id });
    }
    if (row.status === 'consumed') return res.json({ status: 'consumed' });
    if (row.status === 'denied')   return res.json({ status: 'denied' });
    return res.json({ status: 'pending' });
  } catch (err) {
    console.error('[POST /api/cli/auth/poll]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// GET /api/cli/auth/request?user_code= — the web page reads what it's authorizing.
cliAuthRouter.get('/request', verifySupabaseAuth, async (req, res) => {
  try {
    const user_code = String(req.query.user_code || '');
    if (!user_code) return res.status(400).json({ error: 'user_code_required' });
    const supabase = getSupabaseClient();
    const { data: row } = await supabase
      .from('cli_auth_requests').select('status, expires_at')
      .eq('user_code', user_code).order('created_at', { ascending: false }).limit(1).maybeSingle();
    if (!row) return res.status(404).json({ error: 'unknown_code' });
    const expired = new Date(row.expires_at) < new Date();
    return res.json({ status: expired ? 'expired' : row.status });
  } catch (err) {
    console.error('[GET /api/cli/auth/request]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// POST /api/cli/auth/approve — the signed-in user approves; mint a key for their workspace.
cliAuthRouter.post('/approve', verifySupabaseAuth, async (req, res) => {
  try {
    const { user_code } = req.body || {};
    if (!user_code) return res.status(400).json({ error: 'user_code_required' });
    const workspaceId = req.workspaceId;
    if (!workspaceId) return res.status(400).json({ error: 'workspace_required' });

    const supabase = getSupabaseClient();
    const { data: row } = await supabase
      .from('cli_auth_requests').select('*')
      .eq('user_code', user_code).eq('status', 'pending')
      .order('created_at', { ascending: false }).limit(1).maybeSingle();
    if (!row) return res.status(404).json({ error: 'unknown_or_used_code' });
    if (new Date(row.expires_at) < new Date()) return res.status(410).json({ error: 'expired' });

    // Mint an API key scoped to the approving member (same rule as
    // POST /api/workspace/api-keys): a member gets a member-scoped key, an
    // owner/admin an admin key. See PRIVACY_MODEL.md.
    const rawKey = `pk_${crypto.randomBytes(24).toString('hex')}`;
    const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
    // Short suffix keeps the (workspace_id, name) unique constraint happy across logins.
    const name = `CLI login ${crypto.randomBytes(2).toString('hex')}`;
    const { data: keyRow, error: keyErr } = await supabase
      .from('api_keys').insert({
        workspace_id: workspaceId, name, key_hash: keyHash,
        created_by_user_id: req.internalUserId ?? null,
        ...apiKeyScopeFor(req),
      })
      .select('id').single();
    if (keyErr) throw keyErr;

    const { error: updErr } = await supabase.from('cli_auth_requests').update({
      status: 'approved',
      workspace_id: workspaceId,
      api_key_id: keyRow.id,
      raw_key: rawKey,
      approved_at: new Date().toISOString(),
    }).eq('id', row.id);
    if (updErr) throw updErr;

    return res.json({ ok: true });
  } catch (err) {
    console.error('[POST /api/cli/auth/approve]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});
