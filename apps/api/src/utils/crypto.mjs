import crypto from 'crypto';

const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY
  ? Buffer.from(process.env.ENCRYPTION_KEY.slice(0, 64).padEnd(64, '0'), 'hex')
  : null;

export function encrypt(value) {
  if (!value) return value;
  // Fail CLOSED: never silently store a secret in plaintext because the key is
  // missing. Prod sets ENCRYPTION_KEY; a misconfigured deploy now errors loudly
  // at the point of storing a credential instead of writing it unencrypted.
  if (!ENCRYPTION_KEY) throw new Error('ENCRYPTION_KEY is not configured — refusing to store a credential unencrypted');
  // Authenticated AES-256-GCM (iv:data:tag). Legacy CBC (iv:data) rows still
  // decrypt below, so this needs no re-encryption of existing data.
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', ENCRYPTION_KEY, iv);
  const enc = cipher.update(String(value), 'utf8', 'hex') + cipher.final('hex');
  const tag = cipher.getAuthTag().toString('hex');
  return iv.toString('hex') + ':' + enc + ':' + tag;
}

export function decrypt(encryptedValue) {
  if (!ENCRYPTION_KEY || !encryptedValue) return null;
  try {
    const parts = String(encryptedValue).split(':');
    const iv = Buffer.from(parts[0], 'hex');
    if (parts.length === 3) {
      // GCM: iv:data:tag
      const decipher = crypto.createDecipheriv('aes-256-gcm', ENCRYPTION_KEY, iv);
      decipher.setAuthTag(Buffer.from(parts[2], 'hex'));
      return decipher.update(parts[1], 'hex', 'utf8') + decipher.final('utf8');
    }
    // Legacy CBC: iv:data
    const decipher = crypto.createDecipheriv('aes-256-cbc', ENCRYPTION_KEY, iv);
    return decipher.update(parts[1], 'hex', 'utf8') + decipher.final('utf8');
  } catch { return null; }
}
