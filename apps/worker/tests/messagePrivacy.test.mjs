// Message privacy by participant (GET-244) — the rule every reader shares.
//
// The scenario is the Harborline thread: Theo and Avery (co-founders) with Rowan and Corwin.
// Some emails had Theo on cc; Avery's earlier 1:1s with Rowan did not. The rule: content only
// for the people on the email and the members whose mailbox holds a copy — role does not matter.
//
// Run: node --test apps/worker/tests/messagePrivacy.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canReadMessage, redactObservationForViewer, redactActivityForViewer, applyMessagePrivacyToActivities,
  isPrivateMessageType, messageParticipants, redactedMessageLabel,
} from '@nous/core';

const THEO = { userId: 'u-theo', emails: new Set(['theo@bramwell.example', 'test.user.0002@gmail.com']) };
const AVERY = { userId: 'u-avery', emails: new Set(['test.user.0001@gmail.com']) };

const ccEmail = {
  property: 'interaction.email_received', owner_user_id: 'u-avery',
  value: { description: 'Thank you, we will send you an NDA', summary: 'Thank you, we will send you an NDA' },
  raw: { subject: 'Re: Ahead of onboarding', body_text: 'Thank you, we will send you an NDA',
    participants: { from: 'rowan@harborline.example', to: ['test.user.0001@gmail.com'], cc: ['corwin@harborline.example', 'test.user.0002@gmail.com'] },
    mailbox_owner_ids: ['u-avery'] },
};
const oneToOne = {
  property: 'interaction.email_sent', owner_user_id: 'u-avery',
  value: { description: 'Hey Rowan, great talking to you', summary: 'Hey Rowan, great talking to you' },
  raw: { subject: 'Re: Invitation: Rowan and Avery', from: 'test.user.0001@gmail.com', to: ['rowan@harborline.example'], is_outbound: true },
};

test('a co-founder on cc reads the email; the sender reads it too', () => {
  assert.equal(canReadMessage(ccEmail, THEO), true);
  assert.equal(canReadMessage(ccEmail, AVERY), true);
});

test("a co-founder's private 1:1 is not readable by the other founder, whatever their role", () => {
  assert.equal(canReadMessage(oneToOne, THEO), false);
  assert.equal(canReadMessage(oneToOne, AVERY), true);
});

test('a copy in your own mailbox is enough (how a bcc is honoured)', () => {
  const bcc = { ...oneToOne, raw: { ...oneToOne.raw, mailbox_owner_ids: ['u-avery', 'u-theo'] } };
  assert.equal(canReadMessage(bcc, THEO), true);
});

test('system jobs and company tooling are not privacy boundaries', () => {
  assert.equal(canReadMessage(oneToOne, null), true);
  assert.equal(canReadMessage({ ...oneToOne, owner_user_id: null }, THEO), true);
});

test('a redacted observation keeps who and when, never the subject or body', () => {
  const r = redactObservationForViewer(oneToOne, THEO);
  assert.equal(r.redacted, true);
  assert.deepEqual(r.value, { description: 'Email sent', summary: null });
  assert.equal(r.raw.subject, undefined);
  assert.equal(r.raw.body_text, undefined);
  assert.deepEqual(r.raw.participants, { from: 'test.user.0001@gmail.com', to: ['rowan@harborline.example'], cc: [] });
  assert.equal(JSON.stringify(r).includes('Invitation'), false, 'the subject must not survive anywhere');
});

test('a readable observation passes through untouched', () => {
  assert.equal(redactObservationForViewer(ccEmail, THEO), ccEmail);
});

test('activity rows follow the same rule', () => {
  const act = { activity_type: 'email_sent', owner_user_id: 'u-avery', description: 'Hey Rowan', summary: 'Hey Rowan', raw_data: oneToOne.raw };
  const [r] = applyMessagePrivacyToActivities([act], THEO);
  assert.equal(r.redacted, true);
  assert.equal(r.description, 'Email sent');
  assert.equal(r.summary, null);
  assert.equal(redactActivityForViewer(act, AVERY), act);
});

test('meetings and other events are not messages', () => {
  assert.equal(isPrivateMessageType('interaction.meeting_held'), false);
  const meeting = { property: 'interaction.meeting_held', owner_user_id: 'u-avery', value: { description: 'Harborline x OpenNous' }, raw: {} };
  assert.equal(redactObservationForViewer(meeting, THEO), meeting);
});

test('LinkedIn messages are private to their account owner', () => {
  const li = { property: 'interaction.linkedin_message', owner_user_id: 'u-avery', value: { summary: 'You: hi' }, raw: { is_outbound: true } };
  const r = redactObservationForViewer(li, THEO);
  assert.equal(r.value.description, 'LinkedIn message sent');
  assert.equal(redactedMessageLabel('linkedin_message', { is_outbound: false }, ''), 'LinkedIn message received');
});

test('participants read the stored list and the legacy fields', () => {
  assert.deepEqual(messageParticipants({ from: 'A@x.example', to: ['b@x.example'] }).sort(), ['a@x.example', 'b@x.example']);
});
