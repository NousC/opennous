// With a signing key on the connection, an unsigned delivery is a forgery, not an old sender
// (GET-247). Dropping the headers used to skip the check.
//
// Run: cd apps/worker && node --test tests/webhookSignatureRequired.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { verifyStandardWebhook, UNREADABLE_KEY } from '../src/webhooks/standardWebhook.mjs';

const secret = 'whsec_' + Buffer.from('signing-key').toString('base64');
const body = '{"ok":true}';
const now = () => String(Math.floor(Date.now() / 1000));
const signed = (id, ts, b = body) => `v1,${createHmac('sha256', Buffer.from('signing-key')).update(`${id}.${ts}.${b}`).digest('base64')}`;

test('a correct signature passes', () => {
  const ts = now();
  assert.equal(verifyStandardWebhook(secret, body, 'm1', ts, signed('m1', ts)), true);
});

test('no key configured stays open, as before', () => {
  assert.equal(verifyStandardWebhook(null, body, null, null, null), true);
});

test('a key configured and any header missing is refused', () => {
  const ts = now();
  assert.equal(verifyStandardWebhook(secret, body, null, null, null), false);
  assert.equal(verifyStandardWebhook(secret, body, 'm1', ts, null), false);
  assert.equal(verifyStandardWebhook(secret, body, null, ts, signed('m1', ts)), false);
});

test('a wrong body or an old timestamp is refused', () => {
  const ts = now();
  assert.equal(verifyStandardWebhook(secret, '{"ok":false}', 'm1', ts, signed('m1', ts)), false);
  const old = String(Math.floor(Date.now() / 1000) - 900);
  assert.equal(verifyStandardWebhook(secret, body, 'm1', old, signed('m1', old)), false);
});

test('a key we cannot decrypt refuses everything', () => {
  const ts = now();
  assert.equal(verifyStandardWebhook(UNREADABLE_KEY, body, 'm1', ts, signed('m1', ts)), false);
  assert.equal(verifyStandardWebhook(UNREADABLE_KEY, body, null, null, null), false);
});
