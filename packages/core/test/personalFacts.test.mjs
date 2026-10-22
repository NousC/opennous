// A personal mark retires the deal facts already on file (GET-1016): a person's own, what they
// voiced that was filed on their company, and for a company its people's. Unmarking brings back
// exactly what that mark retired. Nothing is deleted.
//
// Run: cd packages/core && npm run build && node --test test/personalFacts.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { retirePersonalFacts, restorePersonalFacts, isPersonalRetirable, RETIRED_FOR_PERSONAL } from '../dist/db/personalFacts.js';

const WS = 'ws-1';
const ACME = 'co-harborline';
const ROWAN = 'p-rowan';
const IDA = 'p-ida';

// A Supabase stand-in over in-memory tables: the filters the module uses, and update().
function fakeDb(tables) {
  const read = (row, k) => {
    const m = k.match(/^value->metadata->>(.+)$/);
    return m ? row.value?.metadata?.[m[1]] : row[k];
  };
  return {
    tables,
    from(table) {
      const preds = [];
      let patch = null;
      const q = {
        select: () => q,
        range: () => q,
        order: () => q,
        eq: (k, v) => { preds.push(r => read(r, k) === v); return q; },
        in: (k, vs) => { preds.push(r => vs.includes(read(r, k))); return q; },
        like: (k, p) => { preds.push(r => String(read(r, k)).startsWith(p.replace('%', ''))); return q; },
        is: (k, v) => { preds.push(r => (read(r, k) ?? null) === v); return q; },
        not: (k, _op, v) => { preds.push(r => (read(r, k) ?? null) !== v); return q; },
        update: (p) => { patch = p; return q; },
        then: (resolve) => {
          const hit = (tables[table] ?? []).filter(r => preds.every(f => f(r)));
          if (patch) for (const r of hit) Object.assign(r, structuredClone(patch));
          resolve({ data: patch ? null : structuredClone(hit), error: null });
        },
      };
      return q;
    },
  };
}

const fact = (id, entity_id, category, metadata = {}) => ({
  id, workspace_id: WS, entity_id, property: `note.${id}`, invalid_at: null,
  value: { category, content: `${category} fact`, metadata },
});
const fixtures = () => ({
  contacts: [
    { id: ROWAN, workspace_id: WS, company_id: ACME },
    { id: IDA, workspace_id: WS, company_id: ACME },
  ],
  claims: [
    fact('budget-rowan', ROWAN, 'budget'),
    fact('pref-rowan', ROWAN, 'preference'),
    fact('brief-rowan', ROWAN, 'objection', { doc_type: 'brief' }),
    fact('blocker-co-by-rowan', ACME, 'blocker', { voiced_by_contact_id: ROWAN }),
    fact('blocker-co-by-ida', ACME, 'blocker', { voiced_by_contact_id: IDA }),
    fact('buying-ida', IDA, 'buying_signal'),
    fact('stack-co', ACME, 'tech_stack'),
    { ...fact('old-objection-rowan', ROWAN, 'objection'), invalid_at: '2026-01-01T00:00:00Z' },
  ],
});
const live = (db) => db.tables.claims.filter(c => !c.invalid_at).map(c => c.id).sort();

test('deal facts retire; who someone is, documents and the stack stay', () => {
  assert.equal(isPersonalRetirable({ category: 'budget' }), true);
  assert.equal(isPersonalRetirable({ category: 'Buying Signal' }), true);
  assert.equal(isPersonalRetirable({ category: 'authority' }), true);
  assert.equal(isPersonalRetirable({ category: 'preference' }), false);
  assert.equal(isPersonalRetirable({ category: 'tech_stack' }), false);
  assert.equal(isPersonalRetirable({ category: 'objection', metadata: { doc_type: 'brief' } }), false);
});

