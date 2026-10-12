// A claim about the customer may only quote the customer (GET-329).
//
// A transcript has one text. A thread has two, and that breaks an assumption every guard in the
// claims path was built on: that the text the model READ and the text a claim may REST ON are the
// same thing. On a thread they are not. We restate the customer back to them constantly —
// "as you mentioned, your finance team needs the import fix" — and a model reading the whole thread
// will file that as something THEY said, with a quote that is verbatim, passes every check, and is
// attributed to the wrong side.
//
// That is worse than an ungrounded claim. An ungrounded claim is visibly weak; this one looks like
// evidence, and it is the email version of the bug that filed calls onto the seller's own employees.
//
// These tests pin the narrowing. The model still reads the whole thread — it has to, or a reply
// means nothing — only what a claim may speak for is cut down.
//
// Run: node --test apps/worker/tests/twoSidedGrounding.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sideBlocks, theirSideOf, groundFacts, groundQuote } from '../src/noema/grounding.mjs';

// One thread, as the Gmail Read renders it: a header line per message, then the written body.
const THREAD = `--- them · marisol@tidewell.example · 2026-09-16 ---
Turns out the mix-up was ours. We sent two test orders this morning with the same reference.
In our tracker only the second one has the delivery note attached.

--- us · ezra@harborline.example · 2026-09-16 ---
As you mentioned, your finance team needs the import fix before the pilot can start.
We can have that out this week.

--- them · marisol@tidewell.example · 2026-09-17 ---
That works. Let's do the 15th.`;

test('their side is their messages, ours is ours', () => {
  const theirs = theirSideOf(THREAD);
  assert.ok(theirs.includes('Turns out the mix-up was ours'));
  assert.ok(theirs.includes("Let's do the 15th"));
  assert.ok(!theirs.includes('your finance team needs the import fix'), 'our sentence is not theirs');

  const ours = sideBlocks(THREAD, 'us');
  assert.ok(ours.includes('your finance team needs the import fix'));
  assert.ok(!ours.includes('Turns out'));
});

test('OUR sentence cannot ground a claim about them — the whole point', () => {
  const quote = 'your finance team needs the import fix';

  // It is genuinely in the thread. Grounded against the whole thread it passes, and the claim reads
  // as something the customer told us. That is the bug.
  assert.ok(groundQuote(quote, THREAD), 'verbatim in the thread — which is exactly why this is a trap');

  // Grounded against their side, it is refused.
  assert.equal(groundQuote(quote, theirSideOf(THREAD)), null);
});

test('their own sentence still grounds — the guard narrows, it does not break grounding', () => {
  assert.ok(groundQuote('Turns out the mix-up was ours', theirSideOf(THREAD)));
  assert.ok(groundQuote("That works. Let's do the 15th", theirSideOf(THREAD)));
});

test('a claim survives with its misattributed quote dropped, not the claim', () => {
  const { facts, offered, grounded } = groundFacts([
    { content: "Marisol's finance team needs the import fix before the pilot starts.",
      quote: 'your finance team needs the import fix' },            // ours, restated back at them
    { content: 'Marisol confirmed the order mix-up was on their side.',
      quote: 'Turns out the mix-up was ours' },                // theirs
  ], theirSideOf(THREAD));

  assert.equal(facts.length, 2, 'a claim with an unverified quote is still a claim');
  assert.equal(facts[0].quote, null, 'our sentence is not stored as their evidence');
  assert.equal(facts[1].quote, 'Turns out the mix-up was ours');
  assert.equal(offered, 2);
  assert.equal(grounded, 1);
});

test('text with no side headers grounds nothing — fails closed, on purpose', () => {
  // Returning the text whole would silently restore the behaviour this exists to prevent. The
  // closed direction shows up as a 0% grounding rate on the email line in the weekly read; the
  // open one shows up as nothing at all, which is the direction that has actually cost us.
  const plain = 'Baptiste Ormsby: Getting the Lumen Quote export into our warehouse sheet matters a lot.';
  assert.equal(theirSideOf(plain), '');
  assert.equal(groundQuote('Getting the Lumen Quote export into our warehouse sheet', theirSideOf(plain)), null);
});

test('a header with no body contributes nothing, and does not leak the next block', () => {
  const empty = `--- them · a@b.example · 2026-09-16 ---

--- us · c@d.example · 2026-09-16 ---
Our only sentence here.`;
  assert.equal(theirSideOf(empty), '');
  assert.ok(sideBlocks(empty, 'us').includes('Our only sentence here'));
});

test('malformed and missing input do not throw', () => {
  assert.equal(theirSideOf(null), '');
  assert.equal(theirSideOf(undefined), '');
  assert.equal(theirSideOf(''), '');
});
