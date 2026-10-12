import { test } from 'node:test';
import assert from 'node:assert/strict';
import { num, sanitizeBlock, sanitizeBlocks } from '../src/lib/reportBlocks.mjs';

// The block sanitizer shared by present_document and present_answer. Pure; no DB.

test('num recovers the number a model formatted anyway', () => {
  assert.equal(num(1340000), 1340000);
  assert.equal(num('$1,340,000'), 1340000);
  assert.equal(num('31%'), 31);
  assert.equal(num('$3.35M'), 3350000);
  assert.equal(num('$210K'), 210000);
  assert.equal(num('3 of 11'), null);
  assert.equal(num(''), null);
  assert.equal(num(null), null);
});

test('unknown and empty blocks are dropped, not shipped broken', () => {
  assert.equal(sanitizeBlock({ type: 'html', body: '<b>x</b>' }), null);
  assert.equal(sanitizeBlock({ type: 'prose', body: '   ' }), null);
  assert.equal(sanitizeBlock({ type: 'table', headers: ['a'], rows: [] }), null);
  assert.equal(sanitizeBlock({ type: 'chart', data: [{ label: 'one', value: 1 }] }), null, 'one point is not a chart');
});

test('a table unit turns typed money back into a number the renderer formats', () => {
  const t = sanitizeBlock({
    type: 'table',
    headers: ['Account', 'Value', 'Days quiet', 'Intervention'],
    units: [null, 'usd', 'days', 'nonsense'],
    rows: [['Calder Industrial', '$210K', 31, 'Call the sponsor']],
    emphasis: 3,
  });
  assert.deepEqual(t.rows[0], ['Calder Industrial', 210000, 31, 'Call the sponsor']);
  assert.deepEqual(t.units, [null, 'usd', 'days', null]);
});

test('a cell holding only a dash is empty; a hyphen inside a word survives', () => {
  const t = sanitizeBlock({
    type: 'table',
    headers: ['Account', 'Competitor', 'What to do'],
    rows: [
      ['Marlowe', '—', 'Re-engage before it goes cold'],
      ['Tidewell Cloud', 'rivalscope.example', '-'],
      ['Quayside', ' – ', 'Single-threaded, find a second contact'],
    ],
  });
  assert.deepEqual(t.rows[0], ['Marlowe', '', 'Re-engage before it goes cold']);
  assert.deepEqual(t.rows[1], ['Tidewell Cloud', 'rivalscope.example', '']);
  assert.deepEqual(t.rows[2], ['Quayside', '', 'Single-threaded, find a second contact']);
});

test('a table without units keeps every cell as text, as before', () => {
  const t = sanitizeBlock({ type: 'table', headers: ['Stage', 'Deals'], rows: [['Demo', 4]] });
  assert.deepEqual(t.rows[0], ['Demo', '4']);
  assert.equal('units' in t, false);
});

test('metrics: raw value with a unit, text only when it is not a number, four at most', () => {
  const m = sanitizeBlock({
    type: 'metrics',
    items: [
      { label: 'Closed won', value: '$3.35M', unit: 'usd' },
      { label: 'Coverage', text: '3 of 11' },
      { label: 'Touches', value: 42, unit: 'count' },
      { label: 'Win rate', value: 31, unit: 'pct' },
      { label: 'A fifth', value: 5, unit: 'count' },
    ],
  });
  assert.equal(m.items.length, 4, 'a fifth card would sit alone on its own line');
  assert.deepEqual(m.items[0], { label: 'Closed won', value: 3350000, unit: 'usd', note: null });
  assert.deepEqual(m.items[1], { label: 'Coverage', text: '3 of 11', note: null });
});

test('sanitizeBlocks can refuse a type and caps the count', () => {
  const blocks = [
    { type: 'callout', body: 'loud' },
    { type: 'prose', body: 'one' },
    { type: 'prose', body: 'two' },
    { type: 'prose', body: 'three' },
  ];
  const out = sanitizeBlocks(blocks, { max: 2, allow: new Set(['prose']) });
  assert.deepEqual(out.map((b) => b.body), ['one', 'two']);
});
