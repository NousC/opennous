// What was derived from a message is the team's; the message's own words are not (GET-253, GET-985).
//
// The Harborline scenario again: Avery's private 1:1 with Rowan, a thread Theo was cc'd on, a
// sequencer email nobody owns, a meeting, and Avery's Slack DM with Rowan. A fact, an action item
// or a reply chip read out of a message is shown to every member; the verbatim quote it carries is
// shown only to the people who may read that message.
//
// Run: node --test apps/worker/tests/derivedFactPrivacy.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  derivedSources, loadDerivedSources, canReadDerived, filterDerivedForViewer, filterByCitedClaimsForViewer,
  derivedAudienceKey, redactDerivedText, isPrivateMessageType, TEAM_VIEWER,
} from '@nous/core';

const THEO = { userId: 'u-theo', emails: new Set(['test.user.0002@gmail.com']) };
const AVERY = { userId: 'u-avery', emails: new Set(['test.user.0001@gmail.com']) };

const ID = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const PRIVATE_1TO1 = ID(1), CC_THREAD = ID(2), SEQUENCER = ID(3), MEETING = ID(4), ACTION_OBS = ID(5), SLACK_DM = ID(6), GONE = ID(9);

const OBSERVATIONS = [
  { id: PRIVATE_1TO1, property: 'interaction.email_sent', owner_user_id: 'u-avery',
    raw: { participants: { from: 'test.user.0001@gmail.com', to: ['rowan@harborline.example'], cc: [] }, mailbox_owner_ids: ['u-avery'] } },
  { id: CC_THREAD, property: 'interaction.email_received', owner_user_id: 'u-avery',
    raw: { participants: { from: 'rowan@harborline.example', to: ['test.user.0001@gmail.com'], cc: ['test.user.0002@gmail.com'] }, mailbox_owner_ids: ['u-avery'] } },
  { id: SEQUENCER, property: 'interaction.email_received', owner_user_id: null, raw: {} },
  { id: MEETING, property: 'interaction.meeting_held', owner_user_id: 'u-theo', raw: {} },
  { id: ACTION_OBS, property: 'action_item.email_x_0', owner_user_id: null, raw: {} },
  { id: SLACK_DM, property: 'interaction.slack_dm', owner_user_id: 'u-avery', raw: { mailbox_owner_ids: ['u-avery'], is_outbound: false } },
];
const CLAIMS = [];

function fakeSupabase() {
  return {
    from(table) {
      const rows = table === 'observations' ? OBSERVATIONS : CLAIMS;
      const f = [];
      const q = {
        select() { return q; },
        eq(col, v) { if (col !== 'workspace_id') f.push((r) => r[col] === v); return q; },
        in(col, vs) { f.push((r) => vs.includes(r[col])); return q; },
        then(res, rej) {
          // Mirror the aliased raw->key selects the loader uses.
          const data = rows.filter((r) => f.every((fn) => fn(r))).map((r) => ({ ...r, ...(r.raw || {}) }));
          return Promise.resolve({ data, error: null }).then(res, rej);
        },
      };
      return q;
    },
  };
}

const fact = (id, sourceId, extra = {}) => ({
  id, property: `note.${id}`, supporting_observation_ids: sourceId ? [sourceId] : [],
  value: { content: `fact ${id}`, metadata: { source_activity_id: sourceId ?? null, signal_type: 'email_received', quote: `words ${id}`, ...extra } },
});

test('pointers are read from every shape a reader holds', () => {
  assert.deepEqual(derivedSources(fact('a', PRIVATE_1TO1)).ids, [PRIVATE_1TO1]);
  assert.deepEqual(derivedSources({ value: { source_id: CC_THREAD, source_type: 'email' } }).ids, [CC_THREAD]);
  assert.deepEqual(derivedSources({ metadata: { source_activity_id: MEETING } }).ids, [MEETING]);
  assert.equal(derivedSources({ value: { source_type: 'email' } }).messageHint, true);
  assert.equal(derivedSources({ value: { source_type: 'fireflies' } }).messageHint, false);
});

test("a fact from Avery's private 1:1 is his, not his co-founder's", async () => {
  const rows = [fact('a', PRIVATE_1TO1)];
  const src = await loadDerivedSources(fakeSupabase(), 'ws', rows);
  assert.equal(canReadDerived(rows[0], src, AVERY), true);
  assert.equal(canReadDerived(rows[0], src, THEO), false);
  assert.equal(canReadDerived(rows[0], src, null), true, 'system jobs see everything');
});

test('a fact from a thread Theo was cc\'d on is readable by both founders', async () => {
  const rows = [fact('b', CC_THREAD)];
  const src = await loadDerivedSources(fakeSupabase(), 'ws', rows);
  assert.equal(canReadDerived(rows[0], src, THEO), true);
  assert.equal(canReadDerived(rows[0], src, AVERY), true);
});

test('facts from a meeting, a sequencer, or typed by hand stay shared', async () => {
  const rows = [fact('m', MEETING, { signal_type: 'meeting_held' }), fact('s', SEQUENCER), { id: 'manual', property: 'note.manual', value: { content: 'x', metadata: {} } }];
  const out = await filterDerivedForViewer(fakeSupabase(), 'ws', rows, THEO);
  assert.deepEqual(out.map((r) => r.id), ['m', 's', 'manual']);
});

test('a thread fact backed by a private message AND a cc thread is readable by anyone on either', async () => {
  const thread = { id: 't', property: 'note.t', supporting_observation_ids: [PRIVATE_1TO1, CC_THREAD], value: { metadata: { signal_type: 'conversation_thread' } } };
  const out = await filterDerivedForViewer(fakeSupabase(), 'ws', [thread], THEO);
  assert.equal(out.length, 1);
});

