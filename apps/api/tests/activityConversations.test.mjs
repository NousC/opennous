// Activity lists a conversation once (GET-744): a meeting is not five rows because five people
// were on it, and a HubSpot call is not four because four contacts are on it.
//
// Run: node --test apps/api/tests/activityConversations.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupConversations } from '../src/routes/api/activityStats.mjs';

const at = '2026-10-06T13:30:00Z';
const meeting = (id, s = 'Monthly touch point with Brackenmoor Labs') => ({ id, property: 'interaction.meeting_held', source: 'fellow', observed_at: at, value: { summary: s } });

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

// GET-903: the ledger pages by a cursor, and its claim lookups stay on the GIN index.
import { claimLookupChunks, CLAIM_CHUNK, pageRows, cutItems, encodeCursor, decodeCursor } from '../src/routes/api/activityStats.mjs';

test('claim lookups go in chunks small enough that the planner keeps the GIN index', () => {
  const ids = Array.from({ length: 1001 }, (_, i) => `id${i}`);
  const chunks = claimLookupChunks(ids);
  assert.ok(CLAIM_CHUNK <= 10);  // 12 already seq-scans on prod
  assert.ok(chunks.every((c) => c.length <= CLAIM_CHUNK && c.length > 0));
  assert.deepEqual(chunks.flat(), ids);
  assert.deepEqual(claimLookupChunks([]), []);
});

const row = (id, t) => ({ id, observed_at: t });

test('pageRows: a short read is the whole tail, no next cursor', () => {
  const rows = [row('a', '2026-10-03'), row('b', '2026-10-02')];
  assert.deepEqual(pageRows(rows, 5), { rows, next: null });
});

test('pageRows: a full read drops the last instant, so its copies come whole on the next page', () => {
  const rows = [row('a', '2026-10-05'), row('b', '2026-10-04'), row('c', '2026-10-03'), row('d', '2026-10-03')];
  const out = pageRows(rows, 4);
  assert.deepEqual(out.rows.map((r) => r.id), ['a', 'b']);
  assert.deepEqual(out.next, { ts: '2026-10-03', incl: true });
});

test('pageRows: a full read all at one instant is kept, and the cursor moves strictly past it', () => {
  const rows = [row('a', '2026-10-03'), row('b', '2026-10-03')];
  const out = pageRows(rows, 2);
  assert.equal(out.rows.length, 2);
  assert.deepEqual(out.next, { ts: '2026-10-03', incl: false });
});

const item = (id, when) => ({ id, when });

test('cutItems: at most limit rows, and the cut never splits an instant', () => {
  const items = [item('1', '2026-10-09'), item('2', '2026-10-08'), item('3', '2026-10-07'), item('4', '2026-10-07'), item('5', '2026-10-06')];
  assert.deepEqual(cutItems(items, 5), { items, next: null });
  const two = cutItems(items, 2);
  assert.deepEqual(two.items.map((i) => i.id), ['1', '2']);
  assert.deepEqual(two.next, { ts: '2026-10-07', incl: true });
  // limit 3 would split the two rows at 10-07: the page stops before them.
  const three = cutItems(items, 3);
  assert.deepEqual(three.items.map((i) => i.id), ['1', '2']);
  assert.deepEqual(three.next, { ts: '2026-10-07', incl: true });
});

test('cutItems: more than limit rows at one instant are returned together, cursor strictly past', () => {
  const items = [item('1', '2026-10-07'), item('2', '2026-10-07'), item('3', '2026-10-07'), item('4', '2026-10-06')];
  const out = cutItems(items, 2);
  assert.deepEqual(out.items.map((i) => i.id), ['1', '2', '3']);
  assert.deepEqual(out.next, { ts: '2026-10-07', incl: false });
});

test('cursor round-trips, and junk decodes to the first page', () => {
  const c = { ts: '2026-10-07T10:00:00.123456+00:00', incl: true };
  assert.deepEqual(decodeCursor(encodeCursor(c)), c);
  assert.equal(encodeCursor(null), null);
  assert.equal(decodeCursor(undefined), null);
  assert.equal(decodeCursor('not-a-cursor'), null);
  assert.equal(decodeCursor(Buffer.from(JSON.stringify({ ts: 5 })).toString('base64url')), null);
});
