// One canonical name per competitor / tool (GET-1049): the matcher ported from Hindsight's
// entity_resolver.py, the resolve-on-write path against an in-memory store, its fail-safe when the
// migration is not applied, and the insight engine counting by entity.
//
// Run: pnpm --filter @nous/core build && node --test packages/core/test/marketEntities.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeEntityName, trigrams, trigramSimilarity, sequenceRatio, wordGate, numbersCompatible,
  comparePair, decideEntity, resolveMarketEntity, resolveClaimMarketEntity, canonicalEntityNames,
} from '../dist/db/marketEntities.js';
import { competitorKey, groupMembers } from '../dist/db/insightEngine.js';

// The naming cases, Hindsight-style: [a, b, expected verdict]. Public products where the case is
// about a well-known name; the invented world (Lumen, Fernpoint, Harborline, Pearl Lantern) otherwise.
const CASES = [
  ['HubSpot', 'Hubspot', 'same'],
  ['HubSpot', "HubSpot's", 'same'],
  ['HubSpot', 'Hub Spot', 'same'],
  ['HubSpot', 'Hubspt', 'same'],
  ["HubSpot's MCP", 'HubSpot MCP', 'same'],
  ['HubSpot', 'HubSpot MCP', 'ask'],
  ['Gong', 'Gong Engage', 'ask'],
  ['Salesforce', 'Salesforce Agentforce', 'ask'],
  ['Clay', 'Clari', 'new'],
  ['Notion', 'Motion', 'new'],
  ['GPT-4', 'GPT 4', 'same'],
  ['Python 3.1', 'Python 3.10', 'new'],
  ['Room 101', 'Room 102', 'new'],
  ['Q3', 'Q3 2024', 'ask'],
  ['Outreach', 'Outreach.io', 'same'],
  ['Pearl Lantern', 'Pearl-Lantern', 'same'],
  ['Café Lumen', 'Cafe Lumen', 'same'],
  ['Lumen Desk', 'Lumen Desks', 'same'],
  ['Harborline Signals', 'Harbourline Signals', 'same'],
  ['Tallyhook', 'Tally Hook', 'same'],
  ['Fernpoint Relay', 'Fernpoint Relay Pro', 'ask'],
  ['Lumen Desk', 'Lumen Ledger', 'ask'],
  ['Brightlist', 'Brightlane', 'new'],
  ['Lumen Desk', 'Ember Desk', 'new'],
];

for (const [a, b, want] of CASES) {
  test(`naming: ${a} vs ${b} → ${want}`, () => {
    const r = comparePair(normalizeEntityName(a), normalizeEntityName(b));
    assert.equal(r.verdict, want, `${a} / ${b}: ${JSON.stringify(r)}`);
    // Symmetric.
    assert.equal(comparePair(normalizeEntityName(b), normalizeEntityName(a)).verdict, want);
  });
}

test('normalize: accents, case, possessive, punctuation, web suffix', () => {
  assert.equal(normalizeEntityName("  HubSpot's  "), 'hubspot');
  assert.equal(normalizeEntityName('GPT-4'), 'gpt 4');
  assert.equal(normalizeEntityName('lumen_desk--pro'), 'lumen desk pro');
  assert.equal(normalizeEntityName('Café'), 'cafe');
  assert.equal(normalizeEntityName('Lumen.io'), 'lumen');
  assert.equal(normalizeEntityName(null), '');
});

test('trigrams are pg_trgm-shaped and Jaccard is rounded to 6 places', () => {
  assert.deepEqual([...trigrams('cat')].sort(), ['  c', ' ca', 'at ', 'cat'].sort());
  // hubspot (8) vs hub spot (9): 6 shared of 11.
  assert.equal(trigramSimilarity(trigrams('hubspot'), trigrams('hub spot')), 0.545455);
});

test('sequenceRatio matches difflib.SequenceMatcher.ratio', () => {
  assert.equal(sequenceRatio('abcd', 'bcde'), 0.75);
  assert.equal(sequenceRatio('signals', 'signal'), 0.923077);
  assert.equal(sequenceRatio('', ''), 1);
  assert.equal(sequenceRatio('abc', 'xyz'), 0);
});

test('word gate: every word of the shorter matches; a single word is exempt', () => {
  assert.equal(wordGate(['lumen', 'desk'], ['lumen', 'desks']), true);
  assert.equal(wordGate(['lumen', 'desk'], ['ember', 'desk']), false);
  assert.equal(wordGate(['hubspot'], ['hub', 'spot']), true);
});

test('number rule: each lacking one of the other\'s numbers is different; a subset is fine', () => {
  assert.equal(numbersCompatible('python 3 1', 'python 3 10'), false);
  assert.equal(numbersCompatible('q3', 'q3 2024'), true);
  assert.equal(numbersCompatible('lumen', 'lumen'), true);
});