test('an email fact whose message is gone keeps its fact and loses its quote; a meeting fact keeps both', async () => {
  const rows = [fact('g', GONE), fact('gm', GONE, { signal_type: 'meeting_held' })];
  const out = await filterDerivedForViewer(fakeSupabase(), 'ws', rows, THEO);
  assert.deepEqual(out.map((r) => r.id), ['g', 'gm']);
  assert.equal(out[0].value.metadata.quote, null);
  assert.equal(out[0].quote_private, true);
  assert.equal(out[1].value.metadata.quote, 'words gm');
});

test('an action item from a private email is the team\'s; only its quote is judged by the email it names', async () => {
  const item = { property: 'action_item.email_x_0', supporting_observation_ids: [ACTION_OBS],
    value: { title: 'Send NDA', quote: 'Can you send the NDA?', accepted_quote: 'Will do', source_id: PRIVATE_1TO1, source_type: 'email' } };
  const [theo] = await filterDerivedForViewer(fakeSupabase(), 'ws', [item], THEO);
  assert.equal(theo.value.title, 'Send NDA');
  assert.equal(theo.value.quote, null);
  assert.equal(theo.value.accepted_quote, null);
  assert.equal(theo.quote_private, true);
  const [avery] = await filterDerivedForViewer(fakeSupabase(), 'ws', [item], AVERY);
  assert.equal(avery, item, 'the owner gets the row untouched');
  assert.equal(item.value.quote, 'Can you send the NDA?', 'the input row is never mutated');
});

test('a Slack DM is a private message, and a fact from it is shared without its words', async () => {
  assert.equal(isPrivateMessageType('interaction.slack_dm'), true);
  assert.equal(isPrivateMessageType('evidence.slack_dm_conversation'), true);
  assert.equal(isPrivateMessageType('interaction.slack_message'), false, 'a channel stays shared');
  const item = { property: 'action_item.slack_1_0', value: { title: 'Set up a call', quote: 'please set up a call', source_id: SLACK_DM, source_type: 'slack' } };
  const [team] = await filterDerivedForViewer(fakeSupabase(), 'ws', [item], TEAM_VIEWER);
  assert.equal(team.value.title, 'Set up a call');
  assert.equal(team.value.quote, null);
  const [avery] = await filterDerivedForViewer(fakeSupabase(), 'ws', [item], AVERY);
  assert.equal(avery.value.quote, 'please set up a call');
});

test('redactDerivedText strips quotes on the row, its value, its metadata and its value\'s metadata', () => {
  const out = redactDerivedText({ quote: 'a', metadata: { quote: 'b', speaker: 'Rowan' }, value: { quote: 'c', title: 'T', metadata: { quote: 'd' } } });
  assert.deepEqual([out.quote, out.metadata.quote, out.value.quote, out.value.metadata.quote], [null, null, null, null]);
  assert.equal(out.metadata.speaker, 'Rowan');
  assert.equal(out.value.title, 'T');
});

test('non-derived claims and documents pass through untouched', async () => {
  const rows = [{ property: 'name', value: 'Rowan' }, { id: 'd', property: 'note.d', value: { metadata: { doc_type: 'meeting_brief', source_activity_id: PRIVATE_1TO1 } } }];
  const out = await filterDerivedForViewer(fakeSupabase(), 'ws', rows, THEO);
  assert.equal(out.length, 2);
});

test('the team viewer gets every fact, and the words only of what every member may read — the input to summaries', async () => {
  const rows = [fact('a', PRIVATE_1TO1), fact('b', CC_THREAD), fact('s', SEQUENCER), fact('m', MEETING, { signal_type: 'meeting_held' })];
  const out = await filterDerivedForViewer(fakeSupabase(), 'ws', rows, TEAM_VIEWER);
  assert.deepEqual(out.map((r) => r.id), ['a', 'b', 's', 'm']);
  assert.deepEqual(out.map((r) => r.value.metadata.quote), [null, null, 'words s', 'words m']);
});

test('a graph edge citing a fact is shown, since the fact is the team\'s', async () => {
  CLAIMS.length = 0;
  CLAIMS.push({ id: ID(20), ...fact('x', PRIVATE_1TO1) , }, { id: ID(21), ...fact('y', MEETING, { signal_type: 'meeting_held' }) });
  CLAIMS[0].id = ID(20); CLAIMS[1].id = ID(21);
  const edges = [{ e: 1, source_memory_id: ID(20) }, { e: 2, source_memory_id: ID(21) }, { e: 3, source_memory_id: null }];
  const out = await filterByCitedClaimsForViewer(fakeSupabase(), 'ws', edges, THEO, (e) => [e.source_memory_id]);
  assert.deepEqual(out.map((e) => e.e), [1, 2, 3]);
});

test('facts merge only within one audience', async () => {
  const rows = [fact('a', PRIVATE_1TO1), fact('b', CC_THREAD), fact('s', SEQUENCER), fact('m', MEETING, { signal_type: 'meeting_held' })];
  const src = await loadDerivedSources(fakeSupabase(), 'ws', rows);
  assert.equal(derivedAudienceKey(rows[2], src), 'team');
  assert.equal(derivedAudienceKey(rows[3], src), 'team');
  assert.match(derivedAudienceKey(rows[0], src), /^msg:u-avery\|/);
  // The cc thread has a different set of readers (Theo is on it), so it is a different audience.
  assert.notEqual(derivedAudienceKey(rows[0], src), derivedAudienceKey(rows[1], src));
  assert.notEqual(derivedAudienceKey(rows[0], src), derivedAudienceKey(rows[2], src));
});
