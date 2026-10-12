// What counts as a customer asking for a product (apps/worker/src/services/csSignalCheck.mjs).
// The model answers the questions; these test the rule that turns answers into a verdict, which is
// the part that must not drift. Run: node --test apps/worker/tests/csSignalCheck.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verdictFromAnswers, hasAskEvidence, checkAsk } from '../src/services/csSignalCheck.mjs';

const ans = (over = {}) => JSON.stringify({ why: 'x', who: 'customer', about: 'new', wants_more: true, complaint: false, ...over });

test('a customer wanting something new is the only YES', () => {
  assert.equal(verdictFromAnswers(ans()), 'YES');
});

test('our rep presenting a product is a pitch, however interested the customer seemed', () => {
  assert.equal(verdictFromAnswers(ans({ who: 'vendor' })), 'PITCH');
});

test('a question about something they already have is support, not an ask', () => {
  // "Can you give me access to the portal", "can it read a scanned licence".
  assert.equal(verdictFromAnswers(ans({ about: 'existing' })), 'SUPPORT');
});

test('a complaint wins over everything, so it is re-filed as a risk rather than pitched', () => {
  assert.equal(verdictFromAnswers(ans({ complaint: true })), 'COMPLAINT');
  assert.equal(verdictFromAnswers(ans({ complaint: true, who: 'vendor' })), 'COMPLAINT');
});

test('a customer talking about something new without wanting it is not an ask', () => {
  assert.equal(verdictFromAnswers(ans({ wants_more: false })), 'NO');
});

test('anything unreadable is NO, never YES', () => {
  for (const raw of ['', 'YES', 'sure, looks like a yes', '{"who":"customer"', null, undefined, '{"wants_more":"true","who":"customer","about":"new"}']) {
    assert.notEqual(verdictFromAnswers(raw), 'YES', `read as YES: ${raw}`);
  }
  // A JSON object wrapped in prose is still read.
  assert.equal(verdictFromAnswers(`Here you go: ${ans()}`), 'YES');
});

test('an ask must say what the customer did', () => {
  assert.equal(hasAskEvidence({ evidence: 'price' }), true);
  assert.equal(hasAskEvidence({ evidence: 'Another_Location' }), true);
  assert.equal(hasAskEvidence({ evidence: 'interested' }), false);
  assert.equal(hasAskEvidence({}), false);
});

test('a failed model call retires nothing', async () => {
  const createMessage = async () => { throw new Error('network'); };
  const r = await checkAsk({ product: 'Ledger', text: 't', quote: 'q' }, { createMessage, messageText: () => '', model: 'm' });
  assert.equal(r.verdict, 'SKIP');
});
