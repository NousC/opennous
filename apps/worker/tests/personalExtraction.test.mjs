// Personal contacts (GET-1014): a call with someone we know is read for insights, never for deal
// facts. withoutPersonal is what holds them back from the meeting fact pass.
//
// Run: node --test apps/worker/tests/personalExtraction.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withoutPersonal } from '../src/signals/index.mjs';

// Claims and contacts, narrowed by the eq filters the reads use.
function fakeDb({ claims = [], contacts = [] }) {
  return {
    from(table) {
      const filters = [];
      const rows = () => ({ claims, contacts }[table] ?? []).filter(r => filters.every(([k, v]) => !(k in r) || r[k] === v));
      const q = new Proxy({}, {
        get(_t, prop) {
          if (prop === 'then') return (resolve) => resolve({ data: rows(), error: null });
          if (prop === 'maybeSingle') return async () => ({ data: rows()[0] ?? null, error: null });
          if (prop === 'eq') return (k, v) => { filters.push([k, v]); return q; };
          if (prop === 'is') return () => q;
          return () => q;
        },
      });
      return q;
    },
  };
}

const WS = 'ws';
const people = [
  { contactId: 'friend', name: 'Rita Roster' },
  { contactId: 'buyer', name: 'Dana Whitfield' },
  { contactId: 'atPersonalCo', name: 'Oskar Lund' },
  { name: 'Unresolved Guest' },
];

test('a personal contact, and anyone at a personal company, is left out; the rest stay', async () => {
  const db = fakeDb({
    claims: [
      { workspace_id: WS, entity_id: 'friend', property: 'is_personal', value: true },
      { workspace_id: WS, entity_id: 'homeCo', property: 'is_personal', value: true },
    ],
    contacts: [
      { workspace_id: WS, id: 'buyer', company_id: 'acme' },
      { workspace_id: WS, id: 'atPersonalCo', company_id: 'homeCo' },
    ],
  });
  const kept = await withoutPersonal(db, WS, people);
  assert.deepEqual(kept.map(p => p.name), ['Dana Whitfield', 'Unresolved Guest']);
});

test('nobody marked personal: everyone stays', async () => {
  const kept = await withoutPersonal(fakeDb({}), WS, people);
  assert.equal(kept.length, people.length);
});
