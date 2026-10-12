// RingCentral calls (GET-289): which calls are conversations, which side is ours, who the buyer
// is by phone, and how RingSense's insights become the transcript every other call source writes.
//
// Run: pnpm --filter @nous/core build && node --test packages/core/test/ringcentral.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { phoneKey, callFromCallLog, isConversation, transcriptFromInsights, ringCentralAuth } from '../dist/integrations/ringcentral.js';

const outbound = {
  id: 'Ab3cDe4FgH5iJk6L', telephonySessionId: 's-a1b2c3', startTime: '2026-09-16T14:00:00.000Z',
  duration: 312, type: 'Voice', direction: 'Outbound', result: 'Call connected',
  from: { phoneNumber: '+15125550100', extensionId: '111', name: 'Dana Rep' },
  to:   { phoneNumber: '+1 (512) 555-0199', name: 'SMITH JOHN' },
  recording: { id: '9001', contentUri: 'https://media.ringcentral.com/restapi/v1.0/account/1/recording/9001/content' },
};

test('one number in every format a CRM stores it compares equal', () => {
  const k = phoneKey('+1 (512) 555-0199');
  assert.equal(k, '5125550199');
  for (const v of ['512.555.0199', '15125550199', '512 555 0199', '+15125550199']) assert.equal(phoneKey(v), k, v);
});

test('an extension or short code is not a phone to match a person on', () => {
  assert.equal(phoneKey('101'), null);
  assert.equal(phoneKey(''), null);
  assert.equal(phoneKey(null), null);
});

test('an outbound call: our side is the caller, the buyer is who was dialled', () => {
  const c = callFromCallLog(outbound);
  assert.equal(c.direction, 'Outbound');
  assert.equal(c.repExtensionId, '111');
  assert.equal(c.otherPhone, '+1 (512) 555-0199');
  assert.equal(c.otherName, 'SMITH JOHN');
  assert.equal(c.recordingId, '9001');
  assert.equal(c.internal, false);
});

test('an inbound call through a queue belongs to the rep whose leg accepted it, not the queue', () => {
  const c = callFromCallLog({
    id: 'inb-1', startTime: '2026-09-16T15:00:00.000Z', duration: 200, type: 'Voice', direction: 'Inbound', result: 'Accepted',
    from: { phoneNumber: '+15125550199', name: 'WIRELESS CALLER' },
    to:   { phoneNumber: '+15125550000', extensionId: '900', name: 'Sales Queue' },
    legs: [
      { result: 'Accepted', to: { name: 'Sales Queue' }, extension: undefined, master: true },
      { result: 'Missed',   to: { name: 'Alex Rep' },   extension: { id: 222 } },
      { result: 'Accepted', to: { name: 'Dana Rep' },   extension: { id: 111 } },
    ],
  });
  assert.equal(c.repExtensionId, '111');
  assert.equal(c.repName, 'Dana Rep');
  assert.equal(c.otherPhone, '+15125550199');
});

test('only connected calls with someone outside, long enough to be a conversation, are filed', () => {
  assert.equal(isConversation(outbound), true);
  assert.equal(isConversation({ ...outbound, result: 'Missed' }), false, 'missed');
  assert.equal(isConversation({ ...outbound, result: 'Voicemail' }), false, 'voicemail');
  assert.equal(isConversation({ ...outbound, duration: 12 }), false, 'too short');
  assert.equal(isConversation({ ...outbound, type: 'Fax' }), false, 'fax');
  assert.equal(isConversation({ ...outbound, to: { extensionId: '333', phoneNumber: '+15125550222' } }), false, 'a colleague');
  assert.equal(isConversation({ ...outbound, to: { name: 'Anonymous' } }), false, 'no number to match');
});

test('RingSense insights become "Name: line" transcript lines, legs in order, plus a recap', () => {
  const later = {
    recordingStartTime: '2026-09-16T14:03:00Z',
    speakerInfo: [{ speakerId: '1', name: 'Dana Rep' }, { speakerId: '2', name: 'Speaker 2' }],
    insights: { Transcript: [{ speakerId: '2', text: 'Send me the proposal by Friday.' }], NextSteps: [{ value: 'Send proposal' }] },
  };
  const earlier = {
    recordingStartTime: '2026-09-16T14:00:00Z',
    speakerInfo: [{ speakerId: '1', name: 'Dana Rep' }, { speakerId: '2', name: 'John Smith' }],
    insights: {
      Transcript: [{ speakerId: '1', text: 'Thanks for picking up.' }, { speakerId: '2', text: 'Sure, go ahead.' }],
      Summary: [{ value: 'Discussed the second rooftop.' }],
    },
  };
  const t = transcriptFromInsights([later, earlier]);
  assert.equal(t.text, 'Dana Rep: Thanks for picking up.\nJohn Smith: Sure, go ahead.\nSpeaker 2: Send me the proposal by Friday.');
  assert.deepEqual(t.speakerNames.sort(), ['Dana Rep', 'John Smith'], 'a generic "Speaker 2" is not a name');
  assert.match(t.recap, /## Summary\nDiscussed the second rooftop\./);
  assert.match(t.recap, /## Next steps\n- Send proposal/);
});

test('no insights: no transcript, no recap', () => {
  assert.deepEqual(transcriptFromInsights(null), { text: null, recap: null, speakerNames: [] });
});

test('a JWT goes through our app unless the customer brought their own', () => {
  const prev = { id: process.env.RINGCENTRAL_CLIENT_ID, secret: process.env.RINGCENTRAL_CLIENT_SECRET };
  try {
    process.env.RINGCENTRAL_CLIENT_ID = 'ours';
    process.env.RINGCENTRAL_CLIENT_SECRET = 'our-secret';
    assert.deepEqual(ringCentralAuth({ jwt: ' eyJ.x ' }), { jwt: 'eyJ.x', clientId: 'ours', clientSecret: 'our-secret' });
    assert.deepEqual(ringCentralAuth({ jwt: 'eyJ.x', client_id: 'theirs', client_secret: 's' }), { jwt: 'eyJ.x', clientId: 'theirs', clientSecret: 's' });
    // Their client id with no secret must never borrow OUR secret.
    assert.equal(ringCentralAuth({ jwt: 'eyJ.x', client_id: 'theirs' }), null);
    assert.equal(ringCentralAuth({ jwt: '' }), null);
    delete process.env.RINGCENTRAL_CLIENT_ID;
    assert.equal(ringCentralAuth({ jwt: 'eyJ.x' }), null, 'no app configured anywhere');
  } finally {
    if (prev.id === undefined) delete process.env.RINGCENTRAL_CLIENT_ID; else process.env.RINGCENTRAL_CLIENT_ID = prev.id;
    if (prev.secret === undefined) delete process.env.RINGCENTRAL_CLIENT_SECRET; else process.env.RINGCENTRAL_CLIENT_SECRET = prev.secret;
  }
});
