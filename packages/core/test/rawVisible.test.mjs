// Leak-test for the per-member privacy chokepoint (PRIVACY_MODEL.md §7).
// Every leak-critical reader either calls rawVisible or mirrors its exact
// predicate at the DB level (owner_user_id IS NULL OR owner_user_id = viewer).
// So proving rawVisible's matrix + that the DB predicate matches it is the proof.
//
// Run: node --test packages/core/test/rawVisible.test.mjs  (after building core)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rawVisible } from '../dist/db/readContext.js';

const A = 'user-A';
const B = 'user-B';
const admin = { workspaceId: 'w', viewerUserId: 'owner', viewerScope: 'admin' };
const memberA = { workspaceId: 'w', viewerUserId: A, viewerScope: 'member' };

test('admin sees all raw (own, others, shared)', () => {
  assert.equal(rawVisible(A, admin), true);
  assert.equal(rawVisible(B, admin), true);
  assert.equal(rawVisible(null, admin), true);
});

test('member sees their own raw', () => {
  assert.equal(rawVisible(A, memberA), true);
});

test('member sees shared (null-owner) raw', () => {
  assert.equal(rawVisible(null, memberA), true);
  assert.equal(rawVisible(undefined, memberA), true);
});

test('member CANNOT see another rep\'s raw — the core leak guard', () => {
  assert.equal(rawVisible(B, memberA), false);
});

test('no ctx (unmigrated caller) sees all — no member to leak to', () => {
  assert.equal(rawVisible(A, undefined), true);
  assert.equal(rawVisible(B, undefined), true);
});

test('DB predicate matches rawVisible for member scope', () => {
  // The readers filter with `.or(owner_user_id.is.null, owner_user_id.eq.<viewer>)`.
  // Model it and assert it agrees with rawVisible on every owner value.
  const dbPredicate = (owner, viewer) => owner == null || owner === viewer;
  for (const owner of [A, B, null, undefined]) {
    assert.equal(
      dbPredicate(owner ?? null, A),
      rawVisible(owner, memberA),
      `mismatch for owner=${owner}`,
    );
  }
});
