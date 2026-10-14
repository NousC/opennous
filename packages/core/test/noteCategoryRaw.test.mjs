// GET-875: a note saved under a GTM label outside the claim taxonomy ('ICP', 'Market', ...) is stored
// as category 'general' with metadata.category_raw. listNotes({ categories: ['ICP'] }), which the
// ICP scorecard seed and the per-contact ICP scorers use, must still find it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { saveNote, listNotes } from '../dist/db/notes.js';

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

test('a note saved as ICP is found by a categories:[ICP] filter', async () => {
  const sb = fakeSupabase();
  await saveNote(sb, 'ws', { entityId: 'ws-entity', category: 'ICP', content: 'B2B SaaS, 100-1000 staff.', source: 'onboarding' });
  await saveNote(sb, 'ws', { entityId: 'ws-entity', category: 'Market', content: 'EU only.', source: 'onboarding' });
  await saveNote(sb, 'ws', { entityId: 'ws-entity', category: 'goal', content: 'Unrelated.', source: 'manual' });
  assert.equal(sb.inserted[0].value.category, 'general', 'stored under the taxonomy');
  const icp = await listNotes(sb, 'ws', { categories: ['ICP', 'Market'] });
  assert.deepEqual(icp.map(n => n.content).sort(), ['B2B SaaS, 100-1000 staff.', 'EU only.']);
  assert.equal((await listNotes(sb, 'ws', { categories: ['ICP'] })).length, 1);
});
