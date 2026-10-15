import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pickOurSender } from '../scripts/backfillTaskOwners.mjs';

// Who gets blamed for a promise.
//
// This script writes an owner onto hundreds of existing tasks. Every rule below decides whether a real
// person's name appears next to work they may not have agreed to do, so each is pinned rather
// than left to the reading.

const OURS = (e) => e.endsWith('@harborline.example');

test('one address on our side is the owner', () => {
  const r = pickOurSender(['quinlan@harborline.example', 'jory.tamsin@stonebridgesoftware.example'], OURS);
  assert.equal(r.email, 'quinlan@harborline.example');
  assert.equal(r.why, null);
});

test('a display-name header still resolves', () => {
  // Mail headers arrive wrapped as often as bare, and a wrapped address that failed to match
  // would look identical to a thread with nobody on our side.
  const r = pickOurSender(['Quinlan Marsh <QUINLAN@Harborline.example>', 'someone@customer.example'], OURS);
  assert.equal(r.email, 'quinlan@harborline.example');
});

test('the same person writing five times is still one owner', () => {
  const r = pickOurSender(Array(5).fill('quinlan@harborline.example').concat('them@customer.example'), OURS);
  assert.equal(r.email, 'quinlan@harborline.example');
});

test('TWO of our people means we refuse, rather than pick the loudest', () => {
  // A handoff or a group thread. Guessing here nags a rep for someone else's promise, which is
  // worse than the honest "unassigned" the list already shows.
  const r = pickOurSender(['quinlan@harborline.example', 'perrin@harborline.example', 'them@customer.example'], OURS);
  assert.equal(r.email, null);
  assert.match(r.why, /2 our-side senders/);
});

test('a thread with nobody of ours says so, and attributes nothing', () => {
  const r = pickOurSender(['them@customer.example', 'other@customer.example'], OURS);
  assert.equal(r.email, null);
  assert.match(r.why, /no our-side sender/);
});

test('junk in the headers does not become an owner', () => {
  for (const froms of [[], null, undefined, [null, '', '   ', 'not-an-address', 42, {}]]) {
    const r = pickOurSender(froms, OURS);
    assert.equal(r.email, null, JSON.stringify(froms));
  }
});

test("the writer never names one of ours on a customer's promise", async () => {
  // taskAssignee.ts protects this on READ. This script is the write side, so it has to hold the
  // same line independently — a prospect-owned task must be skipped before any owner is stamped.
  const src = await readFile(new URL('../scripts/backfillTaskOwners.mjs', import.meta.url), 'utf8');
  const code = src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(code, /owner_kind === 'prospect'\)\s*continue/, 'prospect tasks must be skipped in the write loop');
  assert.match(code, /owner_kind === 'user'/, 'and only user-owned tasks selected in the first place');
});

test('the claim scan uses a range, not a prefix LIKE', async () => {
  // Same trap as GET-396: a prefix LIKE cannot use claims_ws_property_live and reads every claim
  // in the table. Measured roughly ten times slower, over ~25x the buffers.
  const src = await readFile(new URL('../scripts/backfillTaskOwners.mjs', import.meta.url), 'utf8');
  const code = src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/\.like\(/.test(code), 'no prefix LIKE anywhere in the script');
  assert.match(code, /\.gte\(\s*['"]property['"]/);
  assert.match(code, /\.lt\(\s*['"]property['"]/);
});

test('it writes nothing without --apply', async () => {
  const src = await readFile(new URL('../scripts/backfillTaskOwners.mjs', import.meta.url), 'utf8');
  const code = src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(code, /if\s*\(!APPLY\)\s*continue/, 'the dry run must return before recordObservation');
  // And the repair must not restamp the date, or every backfilled task looks freshly promised.
  assert.match(code, /observedAt:\s*t\.value\.recorded_at/);
});
