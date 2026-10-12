// The org chart labelled people by a regex on their job title while ignoring the one claim
// category that exists to say what their decision power is.
//
// titleRead.ts already stated the rule it was breaking: "Anything evidence-based (a CHAMPIONS
// edge, a budget-holder statement) always wins over the title." The edge half was wired. The
// budget-holder statement was not.
//
// These tests pin the rule that picks a role from what was said — and, as much, what it
// refuses to pick.
//
// Run: node --test packages/core/tests/authorityRole.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { roleFromAuthorityClaims, COMMITTEE_ROLE_RANK } from '../dist/services/committee.js';

const claim = (role) => ({ value: { category: 'authority', metadata: role === undefined ? {} : { role } } });

test('the stated role is the role', () => {
  assert.equal(roleFromAuthorityClaims([claim('economic_buyer')]), 'economic_buyer');
});

test('nothing said is null, not a guess', () => {
  // The whole point of the change is that silence stays silence. A person we have heard
  // nothing about must fall through to the title, not be assigned a role here.
  assert.equal(roleFromAuthorityClaims([]), null);
  assert.equal(roleFromAuthorityClaims([claim(undefined)]), null);
});

test('a role outside the vocabulary is dropped, never coerced', () => {
  // The vocabulary is exactly what the org chart can badge. A model returning "end_user" or
  // "influencer" is returning something true that nothing can display, and quietly mapping it
  // to a neighbouring role would put a badge on a person nobody described that way.
  for (const bogus of ['end_user', 'influencer', 'buyer', 'CHAMPION', '', null, 42]) {
    assert.equal(roleFromAuthorityClaims([claim(bogus)]), null, `${bogus} should not survive`);
  }
});

test('the strongest role wins when several were said', () => {
  // Someone can be described as a decision maker on one call and a champion on the next.
  // Both are true; champion is the one that changes what you do next.
  assert.equal(roleFromAuthorityClaims([claim('decision_maker'), claim('champion')]), 'champion');
  assert.equal(roleFromAuthorityClaims([claim('champion'), claim('decision_maker')]), 'champion');
  assert.equal(roleFromAuthorityClaims([claim('technical'), claim('blocker')]), 'blocker');
});

test('a blocker outranks an economic buyer', () => {
  // Deliberate. Someone who holds the budget AND is blocking is a blocker — that is the fact
  // that decides the next move, and the budget is why it matters.
  assert.equal(roleFromAuthorityClaims([claim('economic_buyer'), claim('blocker')]), 'blocker');
});

test('the ranking covers every role the vocabulary allows', () => {
  // A role the extractor may emit but the ranking does not know would be silently dropped by
  // the `role in COMMITTEE_ROLE_RANK` check — the failure would look like "we never heard".
  for (const role of ['economic_buyer', 'decision_maker', 'champion', 'blocker', 'technical']) {
    assert.equal(typeof COMMITTEE_ROLE_RANK[role], 'number', `${role} has no rank`);
    assert.equal(roleFromAuthorityClaims([claim(role)]), role);
  }
});

test('malformed rows do not throw', () => {
  // These come from a model over a database. Null, a missing value, a metadata that is a
  // string — all reachable, none worth a 500 on an account page.
  assert.equal(roleFromAuthorityClaims([null, undefined, {}, { value: null }, { value: { metadata: 'x' } }]), null);
});
