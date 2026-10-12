// The board is the customer's voice: our own people's words never reach it (see insightBoard.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isInternalSpeaker } from '../dist/db/insightBoard.js';

const s = {
  ids: new Set(['e-cor']),
  names: new Set(['corwin ashby', 'theo bramwell']),
  emails: new Set(['corwin@fernpoint.example']),
  domains: new Set(['fernpoint.example']),
};

test('a team member by name is internal, whoever the insight was filed against', () => {
  assert.equal(isInternalSpeaker({ speaker: 'Corwin Ashby', contact_id: 'e-saoirse' }, s), true);
  assert.equal(isInternalSpeaker({ speaker: '  corwin  ASHBY ' }, s), true);
});

test('by id, by address, and by the company domain', () => {
  assert.equal(isInternalSpeaker({ speaker: 'Cor', speaker_id: 'e-cor' }, s), true);
  assert.equal(isInternalSpeaker({ speaker: 'corwin@fernpoint.example' }, s), true);
  assert.equal(isInternalSpeaker({ speaker: 'bastian@fernpoint.example' }, s), true);
});

test('a meeting title naming one of us is internal; a shared first name is not', () => {
  assert.equal(isInternalSpeaker({ speaker: 'Networking Call between Theo Bramwell and Corwin Ashby' }, s), true);
  assert.equal(isInternalSpeaker({ speaker: 'Corwin <> Saoirse' }, s), false);
});

test('customers stay customers', () => {
  assert.equal(isInternalSpeaker({ speaker: 'Tobin Marsh', contact_id: 'e-tobin' }, s), false);
  assert.equal(isInternalSpeaker({ speaker: 'tobin.marsh@marsh-labs.example' }, s), false);
  assert.equal(isInternalSpeaker({ speaker: null }, s), false);
});
