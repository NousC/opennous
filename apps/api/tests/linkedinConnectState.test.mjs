// The public LinkedIn callback trusts only a redirect we signed (GET-247).
//
// Run: cd apps/api && node --test tests/linkedinConnectState.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.ENCRYPTION_KEY = 'a'.repeat(64);
const { connectStateQuery, connectStateValid } = await import('../src/cloud/lib/linkedinConnectState.mjs');

const WS = '11111111-1111-4111-8111-111111111111';
const OTHER = '44444444-4444-4444-8444-444444444444';
const REP = '33333333-3333-4333-8333-333333333333';
const parse = (q) => Object.fromEntries(new URLSearchParams(q));

test('a redirect we signed is accepted', () => {
  assert.equal(connectStateValid(parse(connectStateQuery(WS, REP))), true);
  assert.equal(connectStateValid(parse(connectStateQuery(WS, null))), true);
});

test('no signature, as the callback accepted until now, is refused', () => {
  assert.equal(connectStateValid({ workspace_id: WS, owner_user_id: REP }), false);
});

test('changing the workspace or the owner breaks the signature', () => {
  const state = parse(connectStateQuery(WS, REP));
  assert.equal(connectStateValid({ ...state, workspace_id: OTHER }), false);
  assert.equal(connectStateValid({ ...state, owner_user_id: OTHER }), false);
});

test('an expired redirect is refused, and the expiry cannot be extended', () => {
  const state = parse(connectStateQuery(WS, REP, Date.now() - 2 * 60 * 60 * 1000));
  assert.equal(connectStateValid(state), false);
  assert.equal(connectStateValid({ ...state, expires: String(Date.now() + 1000) }), false);
});

test('a repeated parameter is refused', () => {
  const state = parse(connectStateQuery(WS, REP));
  assert.equal(connectStateValid({ ...state, sig: [state.sig] }), false);
});
