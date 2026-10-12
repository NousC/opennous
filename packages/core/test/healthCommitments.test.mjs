// A commitment is a task that was never filed.
//
// The health read has always found them — "I'll send the export fix by Friday" — rendered them on the
// call page, and dropped them. Meanwhile `action_item.*` exists with a two-tier completion engine:
// deterministic rules for the common verbs (promised to email, an email followed), and for
// everything else the next conversation, where the model must quote its evidence before it may call
// anything done.
//
// Nothing connected the two. Meetings were meant to be Fireflies' job — it supplies action items in
// its own payload — and Fellow does not, so a whole backfill of meetings produced open risks and zero tasks.
//
// These tests pin the two fields that make a commitment fileable, and the default that decides what
// happens when the model does not say.
//
// Run: node --test packages/core/test/healthCommitments.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHealthReadJson, buildHealthReadPrompt } from '../dist/services/accountHealth.js';

const read = (commitments) => parseHealthReadJson(JSON.stringify({
  summary: 'A check-in.', what_changed: 'Nothing much.', adoption: 'The finance team uses it.',
  standing: 'neutral', risks: [], expansion: [], commitments,
}));

test('a commitment carries who owes it and by when', () => {
  const h = read([{ text: 'Send the export fix', quote: "I'll get that over Friday", owner: 'us', due: 'by Friday' }]);
  assert.equal(h.commitments.length, 1);
  assert.equal(h.commitments[0].owner, 'us');
  assert.equal(h.commitments[0].due, 'by Friday');
  assert.equal(h.commitments[0].quote, "I'll get that over Friday");
});

test('theirs stays theirs', () => {
  const h = read([{ text: 'Send us the DMS credentials', quote: 'I will dig those out', owner: 'them', due: '' }]);
  assert.equal(h.commitments[0].owner, 'them');
});

test('an unstated owner defaults to US, and that direction is the safe one', () => {
  // A commitment wrongly on our list gets seen and dismissed. One wrongly on theirs disappears
  // silently — and the entire point is that nothing promised on a call goes missing.
  const h = read([{ text: 'Follow up on the appraisal tool', quote: 'we should look at that' }]);
  assert.equal(h.commitments[0].owner, 'us');
});

test('an unrecognised owner is not trusted, it falls to us', () => {
  const h = read([{ text: 'Do the thing', quote: 'yes', owner: 'maybe-both', due: '' }]);
  assert.equal(h.commitments[0].owner, 'us');
});

test('no due phrase is empty, never invented', () => {
  const h = read([{ text: 'Share the training deck', quote: 'I can send that', owner: 'us' }]);
  assert.equal(h.commitments[0].due, '');
});

test('a commitment with no text is dropped — a task needs a verb', () => {
  const h = read([{ text: '', quote: 'mm', owner: 'us' }, { text: 'Send the deck', quote: 'will do', owner: 'us' }]);
  assert.equal(h.commitments.length, 1);
  assert.equal(h.commitments[0].text, 'Send the deck');
});

test('the prompt asks for both fields, or the parser is reading something nobody writes', () => {
  const p = buildHealthReadPrompt('a transcript', { title: 'QBR', callType: 'business_review', people: [] });
  assert.match(p, /"owner"/);
  assert.match(p, /"due"/);
  assert.match(p, /us.*them|them.*us/);
});
