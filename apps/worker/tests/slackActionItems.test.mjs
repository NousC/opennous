// Asks and promises in a team chat become tasks only as far as the conversation shows (GET-976).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkConversationActionItem, extractConversationActionItems } from '../src/signals/index.mjs';

const recent = new Date(Date.now() - 2 * 86_400_000).toISOString();
const later = new Date(Date.now() - 86_400_000).toISOString();
const people = [
  { name: 'Morgan Reyes', side: 'internal', contactId: null },
  { name: 'Dana Whitfield', side: 'external', contactId: 'person-dana' },
  { name: 'Priya Lund', side: 'external', contactId: 'person-priya' },
];
const ask = { id: 'm1', speaker: 'Dana Whitfield', side: 'external', contactId: 'person-dana', activityId: 'act-1', ts: '1790000000.000100', occurredAt: recent,
  text: '<@U1> Please set up a call with <@U3> to walk her through the Lumen workspace and connect it to her agents', url: 'https://example.slack/p1' };
const thanks = { id: 'm2', speaker: 'Dana Whitfield', side: 'external', contactId: 'person-dana', activityId: 'act-2', ts: '1790000100.000100', occurredAt: later, text: 'Thank you!' };
const yes = { id: 'm3', speaker: 'Morgan Reyes', side: 'internal', contactId: null, ts: '1790000200.000100', occurredAt: later, text: 'Sure, happy to. How about Thursday at 2pm?' };

const item = (over = {}) => ({ title: 'Set up a platform walkthrough with Priya', quote: 'Please set up a call with <@U3> to walk her through the Lumen workspace',
  owner_kind: 'user', owner: 'Morgan', participants: ['Priya'], commitment: 'requested', accepted_quote: null, due_phrase: null, ...over });

test('a customer ask is a requested task owed by our side, with asker, owner and participants', () => {
  const it = checkConversationActionItem(item(), { messages: [ask, thanks], people });
  assert.equal(it.commitment, 'requested');
  assert.equal(it.owner_kind, 'user');
  assert.equal(it.owner_name, 'Morgan Reyes');
  assert.equal(it.asked_by, 'Dana Whitfield');
  assert.equal(it.asked_by_entity_id, 'person-dana');
  assert.deepEqual(it.participants, [{ name: 'Priya Lund', side: 'external', entity_id: 'person-priya' }]);
  assert.equal(it.said.activityId, 'act-1');
  assert.equal(it.due_phrase, null);
});

test('a quote nobody wrote keeps nothing', () => {
  assert.equal(checkConversationActionItem(item({ quote: 'We are ready to sign the contract this week' }), { messages: [ask, thanks], people }), null);
  assert.equal(checkConversationActionItem(item({ quote: '' }), { messages: [ask], people }), null);
});

test('accepted and scheduled are never taken on the model\'s word', () => {
  // Says accepted, no later yes from our side: still requested.
  assert.equal(checkConversationActionItem(item({ commitment: 'accepted', accepted_quote: 'Thank you!' }), { messages: [ask, thanks], people }).commitment, 'requested');
  // Says scheduled with an invented time: still requested, and the invented time is dropped.
  const invented = checkConversationActionItem(item({ commitment: 'scheduled', due_phrase: 'Friday at 10am' }), { messages: [ask, thanks], people });
  assert.equal(invented.commitment, 'requested');
  assert.equal(invented.due_phrase, null);
  // Our side said yes in a later message: accepted.
  const accepted = checkConversationActionItem(item({ commitment: 'accepted', accepted_quote: 'Sure, happy to.' }), { messages: [ask, yes], people });
  assert.equal(accepted.commitment, 'accepted');
  assert.equal(accepted.accepted_quote, 'Sure, happy to.');
  // Accepted and a time stated in the chat: scheduled, with that phrase.
  const scheduled = checkConversationActionItem(item({ commitment: 'scheduled', accepted_quote: 'Sure, happy to.', due_phrase: 'Thursday at 2pm' }), { messages: [ask, yes], people });
  assert.equal(scheduled.commitment, 'scheduled');
  assert.equal(scheduled.due_phrase, 'Thursday at 2pm');
});

test('an owner named on the wrong side keeps the side and drops the name', () => {
  const it = checkConversationActionItem(item({ owner: 'Priya' }), { messages: [ask], people });
  assert.equal(it.owner_kind, 'user');
  assert.equal(it.owner_name, null);
});

test('records the task on the asker, keyed by the message, with no invented date and one model read', async () => {
  const writes = [];
  let reads = 0;
  const out = await extractConversationActionItems({
    supabase: { from: () => { throw new Error('no db in this test'); } }, workspaceId: 'ws',
    messages: [ask, thanks], people, mentions: { U1: { name: 'Morgan Reyes' }, U3: { name: 'Priya Lund', personId: 'person-priya' } },
    sourceRef: 'source://slack/T1/C1/conv/abcdef0123456789',
  }, {
    reader: async ({ prompt }) => { reads++; assert.match(prompt, /<@U3> is Priya Lund/); assert.match(prompt, /Dana Whitfield: the customer/);
      return { ok: true, value: [item(), { title: 'Say thanks', quote: 'nothing like this was said', owner_kind: 'user' }] }; },
    observe: async (_db, row) => { writes.push(row); return { id: 'obs' }; },
  });
  assert.equal(reads, 1);
  assert.equal(out.length, 1);
  assert.equal(writes.length, 1);
  const w = writes[0];
  assert.equal(w.entityId, 'person-dana');
  assert.equal(w.property, 'action_item.slack_1790000000_000100_0');
  assert.equal(w.value.status, 'open');
  assert.equal(w.value.commitment, 'requested');
  assert.equal(w.value.due_at, null);
  assert.equal(w.value.source_id, 'act-1');
  assert.equal(w.value.source_url, 'https://example.slack/p1');
  assert.equal(w.value.occurred_at, recent);
  assert.equal(w.value.quote, item().quote);
  assert.equal(w.value.for_entity_id, 'person-dana');
});

test('internal-only chat and stale conversations read nothing', async () => {
  const fail = async () => { throw new Error('must not read'); };
  assert.deepEqual(await extractConversationActionItems({ workspaceId: 'ws', messages: [yes], people }, { reader: fail }), []);
  const old = { ...ask, occurredAt: '2025-01-01T00:00:00Z' };
  assert.deepEqual(await extractConversationActionItems({ workspaceId: 'ws', messages: [old], people }, { reader: fail }), []);
});
