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
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', ENCRYPTION_KEY, iv);
  return iv.toString('hex') + ':' + cipher.update(String(value), 'utf8', 'hex') + cipher.final('hex');
}

export function decrypt(encryptedValue) {
  if (!ENCRYPTION_KEY || !encryptedValue) return null;
  try {
    const [ivHex, encrypted] = encryptedValue.split(':');
    const iv = Buffer.from(ivHex, 'hex');
    const decipher = crypto.createDecipheriv('aes-256-cbc', ENCRYPTION_KEY, iv);
    return decipher.update(encrypted, 'hex', 'utf8') + decipher.final('utf8');
  } catch { return null; }
}
