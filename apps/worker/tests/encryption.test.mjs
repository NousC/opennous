/**
 * Encryption unit tests — pure, no Supabase or network calls needed.
 * Tests both AES-256-GCM (worker format) and AES-256-CBC (API format) decryption.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

// Set test key BEFORE dynamic import so the module-level KEY buffer is populated
process.env.ENCRYPTION_KEY ??= 'deadbeef'.repeat(8); // 64 hex chars = 32 bytes

const { encrypt, decrypt } = await import('../src/utils/encryption.mjs');

// ── GCM encrypt output format ──────────────────────────────────────────────────

test('encrypt returns iv:tag:ciphertext (3 parts, all hex)', () => {
  const enc = encrypt('hello');
  const parts = enc.split(':');
  assert.equal(parts.length, 3);
  assert.match(parts[0], /^[0-9a-f]{24}$/, 'iv should be 12-byte hex (24 chars)');
  assert.match(parts[1], /^[0-9a-f]{32}$/, 'tag should be 16-byte hex (32 chars)');
  assert.match(parts[2], /^[0-9a-f]+$/,    'ciphertext should be hex');
});

test('encrypt produces unique ciphertext on each call (random IV)', () => {
  const a = encrypt('same plaintext');
  const b = encrypt('same plaintext');
  assert.notEqual(a, b);
});

// ── GCM round-trip ─────────────────────────────────────────────────────────────

test('decrypt(encrypt(x)) === x — short string', () => {
  const plain = 'secret';
  assert.equal(decrypt(encrypt(plain)), plain);
});

test('decrypt(encrypt(x)) === x — OAuth token', () => {
  const token = 'xoxp-1234567890-abcdefghij-slacktokenvalue';
  assert.equal(decrypt(encrypt(token)), token);
});

test('decrypt(encrypt(x)) === x — URL with special chars', () => {
  const url = 'https://api.example.com/oauth?code=abc&state=xyz#fragment';
  assert.equal(decrypt(encrypt(url)), url);
});

// ── Passthrough — non-encrypted values ────────────────────────────────────────

test('decrypt(undefined) → undefined', () => {
  assert.equal(decrypt(undefined), undefined);
});

test('decrypt(null) → null', () => {
  assert.equal(decrypt(null), null);
});

test('decrypt(number) → number', () => {
  assert.equal(decrypt(42), 42);
});

test('decrypt of plain URL returns as-is (no colon pattern)', () => {
  // URLs contain colons but don't match the iv:tag:data or iv:data patterns
  assert.equal(decrypt('https://slack.com/api/auth'), 'https://slack.com/api/auth');
});

test('decrypt of single-word string returns as-is', () => {
  assert.equal(decrypt('plaintext'), 'plaintext');
});

// ── CBC format (API-stored credentials) ───────────────────────────────────────

test('CBC-encrypted value (API format) decrypts correctly', () => {
  const CBC_KEY = Buffer.from(process.env.ENCRYPTION_KEY.slice(0, 64).padEnd(64, '0'), 'hex');
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', CBC_KEY, iv);
  const cbcEncrypted = iv.toString('hex') + ':' + cipher.update('ya29.google-access-token', 'utf8', 'hex') + cipher.final('hex');

  assert.match(cbcEncrypted, /^[0-9a-f]{32}:[0-9a-f]+$/);
  assert.equal(decrypt(cbcEncrypted), 'ya29.google-access-token');
});

test('CBC decryption works for Slack tokens', () => {
  const CBC_KEY = Buffer.from(process.env.ENCRYPTION_KEY.slice(0, 64).padEnd(64, '0'), 'hex');
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', CBC_KEY, iv);
  const cbcEncrypted = iv.toString('hex') + ':' + cipher.update('xoxp-slack-user-token', 'utf8', 'hex') + cipher.final('hex');

  assert.equal(decrypt(cbcEncrypted), 'xoxp-slack-user-token');
});
