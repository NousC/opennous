// A key lasts 90 days unless an admin says otherwise, and a grant can be read-only (GET-1061).
//
// Run: cd apps/api && node --test tests/leastPrivilegeKeys.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { grantCapability, keyExpiry, DEFAULT_KEY_DAYS } from '../src/lib/apiKeyScope.mjs';

const NOW = Date.parse('2026-10-31T00:00:00Z');
const DAY = 86_400_000;
const inDays = (iso) => Math.round((Date.parse(iso) - NOW) / DAY);

test('a new key lasts 90 days when nothing is asked for', () => {
  assert.equal(DEFAULT_KEY_DAYS, 90);
  assert.equal(inDays(keyExpiry({}, { isAdmin: false, now: NOW })), 90);
  assert.equal(inDays(keyExpiry(undefined, { isAdmin: true, now: NOW })), 90);
});

test('an asked-for length is kept', () => {
  assert.equal(inDays(keyExpiry({ expires_in_days: 7 }, { isAdmin: false, now: NOW })), 7);
  assert.equal(inDays(keyExpiry({ expires_in_days: 365 }, { isAdmin: false, now: NOW })), 365);
});

test('a length is capped at a year, and a huge one is not an error', () => {
  assert.equal(inDays(keyExpiry({ expires_in_days: 36500 }, { isAdmin: true, now: NOW })), 365);
  assert.equal(inDays(keyExpiry({ expires_in_days: 1e9 }, { isAdmin: false, now: NOW })), 365);
});

test('only an admin can ask for no expiry', () => {
  assert.equal(keyExpiry({ expires_in_days: 0 }, { isAdmin: true, now: NOW }), null);
  assert.equal(inDays(keyExpiry({ expires_in_days: 0 }, { isAdmin: false, now: NOW })), 90);
});

test('nonsense falls back to the default, never to no expiry', () => {
  for (const v of ['soon', -3, null, NaN]) {
    assert.equal(inDays(keyExpiry({ expires_in_days: v }, { isAdmin: true, now: NOW })), 90);
  }
});

test('a grant is read/write unless read-only is asked for', () => {
  assert.equal(grantCapability({ capability: 'read_only' }), 'read_only');
  assert.equal(grantCapability({}), 'read_write');
  assert.equal(grantCapability(undefined), 'read_write');
  assert.equal(grantCapability({ capability: 'admin' }), 'read_write');
});
