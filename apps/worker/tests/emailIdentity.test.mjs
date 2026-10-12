// Email identity — one email, whichever mailbox it was read from (GET-244, GET-245).
//
// The fixture is shaped like the Harborline thread that exposed it: Rowan replies to Avery with
// Corwin and Theo on cc. Both founders' mailboxes hold a copy with different Gmail ids and thread
// ids, and the same RFC Message-ID. Every id below is invented.
// The founders' addresses stay on gmail.com because a personal-mailbox domain is part of the case;
// the local parts (test.user.0001/0002) are placeholders, not anyone's address.
//
// Run: node --test apps/worker/tests/emailIdentity.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseEmailHeaders, emailExternalId, isBulkEmail, isReply, addressesIn, normalizeMessageId, participantsOf,
} from '../src/utils/emailIdentity.mjs';
import { filedMessageIds, messageIdFromExternalId } from '../src/services/gmailSync.mjs';

const ROWAN_REPLY = [
  { name: 'From', value: 'Rowan Achterberg <rowan@harborline.example>' },
  { name: 'To', value: 'Avery Castellan <test.user.0001@gmail.com>' },
  { name: 'Cc', value: 'Corwin Ashdale <corwin@harborline.example>, test.user.0002@gmail.com' },
  { name: 'Message-ID', value: '<CAF+qx7Tn42Rm8VbLd0eWpYs3kHjZ19aUcN5oPiQr_2mXv8fTwq@mail.gmail.com>' },
  { name: 'In-Reply-To', value: '<CAB1234@mail.gmail.com>' },
  { name: 'References', value: '<CAB1234@mail.gmail.com>' },
  { name: 'Subject', value: 'Re: Ahead of onboarding: CRM access and a few questions' },
];

test('headers give the participants the list call never returns (cc)', () => {
  const h = parseEmailHeaders(ROWAN_REPLY);
  assert.equal(h.from, 'rowan@harborline.example');
  assert.deepEqual(h.to, ['test.user.0001@gmail.com']);
  assert.deepEqual(h.cc, ['corwin@harborline.example', 'test.user.0002@gmail.com']);
  assert.equal(h.rfcMessageId, 'caf+qx7tn42rm8vbld0ewpys3khjz19aucn5opiqr_2mxv8ftwq@mail.gmail.com');
  assert.equal(isReply(h), true);
  assert.equal(isBulkEmail(h, h.from), false);
});

test('two mailboxes, one email: the external id is the same, so the second copy cannot file twice', () => {
  const h = parseEmailHeaders(ROWAN_REPLY);
  const theoCopy = emailExternalId({ rfcMessageId: h.rfcMessageId, gmailMessageId: '18f3c0a4e2b71d05', contactId: 'rowan' });
  const averyCopy = emailExternalId({ rfcMessageId: h.rfcMessageId, gmailMessageId: '18f3c0a4f9d26e40', contactId: 'rowan' });
  assert.equal(theoCopy, averyCopy);
  assert.match(theoCopy, /^gmail_rfc_[0-9a-f]{20}_rowan$/);
  // …but one email on two different people is two rows.
  assert.notEqual(theoCopy, emailExternalId({ rfcMessageId: h.rfcMessageId, gmailMessageId: 'x', contactId: 'corwin' }));
});

test('without a Message-ID the per-mailbox id is kept (the shape older rows have)', () => {
  assert.equal(emailExternalId({ rfcMessageId: null, gmailMessageId: 'abc', contactId: 'c1' }), 'gmail_abc_c1');
});

test('newsletters, lists and autoresponders are bulk', () => {
  assert.equal(isBulkEmail(parseEmailHeaders([{ name: 'List-Unsubscribe', value: '<mailto:x@y.example>' }]), 'team@vendor.example'), true);
  assert.equal(isBulkEmail(parseEmailHeaders([{ name: 'Precedence', value: 'bulk' }]), 'a@b.example'), true);
  assert.equal(isBulkEmail(parseEmailHeaders([{ name: 'Auto-Submitted', value: 'auto-replied' }]), 'a@b.example'), true);
  assert.equal(isBulkEmail(parseEmailHeaders([]), 'no-reply@stripe.com'), true);
  assert.equal(isBulkEmail(parseEmailHeaders([]), 'notifications@github.com'), true);
  assert.equal(isBulkEmail(parseEmailHeaders([]), 'rowan@harborline.example'), false);
});

test('a first email is not a reply', () => {
  assert.equal(isReply(parseEmailHeaders([{ name: 'Message-ID', value: '<a@b>' }])), false);
});

test('participants fall back to the list fields when headers are missing', () => {
  assert.deepEqual(participantsOf(null, { from: 'a@b.example', to: ['c@d.example'], cc: [] }), { from: 'a@b.example', to: ['c@d.example'], cc: [] });
});

test('address parsing handles display names and angle brackets', () => {
  assert.deepEqual(addressesIn('"Achterberg, Rowan" <Rowan@Harborline.example>, x@y.example'), ['rowan@harborline.example', 'x@y.example']);
  assert.equal(normalizeMessageId(' <ABC@x> '), 'abc@x');
  assert.equal(normalizeMessageId(''), null);
});

test('the scan knows what THIS mailbox filed, from new and legacy rows', () => {
  const rows = [
    { external_id: 'gmail_rfc_aaaa_rowan', owner_user_id: 'avery', gmail_copies: [{ owner_user_id: 'avery', message_id: 'A1' }, { owner_user_id: 'theo', message_id: 'B1' }] },
    { external_id: 'gmail_18f3_legacy', owner_user_id: 'theo', gmail_copies: null },
  ];
  assert.deepEqual([...filedMessageIds(rows, 'theo')].sort(), ['18f3', 'B1']);
  assert.deepEqual([...filedMessageIds(rows, 'avery')], ['A1']);
  assert.equal(messageIdFromExternalId('gmail_rfc_aaaa_rowan'), null);
});
