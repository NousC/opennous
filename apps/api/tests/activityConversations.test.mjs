// Activity lists a conversation once (GET-744): a meeting is not five rows because five people
// were on it, and a HubSpot call is not four because four contacts are on it.
//
// Run: node --test apps/api/tests/activityConversations.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupConversations } from '../src/routes/api/activityStats.mjs';

const at = '2026-10-06T13:30:00Z';
const meeting = (id, s = 'Monthly touch point with Brackenmoor Honda') => ({ id, property: 'interaction.meeting_held', source: 'fellow', observed_at: at, value: { summary: s } });

test('five attendee rows of one meeting are one row, standing on the copy that was read', () => {
  const rows = [meeting('a'), meeting('b'), meeting('c'), meeting('d'), meeting('e')];
  const out = groupConversations(rows, new Set(['c']));
  assert.equal(out.length, 1);
  assert.equal(out[0].r.id, 'c');
  assert.deepEqual(out[0].ids, ['a', 'b', 'c', 'd', 'e']);
});

test('the same call logged per contact is one row; different calls stay apart', () => {
  const call = (id, t = at, s = 'Call to Tallowmere Marine') => ({ id, property: 'interaction.call_made', source: 'hubspot', observed_at: t, value: { description: s } });
  const out = groupConversations([call('1'), call('2'), call('3'), call('4'), call('5', '2026-10-06T13:31:00Z')]);
  assert.deepEqual(out.map((g) => g.ids.length), [4, 1]);
});

test('notes and different meetings at the same time are never merged', () => {
  const note = (id) => ({ id, property: 'interaction.note_added', source: 'hubspot', observed_at: at, value: { description: 'same' } });
  const out = groupConversations([note('n1'), note('n2'), meeting('m1'), meeting('m2', 'Another meeting')]);
  assert.equal(out.length, 4);
});
