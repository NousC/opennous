// The LinkedIn ingest dedup contract. A message can arrive twice — once on the live
// webhook, once when the history backfill re-fetches the chat — and the two paths
// must produce the SAME non-null external_id, or the partial unique index
// (observations_dedup WHERE external_id IS NOT NULL) logs it twice. These tests lock
// that in: they are what caught the "every message doubled" bug.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { linkedinProviderMsgId, linkedinMessageExternalId } from '../src/webhooks/handlers/linkedin.mjs';

test('provider id resolves the same across webhook and backfill payload shapes', () => {
  // Same message, two shapes: the webhook body carries provider_message_id; the
  // backfill REST object carries it under provider_id. Both must resolve to the id.
  const webhookBody   = { provider_message_id: 'ABC123', text: 'hi', chat_id: 'chat1' };
  const backfillMsg   = { provider_id: 'ABC123', text: 'hi' };
  assert.equal(linkedinProviderMsgId(webhookBody), 'ABC123');
  assert.equal(linkedinProviderMsgId(backfillMsg), 'ABC123');

  const opts = { chatId: 'chat1', occurredAt: '2026-07-22T10:00:00.000Z', text: 'hi', isOutbound: false };
  assert.equal(
    linkedinMessageExternalId(webhookBody, opts),
    linkedinMessageExternalId(backfillMsg, opts),
    'same provider id → identical external_id → dedups to one row',
  );
  assert.equal(linkedinMessageExternalId(webhookBody, opts), 'li_msg_ABC123');
});

test('divergent id field names still converge (the original bug)', () => {
  // The webhook path only had message_id; the backfill only had provider_id. The old
  // code checked different fallback chains and produced two ids. The shared resolver
  // fixes it: message_id and provider_id both map through the same priority list.
  const webhookBody = { message_id: 'XYZ', text: 'yo' };
  const backfillMsg = { provider_id: 'XYZ', text: 'yo' };
  assert.equal(linkedinProviderMsgId(webhookBody), 'XYZ');
  assert.equal(linkedinProviderMsgId(backfillMsg), 'XYZ');
  const opts = { chatId: 'c', occurredAt: '2026-07-22T10:00:00Z', text: 'yo', isOutbound: false };
  assert.equal(linkedinMessageExternalId(webhookBody, opts), linkedinMessageExternalId(backfillMsg, opts));
});

test('external_id is never null, even with no provider id', () => {
  // Some Unipile webhook shapes carry no recognisable id. A null external_id skips
  // the partial dedup index entirely — the deterministic fallback prevents that.
  const noId = { text: 'no id here' };
  const id = linkedinMessageExternalId(noId, {
    chatId: 'chat9', occurredAt: '2026-07-22T10:00:30.000Z', text: 'no id here', isOutbound: true,
  });
  assert.ok(id, 'fallback id is non-null');
  assert.match(id, /^li_msg_f_chat9_/);
});

test('fallback id absorbs millisecond / timezone drift for the same message', () => {
  // The webhook stamps body.timestamp; the backfill stamps msg.created_at. For the
  // same message these are the same instant formatted differently — minute-bucketing
  // makes the fallback id identical so they still dedup.
  const base = { chatId: 'chat9', text: 'same message', isOutbound: false };
  const fromWebhook  = linkedinMessageExternalId({ text: 'same message' }, { ...base, occurredAt: '2026-07-22T10:00:00.000Z' });
  const fromBackfill = linkedinMessageExternalId({ text: 'same message' }, { ...base, occurredAt: '2026-07-22T10:00:45.900+00:00' });
  assert.equal(fromWebhook, fromBackfill);
});

test('different messages get different ids', () => {
  const a = linkedinMessageExternalId({ text: 'first' },  { chatId: 'c', occurredAt: '2026-07-22T10:00:00Z', text: 'first',  isOutbound: false });
  const b = linkedinMessageExternalId({ text: 'second' }, { chatId: 'c', occurredAt: '2026-07-22T10:00:00Z', text: 'second', isOutbound: false });
  assert.notEqual(a, b);
});
