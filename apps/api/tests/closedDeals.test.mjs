// Closed-deal import normalisation.
//
// This is the only path into Nous for real closed deals when a workspace has no CRM, so it
// is the only way such a workspace ever gets a deal amount or a win date. It used to keep
// the domain and discard everything else, stamping every import with now() — which meant a
// year of history all landed on today, every win read as closing this morning, and no money
// entered the system at all.
//
// Run: node --test apps/api/tests/closedDeals.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeClosedDeals, normalizeClosedAt, cleanDomain } from '../src/lib/closedDeals.mjs';

const NOW = Date.parse('2026-08-30T12:00:00.000Z');

// ── backward compatibility: the shape the web form still sends ───────────────

test('a bare domain string still works', () => {
  const [d] = normalizeClosedDeals(['acme.com'], NOW);
  assert.equal(d.domain, 'acme.com');
  assert.equal(d.amount, null);
  assert.equal(d.closedAt, null);
});

test('domains are cleaned the same way they always were', () => {
  const out = normalizeClosedDeals(
    ['https://www.Acme.com/pricing', ' GLOBEX.IO ', 'http://tinyco.io'], NOW);
  assert.deepEqual(out.map(d => d.domain), ['acme.com', 'globex.io', 'tinyco.io']);
});

test('junk entries are dropped, not turned into empty deals', () => {
  const out = normalizeClosedDeals(['', null, undefined, {}, { amount: 500 }, 'acme.com'], NOW);
  assert.equal(out.length, 1);
  assert.equal(out[0].domain, 'acme.com');
});

test('a non-array input returns an empty list', () => {
  assert.deepEqual(normalizeClosedDeals(null, NOW), []);
  assert.deepEqual(normalizeClosedDeals('acme.com', NOW), []);
});

test('the 40-deal cap is preserved', () => {
  const many = Array.from({ length: 60 }, (_, i) => `co${i}.com`);
  assert.equal(normalizeClosedDeals(many, NOW).length, 40);
});

// ── the new fields ───────────────────────────────────────────────────────────

test('amount and close date survive — the whole point of the change', () => {
  const [d] = normalizeClosedDeals(
    [{ domain: 'acme.com', amount: 48000, currency: 'USD', closed_at: '2026-03-14' }], NOW);
  assert.equal(d.domain, 'acme.com');
  assert.equal(d.amount, 48000);
  assert.equal(d.currency, 'USD');
  assert.equal(d.closedAt, '2026-03-14T00:00:00.000Z');
});

test('the alternate spellings an LLM is likely to send all work', () => {
  for (const key of ['amount', 'value', 'deal_value']) {
    const [d] = normalizeClosedDeals([{ domain: 'acme.com', [key]: 1234 }], NOW);
    assert.equal(d.amount, 1234, `amount not read from ${key}`);
  }
  for (const key of ['closed_at', 'closedAt', 'close_date']) {
    const [d] = normalizeClosedDeals([{ domain: 'acme.com', [key]: '2026-01-05' }], NOW);
    assert.equal(d.closedAt, '2026-01-05T00:00:00.000Z', `date not read from ${key}`);
  }
});

test('a zero or negative amount reads as missing, not as zero', () => {
  // Recording 0 would drag any average deal size down with a number nobody entered.
  for (const amount of [0, -100]) {
    const [d] = normalizeClosedDeals([{ domain: 'acme.com', amount }], NOW);
    assert.equal(d.amount, null, `amount ${amount} was kept`);
  }
});

test('a nonsense amount reads as missing rather than NaN', () => {
  const [d] = normalizeClosedDeals([{ domain: 'acme.com', amount: 'a lot' }], NOW);
  assert.equal(d.amount, null);
});

test('mixed shapes in one list are fine', () => {
  const out = normalizeClosedDeals(
    ['tinyco.io', { domain: 'acme.com', amount: 48000, closed_at: '2026-03-14' }], NOW);
  assert.equal(out.length, 2);
  assert.equal(out[0].amount, null);
  assert.equal(out[1].amount, 48000);
});

// ── dates ────────────────────────────────────────────────────────────────────

test('a real past close date is preserved', () => {
  assert.equal(normalizeClosedAt('2026-03-14T09:30:00.000Z', NOW), '2026-03-14T09:30:00.000Z');
});

test('a future close date is clamped to now', () => {
  // A win dated next month produces a negative cycle time in the funnel reconstruction.
  assert.equal(normalizeClosedAt('2027-01-01T00:00:00.000Z', NOW), new Date(NOW).toISOString());
});

test('a missing or unparseable date returns null so the caller can fall back', () => {
  for (const bad of [null, undefined, '', 'last spring', 'not-a-date']) {
    assert.equal(normalizeClosedAt(bad, NOW), null);
  }
});

test('no imported deal is ever dated in the future', () => {
  const out = normalizeClosedDeals([
    { domain: 'a.com', closed_at: '2020-01-01' },
    { domain: 'b.com', closed_at: '2030-01-01' },
    { domain: 'c.com', closed_at: 'garbage' },
    { domain: 'd.com' },
  ], NOW);
  for (const d of out) {
    if (d.closedAt) assert.ok(Date.parse(d.closedAt) <= NOW, `${d.domain} dated in the future`);
  }
});

test('cleanDomain handles the usual paste-in mess', () => {
  assert.equal(cleanDomain('HTTPS://WWW.Acme.COM/careers?x=1'), 'acme.com');
  assert.equal(cleanDomain(null), '');
});
