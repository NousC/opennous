// Two silent failures from the 2026-10-07 credit outage and the 2026-10-08 cleanups.
//
// 1. The Gmail reader wrote its "read" marker even when the insight or commitment step could not
//    reach the model, so a thread read during an outage kept its facts and lost its insights and
//    tasks for good: the marker said done. A step the model was UNAVAILABLE for now leaves the
//    thread unmarked, so the next run reads it again. An unreadable answer does not: re-buying a
//    thread that always confuses the model would cost credits forever.
// 2. An account's summary was only rewritten when new facts arrived, the stage moved, or someone
//    pressed refresh, so retiring facts (a supersede, a re-sort, a manual review) left a summary
//    describing what is no longer true. The sweep now also picks up accounts with facts retired
//    in its window.
//
// Run: node --test apps/worker/tests/markerAndSummary.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { shouldMarkThreadRead } from '../src/noema/gmailRead.mjs';
import { entitiesWithRetiredFacts } from '../src/signals/companySummary.mjs';

test('a thread is marked read only when no step was missing its model', () => {
  assert.equal(shouldMarkThreadRead({ insights: { ok: true }, commitments: { ok: true } }), true);
  assert.equal(shouldMarkThreadRead({ insights: { ok: false, reason: 'unavailable' }, commitments: { ok: true } }), false);
  assert.equal(shouldMarkThreadRead({ insights: { ok: true }, commitments: { ok: false, reason: 'unavailable' } }), false);
  assert.equal(shouldMarkThreadRead({ insights: { ok: false, reason: 'unparseable' }, commitments: { ok: true } }), true, 'an unreadable answer does not hold the marker');
  assert.equal(shouldMarkThreadRead({ insights: null, commitments: null }), true, 'a step that did not run does not hold it');
});

test('the reader asks shouldMarkThreadRead before writing the marker', () => {
  const src = readFileSync(new URL('../src/noema/gmailRead.mjs', import.meta.url), 'utf8');
  const at = src.indexOf('await markThreadRead(supabase, workspaceId, thread, contactId');
  assert.ok(at > 0);
  assert.match(src.slice(Math.max(0, at - 600), at), /shouldMarkThreadRead\(/);
});

test('the sweep finds the entities whose facts were retired since the window opened', async () => {
  const calls = [];
  const sb = {
    from(table) {
      const q = { table, filters: [] };
      const b = {
        select: () => b, like: (c, v) => { q.filters.push(['like', c, v]); return b; },
        gte: (c, v) => { q.filters.push(['gte', c, v]); return b; }, limit: () => b,
        then: (ok) => { calls.push(q); return Promise.resolve({ data: [
          { workspace_id: 'ws1', entity_id: 'p1' }, { workspace_id: 'ws1', entity_id: 'c1' }, { workspace_id: 'ws2', entity_id: 'c9' }, { workspace_id: 'ws1', entity_id: 'p1' },
        ], error: null }).then(ok); },
      };
      return b;
    },
  };
  const byWs = await entitiesWithRetiredFacts(sb, '2026-10-08T00:00:00Z');
  assert.deepEqual([...byWs.get('ws1')].sort(), ['c1', 'p1']);
  assert.deepEqual([...byWs.get('ws2')], ['c9']);
  assert.ok(calls[0].filters.some(([op, c, v]) => op === 'gte' && c === 'invalid_at' && v === '2026-10-08T00:00:00Z'));
  assert.ok(calls[0].filters.some(([op, c, v]) => op === 'like' && c === 'property' && v === 'note.%'));
});
