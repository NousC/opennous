/**
 * Encryption Utility
 * Encrypts and decrypts sensitive data like API keys
 * Uses Node's built-in crypto module with AES-256-GCM
 */

import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const SALT_LENGTH = 16;
const TAG_LENGTH = 16;
const IV_LENGTH = 16;

/**
 * Get encryption key from environment or derive from workspace ID
 * In production, store the master key in a secrets manager
 */
function getEncryptionKey() {
  const masterKey = process.env.ENCRYPTION_KEY;
  
  if (!masterKey) {
    throw new Error('ENCRYPTION_KEY not set in environment variables. Set a 32-byte hex string.');
  }

  // Convert hex string to buffer
  if (masterKey.length !== 64) {
    throw new Error('ENCRYPTION_KEY must be a 64-character hex string (32 bytes)');
  }

  return Buffer.from(masterKey, 'hex');
}

/**
 * Encrypt sensitive data
 * @param {string} data - Data to encrypt
 * @returns {string} Encrypted data as hex string (iv:encryptedData:tag format)
 */
export function encrypt(data) {
  try {
    const key = getEncryptionKey();
    const iv = crypto.randomBytes(IV_LENGTH);
    
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    let encrypted = cipher.update(data, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    
    const tag = cipher.getAuthTag();
    
    // Return format: iv:encryptedData:tag (all as hex)
    return `${iv.toString('hex')}:${encrypted}:${tag.toString('hex')}`;
  } catch (error) {
    console.error('[ENCRYPTION] Error encrypting data:', error.message);
    throw new Error('Failed to encrypt data');
  }
}

/**
 * Decrypt sensitive data
 * @param {string} encryptedData - Encrypted data in format iv:encryptedData:tag
 * @returns {string} Decrypted data
 */
export function decrypt(encryptedData) {
  try {
    const key = getEncryptionKey();
    const parts = String(encryptedData).split(':');

    // CBC format (iv:data) — what the workflow-provider connect flow writes for
    // BYOK keys (Prospeo/Apollo/MillionVerifier/NeverBounce). Must be handled
    // here or those keys can't be read back (verify saw "no verifier connected").
    if (parts.length === 2 && /^[0-9a-f]{32}$/i.test(parts[0])) {
      const decipher = crypto.createDecipheriv('aes-256-cbc', key, Buffer.from(parts[0], 'hex'));
      return decipher.update(parts[1], 'hex', 'utf8') + decipher.final('utf8');
    }

    // GCM format (iv:data:tag).
    if (parts.length === 3) {
      const iv = Buffer.from(parts[0], 'hex');
      const tag = Buffer.from(parts[2], 'hex');
      const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
      decipher.setAuthTag(tag);
      return decipher.update(parts[1], 'hex', 'utf8') + decipher.final('utf8');
    }

    throw new Error('Invalid encrypted data format');
  } catch (error) {
    console.error('[ENCRYPTION] Error decrypting data:', error.message);
    throw new Error('Failed to decrypt data');
  }
}

/**
 * Generate a secure encryption key (for setup/documentation)
 * Run this once and save the output to ENCRYPTION_KEY env var
 */
export function generateEncryptionKey() {
  const key = crypto.randomBytes(32); // 256 bits
  return key.toString('hex');
}

export default {
  encrypt,
  decrypt,
  generateEncryptionKey,
};
