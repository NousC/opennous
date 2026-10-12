import crypto from 'crypto';

// OAuth 2.1 authorization server for the hosted MCP (GET-762). Pure helpers live
// here so they test without a database; the routes are in routes/oauth.mjs.
//
// Spec: MCP authorization 2025-06-18 (OAuth 2.1 + PKCE, RFC 8414 metadata,
// RFC 7591 dynamic client registration, RFC 9728 protected-resource metadata,
// RFC 8707 resource indicators, RFC 7009 revocation).

export const ACCESS_TOKEN_PREFIX = 'nat_';
export const REFRESH_TOKEN_PREFIX = 'nrt_';
export const ACCESS_TTL_S = 60 * 60;               // 1 hour
export const REFRESH_TTL_S = 60 * 60 * 24 * 30;    // 30 days, rotated on every use
export const CODE_TTL_MS = 60 * 1000;              // an approved code must be redeemed within a minute
export const REQUEST_TTL_MS = 10 * 60 * 1000;      // time to sign in and approve
export const SCOPE = 'nous';

export const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
export const randomToken = (prefix, bytes = 32) => `${prefix}${crypto.randomBytes(bytes).toString('base64url')}`;

// Public origin only: API_URL is the in-cluster http://api:3000 on a compose install,
// which a client like Grok can't reach, so it counts only when it is https.
export function issuerUrl() {
  const e = process.env;
  const url = e.OAUTH_ISSUER
    || (e.API_DOMAIN && `https://${e.API_DOMAIN}`)
    || (e.API_URL?.startsWith('https://') && e.API_URL)
    || 'https://api.opennous.cloud';
  return url.replace(/\/$/, '');
}

export function appUrl() {
  return (process.env.APP_URL || 'https://app.opennous.cloud').replace(/\/$/, '');
}

// The MCP endpoint is the protected resource. Tokens are only issued for it.
export function mcpResourceUrl() {
  if (process.env.MCP_URL) return `${process.env.MCP_URL.replace(/\/$/, '')}/mcp`;
  if (process.env.MCP_DOMAIN) return `https://${process.env.MCP_DOMAIN}/mcp`;
  return 'https://mcp.opennous.cloud/mcp';
}

// RFC 8414 authorization-server metadata.
export function authorizationServerMetadata(issuer = issuerUrl()) {
  return {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`,
    revocation_endpoint: `${issuer}/oauth/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    revocation_endpoint_auth_methods_supported: ['none'],
    scopes_supported: [SCOPE],
  };
}

// PKCE S256: BASE64URL(SHA256(code_verifier)) must equal the stored challenge.
// RFC 7636 verifiers are 43-128 chars of [A-Z a-z 0-9 - . _ ~].
export function verifyPkce(codeVerifier, codeChallenge) {
  if (typeof codeVerifier !== 'string' || typeof codeChallenge !== 'string') return false;
  if (!/^[A-Za-z0-9\-._~]{43,128}$/.test(codeVerifier)) return false;
  const computed = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
  const a = Buffer.from(computed);
  const b = Buffer.from(codeChallenge);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// A redirect URI a client may register: https anywhere, or http only on a
// loopback host (desktop clients and the MCP Inspector). No fragments, no
// custom schemes, nothing that is not a real URL.
export function isAllowedRedirectUri(uri) {
  let u;
  try { u = new URL(uri); } catch { return false; }
  if (u.hash) return false;
  if (u.protocol === 'https:') return true;
  if (u.protocol === 'http:') return ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  return false;
}

// Validate a dynamic client registration body. Returns { client } or { error }.
export function validateRegistration(body) {
  const b = body && typeof body === 'object' ? body : {};
  const uris = b.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0 || uris.length > 10) {
    return { error: 'invalid_redirect_uri', error_description: 'redirect_uris must list 1 to 10 URIs.' };
  }
  for (const uri of uris) {
    if (typeof uri !== 'string' || uri.length > 2000 || !isAllowedRedirectUri(uri)) {
      return { error: 'invalid_redirect_uri', error_description: 'Redirect URIs must be https, or http on localhost.' };
    }
  }
  const grantTypes = b.grant_types ?? ['authorization_code', 'refresh_token'];
  if (!Array.isArray(grantTypes) || !grantTypes.includes('authorization_code')
      || grantTypes.some((g) => !['authorization_code', 'refresh_token'].includes(g))) {
    return { error: 'invalid_client_metadata', error_description: 'Only authorization_code and refresh_token grants are supported.' };
  }
  const responseTypes = b.response_types ?? ['code'];
  if (!Array.isArray(responseTypes) || responseTypes.some((r) => r !== 'code')) {
    return { error: 'invalid_client_metadata', error_description: 'Only the code response type is supported.' };
  }
  const name = typeof b.client_name === 'string' ? b.client_name.trim().slice(0, 100) : '';
  return { client: { client_name: name || null, redirect_uris: [...new Set(uris)] } };
}

// Validate the /authorize query against the registered client. Errors that make
// the redirect unsafe (unknown client, unregistered redirect_uri) are returned
// with redirect: false and must be shown, never redirected to.
export function validateAuthorizeParams(q, client, resource = mcpResourceUrl()) {
  if (!client) return { error: 'invalid_client', redirect: false };
  if (!q.redirect_uri || !client.redirect_uris.includes(q.redirect_uri)) {
    return { error: 'invalid_redirect_uri', redirect: false };
  }
  if (q.response_type !== 'code') return { error: 'unsupported_response_type', redirect: true };
  if (!q.code_challenge || q.code_challenge_method !== 'S256') {
    return { error: 'invalid_request', error_description: 'PKCE with S256 is required.', redirect: true };
  }
  if (!/^[A-Za-z0-9\-_]{43}$/.test(q.code_challenge)) {
    return { error: 'invalid_request', error_description: 'Malformed code_challenge.', redirect: true };
  }
  if (q.resource && stripSlash(q.resource) !== stripSlash(resource)) {
    return { error: 'invalid_target', error_description: 'Unknown resource.', redirect: true };
  }
  for (const k of ['response_type', 'redirect_uri', 'code_challenge', 'code_challenge_method', 'state', 'scope', 'resource']) {
    if (q[k] != null && typeof q[k] !== 'string') return { error: 'invalid_request', redirect: false };
  }
  if (q.scope && q.scope.split(' ').some((s) => s && s !== SCOPE)) {
    return { error: 'invalid_scope', redirect: true };
  }
  return { ok: true };
}

// The consent screen names the app by where the code is going, never by the
// client_name a registrant chose (anyone can register "Claude"). Known hosts get
// their product name; anything else is shown as its bare host.
const KNOWN_CLIENTS = {
  'claude.ai': 'Claude', 'claude.com': 'Claude',
  'chatgpt.com': 'ChatGPT', 'chat.openai.com': 'ChatGPT',
  'grok.com': 'Grok', 'x.ai': 'Grok',
};
export function displayFor(host) {
  const h = String(host).toLowerCase().split(':')[0];
  if (h === 'localhost' || h === '127.0.0.1' || h === '[::1]') return { displayName: 'An app on this computer', verified: false };
  const known = Object.keys(KNOWN_CLIENTS).find((k) => h === k || h.endsWith(`.${k}`));
  return known ? { displayName: KNOWN_CLIENTS[known], verified: true } : { displayName: h, verified: false };
}

const stripSlash = (s) => String(s).replace(/\/$/, '');

// Build the redirect back to the client with either a code or an error.
export function clientRedirect(redirectUri, params) {
  const u = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) if (v != null) u.searchParams.set(k, v);
  return u.toString();
}