test('decideEntity: an exact alias hit wins over a better-scoring name', () => {
  const cands = [
    { id: 'a', name: 'Lumen Desk', aliases: ['LumenDesk'] },
    { id: 'b', name: 'Lumendesk Cloud' },
  ];
  assert.deepEqual(decideEntity('lumendesk', cands), { action: 'same', entityId: 'a', score: 1, reason: 'alias' });
  assert.equal(decideEntity('Lumen Desks', cands).action, 'same');
  assert.equal(decideEntity('Lumen Desks', cands).entityId, 'a');
  const ask = decideEntity('Lumen Desk Pro', [{ id: 'a', name: 'Lumen Desk' }]);
  assert.equal(ask.action, 'ask');
  assert.equal(ask.entityId, 'a');
  assert.equal(decideEntity('Pearl Lantern', cands).action, 'new');
  assert.equal(decideEntity('Anything', []).action, 'new');
});

// ── The resolve-on-write path, against an in-memory store ──────────────────

function store({ missing = false } = {}) {
  const tables = { market_entities: [], market_entity_aliases: [] };
  const uniques = { market_entities: ['workspace_id', 'kind', 'normalized_key'], market_entity_aliases: ['workspace_id', 'kind', 'normalized_alias'] };
  let n = 0;
  return {
    tables,
    from(name) {
      const f = [];
      let mode = 'select', payload = null, lim = Infinity;
      const err = missing ? { code: 'PGRST205', message: `Could not find the table 'public.${name}' in the schema cache` } : null;
      const run = () => {
        if (err) return { data: null, error: err };
        const rows = tables[name];
        if (mode === 'insert') {
          const u = uniques[name];
          if (rows.some(r => u.every(c => r[c] === payload[c]))) return { data: null, error: { code: '23505', message: 'duplicate key' } };
          const row = { id: `${name === 'market_entities' ? 'me' : 'al'}-${++n}`, merged_into_id: null, ...payload };
          rows.push(row);
          return { data: [row], error: null };
        }
        const hit = rows.filter(r => f.every(fn => fn(r)));
        if (mode === 'update') { for (const r of hit) Object.assign(r, payload); return { data: hit, error: null }; }
        return { data: hit.slice(0, lim), error: null };
      };
      const q = {
        select() { return q; },
        insert(p) { mode = 'insert'; payload = p; return q; },
        update(p) { mode = 'update'; payload = p; return q; },
        eq(c, v) { f.push(r => r[c] === v); return q; },
        is(c, v) { f.push(r => (r[c] ?? null) === v); return q; },
        in(c, vs) { f.push(r => vs.includes(r[c])); return q; },
        limit(k) { lim = k; return q; },
        maybeSingle() { const r = run(); return Promise.resolve({ data: r.data?.[0] ?? null, error: r.error }); },
        single() { const r = run(); return Promise.resolve({ data: r.data?.[0] ?? null, error: r.error }); },
        then(res, rej) { return Promise.resolve(run()).then(res, rej); },
      };
      return q;
    },
  };
}

test('resolve: new, then alias hit, then a variant joins as an alias, then a sub-product is asked', async () => {
  const sb = store();
  const a = await resolveMarketEntity(sb, 'ws1', 'competitor', 'HubSpot', { seenAt: '2026-10-01T00:00:00Z' });
  assert.equal(a.action, 'new');
  const b = await resolveMarketEntity(sb, 'ws1', 'competitor', 'hubspot', { seenAt: '2026-10-02T00:00:00Z' });
  assert.deepEqual([b.action, b.entityId, b.canonicalName], ['alias', a.entityId, 'HubSpot']);
  const c = await resolveMarketEntity(sb, 'ws1', 'competitor', 'Hub Spot');
  assert.deepEqual([c.action, c.entityId], ['same', a.entityId]);
  const e = sb.tables.market_entities.find(r => r.id === a.entityId);
  assert.equal(e.mention_count, 3);
  assert.equal(e.first_seen, '2026-10-01T00:00:00Z');
  // A backfill reading an older claim widens first_seen and never moves last_seen back.
  await resolveMarketEntity(sb, 'ws1', 'competitor', 'HubSpot', { seenAt: '2026-09-01T00:00:00Z' });
  assert.equal(e.first_seen, '2026-09-01T00:00:00Z');
  assert.ok(e.last_seen > '2026-10-01');
  assert.equal(e.mention_count, 4);
  assert.deepEqual(sb.tables.market_entity_aliases.map(r => r.normalized_alias).sort(), ['hub spot', 'hubspot']);

  const d = await resolveMarketEntity(sb, 'ws1', 'competitor', 'HubSpot MCP');
  assert.equal(d.action, 'ask');
  assert.notEqual(d.entityId, a.entityId);
  const asked = sb.tables.market_entities.find(r => r.id === d.entityId);
  assert.equal(asked.proposed_same_as, a.entityId);
  assert.equal(asked.proposed_reason, 'parent_child');
});

