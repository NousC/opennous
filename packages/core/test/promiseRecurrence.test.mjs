// A promise made twice is a different fact from two promises.
//
// The count IS the product here — someone will look at "promised 3 times, still open" and pick up
// the phone. So these tests care as much about what does NOT cluster as what does. A recurrence
// counter that merges "send the deck" with "send the contract" does not degrade gracefully; it
// tells someone a lie in a confident voice.
//
// Run: node --test packages/core/test/promiseRecurrence.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  promiseTokens, promiseSimilarity, clusterPromises, countRepeatedPromises, PROMISE_MATCH_THRESHOLD,
} from '../dist/services/promiseRecurrence.js';

const p = (title, at = '2026-01-01', owner_kind = 'user') => ({ title, at, owner_kind });

test('the same promise, reworded, is one promise', () => {
  const n = countRepeatedPromises([
    p('Send the export fix', '2026-01-01'),
    p("I'll send over the export fix", '2026-02-01'),
    p('Sending the export fix to them', '2026-03-01'),
  ]);
  assert.equal(n, 1, 'three sayings of one thing is one broken promise, not three');
});

test('different promises stay different', () => {
  // The failure that would make this feature untrustworthy: everything collapsing into one
  // cluster because "send" is common.
  const clusters = clusterPromises([
    p('Send the deck'), p('Send the contract'), p('Send the pricing sheet'),
  ]);
  assert.equal(clusters.length, 3);
  assert.equal(countRepeatedPromises([p('Send the deck'), p('Send the contract')]), 0);
});

test('a promise said once is not a repeat', () => {
  assert.equal(countRepeatedPromises([p('Send the export fix')]), 0);
  assert.equal(countRepeatedPromises([]), 0);
});

test('one thing promised three times counts once', () => {
  // Counting rows would say 3 and make one account look like three problems.
  const clusters = clusterPromises([
    p('Fix the mobile layout', '2026-01-01'),
    p('Fix the mobile layout', '2026-02-01'),
    p('Fix the mobile layout', '2026-03-01'),
  ]);
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].count, 3);
  assert.equal(countRepeatedPromises(clusters.map(c => c.items).flat()), 1);
});

test('the cluster knows when it was first and last said', () => {
  // "Promised in January, still promising in March" is the sentence this enables. Without an
  // order it cannot be said, and most commitments carry no explicit recorded_at.
  const [c] = clusterPromises([
    p('Share the MVP build', '2026-03-09'),
    p('Share the MVP build', '2026-01-04'),
    p('Share the MVP build', '2026-02-11'),
  ]);
  assert.equal(c.first_at, '2026-01-04');
  assert.equal(c.last_at, '2026-03-09');
});

test('their promise and our promise are never the same promise', () => {
  // Identical words, opposite obligations. Merging them would put the customer's homework into
  // a rep's broken-promise count.
  const n = countRepeatedPromises([
    p('Send the signed order form', '2026-01-01', 'user'),
    p('Send the signed order form', '2026-02-01', 'prospect'),
  ]);
  assert.equal(n, 0);
});

test('a closed promise made again still counts — it is the worst case, not an error', () => {
  // The naive reading is "count the open ones". That misses exactly the pattern worth catching:
  // we marked it done, and they asked for it again.
  const n = countRepeatedPromises([
    { title: 'Send the export fix', at: '2026-01-01', owner_kind: 'user' },   // long since closed
    { title: 'Send the export fix', at: '2026-04-01', owner_kind: 'user' },   // and promised again
  ]);
  assert.equal(n, 1);
});

test('filler words do not make two promises look alike', () => {
  // "I'll get back to you" and "I'll get you the numbers" share every stopword and no content.
  assert.equal(countRepeatedPromises([p('Get back to you'), p('Get you the numbers')]), 0);
});

test('a title with no content words cannot be matched on', () => {
  // Better to count nothing than to cluster every piece of courtesy together.
  assert.equal(clusterPromises([p('to the'), p('and the')]).length, 0);
});

test('similarity is symmetric and bounded', () => {
  const a = promiseTokens('send the export fix'), b = promiseTokens('send over the export fix to Tobin');
  assert.equal(promiseSimilarity(a, b), promiseSimilarity(b, a));
  assert.ok(promiseSimilarity(a, b) >= PROMISE_MATCH_THRESHOLD);
  assert.equal(promiseSimilarity(a, a), 1);
  assert.equal(promiseSimilarity(a, new Set()), 0);
});

