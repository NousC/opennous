// Account notes (GET-223): what an account record reads — the company's own notes plus its
// people's DEAL facts, never their personal ones.
//
// Run: pnpm --filter @nous/core build && node --test packages/core/test/accountNotes.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listAccountNotes, listNotes } from '../dist/db/notes.js';

const CO = 'co-1', ROWAN = 'p-rowan', WREN = 'p-wren';

const claim = (id, entity_id, category, content, valid_from, source = 'signal_extraction', metadata = {}) => ({
  id, workspace_id: 'ws', entity_id, property: `note.${id}`,
  value: { category, content, source, metadata },
  confidence: 0.8, valid_from, computed_at: valid_from, invalid_at: null, supporting_observation_ids: [],
});

const ROWS = [
  claim('c1', CO, 'pain', 'Harborline prospecting is manual.', '2026-09-02T10:00:00Z', 'signal_extraction', { about: 'company', voiced_by_contact_id: ROWAN }),
  claim('c2', CO, 'status_quo', 'Harborline has three full-cycle AEs.', '2026-09-02T09:00:00Z'),
  claim('d1', CO, 'meeting_notes', 'Call notes', '2026-09-01T09:00:00Z', 'fireflies', { doc_type: 'meeting_notes' }),
  claim('p1', ROWAN, 'objection', 'Rowan Achterberg doubts Nous solves outbound.', '2026-09-02T11:00:00Z'),
  claim('p2', ROWAN, 'authority', 'Rowan Achterberg decides on GTM tools.', '2026-09-02T08:00:00Z'),
  claim('p3', ROWAN, 'discovery', 'Rowan Achterberg found Nous on Hacker News.', '2026-09-02T12:00:00Z'),
  claim('p4', ROWAN, 'goal', 'Rowan Achterberg wants better lead quality.', '2026-09-02T07:00:00Z'),
  claim('p5', WREN, 'Timeline', 'Wren wants it live by Q4.', '2026-08-30T07:00:00Z'),
  claim('p6', WREN, 'Pain Points', 'Wren finds reporting slow.', '2026-08-29T07:00:00Z'),
  // Writers other than the worker. These used to be invisible to the account, because the filter
  // asked WHO WROTE IT rather than WHAT IT IS — plugin-written and health-read facts on
  // people were missing in prod. A deal fact is a deal fact whoever recorded it.
  claim('p7', WREN, 'objection', 'Wren pushed back on the annual commitment.', '2026-08-28T07:00:00Z', 'manual'),
  claim('p8', WREN, 'authority', 'Wren signs off on tooling spend.', '2026-08-27T07:00:00Z', 'fellow'),
  // …and the thing that genuinely does not belong on an account page: a document. Excluded for
  // carrying a doc_type, not for its source.
  claim('p9', ROWAN, 'objection', 'Transcript of the Q3 review.', '2026-08-26T07:00:00Z', 'fellow', { doc_type: 'meeting_notes' }),
];

// A PostgREST-shaped query builder over ROWS: records the filters, applies the ones the
// notes readers use, and resolves like supabase-js.
function fakeSupabase() {
  return {
    from() {
      const f = [];
      const q = {
        select() { return q; },
        eq(col, v) { f.push(r => (col === 'value->>source' ? r.value.source : r[col]) === v); return q; },
        not(col, op, v) { f.push(r => (col === 'value->>category' ? r.value.category : r[col]) !== v); return q; },
        like(col, pat) { const p = pat.replace('%', ''); f.push(r => String(r[col]).startsWith(p)); return q; },
        is(col, v) {
          f.push(r => (col === 'value->metadata->>doc_type'
            ? (r.value.metadata?.doc_type ?? null)
            : r[col]) === v);
          return q;
        },
        in(col, vs) { f.push(r => vs.includes(r[col])); return q; },
        order() { return q; },
        range() { return q; },
        then(res, rej) { return Promise.resolve({ data: ROWS.filter(r => f.every(fn => fn(r))), error: null }).then(res, rej); },
      };
      return q;
    },
  };
}

test('an account reads its own notes plus its people\'s deal facts, and nothing personal', async () => {
  const notes = await listAccountNotes(fakeSupabase(), 'ws', CO, [ROWAN, WREN]);
  const ids = notes.map(n => n.id).sort();
  // Company: both facts and the document. People: objection, authority, and the legacy
  // "Timeline" label — plus the manually recorded objection (p7) and the plugin-written authority
  // (p8), which are deal facts whoever wrote them. Not: discovery, goal, legacy "Pain Points"
  // (pain is personal), and not p9, which is a document.
  assert.deepEqual(ids, ['c1', 'c2', 'd1', 'p1', 'p2', 'p5', 'p7', 'p8']);
});

test('a rolled-up fact says who voiced it; a company fact keeps its own voice', async () => {
  const notes = await listAccountNotes(fakeSupabase(), 'ws', CO, [ROWAN, WREN]);
  const by = Object.fromEntries(notes.map(n => [n.id, n]));
  assert.equal(by.p1.metadata.voiced_by_contact_id, ROWAN);
  assert.equal(by.p5.metadata.voiced_by_contact_id, WREN);
  assert.equal(by.c1.metadata.voiced_by_contact_id, ROWAN);
  assert.equal(by.c2.metadata.voiced_by_contact_id, undefined);
});

test('newest first across company and people', async () => {
  const notes = await listAccountNotes(fakeSupabase(), 'ws', CO, [ROWAN, WREN]);
  assert.deepEqual(notes.map(n => n.id), ['p1', 'c1', 'c2', 'p2', 'd1', 'p5', 'p7', 'p8']);
});

test('no people → just the company', async () => {
  const notes = await listAccountNotes(fakeSupabase(), 'ws', CO, []);
  assert.deepEqual(notes.map(n => n.id).sort(), ['c1', 'c2', 'd1']);
});

test('legacy Title-Case labels on extracted facts read as taxonomy keys; documents keep theirs', async () => {
  const notes = await listNotes(fakeSupabase(), 'ws', { entityIds: [WREN, CO] });
  const by = Object.fromEntries(notes.map(n => [n.id, n.category]));
  assert.equal(by.p5, 'timeline');
  assert.equal(by.p6, 'pain');
  assert.equal(by.d1, 'meeting_notes');
  assert.equal(by.p7, 'objection');
});
