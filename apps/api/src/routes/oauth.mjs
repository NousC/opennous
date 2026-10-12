import { Router } from 'express';
import crypto from 'crypto';
import { getSupabaseClient } from '@nous/core';
import { verifySupabaseAuth } from '../middleware/supabaseAuth.mjs';
import { apiKeyScopeFor } from '../lib/apiKeyScope.mjs';
import { auditFromReq } from '../lib/audit.mjs';
import {
  ACCESS_TOKEN_PREFIX, REFRESH_TOKEN_PREFIX, ACCESS_TTL_S, REFRESH_TTL_S, CODE_TTL_MS, REQUEST_TTL_MS, SCOPE,
  sha256, randomToken, appUrl, mcpResourceUrl, authorizationServerMetadata,
  verifyPkce, validateRegistration, validateAuthorizeParams, clientRedirect, displayFor,
} from '../lib/oauth.mjs';

const REUSE_GRACE_MS = 60 * 1000;
const r_host = (uri) => new URL(uri).host;

// OAuth 2.1 authorization server for the hosted MCP (GET-762). Grok, Claude.ai,
// ChatGPT and other MCP clients discover it from the MCP server's 401, register
// themselves, send the user here to sign in and approve, then trade the code for
// tokens. See lib/oauth.mjs for the model and the 2026_10_07_mcp_oauth migration
// for why a grant is an api_keys row.
//
// Never log codes, tokens or verifiers.

// GET /.well-known/oauth-authorization-server (RFC 8414)
export function authorizationServerMetadataHandler(_req, res) {
  res.set('Cache-Control', 'public, max-age=300');
  res.json(authorizationServerMetadata());
}

/**
 * The routers, over a Supabase client getter and a session check (tests pass fakes).
 * oauthRouter is public (/oauth/*); oauthConsentRouter backs the consent screen.
 */
