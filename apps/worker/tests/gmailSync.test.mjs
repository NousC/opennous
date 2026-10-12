// Gmail scan — message shape and the "already filed" key (GET-234).
//
// The fixture mirrors the GMAIL_FETCH_EMAILS message shape (keys checked against the real
// payload; every value invented): messageId, threadId, sender, to, labelIds, messageText, messageTimestamp.
//
// Run: node --test apps/worker/tests/gmailSync.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gmailMessageToData, messageIdFromExternalId, maxPagesFor, isPayloadTooLarge } from '../src/services/gmailSync.mjs';

const SENT = {
  messageId: '19a2b3c4d5e6f708',
  threadId: '19a2b3c4d5e6f700',
  sender: 'Avery Castellan <test.user.0001@gmail.com>',
  to: 'corwin@harborline.example',
  subject: 'Re: OpenNous pilot',
  labelIds: ['SENT'],
  messageText: 'Following up on our call...',
  messageTimestamp: '2026-09-12T15:04:00Z',
};

test('a fetched message becomes the data ingestGmail reads, labels included', () => {
  const d = gmailMessageToData(SENT);
  assert.equal(d.id, '19a2b3c4d5e6f708');
  assert.equal(d.sender, 'Avery Castellan <test.user.0001@gmail.com>');
  assert.equal(d.to, 'corwin@harborline.example');
  assert.deepEqual(d.labelIds, ['SENT'], 'the SENT label is what marks the message outbound');
  assert.equal(d.message_text, 'Following up on our call...');
  assert.equal(d.messageTimestamp, '2026-09-12T15:04:00Z');
});

test('snake_case payloads parse too', () => {
  const d = gmailMessageToData({ message_id: 'abc', from: 'x@y.example', label_ids: ['INBOX'], snippet: 'hi' });
  assert.equal(d.id, 'abc');
  assert.deepEqual(d.labelIds, ['INBOX']);
  assert.equal(d.body_text, 'hi');
});

test('the filed message id comes back out of the observation external id', () => {
  assert.equal(messageIdFromExternalId('gmail_19a2b3c4d5e6f708_8218e274-5ab1-4ede-9af6-4b4a6e51ecc9'), '19a2b3c4d5e6f708');
  assert.equal(messageIdFromExternalId('gcal_x_y'), null);
  assert.equal(messageIdFromExternalId(null), null);
});

test('a heavy page is recognised as too large, other failures are not', () => {
  // The shape Composio's SDK threw in production (GET-237).
  const e = Object.assign(new Error('Error executing the tool GMAIL_FETCH_EMAILS'), {
    cause: { status: 413, message: '413 {"error":{"slug":"Upstream_PayloadTooLarge"}}', error: { error: { slug: 'Upstream_PayloadTooLarge' } } },
  });
  assert.equal(isPayloadTooLarge(e), true);
  assert.equal(isPayloadTooLarge(new Error('Connected account not found')), false);
});

test('page budget scales with the lookback, bounded', () => {
  assert.equal(maxPagesFor(1), 10);
  assert.equal(maxPagesFor(60), 120);
  assert.equal(maxPagesFor(365), 200);
});

test('a backfill searches Gmail for its people, OR-batched under the query limit (GET-557)', async () => {
  const { addressQueries } = await import('../src/services/gmailSync.mjs');
  const qs = addressQueries(['A@x.example', 'a@x.example', 'b@y.example', 'not-an-email', ''], 90);
  assert.equal(qs.length, 1);
  assert.equal(qs[0], 'newer_than:90d {from:a@x.example to:a@x.example cc:a@x.example from:b@y.example to:b@y.example cc:b@y.example}');
  const many = Array.from({ length: 45 }, (_, i) => `p${i}@z.example`);
  assert.equal(addressQueries(many, 30).length, 3, '20 addresses per search');
});

test('the backfill search never includes the mailbox owner (GET-557)', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../src/services/gmailSync.mjs', import.meta.url), 'utf8');
  const filter = src.indexOf("addresses = addresses.filter(a => String(a || '').toLowerCase() !== own)");
  const search = src.indexOf('addressQueries(addresses, days)');
  assert.ok(filter >= 0 && filter < search, 'the own address is dropped before the search is built');
});
