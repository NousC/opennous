// HubSpot · Read records (GET-773): a window of days against the one before, boiled down to the
// rows with activity, so the AI step and Slack read a short exact table.
//
// Run: pnpm --filter @nous/core build && node --test packages/core/test/hubspotRead.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeRecords, periodsFor, nameFromCompany } from '../dist/services/hubspotRead.mjs';

test('yesterday is that UTC day against the day before; 7 days against the 7 before', () => {
  const now = Date.parse('2026-10-08T14:00:00Z');
  const p = periodsFor('yesterday', now);
  assert.equal(p.current.label, '2026-10-07');
  assert.equal(p.previous.label, '2026-10-06');
  assert.equal(p.current.to - p.current.from, 86_400_000);
  const w = periodsFor('last_7_days', now);
  assert.equal(w.current.label, '2026-10-01 to 2026-10-07');
  assert.equal(w.previous.label, '2026-09-24 to 2026-09-30');
});

test('sums per row, shows the change, drops rows with nothing, adds totals', () => {
  const rec = (name, pulls, sold) => ({ id: name ?? 'x1', properties: { company_name: name, pulls: String(pulls), sold: String(sold) } });
  const out = summarizeRecords({
    current: [rec('Acme Motors', 40, 0), rec('Acme Motors', 3, 0), rec('Globex Auto', 15, 1), rec('Initech Cars', 0, 0), rec(null, 6, 0)],
    previous: [rec('Acme Motors', 26, 0), rec('Globex Auto', 10, 0), rec('Umbrella Sales', 4, 0)],
  }, { groupBy: 'company_name', fields: ['pulls', 'sold'], labels: { pulls: 'Lookups', sold: 'Sold' }, objectLabel: 'Daily Stats' });
  const lines = out.text.split('\n');
  assert.match(lines[0], /^Daily Stats: 4 with activity\./);
  assert.equal(lines[1], 'Name | Lookups | Sold');
  assert.equal(lines[2], 'Acme Motors | 43 (+17) | 0');
  assert.equal(lines[3], 'Globex Auto | 15 (+5) | 1 (+1)');
  assert.ok(lines.some(l => l.startsWith('Record x1 (no name) | 6 (+6)')));
  assert.ok(lines.some(l => l === 'Umbrella Sales | 0 (-4) | 0'));
  assert.ok(!out.text.includes('Initech Cars'), 'a row with nothing in either period is left out');
  assert.equal(lines.at(-1), 'Total | 64 (+24) | 1 (+1)');
});

test('summarizeRecords without compare: plain numbers, no change column (GET-787)', () => {
  const rec = (id, name, n) => ({ id, properties: { company_name: name, lookups: String(n) } });
  const out = summarizeRecords({ current: [rec('1', 'Acme Motors', 4), rec('2', 'Acme Motors', 3)], previous: [] },
    { groupBy: 'company_name', fields: ['lookups'], labels: { lookups: 'Lookups' }, periods: periodsFor('last_7_days', Date.parse('2026-10-08T12:00:00Z')), compare: false });
  const lines = out.text.split('\n');
  assert.equal(lines[0], 'Records, 2026-10-01 to 2026-10-07: 1 with activity.');
  assert.equal(lines[2], 'Acme Motors | 7');
  assert.equal(lines.at(-1), 'Total | 7');
});

test('a record with no name takes its company\'s name; a failure leaves it as it was (GET-791)', async () => {
  const records = [{ id: '7', properties: { company_name: '' } }, { id: '8', properties: { company_name: 'Globex Auto' } }, { id: '9', properties: {} }];
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(url);
    const body = url.includes('/associations/')
      ? { results: [{ from: { id: '7' }, to: [{ toObjectId: 501 }] }] }
      : { results: [{ id: '501', properties: { name: 'Acme Motors' } }] };
    return { ok: true, json: async () => body };
  };
  await nameFromCompany('t', '2-1', records, 'company_name', fetchImpl);
  assert.deepEqual(records.map(r => r.properties.company_name), ['Acme Motors', 'Globex Auto', undefined]);
  assert.match(calls[0], /\/crm\/v4\/associations\/2-1\/companies\/batch\/read$/);
  const broken = [{ id: '7', properties: {} }];
  await nameFromCompany('t', '2-1', broken, 'company_name', async () => ({ ok: false, status: 500, json: async () => ({}) }));
  assert.equal(broken[0].properties.company_name, undefined);
});
