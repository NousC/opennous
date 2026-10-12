// saveNote dates a claim by when it was SAID, and every reader sees freshness computed now (GET-770).
// Before: valid_from was write time, so a backfill dated a June call today; freshness was the
// literal 'fresh' forever and decays_at was never written.
//
// Run: pnpm --filter @nous/core build && node --test packages/core/test/saveNoteSaidAt.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { saveNote, listNotes, retireNote } from '../dist/db/notes.js';

function fakeSupabase(rows = []) {
  const inserted = [];
  const updates = [];
  const api = {
    inserted, updates, rows,
    from() {
      const f = [];
      let mode = 'select', payload = null;
      const q = {
        select() { return q; },
        insert(p) { mode = 'insert'; payload = p; return q; },
        update(p) { mode = 'update'; payload = p; return q; },
        eq(col, v) { f.push(r => r[col] === v); return q; },
        not(col, op, v) { f.push(r => (col === 'value->>category' ? r.value?.category : r[col]) !== v); return q; },
        like(col, pat) { const p = pat.replace('%', ''); f.push(r => String(r[col]).startsWith(p)); return q; },
        is(col, v) { f.push(r => (r[col] ?? null) === v); return q; },
        in(col, vs) { f.push(r => vs.includes(r[col])); return q; },
        order() { return q; },
        range() { return q; },
        maybeSingle() { return q.single(); },
        single() {
          if (mode === 'insert') {
            const row = { id: `id-${inserted.length + 1}`, ...payload };
            inserted.push(row); rows.push(row);
            return Promise.resolve({ data: row, error: null });
          }
          const hit = rows.filter(r => f.every(fn => fn(r)))[0] ?? null;
          if (mode === 'update' && hit) { updates.push({ id: hit.id, ...payload }); Object.assign(hit, payload); }
          return Promise.resolve({ data: hit, error: null });
        },
        then(res, rej) {
          if (mode === 'update') {
            for (const r of rows.filter(r => f.every(fn => fn(r)))) { updates.push({ id: r.id, ...payload }); Object.assign(r, payload); }
            return Promise.resolve({ data: null, error: null }).then(res, rej);
          }
          return Promise.resolve({ data: rows.filter(r => f.every(fn => fn(r))), error: null }).then(res, rej);
        },
      };
      return q;
    },
  };
  return api;
}

test('a claim is dated by when it was said, carries its decay date, and is fresh only by the clock', async () => {
  const sb = fakeSupabase();
  await saveNote(sb, 'ws', {
    entityId: 'p-dana', category: 'goal', source: 'signal_extraction',
    content: 'Dana Reyes needs this turnaround for another couple of months.',
    saidAt: '2026-09-29T15:00:00Z',
  });
  const row = sb.inserted[0];
  assert.equal(row.valid_from, '2026-09-29T15:00:00.000Z');
  assert.ok(row.decays_at, 'decays_at is written');
  assert.ok(Date.parse(row.decays_at) > Date.parse(row.valid_from));
  // computed_at stays the write time: when WE learned it, beside when THEY said it.
  assert.notEqual(row.computed_at, row.valid_from);
});

test('no said-at means now — the old behaviour, for writers that do not know', async () => {
  const sb = fakeSupabase();
  const before = Date.now();
  await saveNote(sb, 'ws', { entityId: 'p', category: 'pain', content: 'X finds reporting slow.' });
  assert.ok(Date.parse(sb.inserted[0].valid_from) >= before - 1000);
  assert.equal(sb.inserted[0].freshness, 'fresh');
});

test('readers see freshness computed now from the category and the said date', async () => {
  const old = new Date(Date.now() - 20 * 86_400_000).toISOString();
  const sb = fakeSupabase([
    { id: 'a', workspace_id: 'ws', entity_id: 'p', property: 'note.a', value: { category: 'buying_signal', content: 'P asked for the DPA.', source: 'signal_extraction', metadata: {} },
      confidence: 1, freshness: 'fresh', valid_from: old, computed_at: old, invalid_at: null, supporting_observation_ids: [] },
    { id: 'b', workspace_id: 'ws', entity_id: 'p', property: 'note.b', value: { category: 'firmographic', content: 'P has 400 customers.', source: 'signal_extraction', metadata: {} },
      confidence: 1, freshness: 'fresh', valid_from: old, computed_at: old, invalid_at: null, supporting_observation_ids: [] },
  ]);
  const notes = await listNotes(sb, 'ws', { entityId: 'p' });
  const by = Object.fromEntries(notes.map(n => [n.id, n]));
  assert.equal(by.a.freshness, 'aging', 'a 20-day-old buying signal is no longer fresh, whatever the column says');
  assert.equal(by.b.freshness, 'fresh');
  assert.equal(by.a.said_at, old);
});

test('retireNote ends a claim and links both ways, keeping the history', async () => {
  const sb = fakeSupabase([
    { id: 'old', workspace_id: 'ws', entity_id: 'p', property: 'note.old', value: { category: 'goal', content: 'Needs a couple of months.', metadata: { quote: 'q' } },
      valid_from: '2026-09-29T15:00:00Z', invalid_at: null },
    { id: 'new', workspace_id: 'ws', entity_id: 'p', property: 'note.new', value: { category: 'buying_signal', content: 'Ready to present it.', metadata: {} },
      valid_from: '2026-10-07T18:00:00Z', invalid_at: null },
  ]);
  await retireNote(sb, 'ws', 'old', 'new', 'contradicted');
  const old = sb.rows.find(r => r.id === 'old');
  const fresh = sb.rows.find(r => r.id === 'new');
  assert.ok(old.invalid_at, 'old claim is retired');
  assert.equal(old.value.metadata.superseded_by, 'new');
  assert.equal(old.value.metadata.superseded_reason, 'contradicted');
  assert.equal(old.value.metadata.quote, 'q', 'nothing else on the old claim is lost');
  assert.equal(fresh.value.metadata.supersedes, 'old');
});

test('retireNote leaves an already-retired claim alone: its first successor stays its successor', async () => {
  const sb = fakeSupabase([
    { id: 'old', workspace_id: 'ws', entity_id: 'p', property: 'note.old', value: { category: 'goal', content: 'x', metadata: { superseded_by: 'first' } },
      valid_from: '2026-09-29T15:00:00Z', invalid_at: '2026-10-07T18:00:00Z' },
    { id: 'second', workspace_id: 'ws', entity_id: 'p', property: 'note.second', value: { category: 'goal', content: 'y', metadata: {} },
      valid_from: '2026-10-07T18:00:00Z', invalid_at: null },
  ]);
  await retireNote(sb, 'ws', 'old', 'second', 'contradicted');
  const old = sb.rows.find(r => r.id === 'old');
  assert.equal(old.value.metadata.superseded_by, 'first');
  assert.equal(old.invalid_at, '2026-10-07T18:00:00Z');
  assert.equal(sb.rows.find(r => r.id === 'second').value.metadata.supersedes, undefined);
});
