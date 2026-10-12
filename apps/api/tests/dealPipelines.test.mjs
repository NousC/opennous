// Which pipeline a deal is in, as the deal routes read it.
//
// The rule these pin: the newest observation per property wins (a deal moved between
// pipelines reads where it is NOW), an unanswered deal stays null rather than guessing, and a
// failed read degrades to null instead of taking a deal list down with it. Two optional
// display fields are never worth a 500.
//
// Pure: a fake PostgREST builder, no database and no network.
//
// Run: node --test apps/api/tests/dealPipelines.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadDealPipelines, withDealPipelines, ACCOUNT_DEAL_ID } from '../src/lib/accountDeals.mjs';

const WS = 'ws-1';

/**
 * A chainable stand-in for the query builder. `rows` is what the (single) page returns;
 * `error` makes the read fail the way PostgREST does. Records every call for assertions.
 */
function fakeSupabase({ rows = [], error = null } = {}) {
  const calls = { reads: 0, orders: [] };
  const builder = {
    select: () => builder,
    eq: () => builder,
    in: () => builder,
    not: () => builder,
    limit: () => builder,
    order: (col) => { calls.orders.push(col); return builder; },
    range: () => Promise.resolve({ data: error ? null : rows, error }),
  };
  return {
    calls,
    from: () => { calls.reads++; return builder; },
  };
}

const obs = (entity_id, property, value, day) => ({ entity_id, property, value });

test('the newest row per property wins, and both fields are trimmed', async () => {
  // Rows arrive newest-first (the query orders descending), so the first one seen is current.
  const sb = fakeSupabase({ rows: [
    obs('d1', 'pipeline_id', ' 1122334455 '),
    obs('d1', 'pipeline', ' Expansion pipeline '),
    obs('d1', 'pipeline_id', 'default'),          // older: must lose
    obs('d1', 'pipeline', ' Sales Pipeline'),     // older: must lose
  ] });
  const out = await loadDealPipelines(sb, WS, ['d1']);
  assert.deepEqual(out.get('d1'), { pipeline: 'Expansion pipeline', pipeline_id: '1122334455' });
});

test('a deal with no observations stays null, never assumed primary', async () => {
  const sb = fakeSupabase({ rows: [] });
  const out = await loadDealPipelines(sb, WS, ['d1', 'd2']);
  assert.deepEqual(out.get('d1'), { pipeline: null, pipeline_id: null });
  assert.deepEqual(out.get('d2'), { pipeline: null, pipeline_id: null });
});

test('the implied account deal is skipped, and an empty input reads nothing', async () => {
  const sb = fakeSupabase({ rows: [] });
  const only = await loadDealPipelines(sb, WS, [ACCOUNT_DEAL_ID]);
  assert.equal(only.size, 0);
  assert.equal(sb.calls.reads, 0, 'no ids left after skipping the implied deal, so no read');

  const none = await loadDealPipelines(fakeSupabase(), WS, []);
  assert.equal(none.size, 0);
});

test('a failed read degrades to null rather than throwing: a deal list must not 500 over a display field', async () => {
  const sb = fakeSupabase({ error: { message: 'permission denied for table observations', code: '42501' } });
  const out = await loadDealPipelines(sb, WS, ['d1']);
  assert.deepEqual(out.get('d1'), { pipeline: null, pipeline_id: null });
});

test('the page window is totally ordered, so a tied pair cannot straddle a page edge', async () => {
  // A sync writes both rows for one deal in one statement, so they share observed_at AND
  // created_at. Without a unique tiebreaker Postgres may return one on both pages or neither.
  const sb = fakeSupabase({ rows: [] });
  await loadDealPipelines(sb, WS, ['d1']);
  assert.deepEqual(sb.calls.orders, ['observed_at', 'created_at', 'id']);
});

test('withDealPipelines adds exactly the two fields and keeps everything else', async () => {
  const sb = fakeSupabase({ rows: [obs('d1', 'pipeline', 'Sales Pipeline'), obs('d1', 'pipeline_id', 'default')] });
  const [deal] = await withDealPipelines(sb, WS, [{ id: 'd1', name: 'Brindlecombe Auto Group', value: 12000 }]);
  assert.deepEqual(deal, { id: 'd1', name: 'Brindlecombe Auto Group', value: 12000, pipeline: 'Sales Pipeline', pipeline_id: 'default' });
});
