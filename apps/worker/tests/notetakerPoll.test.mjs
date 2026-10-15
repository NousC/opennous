// Fireflies/Fathom polling on self-host (GET-854): of a newest-first list, only what is newer
// than the cursor, oldest first, and whether the page already reached back to the cursor.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newerThan } from '../src/pollers/notetakers.mjs';

test('Fireflies epoch-ms dates: newer than the cursor, oldest first, cursor reached', () => {
  const since = Date.parse('2026-10-12T10:00:00Z');
  const items = [
    { id: 'c', date: Date.parse('2026-10-12T12:00:00Z') },
    { id: 'b', date: Date.parse('2026-10-12T11:00:00Z') },
    { id: 'a', date: since },
    { id: 'old', date: Date.parse('2026-10-11T09:00:00Z') },
  ];
  const r = newerThan(items, since, (t) => t.date);
  assert.deepEqual(r.fresh.map(x => x.it.id), ['b', 'c']);
  assert.equal(r.reachedCursor, true);
});

test('Fathom ISO times; a page entirely newer has not reached the cursor', () => {
  const since = Date.parse('2026-10-01T00:00:00Z');
  const r = newerThan([
    { recording_start_time: '2026-10-05T09:00:00Z' },
    { scheduled_start_time: '2026-10-03T09:00:00Z' },
    { recording_start_time: null },
  ], since, (m) => m.recording_start_time || m.scheduled_start_time);
  assert.equal(r.fresh.length, 2);
  assert.equal(r.reachedCursor, false);
});
