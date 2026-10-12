// The pronoun guard, pinned.
//
// This guard shipped in two byte-identical copies with no test in either app, and spent
// its whole life silently dropping every fact containing "F&I" — in an automotive
// workspace, where that is most finance conversations. The drop is a console.warn and a
// `continue`, so nothing downstream could notice: the write path reported success for a
// batch it had refused part of.
//
// The failing case is first. Everything after it is the behaviour that must survive the
// fix, because a guard that stops catching real inversions is worse than the bug.
//
// Run: node --test packages/core/test/pronounGuard.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { violatesPronounRule } from '../dist/text/pronounGuard.js';

test('GET-368: an initialism ending in I is not a first-person pronoun', () => {
  // The exact content that vanished from a real record call, twice, deterministically.
  assert.equal(violatesPronounRule('Dealership runs F&I products through Corbelline'), false);
  assert.equal(violatesPronounRule('F&I manager handles the paperwork'), false);
  // Same shape, different separator — the reason the fix is "free-standing token"
  // rather than "also allow &".
  assert.equal(violatesPronounRule('Tracks R.O.I on every campaign'), false);
  assert.equal(violatesPronounRule('Banks with AT&I for floorplan'), false);
  assert.equal(violatesPronounRule('Uses I&K Lending for floorplan financing'), false);
});

test('the real inversion still drops', () => {
  // This is what the guard is FOR: the model writing as the contact instead of about
  // them. If these ever pass, the fix has gone too far.
  assert.equal(violatesPronounRule('my CEO will decide by Friday'), true);
  assert.equal(violatesPronounRule('I will bring the CFO to the next call'), true);
  assert.equal(violatesPronounRule('Owner found you after viewing your profile'), true);
  assert.equal(violatesPronounRule('mine is the final signature on the contract'), true);
  assert.equal(violatesPronounRule('Wants to move fast, but I need budget approval'), true);
});

test('compounds and proper names are not pronouns', () => {
  assert.equal(violatesPronounRule('Prefers a done-for-you onboarding'), false);
  assert.equal(violatesPronounRule('On a pay-as-you-go plan'), false);
  assert.equal(violatesPronounRule('Books through My Studio for detailing'), false);
  assert.equal(violatesPronounRule('Runs Mine Safety Appliances as a vendor'), false);
});

test('a pronoun inside a quoted span is the contact speaking, not the model', () => {
  // The quote is the evidence; it is allowed to contain anything the person said.
  assert.equal(
    violatesPronounRule(`Stated he is 'keen to try every report before I commit to anything'`),
    false,
  );
  assert.equal(
    violatesPronounRule('Said "I will not sign until legal reviews it" on the call'),
    false,
  );
  // Contractions inside a quote must not close the span early and leak the rest.
  assert.equal(
    violatesPronounRule(`Said 'I'm not the one who signs, my director is' during the review`),
    false,
  );
});

test('first person plural is the workspace, never flagged', () => {
  // "us"/"our"/"we" mean Nous or the seat's own company — legitimate in a claim.
  assert.equal(violatesPronounRule('Asked us to hold pricing until Q3'), false);
  assert.equal(violatesPronounRule('Sees our portal as the system of record'), false);
  assert.equal(violatesPronounRule('Wants we-do-it-for-them onboarding'), false);
});

test('non-strings are not content', () => {
  for (const v of [null, undefined, 42, {}, []]) {
    assert.equal(violatesPronounRule(v), false, String(v));
  }
});

test('the guard is case-sensitive, because capitals are names', () => {
  // "My" and "Mine" at the head of a name must not read as pronouns, while the bare
  // lowercase pronoun must.
  assert.equal(violatesPronounRule('My Studio is their detailing vendor'), false);
  assert.equal(violatesPronounRule('my studio is where the deal happens'), true);
});
