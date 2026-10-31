// An inbound webhook needs a token, or a provider on the rollout's grace list (GET-1088).
//
// Run: cd apps/worker && node --test tests/inboundToken.test.mjs

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.ENCRYPTION_KEY = 'a'.repeat(64);
const { inboundToken, inboundTokenValid } = await import('@nous/core');
const { inboundTrusted, inboundAllowed, untrustedFirefliesBody } = await import('../src/webhooks/inboundGate.mjs');

const WS = '11111111-1111-4111-8111-111111111111';
const OTHER = '44444444-4444-4444-8444-444444444444';
const req = (token) => ({ query: token === undefined ? {} : { token } });

beforeEach(() => { delete process.env.INBOUND_TOKEN_GRACE; });

test('a token is bound to its provider and workspace', () => {
  const t = inboundToken('instantly', WS);
  assert.equal(inboundTokenValid('instantly', WS, t), true);
  assert.equal(inboundTokenValid('heyreach', WS, t), false);
  assert.equal(inboundTokenValid('instantly', OTHER, t), false);
  assert.equal(inboundTokenValid('instantly', WS, [t]), false);
});

test('a provider off the grace list needs its token', () => {
  assert.equal(inboundAllowed(req(), 'rb2b', WS), false);
  assert.equal(inboundAllowed(req('nope'), 'rb2b', WS), false);
  assert.equal(inboundAllowed(req(inboundToken('rb2b', WS)), 'rb2b', WS), true);
});

test('the grace list lets a tokenless delivery through, for that provider only', () => {
  process.env.INBOUND_TOKEN_GRACE = 'instantly, fireflies';
  assert.equal(inboundAllowed(req(), 'instantly', WS), true);
  assert.equal(inboundAllowed(req(), 'fireflies', WS), true);
  assert.equal(inboundAllowed(req(), 'rb2b', WS), false);
  assert.equal(inboundTrusted(req(), 'instantly', WS), false);
});

test('a wrong token is refused even on the grace list: no old sender sends one', () => {
  process.env.INBOUND_TOKEN_GRACE = 'instantly';
  assert.equal(inboundAllowed(req('forged'), 'instantly', WS), false);
});

test('a refused delivery leaves a trace', () => {
  const warned = [];
  const original = console.warn;
  console.warn = (m) => warned.push(m);
  try { inboundAllowed(req(), 'rb2b', WS); } finally { console.warn = original; }
  assert.match(warned[0], /refused/);
});

test('an untrusted Fireflies body keeps the meeting id and loses what it could inject', () => {
  const body = untrustedFirefliesBody({
    meetingId: 'm1', eventType: 'Transcription completed', participants: ['a@x.co'],
    transcript_text: 'forged', title: 'forged', resolveToEntityId: 'e1',
  });
  assert.deepEqual(body, { meetingId: 'm1', eventType: 'Transcription completed' });
});
