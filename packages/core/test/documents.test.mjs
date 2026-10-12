// Documents (GET-197): the pure rules every surface shares — where a report is filed, what a
// document reads as in plain text, how it is chunked, and what its ref looks like.
//
// Run: pnpm --filter @nous/core build && node --test packages/core/test/documents.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  documentCadence, inferPeriodFromTitle, seriesFor, renderDocumentMarkdown, sectionText,
  chunkDocument, documentRef, parseDocumentRef, citeTokensIn, sectionsFromMarkdown, documentKindFromDocType, legacyMarkersIn, splitCiteGroups,
} from '../dist/db/documents.js';

const DAY = 86_400_000;
const span = (days) => {
  const end = new Date('2026-09-13T12:00:00Z');
  return [new Date(end.getTime() - days * DAY).toISOString(), end.toISOString()];
};

test('a report is filed by the length of the window it covers', () => {
  assert.equal(documentCadence('report', ...span(7)), 'weekly');
  assert.equal(documentCadence('report', ...span(30)), 'monthly');
  assert.equal(documentCadence('report', ...span(31)), 'monthly');
  assert.equal(documentCadence('report', ...span(91)), 'quarterly');
  assert.equal(documentCadence('report', ...span(180)), 'one_off');
  assert.equal(documentCadence('report', null, null), 'one_off');
  // A brief covers no window; it is filed by its account, never by cadence.
  assert.equal(documentCadence('brief', ...span(30)), null);
});

test('the period is read from a title only when the title actually names one', () => {
  const at = '2026-09-12T23:24:09Z';
  const days = (p) => Math.round((Date.parse(p.end) - Date.parse(p.start)) / DAY);
  assert.equal(days(inferPeriodFromTitle('Market read — last 30 days', at)), 30);
  assert.equal(days(inferPeriodFromTitle('OpenNous — How revenue actually moved, last six months', at)), 180);
  assert.equal(days(inferPeriodFromTitle('Weekly pipeline', at)), 7);
  assert.equal(days(inferPeriodFromTitle('Pipeline this quarter', at)), 91);
  assert.equal(inferPeriodFromTitle('Revenue Pipeline Report — Fernpoint', at), null);
  assert.equal(documentCadence('report', ...Object.values(inferPeriodFromTitle('Market read — last 30 days', at))), 'monthly');
});

test('series comes from the skill first, the title second', () => {
  assert.equal(seriesFor('revenue-report', 'anything'), 'pipeline');
  assert.equal(seriesFor(null, 'Win/Loss Analysis — Fernpoint'), 'win_loss');
  assert.equal(seriesFor(null, 'Market read — last 30 days'), 'market_read');
  assert.equal(seriesFor(null, 'Backfill Review — What Actually Landed'), null);
});

test('a blocks-only section flattens to its data, never to "undefined"', () => {
  const sections = [{
    label: 'Most value loss begins between discovery and evaluation',
    blocks: [
      { type: 'metrics', items: [{ label: 'Created', value: 1340000, unit: 'usd' }, { label: 'Win rate', value: 31, unit: 'pct' }] },
      { type: 'chart', variant: 'bar', title: 'Deals lost by stage', unit: 'count', data: [{ label: 'Discovery', value: 12 }] },
      { type: 'table', headers: ['Account', 'Value'], units: ['', 'usd'], rows: [['Acme', 210000]] },
      { type: 'prose', body: 'Brin said pricing was steep [ct7k2].' },
    ],
  }];
  const md = renderDocumentMarkdown({ headline: 'Discovery leaks', sections });
  assert.ok(!md.includes('undefined'));
  assert.match(md, /## Most value loss begins/);
  assert.match(md, /- Created: \$1,340,000/);
  assert.match(md, /- Win rate: 31%/);
  assert.match(md, /- Discovery: 12/);
  assert.match(md, /\| Acme \| \$210,000 \|/);
  assert.deepEqual([...citeTokensIn(md)], ['ct7k2']);
  assert.equal(sectionText({ label: 'Empty' }), '');
});

test('chunks follow sections, and a long section is packed by paragraph', () => {
  const para = 'word '.repeat(200).trim();   // ~1000 chars
  const chunks = chunkDocument([
    { label: 'Short', body: 'One line.' },
    { label: 'Long', body: [para, para, para].join('\n\n') },
    { label: 'Nothing' },
  ]);
  assert.equal(chunks[0].section_index, 0);
  assert.equal(chunks[0].heading, 'Short');
  const long = chunks.filter(c => c.section_index === 1);
  assert.equal(long.length, 3);
  assert.ok(long.every(c => c.content.length <= 1500));
  assert.deepEqual(chunks.map(c => c.chunk_index), chunks.map((_, i) => i));
  assert.ok(!chunks.some(c => c.section_index === 2));
});

test('a document ref round-trips, with and without a section', () => {
  const id = '5c0ffee0-1d2e-4f3a-9b8c-7d6e5f4a3b21';
  assert.equal(documentRef(id), `nous://doc/${id}`);
  assert.deepEqual(parseDocumentRef(documentRef(id, 3)), { documentId: id, sectionIndex: 3 });
  assert.deepEqual(parseDocumentRef(documentRef(id)), { documentId: id, sectionIndex: null });
  assert.equal(parseDocumentRef('nous://account/5c0ffee0-1d2e-4f3a-9b8c-7d6e5f4a3b21'), null);
  assert.equal(parseDocumentRef('source://fireflies/01EXAMPLE'), null);
});

test('a one-string document splits on its headings into sections', () => {
  const md = '# Meeting brief — Acme\n\nIntro line.\n\n## Who\nDana, VP Ops.\n\n## Watch-outs\nPricing came up twice.';
  assert.deepEqual(sectionsFromMarkdown(md), [
    { label: 'Summary', body: 'Intro line.' },
    { label: 'Who', body: 'Dana, VP Ops.' },
    { label: 'Watch-outs', body: 'Pricing came up twice.' },
  ]);
  assert.deepEqual(sectionsFromMarkdown('Just a paragraph.'), [{ label: 'Summary', body: 'Just a paragraph.' }]);
  assert.equal(documentKindFromDocType('account_brief'), 'brief');
  assert.equal(documentKindFromDocType('meeting_notes'), null);   // raw the agent reads, not a document it wrote
});

test('legacy [n] markers are read as numbered citations, links are not', () => {
  assert.deepEqual([...legacyMarkersIn('Stage is discovery [1]. Quiet since Aug 10 [1][3]. See [docs](#x) and [12].')].sort((a, b) => a - b), [1, 3, 12]);
  assert.equal(legacyMarkersIn('A cite token [ct7k2] is not a number.').size, 0);
});

test('a grouped citation bracket splits into one token per bracket', () => {
  assert.equal(splitCiteGroups('Theo owns CRM write-back [cbvq8, clf45].'), 'Theo owns CRM write-back [cbvq8][clf45].');
  assert.equal(splitCiteGroups('One [ct7k2] stays.'), 'One [ct7k2] stays.');
  assert.deepEqual([...citeTokensIn(splitCiteGroups('[cbvq8; clf45]'))], ['cbvq8', 'clf45']);
});