test('a person: their deal facts and what they voiced on the company retire, stamped with their id', async () => {
  const db = fakeDb(fixtures());
  assert.equal(await retirePersonalFacts(db, WS, ROWAN), 2);
  assert.deepEqual(live(db), ['blocker-co-by-ida', 'brief-rowan', 'buying-ida', 'pref-rowan', 'stack-co']);
  const budget = db.tables.claims.find(c => c.id === 'budget-rowan');
  assert.equal(budget.value.metadata[RETIRED_FOR_PERSONAL], ROWAN);
  assert.equal(budget.value.content, 'budget fact');
});

test('a company: its own deal facts and every one of its people\'s', async () => {
  const db = fakeDb(fixtures());
  assert.equal(await retirePersonalFacts(db, WS, ACME), 4);
  assert.deepEqual(live(db), ['brief-rowan', 'pref-rowan', 'stack-co']);
});

test('unmarking restores what that mark retired, and nothing it did not', async () => {
  const db = fakeDb(fixtures());
  await retirePersonalFacts(db, WS, ROWAN);
  await retirePersonalFacts(db, WS, IDA);
  assert.equal(await restorePersonalFacts(db, WS, ROWAN), 2);
  assert.deepEqual(live(db), ['blocker-co-by-rowan', 'brief-rowan', 'budget-rowan', 'pref-rowan', 'stack-co']);
  const budget = db.tables.claims.find(c => c.id === 'budget-rowan');
  assert.equal(RETIRED_FOR_PERSONAL in budget.value.metadata, false);
  // A fact retired before the mark (superseded long ago) stays history.
  assert.ok(db.tables.claims.find(c => c.id === 'old-objection-rowan').invalid_at);
});

test('unmarking a person whose company is still personal keeps their facts retired, now under the company', async () => {
  const db = fakeDb(fixtures());
  await retirePersonalFacts(db, WS, ROWAN);
  await retirePersonalFacts(db, WS, ACME);
  db.tables.claims.push({ id: 'mark-co', workspace_id: WS, entity_id: ACME, property: 'is_personal', value: true, invalid_at: null });
  assert.equal(await restorePersonalFacts(db, WS, ROWAN), 0);
  assert.deepEqual(live(db).filter(id => id !== 'mark-co'), ['brief-rowan', 'pref-rowan', 'stack-co']);
  assert.equal(db.tables.claims.find(c => c.id === 'budget-rowan').value.metadata[RETIRED_FOR_PERSONAL], ACME);
  // Unmarking the company now brings everything back.
  db.tables.claims.find(c => c.id === 'mark-co').invalid_at = '2026-10-22T00:00:00Z';
  assert.equal(await restorePersonalFacts(db, WS, ACME), 4);
});

test('the last unmarked person at a company: the company\'s own deal facts go too', async () => {
  const db = fakeDb(fixtures());
  db.tables.claims.push(fact('budget-co', ACME, 'budget'));
  db.tables.claims.push({ id: 'mark-ida', workspace_id: WS, entity_id: IDA, property: 'is_personal', value: true, invalid_at: null });
  await retirePersonalFacts(db, WS, ROWAN);
  assert.equal(db.tables.claims.find(c => c.id === 'budget-co').invalid_at !== null, true);
  assert.equal(db.tables.claims.find(c => c.id === 'blocker-co-by-ida').invalid_at !== null, true);
  // Unmarking them brings the company's facts back: the company itself is not marked.
  await restorePersonalFacts(db, WS, ROWAN);
  assert.equal(db.tables.claims.find(c => c.id === 'budget-co').invalid_at, null);
});

test('with a coworker still a deal, only what they voiced on the company goes', async () => {
  const db = fakeDb(fixtures());
  db.tables.claims.push(fact('budget-co', ACME, 'budget'));
  await retirePersonalFacts(db, WS, ROWAN);
  assert.equal(db.tables.claims.find(c => c.id === 'budget-co').invalid_at, null);
});

test('marking twice retires once', async () => {
  const db = fakeDb(fixtures());
  await retirePersonalFacts(db, WS, ROWAN);
  assert.equal(await retirePersonalFacts(db, WS, ROWAN), 0);
});
