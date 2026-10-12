// AES-256-GCM encryption for storing OAuth credentials at rest.
// ENCRYPTION_KEY must be a 32-byte hex string (64 hex chars).

import crypto from 'crypto';

const KEY = Buffer.from(process.env.ENCRYPTION_KEY || '', 'hex');

export function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const encrypted = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

export function decrypt(encryptedText) {
  if (!encryptedText || typeof encryptedText !== 'string') return encryptedText;
  const parts = encryptedText.split(':');

  if (parts.length === 3) {
    if (!KEY.length) throw new Error('ENCRYPTION_KEY not set — cannot decrypt credentials');

    if (parts[0].length === 24) {
      // New GCM format (this module's encrypt): iv(12B=24hex):tag(16B=32hex):data
      const [ivHex, tagHex, dataHex] = parts;
      const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, Buffer.from(ivHex, 'hex'));
      decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
      return decipher.update(Buffer.from(dataHex, 'hex')) + decipher.final('utf8');
    }

    if (/^[0-9a-f]{32}$/i.test(parts[0]) && /^[0-9a-f]{32}$/i.test(parts[2])) {
      // Old GCM format (api/utils/encryption.js): iv(16B=32hex):data:tag(16B=32hex)
      // tag and data are swapped vs. this module — detect by 32-hex IV and 32-hex tail
      const [ivHex, dataHex, tagHex] = parts;
      const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, Buffer.from(ivHex, 'hex'));
      decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
      return decipher.update(Buffer.from(dataHex, 'hex')) + decipher.final('utf8');
    }

    // 3-part but not a recognized encrypted format (e.g. ISO date "2025-01-15T16:00:00.000Z") — return as-is
    return encryptedText;
  }

  if (parts.length === 2 && /^[0-9a-f]{32}$/i.test(parts[0])) {
    // AES-256-CBC format (API's crypto.mjs encrypt): iv:data
    // Used for credentials stored by the API (Google OAuth, Slack OAuth, etc.)
    if (!KEY.length) throw new Error('ENCRYPTION_KEY not set — cannot decrypt credentials');
    const CBC_KEY = Buffer.from((process.env.ENCRYPTION_KEY || '').slice(0, 64).padEnd(64, '0'), 'hex');
    const decipher = crypto.createDecipheriv('aes-256-cbc', CBC_KEY, Buffer.from(parts[0], 'hex'));
    return decipher.update(parts[1], 'hex', 'utf8') + decipher.final('utf8');
  }

  // Not an encrypted value — return as-is (scope strings, URLs, plain text fields)
  return encryptedText;
}