export function createOAuthRouters({ getClient = getSupabaseClient, requireSession = verifySupabaseAuth, audit = auditFromReq } = {}) {
  const oauthRouter = Router();

  function oauthError(res, status, error, error_description) {
    res.set('Cache-Control', 'no-store');
    return res.status(status).json(error_description ? { error, error_description } : { error });
  }

  async function loadClient(supabase, clientId) {
    if (!clientId || typeof clientId !== 'string') return null;
    const { data } = await supabase
      .from('oauth_clients').select('client_id, client_name, redirect_uris')
      .eq('client_id', clientId).maybeSingle();
    return data ?? null;
  }

  // POST /oauth/register — RFC 7591 dynamic client registration. Public clients only.
  oauthRouter.post('/register', async (req, res) => {
    try {
      const { client, error, error_description } = validateRegistration(req.body);
      if (error) return oauthError(res, 400, error, error_description);
      const clientId = `mcp_${crypto.randomBytes(16).toString('hex')}`;
      const supabase = getClient();
      const { error: insErr } = await supabase.from('oauth_clients').insert({ client_id: clientId, ...client });
      if (insErr) throw insErr;
      res.set('Cache-Control', 'no-store');
      return res.status(201).json({
        client_id: clientId,
        client_id_issued_at: Math.floor(Date.now() / 1000),
        client_name: client.client_name ?? undefined,
        redirect_uris: client.redirect_uris,
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
        scope: SCOPE,
      });
    } catch (err) {
      console.error('[POST /oauth/register]', err?.message);
      return oauthError(res, 500, 'server_error');
    }
  });

  // GET /oauth/authorize — validate, park the request, send the user to the consent screen.
  oauthRouter.get('/authorize', async (req, res) => {
    try {
      const q = req.query;
      const supabase = getClient();
      const client = await loadClient(supabase, q.client_id);
      const v = validateAuthorizeParams(q, client);
      if (v.error && !v.redirect) {
        // Never redirect to a URI we cannot vouch for.
        return res.status(400).type('text/plain').send(
          v.error === 'invalid_client'
            ? 'Unknown client. Remove the connector and add it again.'
            : 'This redirect URI is not registered for this client.');
      }
      if (v.error) {
        // Shown, not redirected: anyone can register an https redirect URI, so bouncing
        // errors to it would make this an open redirector (RFC 9700 4.11.2).
        return res.status(400).type('text/plain').send(`The app sent an invalid sign-in request (${v.error}). Try connecting again.`);
      }

      const requestId = randomToken('ar_', 24);
      const { error } = await supabase.from('oauth_authorization_requests').insert({
        request_id: requestId,
        client_id: client.client_id,
        redirect_uri: q.redirect_uri,
        state: typeof q.state === 'string' ? q.state.slice(0, 1000) : null,
        code_challenge: q.code_challenge,
        scope: SCOPE,
        resource: mcpResourceUrl(),
        expires_at: new Date(Date.now() + REQUEST_TTL_MS).toISOString(),
      });
      if (error) throw error;
      return res.redirect(302, `${appUrl()}/oauth/consent?request=${encodeURIComponent(requestId)}`);
    } catch (err) {
      console.error('[GET /oauth/authorize]', err?.message);
      return res.status(500).type('text/plain').send('Something went wrong. Try connecting again.');
    }
  });

  async function issueTokens(supabase, { apiKeyId, clientId, resource }) {
    const access = randomToken(ACCESS_TOKEN_PREFIX);
    const refresh = randomToken(REFRESH_TOKEN_PREFIX);
    const now = Date.now();
    const { error } = await supabase.from('oauth_tokens').insert([
      { token_hash: sha256(access), kind: 'access', api_key_id: apiKeyId, client_id: clientId, resource,
        expires_at: new Date(now + ACCESS_TTL_S * 1000).toISOString() },
      { token_hash: sha256(refresh), kind: 'refresh', api_key_id: apiKeyId, client_id: clientId, resource,
        expires_at: new Date(now + REFRESH_TTL_S * 1000).toISOString() },
    ]);
    if (error) throw error;
    return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL_S, refresh_token: refresh, scope: SCOPE };
  }

  async function keyIsLive(supabase, apiKeyId) {
    const { data } = await supabase.from('api_keys').select('id').eq('id', apiKeyId).is('revoked_at', null).maybeSingle();
    return !!data;
  }

  // End a grant: every token, and the key behind it. Used on refresh-token reuse,
  // which means a token leaked or a client misbehaved.
  async function revokeGrant(supabase, apiKeyId) {
    const now = new Date().toISOString();
    await supabase.from('oauth_tokens').update({ revoked_at: now }).eq('api_key_id', apiKeyId).is('revoked_at', null);
    await supabase.from('api_keys').update({ revoked_at: now }).eq('id', apiKeyId).is('revoked_at', null);
  }

  // POST /oauth/token — authorization_code and refresh_token grants.
  oauthRouter.post('/token', async (req, res) => {
    try {
      const b = req.body || {};
      const supabase = getClient();
      const client = await loadClient(supabase, b.client_id);
      if (!client) return oauthError(res, 401, 'invalid_client');

      if (b.grant_type === 'authorization_code') {
        if (!b.code || !b.code_verifier || !b.redirect_uri) return oauthError(res, 400, 'invalid_request');
        // Single use: flip approved → used atomically, so a replayed code finds nothing.
        const { data: row } = await supabase.from('oauth_authorization_requests')
          .update({ status: 'used', used_at: new Date().toISOString() })
          .eq('code_hash', sha256(b.code)).eq('status', 'approved')
          .select('client_id, redirect_uri, code_challenge, api_key_id, resource, approved_at')
          .maybeSingle();
        if (!row) return oauthError(res, 400, 'invalid_grant');
        if (row.client_id !== client.client_id || row.redirect_uri !== b.redirect_uri) return oauthError(res, 400, 'invalid_grant');
        if (Date.now() - new Date(row.approved_at).getTime() > CODE_TTL_MS) return oauthError(res, 400, 'invalid_grant', 'Code expired.');
        if (!verifyPkce(b.code_verifier, row.code_challenge)) return oauthError(res, 400, 'invalid_grant', 'PKCE verification failed.');
        if (!(await keyIsLive(supabase, row.api_key_id))) return oauthError(res, 400, 'invalid_grant');
        const tokens = await issueTokens(supabase, { apiKeyId: row.api_key_id, clientId: client.client_id, resource: row.resource });
        res.set('Cache-Control', 'no-store');
        return res.json(tokens);
      }

      if (b.grant_type === 'refresh_token') {
        if (!b.refresh_token) return oauthError(res, 400, 'invalid_request');
        const { data: tok } = await supabase.from('oauth_tokens')
          .select('id, api_key_id, client_id, resource, expires_at, revoked_at')
          .eq('token_hash', sha256(b.refresh_token)).eq('kind', 'refresh').maybeSingle();
        if (!tok || tok.client_id !== client.client_id) return oauthError(res, 400, 'invalid_grant');
        if (tok.revoked_at) {
          // A retry just after rotation (lost response, two workers) is a client race,
          // not theft: refuse it but keep the grant. Later reuse ends the grant.
          if (Date.now() - new Date(tok.revoked_at).getTime() < REUSE_GRACE_MS) return oauthError(res, 400, 'invalid_grant');
          await revokeGrant(supabase, tok.api_key_id);
          return oauthError(res, 400, 'invalid_grant');
        }
        if (new Date(tok.expires_at).getTime() <= Date.now()) return oauthError(res, 400, 'invalid_grant');
        // Rotate: retire the old refresh token first, guarded so two racing refreshes can't both win.
        const { data: retired } = await supabase.from('oauth_tokens')
          .update({ revoked_at: new Date().toISOString() }).eq('id', tok.id).is('revoked_at', null)
          .select('id').maybeSingle();
        if (!retired) return oauthError(res, 400, 'invalid_grant');
        if (!(await keyIsLive(supabase, tok.api_key_id))) return oauthError(res, 400, 'invalid_grant');
        const tokens = await issueTokens(supabase, { apiKeyId: tok.api_key_id, clientId: client.client_id, resource: tok.resource });
        res.set('Cache-Control', 'no-store');
        return res.json(tokens);
      }

      return oauthError(res, 400, 'unsupported_grant_type');
    } catch (err) {
      console.error('[POST /oauth/token]', err?.message);
      return oauthError(res, 500, 'server_error');
    }
  });

  // POST /oauth/revoke — RFC 7009. Always 200, whether or not the token existed.
  oauthRouter.post('/revoke', async (req, res) => {
    try {
      const token = req.body?.token;
      if (typeof token === 'string' && (token.startsWith(ACCESS_TOKEN_PREFIX) || token.startsWith(REFRESH_TOKEN_PREFIX))) {
        await getClient().from('oauth_tokens')
          .update({ revoked_at: new Date().toISOString() })
          .eq('token_hash', sha256(token)).is('revoked_at', null);
      }
      return res.status(200).end();
    } catch (err) {
      console.error('[POST /oauth/revoke]', err?.message);
      return oauthError(res, 503, 'temporarily_unavailable');
    }
  });

  // GET /oauth/token-status — 204 if the bearer nat_ token is live, else 401. The MCP
  // server calls this before handling a request so an expired token becomes an HTTP
  // 401 the client can refresh on, not a tool error. Same checks as verifyApiKey.
  oauthRouter.get('/token-status', async (req, res) => {
    try {
      const auth = req.headers.authorization;
      const token = auth?.startsWith('Bearer ') ? auth.slice(7).trim() : '';
      if (!token.startsWith(ACCESS_TOKEN_PREFIX)) return res.status(401).end();
      const supabase = getClient();
      const { data: tok } = await supabase.from('oauth_tokens')
        .select('api_key_id, expires_at')
        .eq('token_hash', sha256(token)).eq('kind', 'access').is('revoked_at', null)
        .maybeSingle();
      if (!tok || new Date(tok.expires_at).getTime() <= Date.now()) return res.status(401).end();
      const { data: key } = await supabase.from('api_keys').select('expires_at')
        .eq('id', tok.api_key_id).is('revoked_at', null).maybeSingle();
      if (!key || (key.expires_at && new Date(key.expires_at).getTime() <= Date.now())) return res.status(401).end();
      return res.status(204).end();
    } catch (err) {
      console.error('[GET /oauth/token-status]', err?.message);
      return res.status(503).end();
    }
  });

  // ── Consent screen API (session-authed, called by app.opennous.cloud/oauth/consent) ──

  const oauthConsentRouter = Router();

  async function loadPendingRequest(supabase, requestId) {
    if (!requestId || typeof requestId !== 'string') return { error: 'unknown_request', status: 404 };
    const { data: row } = await supabase.from('oauth_authorization_requests')
      .select('id, client_id, redirect_uri, state, status, expires_at')
      .eq('request_id', requestId).maybeSingle();
    if (!row) return { error: 'unknown_request', status: 404 };
    if (row.status !== 'pending') return { error: 'already_used', status: 409 };
    if (new Date(row.expires_at).getTime() <= Date.now()) return { error: 'expired', status: 410 };
    const { data: client } = await supabase.from('oauth_clients')
      .select('client_name').eq('client_id', row.client_id).maybeSingle();
    return { row, clientName: client?.client_name || null, ...displayFor(r_host(row.redirect_uri)) };
  }

  // GET /api/mcp-oauth/requests/:id — what the consent screen shows.
  oauthConsentRouter.get('/requests/:id', requireSession, async (req, res) => {
    try {
      const r = await loadPendingRequest(getClient(), req.params.id);
      if (r.error) return res.status(r.status).json({ error: r.error });
      return res.json({ display_name: r.displayName, verified: r.verified, redirect_host: r_host(r.row.redirect_uri) });
    } catch (err) {
      console.error('[GET /api/mcp-oauth/requests/:id]', err?.message);
      return res.status(500).json({ error: 'internal_error' });
    }
  });

  // POST /api/mcp-oauth/requests/:id/approve { workspace_id } — mint the grant + code.
  oauthConsentRouter.post('/requests/:id/approve', requireSession, async (req, res) => {
    try {
      const workspaceId = req.workspaceId;
      if (!workspaceId) return res.status(400).json({ error: 'workspace_required' });
      const supabase = getClient();
      const r = await loadPendingRequest(supabase, req.params.id);
      if (r.error) return res.status(r.status).json({ error: r.error });

      // The grant is an ordinary member/admin-scoped key, same rule as a key the user
      // creates by hand. Its raw value is thrown away: only OAuth tokens point at it.
      const label = r.displayName.slice(0, 60);
      const { data: keyRow, error: keyErr } = await supabase.from('api_keys').insert({
        workspace_id: workspaceId,
        name: `${label} (connected app) ${crypto.randomBytes(2).toString('hex')}`,
        key_hash: sha256(crypto.randomBytes(32)),
        created_by_user_id: req.internalUserId ?? null,
        oauth_client_id: r.row.client_id,
        ...apiKeyScopeFor(req),
      }).select('id, name').single();
      if (keyErr) throw keyErr;

      const code = randomToken('nac_');
      const { data: approved, error: updErr } = await supabase.from('oauth_authorization_requests')
        .update({ status: 'approved', workspace_id: workspaceId, api_key_id: keyRow.id,
                  code_hash: sha256(code), approved_at: new Date().toISOString() })
        .eq('id', r.row.id).eq('status', 'pending')
        .select('id').maybeSingle();
      if (updErr) throw updErr;
      if (!approved) {
        await supabase.from('api_keys').update({ revoked_at: new Date().toISOString() }).eq('id', keyRow.id);
        return res.status(409).json({ error: 'already_used' });
      }

      audit(req, {
        action: 'oauth.client_authorized', target_type: 'api_key', target_id: keyRow.id,
        target_workspace_id: workspaceId, metadata: { name: keyRow.name, client_id: r.row.client_id },
      });
      return res.json({ redirect_to: clientRedirect(r.row.redirect_uri, { code, state: r.row.state }) });
    } catch (err) {
      if (err?.code === 'no_resolved_user') return res.status(409).json({ error: 'provisioning', retry: true });
      console.error('[POST /api/mcp-oauth/requests/:id/approve]', err?.message);
      return res.status(500).json({ error: 'internal_error' });
    }
  });

  // POST /api/mcp-oauth/requests/:id/deny — send the user back with access_denied.
  oauthConsentRouter.post('/requests/:id/deny', requireSession, async (req, res) => {
    try {
      const supabase = getClient();
      const r = await loadPendingRequest(supabase, req.params.id);
      if (r.error) return res.status(r.status).json({ error: r.error });
      await supabase.from('oauth_authorization_requests').update({ status: 'denied' }).eq('id', r.row.id).eq('status', 'pending');
      return res.json({ redirect_to: clientRedirect(r.row.redirect_uri, { error: 'access_denied', state: r.row.state }) });
    } catch (err) {
      console.error('[POST /api/mcp-oauth/requests/:id/deny]', err?.message);
      return res.status(500).json({ error: 'internal_error' });
    }
  });

  return { oauthRouter, oauthConsentRouter };
}

export const { oauthRouter, oauthConsentRouter } = createOAuthRouters();
