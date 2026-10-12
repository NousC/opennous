// The account page's intel timeline route (GET-794): the window from ?days=, the account's people
// read for their facts, and the core shaping passed through.
//
// Run: node --test apps/api/tests/intelTimeline.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadIntelTimeline, timelineDays } from '../src/lib/intelTimeline.mjs';

const recent = new Date(Date.now() - 3 * 86_400_000).toISOString();

function fakeSupabase(tables) {
  const calls = [];
  return {
    calls,
    from(table) {
      const f = [];
      const q = {
        select: () => q,
        eq: (col, v) => { calls.push([table, 'eq', col, v]); f.push(r => r[col] === undefined || r[col] === v); return q; },
        in: (col, vs) => { calls.push([table, 'in', col, vs]); f.push(r => vs.includes(r[col])); return q; },
        is: () => q, like: () => q, not: () => q, order: () => q, range: () => q,
        gte: (col, v) => { calls.push([table, 'gte', col, v]); return q; },
        then: (ok, bad) => Promise.resolve({ data: (tables[table] ?? []).filter(r => f.every(fn => fn(r))), error: null }).then(ok, bad),
      };
      return q;
    },
  };
}

test('?days= reads 30, 90 and all; anything else is 90', () => {
  assert.equal(timelineDays('30'), 30);
  assert.equal(timelineDays('90'), 90);
  assert.equal(timelineDays('all'), null);
  assert.equal(timelineDays('0'), null);
  assert.equal(timelineDays(undefined), 90);
  assert.equal(timelineDays('soon'), 90);
});

test('the timeline reads the company and its people, and links a replaced fact to its successor', async () => {
  const sb = fakeSupabase({
    contacts: [{ id: 'p-dana', company_id: 'co' }],
    claims: [
      { id: 'old', entity_id: 'co', property: 'note.old', value: { category: 'timeline', content: 'Needs two more months.', source: 'signal_extraction', metadata: { superseded_by: 'new' } }, valid_from: recent, computed_at: recent, invalid_at: recent },
      { id: 'new', entity_id: 'p-dana', property: 'note.new', value: { category: 'buying_signal', content: 'Ready to present.', source: 'signal_extraction', metadata: { supersedes: 'old' } }, valid_from: recent, computed_at: recent, invalid_at: null },
    ],
  });
  const t = await loadIntelTimeline(sb, 'ws', 'co', 30);
  assert.equal(t.days, 30);
  assert.deepEqual(t.facts.map(f => f.id).sort(), ['new', 'old']);
  assert.deepEqual(t.links, [{ from: 'old', to: 'new' }]);
  assert.ok(sb.calls.some(([table, op, col, v]) => table === 'contacts' && op === 'eq' && col === 'company_id' && v === 'co'));
  assert.ok(sb.calls.some(([table, op, col]) => table === 'claims' && op === 'gte' && col === 'valid_from'));
});
