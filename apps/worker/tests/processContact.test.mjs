// The activity is not the work.
//
// logActivity dedupes on external_id, so a meeting whose rows were written by an earlier run
// returns no row and every contact was skipped — leaving nobody external, so nothing extracted,
// and the run reported `filed 0 · already N · failed 0`.
//
// Right for an ordinary retry. Wrong whenever the rows landed and the MODEL CALLS did not: a
// credit outage, a provider 500, a container killed mid-flight. The meeting is then stranded — the
// resume check says "no claims, try it", the handler says "already seen, skip", and the loop
// repeats at any scale, reporting success each time. That happened to a handful of meetings in one
// backfill.
//
// Run: node --test apps/worker/tests/processContact.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { processContact } from '../src/webhooks/handlers/fellow.mjs';

test('a freshly logged meeting is processed', () => {
  assert.equal(processContact({ logged: true }), true);
});

test('an ordinary re-run still skips — that is the dedupe doing its job', () => {
  assert.equal(processContact({ logged: false }), false);
});

test('force processes it, as it always did', () => {
  assert.equal(processContact({ logged: false, force: true }), true);
});

test('the stranded case: rows exist, nothing was ever extracted', () => {
  // The whole reason this function exists. Without reextract this returns false and the meeting is
  // never read, no matter how many times the backfill selects it.
  assert.equal(processContact({ logged: false, force: false, reextract: true }), true);
});

test('reextract and force are independent routes to the same yes', () => {
  // force also rebuilds pages and overwrites what is there; reextract says only "do the work".
  // Neither should require the other.
  assert.equal(processContact({ logged: false, force: true, reextract: false }), true);
  assert.equal(processContact({ logged: false, force: false, reextract: true }), true);
  assert.equal(processContact({ logged: true, force: false, reextract: false }), true);
});

test('missing flags read as false, not as permission', () => {
  assert.equal(processContact({}), false);
  assert.equal(processContact({ logged: undefined, force: undefined, reextract: undefined }), false);
});
