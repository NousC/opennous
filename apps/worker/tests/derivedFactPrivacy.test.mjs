// What was derived from a message follows the message (GET-253).
//
// The Harborline scenario again: Avery's private 1:1 with Rowan, a thread Theo was cc'd on, a
// sequencer email nobody owns, and a meeting. A fact, an action item or a reply chip read out of an
// email is readable by exactly the people who may read that email.
//
// Run: node --test apps/worker/tests/derivedFactPrivacy.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  derivedSources, loadDerivedSources, canReadDerived, filterDerivedForViewer, filterByCitedClaimsForViewer,
  derivedAudienceKey, TEAM_VIEWER,
} from '@nous/core';

const THEO = { userId: 'u-theo', emails: new Set(['test.user.0002@gmail.com']) };
const AVERY = { userId: 'u-avery', emails: new Set(['test.user.0001@gmail.com']) };

const ID = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const PRIVATE_1TO1 = ID(1), CC_THREAD = ID(2), SEQUENCER = ID(3), MEETING = ID(4), ACTION_OBS = ID(5), GONE = ID(9);

const OBSERVATIONS = [
  { id: PRIVATE_1TO1, property: 'interaction.email_sent', owner_user_id: 'u-avery',
    raw: { participants: { from: 'test.user.0001@gmail.com', to: ['rowan@harborline.example'], cc: [] }, mailbox_owner_ids: ['u-avery'] } },
  { id: CC_THREAD, property: 'interaction.email_received', owner_user_id: 'u-avery',
    raw: { participants: { from: 'rowan@harborline.example', to: ['test.user.0001@gmail.com'], cc: ['test.user.0002@gmail.com'] }, mailbox_owner_ids: ['u-avery'] } },
  { id: SEQUENCER, property: 'interaction.email_received', owner_user_id: null, raw: {} },
  { id: MEETING, property: 'interaction.meeting_held', owner_user_id: 'u-theo', raw: {} },
  { id: ACTION_OBS, property: 'action_item.email_x_0', owner_user_id: null, raw: {} },
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
  value: { content: `fact ${id}`, metadata: { source_activity_id: sourceId ?? null, signal_type: 'email_received', ...extra } },
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

test('an email fact whose message is gone fails closed; a meeting fact whose doc is gone stays shared', async () => {
  const rows = [fact('g', GONE), fact('gm', GONE, { signal_type: 'meeting_held' })];
  const out = await filterDerivedForViewer(fakeSupabase(), 'ws', rows, THEO);
  assert.deepEqual(out.map((r) => r.id), ['gm']);
});

test('an action item is judged by the email it names, not by its own observation', async () => {
  const item = { property: 'action_item.email_x_0', supporting_observation_ids: [ACTION_OBS], value: { title: 'Send NDA', source_id: PRIVATE_1TO1, source_type: 'email' } };
  assert.equal((await filterDerivedForViewer(fakeSupabase(), 'ws', [item], THEO)).length, 0);
  assert.equal((await filterDerivedForViewer(fakeSupabase(), 'ws', [item], AVERY)).length, 1);
});

test('non-derived claims and documents pass through untouched', async () => {
  const rows = [{ property: 'name', value: 'Rowan' }, { id: 'd', property: 'note.d', value: { metadata: { doc_type: 'meeting_brief', source_activity_id: PRIVATE_1TO1 } } }];
  const out = await filterDerivedForViewer(fakeSupabase(), 'ws', rows, THEO);
  assert.equal(out.length, 2);
});

test('the team viewer reads only what every member may read — the input to summaries', async () => {
  const rows = [fact('a', PRIVATE_1TO1), fact('b', CC_THREAD), fact('s', SEQUENCER), fact('m', MEETING, { signal_type: 'meeting_held' })];
  const out = await filterDerivedForViewer(fakeSupabase(), 'ws', rows, TEAM_VIEWER);
  assert.deepEqual(out.map((r) => r.id), ['s', 'm']);
});

test('a graph edge follows the fact it cites', async () => {
  CLAIMS.length = 0;
  CLAIMS.push({ id: ID(20), ...fact('x', PRIVATE_1TO1) , }, { id: ID(21), ...fact('y', MEETING, { signal_type: 'meeting_held' }) });
  CLAIMS[0].id = ID(20); CLAIMS[1].id = ID(21);
  const edges = [{ e: 1, source_memory_id: ID(20) }, { e: 2, source_memory_id: ID(21) }, { e: 3, source_memory_id: null }];
  const out = await filterByCitedClaimsForViewer(fakeSupabase(), 'ws', edges, THEO, (e) => [e.source_memory_id]);
  assert.deepEqual(out.map((e) => e.e), [2, 3]);
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
