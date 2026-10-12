// The deal roster edge: person → deal, `stakeholder_of`. Pure shape tests; the write
// itself rides the same idempotent upsert as `belongs_to`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stakeholderEdges } from '../dist/integrations/crm/index.js';

const WS = '00000000-0000-0000-0000-00000000aaaa';
const DEAL = '00000000-0000-0000-0000-0000000dea10';

test('one row per person, all pointing at the deal', () => {
  const rows = stakeholderEdges(WS, DEAL, ['p1', 'p2'], '2026-09-01T00:00:00.000Z');
  assert.equal(rows.length, 2);
  for (const r of rows) {
    assert.equal(r.workspace_id, WS);
    assert.equal(r.to_entity_id, DEAL);
    assert.equal(r.type, 'stakeholder_of');
    assert.equal(r.valid_from, '2026-09-01T00:00:00.000Z');
  }
  assert.deepEqual(rows.map(r => r.from_entity_id), ['p1', 'p2']);
});

test('duplicates and unresolved ids are dropped, never a null person', () => {
  const rows = stakeholderEdges(WS, DEAL, ['p1', null, 'p1', undefined, '']);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].from_entity_id, 'p1');
});

test('no roster → no rows', () => {
  assert.deepEqual(stakeholderEdges(WS, DEAL, []), []);
});

test('missing valid_from falls back to now, as an ISO string', () => {
  const [r] = stakeholderEdges(WS, DEAL, ['p1']);
  assert.ok(!Number.isNaN(Date.parse(r.valid_from)));
});
