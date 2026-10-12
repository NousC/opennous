// Task ownership binds late, so onboarding someone hands them their history.
//
// The tempting design is a user_id stamped at creation. It cannot work here: the people who make
// commitments are usually not users yet. Harborline holds a few seats and runs its calls through
// many more host addresses, most of them not a seat. A task
// created today cannot reference an account that will not exist until someone is onboarded.
//
// So the task stores the address and the seat is resolved on read. The property that matters, and
// the one these tests exist to protect, is that the SAME stored task changes hands the moment a
// seat appears for its address — with no backfill, no migration, and no second write.
//
// Run: node --test packages/core/test/taskAssignee.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ownerOfTask, normaliseOwnerEmail } from '../dist/services/taskAssignee.js';

const NOBODY = new Map();
const WITH_WILHELMINA = new Map([['wilhelmina@harborline.example', { userId: 'u-wilhelmina', name: 'Wilhelmina Strand' }]]);

test('the same task gains an owner when a seat appears — this is the whole point', () => {
  const task = { owner_kind: 'user', owner_email: 'wilhelmina@harborline.example', owner_name: 'Wilhelmina' };

  const before = ownerOfTask(task, NOBODY);
  assert.equal(before.userId, null, 'no seat yet');
  assert.equal(before.name, 'Wilhelmina', 'but the name still shows — "Wilhelmina owes this" is useful');

  const after = ownerOfTask(task, WITH_WILHELMINA);
  assert.equal(after.userId, 'u-wilhelmina', 'onboarding binds it retroactively, same stored row');
  assert.equal(after.name, 'Wilhelmina Strand', "the seat's name wins — it is what the team uses");
});

test("a customer's promise never names one of our people", () => {
  // Filing a customer commitment against a rep nags them for work that was never theirs, which is
  // worse than showing no owner at all.
  const theirs = ownerOfTask(
    { owner_kind: 'prospect', owner_email: 'wilhelmina@harborline.example', owner_name: 'Thaddeus' },
    WITH_WILHELMINA,
  );
  assert.equal(theirs.userId, null);
  assert.equal(theirs.email, null);
  assert.equal(theirs.name, 'Thaddeus', 'their name is still worth showing');
});

test('addresses arrive from calendars and mail headers, not clean', () => {
  assert.equal(normaliseOwnerEmail('Wilhelmina Strand <WILHELMINA@harborline.example>'), 'wilhelmina@harborline.example');
  assert.equal(normaliseOwnerEmail('  Tamsin@Harborline.example  '), 'tamsin@harborline.example');
  // A bare display name is not an address and must not become a matching key.
  assert.equal(normaliseOwnerEmail('Wilhelmina Strand'), null);
  for (const junk of [null, undefined, '', '   ', 42, {}]) {
    assert.equal(normaliseOwnerEmail(junk), null, String(junk));
  }
});

test('a wrapped address still matches a seat', () => {
  const owner = ownerOfTask(
    { owner_kind: 'user', owner_email: 'Wilhelmina Strand <WILHELMINA@harborline.example>' },
    WITH_WILHELMINA,
  );
  assert.equal(owner.userId, 'u-wilhelmina');
});

test('a task with no owner email is unowned, not mis-owned', () => {
  // Every task written before this shipped looks like this. It must degrade to "nobody" rather
  // than guessing a seat — every row written before it carries no owner_email at all.
  const owner = ownerOfTask({ owner_kind: 'user', status: 'open' }, WITH_WILHELMINA);
  assert.equal(owner.userId, null);
  assert.equal(owner.email, null);
  assert.equal(owner.name, null);
});

test('junk values do not throw', () => {
  for (const v of [null, undefined, {}, { owner_kind: 'user', owner_email: 42 }]) {
    assert.doesNotThrow(() => ownerOfTask(v, WITH_WILHELMINA));
  }
});
