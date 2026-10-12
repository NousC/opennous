// Same-meeting guard (GET-240): only another note-taker's RECORDING makes a transcript a duplicate.
//
// The bug: the calendar scan (and HubSpot) write interaction.meeting_held for the meeting itself,
// and the guard counted those as "another note-taker", so the Granola recording of a calendar
// meeting was thrown away with no trace.
//
// Run: node --test apps/worker/tests/sameMeetingDedup.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sameMeetingAlreadyLogged } from '../src/utils/resolveMeeting.mjs';

// A query-builder stub that applies the filters the guard asks for to an in-memory table.
function stub(rows) {
  const filters = [];
  const q = {
    select() { return q; },
    eq(col, v) { filters.push(r => r[col] === v); return q; },
    in(col, vs) { filters.push(r => vs.includes(r[col])); return q; },
    gte(col, v) { filters.push(r => r[col] >= v); return q; },
    lte(col, v) { filters.push(r => r[col] <= v); return q; },
    limit() { return Promise.resolve({ data: rows.filter(r => filters.every(f => f(r))) }); },
  };
  return { from: () => q };
}

const base = { workspace_id: 'w', property: 'interaction.meeting_held', entity_id: 'corwin', observed_at: '2026-09-14T17:00:00.000Z' };
const args = { contactIds: ['corwin'], occurredAt: '2026-09-14T16:50:14.000Z', externalIdPrefix: 'granola_not_a83_' };

test('a calendar "held" entry does not make a recording a duplicate', async () => {
  const sb = stub([{ ...base, source: 'google_calendar', external_id: 'gcal_7l8g_corwin_held' }]);
  assert.equal(await sameMeetingAlreadyLogged(sb, 'w', args), false);
});

test('a CRM meeting does not make a recording a duplicate', async () => {
  const sb = stub([{ ...base, source: 'hubspot', external_id: 'hubspot_123' }]);
  assert.equal(await sameMeetingAlreadyLogged(sb, 'w', args), false);
});

test('another note-taker recording the same call is a duplicate', async () => {
  const sb = stub([{ ...base, source: 'fireflies', external_id: 'ff_01M28_corwin' }]);
  assert.equal(await sameMeetingAlreadyLogged(sb, 'w', args), true);
});

test('a retry of the same recording is not a duplicate', async () => {
  const sb = stub([{ ...base, source: 'granola', external_id: 'granola_not_a83_corwin' }]);
  assert.equal(await sameMeetingAlreadyLogged(sb, 'w', args), false);
});
