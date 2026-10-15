import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ownerFilter } from '../src/lib/ownerScope.mjs';
import { accountWindowFilter, lostCutoffISO, activityCutoff } from '../src/lib/dealListWindow.mjs';

// The two predicates that decide what a rep sees. Pure: no DB.
//
// The invariant under all of them is that an ABSENT answer is not a restrictive one. A viewer we
// could not map to a CRM owner reads the workspace; only a viewer we DID map gets narrowed. The
// opposite — an unmapped rep seeing nothing — is indistinguishable from data loss and is how a
// scoping feature destroys trust on its first morning.

const NOW = new Date('2026-09-20T00:00:00.000Z');

test('no resolved owner means no filter, never an empty list', () => {
  assert.equal(ownerFilter(null), null);
  assert.equal(ownerFilter(undefined), null);
  assert.equal(ownerFilter({ names: [], emails: [] }), null);
});

test('an account is yours by owner name or owner email', () => {
  const f = ownerFilter({ names: ['Rhea Moss'], emails: ['rhea@example.com'] });
  assert.ok(f.includes('owner_name.in.("Rhea Moss")'));
  assert.ok(f.includes('owner_email.in.("rhea@example.com")'));
});

test('there is ONE ownership edge — no role-named second owner', () => {
  // A `cs_owner` fed by one portal's custom property would put a job title in the schema. What
  // separates sales from customer success is the PIPELINE a deal is in: the same reps hold both,
  // and one rep can own deals in a Sales pipeline and an Expansion pipeline at once.
  const f = ownerFilter({ names: ['Rhea Moss'], emails: ['rhea@example.com'] });
  assert.ok(!f.includes('cs_owner'));
  assert.equal(f.split(',').length, 2);
});

test('names are quoted, because a CRM name may hold a comma or a paren', () => {
  const f = ownerFilter({ names: ['Smith, John', 'Acme (West)'], emails: [] });
  // Unquoted, `Smith, John` would read as two owners and `(West)` would break the group.
  assert.equal(f, 'owner_name.in.("Smith, John","Acme (West)")');
});

test('an embedded quote cannot break out of the list', () => {
  const f = ownerFilter({ names: ['He said "hi"'], emails: [] });
  assert.equal(f, 'owner_name.in.("He said hi")');
});

test('an account earns its place by holding a deal the lists show, or by being worked now', () => {
  const f = accountWindowFilter(NOW);
  // The activity clause was added after this shipped: the deal rules alone hid hundreds of Harborline
  // accounts touched in the previous week, most of them with real two-way contact. See
  // ACTIVITY_WINDOW_DAYS.
  assert.equal(
    f,
    `open_deals.gt.0,won_deals.gt.0,child_deals.gt.0,last_lost_at.gte.${lostCutoffISO(NOW)},`
      + `last_activity_at.gte.${activityCutoff(NOW).toISOString()}`,
  );
});

test('the company-group exception is part of that rule, not an afterthought', () => {
  // Quillmere Holdings holds no deals; its branches do. Many of Harborline's group parents
  // are in that shape, and without child_deals the rule hides the record a rep assigns at.
  assert.ok(accountWindowFilter(NOW).includes('child_deals.gt.0'));
});

test('won is counted by rows, not by money', () => {
  // Some accounts have a won deal carrying no amount. Keying on won_value would drop them.
  assert.ok(accountWindowFilter(NOW).includes('won_deals.gt.0'));
  assert.ok(!accountWindowFilter(NOW).includes('won_value'));
});
