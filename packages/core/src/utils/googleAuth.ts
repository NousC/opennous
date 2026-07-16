// Canonical Google OAuth token refresh — the single source of truth for refreshing
// Gmail / Google Calendar access tokens. Both the worker pollers and the API
// on-demand enricher delegate here so the decrypt format, refresh logic, and stored
// credential shape never drift apart again.
//
// Refreshes against Google's token endpoint directly (no googleapis dependency, so
// core stays lean). Only the secret fields are re-encrypted on write-back; metadata
// (scope, email, expiry_date, token_type) is stored as plaintext so downstream
// scope-substring filters keep working.

import { decrypt, encrypt } from './encryption.js';

const ENCRYPTED_FIELDS = new Set(['access_token', 'refresh_token', 'id_token']);
const EXPIRY_BUFFER_MS = 5 * 60 * 1000; // refresh when within 5 minutes of expiry

// Thrown when Google reports the grant is no longer valid (user revoked access, or
// the refresh token expired — e.g. a Testing-mode OAuth app's 7-day window). Callers
// should catch this, flag the connection as needing re-auth, and surface it to the
// user rather than retrying.
export class TokenRevokedError extends Error {
  code = 'google_token_revoked' as const;
  constructor(message = 'Google OAuth token revoked or expired — reconnect required') {
    super(message);
    this.name = 'TokenRevokedError';
  }
}

export interface GoogleRefreshResult {
  // Decrypted, ready-to-use credentials (access_token, refresh_token, email, scope, …).
  credentials: Record<string, any>;
  // True when the access token was refreshed and the row should be persisted.
  needsUpdate: boolean;
  // Re-encrypted credentials to write back to encrypted_credentials (null when unchanged).
  updatedCredentials: Record<string, any> | null;
}

export async function refreshGoogleToken(
  encryptedCredentials: Record<string, any> | null | undefined,
): Promise<GoogleRefreshResult> {
  if (!encryptedCredentials || typeof encryptedCredentials !== 'object') {
    throw new Error('invalid_credentials: encrypted_credentials is missing or not an object');
  }
  if (!process.env.ENCRYPTION_KEY) {
    throw new Error('ENCRYPTION_KEY not set — cannot decrypt Google credentials');
  }

  // Decrypt only the secret fields; pass metadata (scope, email, expiry_date, …) through.
  const creds: Record<string, any> = {};
  for (const [key, value] of Object.entries(encryptedCredentials)) {
    creds[key] = ENCRYPTED_FIELDS.has(key) && typeof value === 'string' ? decrypt(value) : value;
  }

  // Resolve expiry from either field name/format we might encounter:
  //   - expiry_date: unix-ms number (canonical, what we write going forward)
  //   - token_expiry: legacy ISO-string from the older API refresher
  let expiresAt = 0;
  if (creds.expiry_date) expiresAt = parseInt(String(creds.expiry_date), 10) || 0;
  else if (creds.token_expiry) expiresAt = new Date(creds.token_expiry).getTime() || 0;

  // Refresh if: no access token, expiry unknown, or within the buffer of expiry.
  const needsRefresh =
    !creds.access_token || expiresAt === 0 || expiresAt - Date.now() < EXPIRY_BUFFER_MS;

  if (!needsRefresh) {
    return { credentials: creds, needsUpdate: false, updatedCredentials: null };
  }

  if (!creds.refresh_token) {
    throw new TokenRevokedError('No refresh token stored — reconnect required');
  }

  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID || '',
      client_secret: process.env.GOOGLE_CLIENT_SECRET || '',
      refresh_token: creds.refresh_token,
      grant_type: 'refresh_token',
    }),
  });

  const data: any = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    // invalid_grant = token revoked or expired; this is the signal to re-auth.
    if (data?.error === 'invalid_grant') throw new TokenRevokedError();
    throw new Error(`google_token_refresh_failed: ${data?.error || resp.status}`);
  }

  // Google returns a new access_token (+ expires_in/scope) but never a new refresh_token.
  const merged: Record<string, any> = {
    ...creds,
    access_token: data.access_token,
    expiry_date: Date.now() + (Number(data.expires_in) || 3600) * 1000,
    scope: data.scope || creds.scope,
    token_type: data.token_type || creds.token_type,
  };

  // Re-encrypt secrets; migrate off the legacy token_expiry field onto expiry_date.
  const updatedCredentials: Record<string, any> = {};
  for (const [key, value] of Object.entries(merged)) {
    if (key === 'token_expiry') continue;
    updatedCredentials[key] =
      ENCRYPTED_FIELDS.has(key) && typeof value === 'string' ? encrypt(value) : value;
  }

  return { credentials: merged, needsUpdate: true, updatedCredentials };
}
