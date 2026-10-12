// A quote the model did not read in the source is one it made up.
//
// Claims are the account record — what a rep reads before a call, what the briefs and the win/loss
// analysis are built from. Without a quote, a claim that a buyer "pushed back" or that something
// "matters a lot" to them cannot be checked, by hand or by machine, against what was said.
//
// These tests pin the check that makes a claim answerable. The bar is deliberately verbatim: a
// paraphrase is exactly the failure being detected, so anything that would let one through — word
// stemming, fuzzy distance, dropping short words — belongs nowhere near this file.
//
// Run: node --test apps/worker/tests/grounding.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groundQuote, groundFacts, normalizeForMatch } from '../src/noema/grounding.mjs';

const TRANSCRIPT = `Baptiste Ormsby: Getting the Lumen Quote export into our warehouse sheet every Monday matters a lot to us.
Sorrel: Understood — we can keep that export running.
Baptiste Ormsby: We tried a paper checklist last spring and it didn't go well.`;

test('a verbatim line is kept', () => {
  assert.equal(
    groundQuote('Getting the Lumen Quote export into our warehouse sheet every Monday matters a lot to us', TRANSCRIPT),
    'Getting the Lumen Quote export into our warehouse sheet every Monday matters a lot to us',
  );
});

test('a paraphrase is refused — this is the whole point', () => {
  // Close enough to read as true, not close enough to be what he said.
  assert.equal(groundQuote('The warehouse sheet export matters a great deal to them', TRANSCRIPT), null);
  assert.equal(groundQuote('He pushed back hard on the paper checklist', TRANSCRIPT), null);
});

test('an invented line is refused', () => {
  assert.equal(groundQuote('We will not renew unless this is fixed by Q3', TRANSCRIPT), null);
});

test('case, curly punctuation and wrapped whitespace do not count as invention', () => {
  // A transcript renders these differently from the way a model repeats them back; refusing those
  // would make the number measure formatting rather than honesty.
  assert.ok(groundQuote('GETTING THE LUMEN QUOTE EXPORT INTO OUR WAREHOUSE SHEET', TRANSCRIPT));
  assert.ok(groundQuote('it didn’t go well', TRANSCRIPT));          // curly apostrophe
  assert.ok(groundQuote('we tried a   paper checklist\n  last spring', TRANSCRIPT));
});

test('a quote too short to be evidence is refused', () => {
  // "the tool" appears in almost any transcript; matching it proves nothing.
  assert.equal(groundQuote('Lumen Quote', TRANSCRIPT), null);
  assert.equal(groundQuote('', TRANSCRIPT), null);
  assert.equal(groundQuote(null, TRANSCRIPT), null);
});

test('a quote longer than a passage is a paraphrase of it, not the line from it', () => {
  assert.equal(groundQuote('x'.repeat(401), 'x'.repeat(500)), null);
});

test('no source means nothing can be verified, so nothing is claimed', () => {
  assert.equal(groundQuote('Getting the Lumen Quote export into our warehouse sheet', ''), null);
  assert.equal(groundQuote('Getting the Lumen Quote export into our warehouse sheet', null), null);
});

test('facts keep their place; only unverified quotes are dropped', () => {
  const { facts, offered, grounded } = groundFacts([
    { content: 'Baptiste wants the Monday export kept.', quote: 'into our warehouse sheet every Monday' },
    { content: 'Baptiste pushed back on the paper checklist.', quote: 'he was adamant about the paper checklist' },
    { content: 'Baptiste is the decision maker.' },                       // offered nothing
  ], TRANSCRIPT);

  assert.equal(facts.length, 3, 'a claim with an unverified quote is still a claim');
  assert.equal(facts[0].quote, 'into our warehouse sheet every Monday');
  assert.equal(facts[1].quote, null, 'the unverified quote is dropped, not stored unchecked');
  assert.equal(facts[2].quote, null);
  assert.equal(offered, 2);
  assert.equal(grounded, 1);      // the honesty number, per extraction
});

test('normalisation does not stem, drop or reorder words', () => {
  // Anything that makes "we will renew" match "we will not renew" makes the measure worthless.
  assert.equal(normalizeForMatch('We will NOT renew'), 'we will not renew');
  assert.equal(groundQuote('we will renew in the spring', 'We will not renew in the spring'), null);
});
