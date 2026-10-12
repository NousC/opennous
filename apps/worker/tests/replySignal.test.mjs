// The opt-out detector is the deterministic safety net under reply classification:
// an "unsubscribe" must NEVER depend on the LLM (which misses a material share of
// replies). These lock the exact cases that were slipping through as "engaged".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectOptOut } from '../src/signals/replySentiment.mjs';

test('detectOptOut catches plain unsubscribe replies', () => {
  assert.equal(detectOptOut('unsubscribe Wren Halloway CEO @ Acme'), 'unsubscribe');
  assert.equal(detectOptOut('Please remove me from your list.'), 'unsubscribe');
  assert.equal(detectOptOut('take me off this'), 'unsubscribe');
  assert.equal(detectOptOut('opt out'), 'unsubscribe');
  assert.equal(detectOptOut('Stop emailing me.'), 'unsubscribe');
});

test('detectOptOut escalates explicit do-not-contact demands', () => {
  assert.equal(detectOptOut('Do not contact me again or I will report you.'), 'do_not_contact');
  assert.equal(detectOptOut('cease and desist'), 'do_not_contact');
});

test('detectOptOut leaves genuine replies for the model', () => {
  assert.equal(detectOptOut("Thanks, I've set up an intro for Friday."), null);
  assert.equal(detectOptOut('Out of office until Monday.'), null);
  assert.equal(detectOptOut('Not interested right now, maybe next quarter.'), null);
  assert.equal(detectOptOut(''), null);
});
