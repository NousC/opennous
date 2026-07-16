/**
 * Webhook HMAC signature verification unit tests — pure crypto, no network.
 * Tests the same logic used in apps/worker/src/webhooks/index.mjs verifyHmac().
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

function verifyHmac(body, sig, secret) {
  if (!sig || !secret) return false;
  const expected = `sha256=${crypto.createHmac('sha256', secret).update(JSON.stringify(body)).digest('hex')}`;
  try { return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected)); }
  catch { return false; }
}

function sign(body, secret) {
  return `sha256=${crypto.createHmac('sha256', secret).update(JSON.stringify(body)).digest('hex')}`;
}

const SECRET = 'test-webhook-secret-abc123';
const BODY   = { event: 'invitee.created', payload: { email: 'alice@example.com' } };

// ── Valid signatures ───────────────────────────────────────────────────────────

test('correct signature passes', () => {
  assert.ok(verifyHmac(BODY, sign(BODY, SECRET), SECRET));
});

test('x-hub-signature-256 format (sha256=...) is supported', () => {
  const sig = sign(BODY, SECRET);
  assert.ok(sig.startsWith('sha256='));
  assert.ok(verifyHmac(BODY, sig, SECRET));
});

// ── Tampered inputs ────────────────────────────────────────────────────────────

test('wrong secret → false', () => {
  assert.ok(!verifyHmac(BODY, sign(BODY, 'wrong-secret'), SECRET));
});

test('tampered body → false', () => {
  const tampered = { ...BODY, payload: { email: 'hacker@evil.com' } };
  assert.ok(!verifyHmac(tampered, sign(BODY, SECRET), SECRET));
});

test('empty body vs non-empty signature → false', () => {
  assert.ok(!verifyHmac({}, sign(BODY, SECRET), SECRET));
});

// ── Missing / empty values ─────────────────────────────────────────────────────

test('missing signature (null) → false', () => {
  assert.ok(!verifyHmac(BODY, null, SECRET));
});

test('missing signature (empty string) → false', () => {
  assert.ok(!verifyHmac(BODY, '', SECRET));
});

test('missing secret (null) → false', () => {
  assert.ok(!verifyHmac(BODY, sign(BODY, SECRET), null));
});

test('missing secret (empty string) → false', () => {
  assert.ok(!verifyHmac(BODY, sign(BODY, SECRET), ''));
});

// ── Timing-safe length mismatch ────────────────────────────────────────────────

test('short/truncated signature → false (no throw)', () => {
  // timingSafeEqual throws if lengths differ — verifyHmac must catch and return false
  assert.ok(!verifyHmac(BODY, 'sha256=abc', SECRET));
});

test('signature without sha256= prefix → false', () => {
  const raw = crypto.createHmac('sha256', SECRET).update(JSON.stringify(BODY)).digest('hex');
  assert.ok(!verifyHmac(BODY, raw, SECRET)); // length different from "sha256=<hex>"
});

// ── Calendly / Instantly / RB2B event shapes ──────────────────────────────────

test('flat Calendly payload verifies correctly', () => {
  const body = { event: 'invitee.created', invitee: { email: 'bob@example.com', name: 'Bob' } };
  assert.ok(verifyHmac(body, sign(body, SECRET), SECRET));
});

test('Instantly email_sent payload verifies correctly', () => {
  const body = { event_type: 'email_sent', lead_email: 'prospect@company.com', sequence_id: 'seq-1' };
  assert.ok(verifyHmac(body, sign(body, SECRET), SECRET));
});
