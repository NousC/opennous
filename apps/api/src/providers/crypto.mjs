/**
 * Credential encryption for provider connections.
 *
 * Lifted out of the route file unchanged — same key, same AES-256-CBC, same legacy-GCM
 * read path — so that connect.mjs can encrypt without importing a router. Behaviour is
 * identical; only the address changed.
 */

import crypto from 'crypto';

// Byte-for-byte the derivation the route file has always used. It is hex, not utf8 —
// changing it would silently make every credential already in the database
// undecryptable, and the failure would look like "all my integrations broke".
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY
  ? Buffer.from(process.env.ENCRYPTION_KEY.slice(0, 64).padEnd(64, '0'), 'hex')
  : null;

/** Encrypt one value. Fails CLOSED when no key is configured — never stores plaintext. */
export function encryptValue(value) {
  if (value == null) return value;
  if (!ENCRYPTION_KEY) throw new Error('ENCRYPTION_KEY is not configured — refusing to store a credential unencrypted');
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', ENCRYPTION_KEY, iv);
  return iv.toString('hex') + ':' + cipher.update(String(value), 'utf8', 'hex') + cipher.final('hex');
}

export function encryptCredentials(credentials) {
  const out = {};
  if (credentials) {
    for (const [key, val] of Object.entries(credentials)) out[key] = encryptValue(val);
  }
  return out;
}

export function decrypt(encryptedValue) {
  if (!encryptedValue || typeof encryptedValue !== 'string') return encryptedValue ?? null;
  const parts = encryptedValue.split(':');
  // Recognized formats: CBC (iv:data) or legacy GCM (iv:data:tag). Plain strings
  // (instance_url, scope, token_type) flow through unchanged.
  const isCBC = parts.length === 2 && /^[0-9a-f]{32}$/i.test(parts[0]);
  const isGCM = parts.length === 3 && /^[0-9a-f]{32}$/i.test(parts[0]) && /^[0-9a-f]{32}$/i.test(parts[2]);
  if (!ENCRYPTION_KEY || (!isCBC && !isGCM)) return encryptedValue;
  try {
    if (isCBC) {
      const decipher = crypto.createDecipheriv('aes-256-cbc', ENCRYPTION_KEY, Buffer.from(parts[0], 'hex'));
      return decipher.update(parts[1], 'hex', 'utf8') + decipher.final('utf8');
    }
    const [ivHex, dataHex, tagHex] = parts;
    const decipher = crypto.createDecipheriv('aes-256-gcm', ENCRYPTION_KEY, Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    return decipher.update(dataHex, 'hex', 'utf8') + decipher.final('utf8');
  } catch { return encryptedValue; }
}

export { ENCRYPTION_KEY };