test('verb tense does not split a promise', () => {
  // send / sending / sent must be one verb, or every restatement reads as new.
  const t = (s) => [...promiseTokens(s)];
  assert.deepEqual(t('sending the report'), t('sent the report'));
  assert.deepEqual(t('sending the report'), t('send the report'));
});

test('nulls and junk do not throw', () => {
  // These arrive from a model, through a database.
  assert.equal(countRepeatedPromises([{ title: null }, { title: undefined }, { title: '' }]), 0);
  assert.equal(promiseTokens(null).size, 0);
});

// ── Cases in the shape of prod titles, 2026-09-18 ────────────────────────────
//
// Fixtures agree with whoever wrote them. These follow real `action_item` titles from the
// workspace, including the pairs a human can see are the same promise and the pairs that
// merely look alike. If the threshold is ever tuned, this is what says whether it got better.

test('a promise restated a day later clusters', () => {
  assert.equal(countRepeatedPromises([
    p('Review the materials/proposal', '2026-08-13', 'prospect'),
    p('Review the materials', '2026-08-14', 'prospect'),
  ]), 1);
  assert.equal(countRepeatedPromises([
    p('Book a meeting/call', '2026-08-13', 'prospect'),
    p('Book a meeting', '2026-08-14', 'prospect'),
  ]), 1);
});

test('the order form chased twice clusters, and signing it is a different promise', () => {
  const clusters = clusterPromises([
    p('Send order form to sign', '2026-09-14T19:05', 'prospect'),
    p('Send order form to user for signature', '2026-09-14T19:10', 'prospect'),
    p('Sign order form', '2026-09-14T19:05', 'user'),
    p('Sign order form before kickoff', '2026-09-14T19:10', 'user'),
  ]);
  assert.equal(clusters.length, 2, 'sending it and signing it are two obligations');
  assert.ok(clusters.every(c => c.count === 2));
});

test('identical words on opposite sides stay two promises', () => {
  // "Chat on Wednesday" was filed against both parties off one call. Merging them would show
  // a repeat where there is only a mutual agreement.
  assert.equal(countRepeatedPromises([
    p('Chat on Wednesday', '2026-09-14T19:05', 'prospect'),
    p('Chat on Wednesday', '2026-09-14T19:10', 'user'),
  ]), 0);
});

test('two different things to send are not one promise', () => {
  // The failure mode that would make this useless: "send" carrying the match on its own.
  assert.equal(countRepeatedPromises([
    p('Send details on the annual plan', '2026-09-10'),
    p('Send details on warehouse rollout for team', '2026-09-10'),
    p('Share a sample report', '2026-09-10'),
  ]), 0);
});

test('long narrative titles do not collapse into each other', () => {
  // Meeting-derived commitments run to 150 characters and share a lot of business vocabulary.
  // These four are genuinely distinct and must stay so.
  assert.equal(countRepeatedPromises([
    p('Continue improving the import wizard and in-app help text to simplify spreadsheet setup and inventory data upload', '2026-07-20'),
    p('Assist with the pricing page rewrite and layout suggestions, especially around the plan comparison table and footer', '2026-07-20'),
    p('Prepare a detailed rollout plan for the second warehouse and the returns desk; send to Theo for review and sign-off', '2026-07-20'),
    p('Refine the quarterly reporting pack focusing on delivery delays; draft supplier scorecards covering lead times, defects and cost trends', '2026-07-20'),
  ]), 0);
});

test('containment needs two shared words, or one verb swallows the account', () => {
  // Containment is 1.0 for any single word sitting inside a longer title. Without the floor,
  // "Send" would absorb every promise that contains it and the account would report one giant
  // repeated commitment.
  assert.equal(countRepeatedPromises([
    p('Send'), p('Send the revised pricing sheet to procurement'),
  ]), 0);
});

test('prefix matching stops short of absurdity', () => {
  // sign/signature must match; app/approval must not. Four characters is where that line sits.
  assert.ok(promiseSimilarity(promiseTokens('sign NDA'), promiseTokens('signature NDA')) > 0.9);
  assert.equal(countRepeatedPromises([p('App walkthrough'), p('Approval walkthrough')]), 0);
});
