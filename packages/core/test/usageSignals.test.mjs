// Product usage as account signals (GET-751): what a day's PostHog read turns into, and the keys
// that make each fire once per spell.
//
// Run: pnpm --filter @nous/core build && node --test packages/core/test/usageSignals.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accountUsageSignals, seatDroppedSignal } from '../dist/services/usageSignals.mjs';

const now = Date.parse('2026-10-21T00:41:00Z');
const steady = { domain: 'harborline.example', activeUsers30d: 4, activeUsers7d: 2, activeUsersPrev30d: 4, totalUsers: 5, usage30d: 300, usagePrev30d: 310, lastUsedAt: '2026-10-20T10:00:00.000Z', keyEvents: {}, emails: [] };
const kinds = (rows) => rows.map(r => r.kind);

test('steady use is no signal', () => {
  assert.deepEqual(accountUsageSignals('acct-1', steady, { now }), []);
});

test('usage dropped: half the active users, from two or more; once a month', () => {
  const [r] = accountUsageSignals('acct-1', { ...steady, activeUsers30d: 2, activeUsersPrev30d: 4 }, { now });
  assert.equal(r.kind, 'usage_dropped');
  assert.equal(r.content, '2 people used the product in the last 30 days, down from 4 the 30 days before.');
  assert.equal(r.dedupe_key, 'usage_dropped:acct-1:2026-10');
  assert.equal(r.claim_property, 'product.active_users_30d');
  assert.deepEqual(accountUsageSignals('acct-1', { ...steady, activeUsers30d: 0, activeUsersPrev30d: 1, usage30d: 0, usagePrev30d: 10 }, { now }), [], 'too small a base to read');
});

test('usage dropped on events alone, from 50 or more', () => {
  assert.deepEqual(kinds(accountUsageSignals('acct-1', { ...steady, usage30d: 100, usagePrev30d: 220 }, { now })), ['usage_dropped']);
});

test('inactive after 14 quiet days, keyed to the day last used', () => {
  const rows = accountUsageSignals('acct-1', { ...steady, lastUsedAt: '2026-10-05T09:00:00.000Z' }, { now });
  const r = rows.find(x => x.kind === 'account_inactive');
  assert.equal(r.content, 'Nobody at the account has used the product for 15 days. Last used Oct 5.');
  assert.equal(r.dedupe_key, 'account_inactive:acct-1:2026-10-05');
  assert.equal(r.occurred_at, '2026-10-19T09:00:00.000Z', 'dated when it crossed 14 days');
  assert.equal(accountUsageSignals('acct-1', { ...steady, lastUsedAt: '2026-10-10T09:00:00.000Z' }, { now }).length, 0);
});

test('a key event first used in the last 8 days is adopted, once per event', () => {
  const c = { ...steady, keyEvents: { report_created: { count30d: 3, users30d: 2, firstSeen: '2026-10-17T12:00:00.000Z' }, invite_sent: { count30d: 9, users30d: 3, firstSeen: '2026-09-01T00:00:00.000Z' } } };
  const rows = accountUsageSignals('acct-1', c, { now }).filter(r => r.kind === 'feature_adopted');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].dedupe_key, 'feature_adopted:acct-1:report_created');
  assert.equal(rows[0].content, 'The account used report_created for the first time on Oct 17: 3 times by 2 people.');
});

test('a seat dropped: active before, not now; once a month; no address in the text', () => {
  const u = { email: 'wren@harborline.example', activeDays30d: 0, eventsPrev30d: 40, lastSeen: '2026-09-15T10:00:00.000Z' };
  const r = seatDroppedSignal('p-wren', 'acct-1', u, { now });
  assert.equal(r.kind, 'seat_dropped');
  assert.equal(r.entity_id, 'p-wren');
  assert.equal(r.account_id, 'acct-1');
  assert.equal(r.dedupe_key, 'seat_dropped:p-wren:2026-10');
  assert.doesNotMatch(r.content + JSON.stringify(r.detail), /wren@/);
  assert.equal(seatDroppedSignal('p-wren', 'acct-1', { ...u, activeDays30d: 2 }, { now }), null);
  assert.equal(seatDroppedSignal('p-wren', null, u, { now }), null);
});

test('product-qualified: 3+ people now, fewer before; once per account', () => {
  const rows = accountUsageSignals('acct-1', { ...steady, activeUsers30d: 3, activeUsersPrev30d: 1 }, { now });
  const r = rows.find(x => x.kind === 'product_qualified');
  assert.equal(r.content, '3 people at the account used the product in the last 30 days, up from 1.');
  assert.equal(r.dedupe_key, 'product_qualified:acct-1');
  assert.equal(accountUsageSignals('acct-1', steady, { now }).some(x => x.kind === 'product_qualified'), false, 'already there last month');
});

test('seats growing: up by 2 and by half again, from 1 or more; once a month', () => {
  const rows = accountUsageSignals('acct-1', { ...steady, activeUsers30d: 6, activeUsersPrev30d: 4 }, { now });
  assert.deepEqual(kinds(rows), ['seats_growing']);
  assert.equal(rows[0].dedupe_key, 'seats_growing:acct-1:2026-10');
  assert.equal(accountUsageSignals('acct-1', { ...steady, activeUsers30d: 5, activeUsersPrev30d: 4 }, { now }).length, 0, 'up by one is not growth');
});

test('activated: every key event used, the last one for the first time this week', () => {
  const c = { ...steady, keyEvents: {
    report_created: { count30d: 3, users30d: 2, firstSeen: '2026-09-20T12:00:00.000Z' },
    invite_sent: { count30d: 1, users30d: 1, firstSeen: '2026-10-18T09:00:00.000Z' },
  } };
  const rows = accountUsageSignals('acct-1', c, { now });
  const r = rows.find(x => x.kind === 'account_activated');
  assert.equal(r.dedupe_key, 'account_activated:acct-1');
  assert.match(r.content, /report_created, invite_sent/);
  const missing = { ...c, keyEvents: { ...c.keyEvents, export_done: { count30d: 0, users30d: 0, firstSeen: null } } };
  assert.equal(accountUsageSignals('acct-1', missing, { now }).some(x => x.kind === 'account_activated'), false, 'one key event never used');
});
