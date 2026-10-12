// get_context on a company (a domain focus) reads the ACCOUNT: the timeline of its people's
// interactions and its people as the committee. It used to return neither, because both were
// read off the company entity, which holds no interactions and works nowhere.
//
// Run: pnpm --filter @nous/core build && node --test packages/core/test/companyContext.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assembleContext } from '../dist/context.js';

const NOW = Date.now();
const daysAgo = (n) => new Date(NOW - n * 86_400_000).toISOString();
const WS = 'ws', DANA = 'p-dana', LEE = 'p-lee', ACME = 'co-acme', OTHER = 'co-other', SAM = 'p-sam';

const obs = (id, entity_id, property, days) => ({
  id, workspace_id: WS, entity_id, kind: 'event', property, value: { summary: id },
  source: 'gmail', method: 'api', observed_at: daysAgo(days), ingested_at: daysAgo(days),
});
const nameClaim = (entity_id, property, value) => ({
  id: `${entity_id}-${property}`, workspace_id: WS, entity_id, property, value,
  confidence: 0.9, epistemic_class: 'asserted', freshness: 'fresh', valid_from: daysAgo(30),
  computed_at: daysAgo(30), invalid_at: null, supporting_observation_ids: [],
});

function tables() {
  return {
    entities: [
      { id: DANA, workspace_id: WS, type: 'person' },
      { id: LEE, workspace_id: WS, type: 'person' },
      { id: SAM, workspace_id: WS, type: 'person' },
      { id: ACME, workspace_id: WS, type: 'company' },
      { id: OTHER, workspace_id: WS, type: 'company' },
    ],
    relationships: [
      { workspace_id: WS, from_entity_id: DANA, to_entity_id: ACME, type: 'works_at', valid_to: null },
      { workspace_id: WS, from_entity_id: LEE, to_entity_id: ACME, type: 'works_at', valid_to: null },
      { workspace_id: WS, from_entity_id: SAM, to_entity_id: OTHER, type: 'works_at', valid_to: null },
    ],
    claims: [
      nameClaim(ACME, 'name', 'Acme'),
      nameClaim(DANA, 'name', 'Dana Reyes'), nameClaim(DANA, 'job_title', 'VP Operations'),
      nameClaim(LEE, 'name', 'Lee Park'), nameClaim(LEE, 'job_title', 'IT Manager'),
    ],
    observations: [
      obs('o-dana-1', DANA, 'interaction.email_received', 2),
      obs('o-dana-2', DANA, 'interaction.meeting_held', 9),
      obs('o-lee-1', LEE, 'interaction.email_sent', 4),
      obs('o-sam-1', SAM, 'interaction.email_received', 1),
    ],
  };
}

// A PostgREST-shaped query builder over in-memory tables. Unknown tables read as empty.
function fakeSupabase(t = tables()) {
  const col = (r, c) => {
    if (!c.includes('->')) return r[c];
    const parts = c.split(/->>?/);
    let v = r;
    for (const p of parts) v = v == null ? undefined : v[p];
    return v ?? null;
  };
  return {
    from(table) {
      const f = [];
      let lim = null;
      const rows = () => {
        const out = (t[table] ?? []).filter(r => f.every(fn => fn(r)));
        return lim == null ? out : out.slice(0, lim);
      };
      const q = {
        select() { return q; },
        eq(c, v) { f.push(r => col(r, c) === v); return q; },
        neq(c, v) { f.push(r => col(r, c) !== v); return q; },
        not(c, op, v) {
          if (op === 'is') f.push(r => (col(r, c) ?? null) !== v);
          else f.push(r => col(r, c) !== v);
          return q;
        },
        like(c, pat) { const p = pat.replace('%', ''); f.push(r => String(col(r, c)).startsWith(p)); return q; },
        is(c, v) { f.push(r => (col(r, c) ?? null) === v); return q; },
        in(c, vs) { f.push(r => vs.includes(col(r, c))); return q; },
        gte(c, v) { f.push(r => String(col(r, c) ?? '') >= v); return q; },
        lte(c, v) { f.push(r => String(col(r, c) ?? '') <= v); return q; },
        gt(c, v) { f.push(r => String(col(r, c) ?? '') > v); return q; },
        lt(c, v) { f.push(r => String(col(r, c) ?? '') < v); return q; },
        or() { return q; },
        order() { return q; },
        range() { return q; },
        limit(n) { lim = n; return q; },
        maybeSingle() { return Promise.resolve({ data: rows()[0] ?? null, error: null }); },
        single() { return Promise.resolve({ data: rows()[0] ?? null, error: null }); },
        then(res, rej) { return Promise.resolve({ data: rows(), error: null }).then(res, rej); },
      };
      return q;
    },
  };
}

test('get_context on a company: its people\'s interactions are the timeline', async () => {
  const ctx = await assembleContext(fakeSupabase(), WS, ACME, 'account_review');
  assert.equal(ctx.meta.timeline_events, 3, 'Dana\'s two and Lee\'s one, not Sam\'s at another account');
  const recent = ctx.timeline.filter((t) => t.tier !== 'count');
  assert.equal(recent.length, 3);
  // Each item says whose it was, an id the stakeholders list names.
  assert.deepEqual([...new Set(recent.map((t) => t.entity_id))].sort(), [LEE, DANA].sort());
});

test('get_context on a company: its people are the stakeholders and the committee', async () => {
  const ctx = await assembleContext(fakeSupabase(), WS, ACME, 'account_review');
  const people = ctx.stakeholders.filter((s) => s.role !== 'company').map((s) => s.name).sort();
  assert.deepEqual(people, ['Dana Reyes', 'Lee Park']);
  assert.equal(ctx.committee.company, 'Acme');
  assert.equal(ctx.committee.size, 2);
  assert.equal(ctx.committee.engaged, 2);
  assert.equal(ctx.committee.single_threaded, false);
});

test('a company where only one person is engaged reads as single-threaded', async () => {
  const t = tables();
  t.observations = t.observations.filter((o) => o.entity_id !== LEE);
  const ctx = await assembleContext(fakeSupabase(t), WS, ACME, 'account_review');
  assert.equal(ctx.committee.engaged, 1);
  assert.equal(ctx.committee.single_threaded, true);
});