test('resolve: kinds and workspaces are separate; a merged entity resolves to its survivor', async () => {
  const sb = store();
  const comp = await resolveMarketEntity(sb, 'ws1', 'competitor', 'Lumen Desk');
  const tool = await resolveMarketEntity(sb, 'ws1', 'tool', 'Lumen Desk');
  const other = await resolveMarketEntity(sb, 'ws2', 'competitor', 'Lumen Desk');
  assert.equal(new Set([comp.entityId, tool.entityId, other.entityId]).size, 3);
  const dup = await resolveMarketEntity(sb, 'ws1', 'competitor', 'Lumen Ledger');
  sb.tables.market_entities.find(r => r.id === dup.entityId).merged_into_id = comp.entityId;
  const again = await resolveMarketEntity(sb, 'ws1', 'competitor', 'lumen ledger');
  assert.deepEqual([again.entityId, again.canonicalName], [comp.entityId, 'Lumen Desk']);
  const names = await canonicalEntityNames(sb, 'ws1', [dup.entityId, comp.entityId]);
  assert.equal(names.get(dup.entityId), 'Lumen Desk');
});

test('claim seam: only competitor and tech_stack, never throws, no-op without the tables', async () => {
  const sb = store();
  assert.ok((await resolveClaimMarketEntity(sb, 'ws1', 'competitor', { entity: 'Pearl Lantern' }))?.market_entity_id);
  assert.ok((await resolveClaimMarketEntity(sb, 'ws1', 'tech_stack', { tool: 'Fernpoint Relay' }))?.market_entity_id);
  assert.equal(await resolveClaimMarketEntity(sb, 'ws1', 'objection', { entity: 'Pearl Lantern' }), null);
  assert.equal(await resolveClaimMarketEntity(sb, 'ws1', 'competitor', { entity: '  ' }), null);
  assert.equal(await resolveClaimMarketEntity(sb, 'ws1', 'competitor', { entity: 'X', market_entity_id: 'given' }), null);

  const gone = store({ missing: true });
  assert.equal(await resolveClaimMarketEntity(gone, 'ws1', 'competitor', { entity: 'Pearl Lantern' }), null);
  assert.equal((await canonicalEntityNames(gone, 'ws1', ['me-1'])).size, 0);
  const boom = { from() { throw new Error('network down'); } };
  const warn = console.warn; console.warn = () => {};
  try { assert.equal(await resolveClaimMarketEntity(boom, 'ws1', 'competitor', { entity: 'Pearl Lantern' }), null); }
  finally { console.warn = warn; }
});

test('saveNote with resolveMarketEntity stamps market_entity_id; without the tables it saves as before', async () => {
  const { saveNote } = await import('../dist/db/notes.js');
  const mk = (missing) => {
    const s = store({ missing });
    const claims = [];
    const from = s.from.bind(s);
    s.from = (name) => {
      if (name !== 'claims') return from(name);
      const q = { insert(p) { claims.push(p); q.row = { id: 'c1', ...p }; return q; }, select() { return q; }, single() { return Promise.resolve({ data: q.row, error: null }); } };
      return q;
    };
    return { s, claims };
  };
  const { s, claims } = mk(false);
  await saveNote(s, 'ws1', { entityId: 'e1', category: 'competitor', content: 'They are weighing Pearl Lantern', metadata: { entity: 'Pearl Lantern' }, resolveMarketEntity: true }).catch(() => {});
  assert.ok(claims[0].value.metadata.market_entity_id);
  assert.equal(claims[0].value.metadata.entity, 'Pearl Lantern');
  const off = mk(true);
  await saveNote(off.s, 'ws1', { entityId: 'e1', category: 'competitor', content: 'They are weighing Pearl Lantern', metadata: { entity: 'Pearl Lantern' }, resolveMarketEntity: true }).catch(() => {});
  assert.equal(off.claims.length, 1);
  assert.equal(off.claims[0].value.metadata.market_entity_id, undefined);
});

// ── Counting by entity ───────────────────────────────────────────────────────

test('insight engine: competitor variants with one entity id count as one group', () => {
  const canonical = new Map([['me-1', 'HubSpot']]);
  const vals = [
    { metadata: { entity: 'Hubspot', market_entity_id: 'me-1' } },
    { metadata: { entity: "HubSpot's", market_entity_id: 'me-1' } },
    { metadata: { entity: 'Hub Spot', market_entity_id: 'me-1' } },
    { metadata: { entity: 'Pearl Lantern' } },
    { label: 'Fernpoint' },
  ];
  assert.deepEqual(vals.map(v => competitorKey(v, canonical)), ['HubSpot', 'HubSpot', 'HubSpot', 'Pearl Lantern', 'Fernpoint']);
  // No entity yet (before the backfill): the possessive still does not make a second competitor.
  assert.equal(competitorKey({ metadata: { entity: "Pearl Lantern's" } }, new Map()), 'Pearl Lantern');
  assert.equal(competitorKey({}, new Map()), null);
  const members = vals.map((v, i) => ({ table: 'claims', id: `c${i}`, type: 'partners', key: competitorKey(v, canonical), content: 'x', quote: null,
    companyId: `co${i}`, contactId: null, speaker: null, sourceRef: null, sourceSystem: null, at: `2026-10-0${i + 1}`, vec: null }));
  const groups = groupMembers(members);
  assert.equal(groups.length, 3);
  const hub = groups.find(g => g.label === 'HubSpot');
  assert.equal(hub?.members.length, 3);
});
