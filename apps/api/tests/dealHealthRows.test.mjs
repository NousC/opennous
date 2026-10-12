// The deal list carries the stored Nous deal health (2026_10_02_deal_health_rows.sql) without
// computing it: an open deal hands back its row's score, reason and stamp; a closed deal hands back
// nothing (its last score describes a deal that is gone); and a database without the columns yet
// reads exactly as before, with no error.
//
// Run: node --test apps/api/tests/dealHealthRows.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listDealRows } from '../src/lib/listRows.mjs';

const HEALTH_COLS = ['deal_health_score', 'deal_health_reason', 'deal_health_at'];

/** A PostgREST stand-in: deal rows for kind=deal, nothing else, and an error for unknown columns. */
function fakeDb(dealRows, { healthColumns }) {
  const seen = [];
  const from = () => {
    const q = { cols: '', filters: {} };
    const b = {
      select(cols) { q.cols = cols; seen.push(cols); return b; },
      eq(k, v) { q.filters[k] = v; return b; },
      in() { return b; }, or() { return b; }, order() { return b; }, limit() { return b; }, range() { return b; },
      then(resolve) {
        if (!healthColumns && HEALTH_COLS.some(c => q.cols.includes(c))) {
          return resolve({ data: null, error: { code: '42703', message: 'column entity_list_rows.deal_health_score does not exist' } });
        }
        const data = q.filters.kind === 'deal'
          ? dealRows.filter(r => !q.filters.status || r.status === q.filters.status)
          : [];
        return resolve({ data, error: null });
      },
    };
    return b;
  };
  return { from, seen };
}

const deal = (id, status, extra = {}) => ({
  entity_id: id, name: id, company_id: null, company_name: null, country: null, stage: 's', status,
  pipeline_value: 100, close_date: null, owner_name: null, pipeline_ref: null, last_activity_at: null, pipeline: null, ...extra,
});

// Runs first on purpose: the column probe caches only a TRUE answer for the life of the process.
test('before the migration, every deal reads health null and nothing errors', async () => {
  const db = fakeDb([deal('d1', 'open')], { healthColumns: false });
  const rows = await listDealRows(db, 'ws');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].health_score, null);
  assert.equal(rows[0].health_reason, null);
  assert.equal(rows[0].health_at, null);
  // The page query never named a column the database does not have.
  assert.ok(!db.seen.filter(c => c.includes('pipeline_ref')).some(c => c.includes('deal_health_score')));
});

test('an open deal carries its stored score, reason and stamp; a closed one carries none', async () => {
  const at = '2026-10-02T03:35:00.000Z';
  const db = fakeDb([
    deal('open1', 'open', { deal_health_score: 42, deal_health_reason: 'Single-threaded; quiet 14 days', deal_health_at: at }),
    deal('won1', 'won', { deal_health_score: 88, deal_health_reason: 'Active buying intent', deal_health_at: at }),
    deal('open2', 'open'),
  ], { healthColumns: true });
  const rows = await listDealRows(db, 'ws');
  const by = Object.fromEntries(rows.map(r => [r.id, r]));
  assert.deepEqual([by.open1.health_score, by.open1.health_reason, by.open1.health_at], [42, 'Single-threaded; quiet 14 days', at]);
  assert.deepEqual([by.won1.health_score, by.won1.health_reason, by.won1.health_at], [null, null, null]);
  assert.deepEqual([by.open2.health_score, by.open2.health_reason, by.open2.health_at], [null, null, null]);
});
