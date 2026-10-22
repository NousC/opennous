// The insight engine (GET-971): code groups what customers said and counts it; an insight is a
// group heard from enough accounts; the model writes only its title; one status per insight;
// insight.emerged and insight.rising fire once.
//
// Run: node --test packages/core/test/insightEngine.test.mjs   (after tsc)
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  INSIGHT_TYPES, INSIGHT_MIN_ACCOUNTS, normalizeKey, groupMembers, countPattern, needsTitle, parsePatternTitle,
  rebuildInsightPatterns, listInsightPatterns, getInsightPattern, setInsightPatternStatus, patternEventData,
} from '../dist/db/insightEngine.js';

const WS = 'ws-1';
const TODAY = '2026-10-21';
const m = (id, o = {}) => ({ table: 'about_us_claims', id, type: 'feature', key: null, content: `statement ${id}`, quote: null, companyId: null, contactId: null, speaker: null, sourceRef: null, sourceSystem: null, at: '2026-10-01', vec: null, ...o });

test('every type has teams, a bar and something to count', () => {
  for (const t of INSIGHT_TYPES) {
    assert.ok(t.audiences.length, t.key);
    assert.equal(t.minAccounts, INSIGHT_MIN_ACCOUNTS);
    assert.ok(t.aboutUs.length || t.accountCategory, t.key);
  }
  assert.equal(INSIGHT_MIN_ACCOUNTS, 5);
});

test('a fixed field groups regardless of case, punctuation or a plural', () => {
  assert.equal(normalizeKey('Date filters'), normalizeKey('date-filter'));
  assert.equal(normalizeKey('  HubSpot  '), 'hubspot');
  assert.equal(normalizeKey(''), null);
  assert.equal(normalizeKey('Access'), 'access', 'a word ending in ss is not a plural');
});

test('grouping: by the field first, then by meaning; a loose one joins the nearest, or starts its own', () => {
  const g = groupMembers([
    m('a', { key: 'Date filter', vec: [1, 0, 0] }),
    m('b', { key: 'date filters', vec: [0.98, 0.1, 0] }),
    m('c', { key: 'Filter by date', vec: [0.97, 0.12, 0] }),      // another name, same thing: merged
    m('d', { key: null, vec: [0.95, 0.15, 0] }),                  // no field: joins by meaning
    m('e', { key: null, vec: [0, 0, 1] }),                        // nothing near: its own
    m('f', { key: 'Clay', type: 'partners', vec: [1, 0, 0] }),    // another type never mixes in
  ]);
  const byKey = new Map(g.map(x => [x.topicKey, x]));
  const filter = byKey.get('feature|k:date filter');
  assert.deepEqual(filter.members.map(x => x.id).sort(), ['a', 'b', 'c', 'd']);
  assert.equal(filter.label, 'Date filter', 'named by its most said, earliest-sorted name');
  assert.ok(byKey.get('feature|m:e'), 'a loose one keeps its first member as its identity');
  assert.ok(byKey.get('partners|k:clay'));
  assert.equal(g.length, 3);
});

test('counting: named accounts, people, a call once, and rising as GTM insights counts it', () => {
  const c = countPattern([
    m('1', { companyId: 'co-1', contactId: 'p1', sourceRef: 'source://granola/x', at: '2026-10-20' }),
    m('2', { companyId: 'co-1', contactId: 'p1', sourceRef: 'source://granola/x', at: '2026-10-20' }),
    m('3', { companyId: 'co-2', contactId: 'p2', at: '2026-10-10' }),
    m('4', { companyId: 'co-3', at: '2026-10-01' }),
    m('5', { companyId: null, contactId: 'p9', at: '2026-08-30' }),   // no account: listed, not counted
  ], 5, TODAY);
  assert.equal(c.accounts, 3);
  assert.equal(c.people, 3);
  assert.equal(c.mentions, 4, 'two lines from one call are one mention');
  assert.deepEqual([c.firstHeard, c.lastHeard], ['2026-08-30', '2026-10-20']);
  assert.equal(c.now, 3);
  assert.equal(c.before, 0);
  assert.equal(c.rising, true);
  assert.equal(c.atBar, false, '3 accounts is under the bar of 5');
  assert.equal(c.weeks.length, 12);
  assert.equal(c.weeks[11], 1, 'this week: one account');
});

test('a title is written at the bar, then again at every 5 more accounts', () => {
  assert.equal(needsTitle({}, 4, false), false);
  assert.equal(needsTitle({}, 5, true), true);
  assert.equal(needsTitle({ title: 'T', title_account_count: 5 }, 9, true), false);
  assert.equal(needsTitle({ title: 'T', title_account_count: 5 }, 10, true), true);
  // A title the model wrote but that was not used (it named someone) waits for 5 more accounts,
  // so the same groups do not take every title of every run.
  assert.equal(needsTitle({ title: null, title_account_count: 7 }, 9, true), false, 'tried at 7, no title');
  assert.equal(needsTitle({ title: null, title_account_count: 7 }, 10, true), true, 'tried at 7, now 10');
  assert.equal(needsTitle({ title: null, title_account_count: null }, 5, true), true, 'never tried');
  assert.equal(parsePatternTitle('{"title":"Teams want a date filter on the inbox."}'), 'Teams want a date filter on the inbox');
  assert.equal(parsePatternTitle('no json'), null);
});

test('an event carries the insight and its numbers, never a quote', () => {
  const d = patternEventData({ id: 'p1', type: 'feature', title: 'T', label: 'Date filter' }, countPattern([m('1', { companyId: 'co-1', quote: 'secret words' })], 5, TODAY));
  assert.equal(d.insight.type_label, 'Feature request');
  assert.deepEqual(d.insight.audiences, ['product', 'gtm']);
  assert.doesNotMatch(JSON.stringify(d), /secret words/);
});

// ── The rebuild, on a small PostgREST-like fake ──────────────────────────────

function database(seed = {}) {
  const tables = { about_us_claims: [], claims: [], entity_list_rows: [], insight_patterns: [], insight_pattern_members: [], ...seed };
  let n = 0;
  class Q {
    constructor(t) { this.t = t; this.f = []; this.op = 'select'; }
    select() { if (this.op === 'select') this.op = 'select'; this.ret = true; return this; }
    eq(k, v) { this.f.push(r => (k.includes('->>') ? r.value?.[k.split('->>')[1]] : r[k]) === v); return this; }
    in(k, vs) { this.f.push(r => vs.includes(k.includes('->>') ? r.value?.[k.split('->>')[1]] : r[k])); return this; }
    is(k, v) { this.f.push(r => (v === null ? r[k] == null : r[k] === v)); return this; }
    gte(k, v) { this.f.push(r => String(r[k]) >= v); return this; }
    lt(k, v) { this.f.push(r => String(r[k]) < v); return this; }
    gt(k, v) { this.f.push(r => String(r[k]) > v); return this; }
    order() { return this; } range() { return this; } limit() { return this; }
    upsert(rows) { this.op = 'upsert'; this.rows = rows; return this; }
    update(v) { this.op = 'update'; this.v = v; return this; }
    insert(rows) { this.op = 'insert'; this.rows = rows; return this; }
    delete() { this.op = 'delete'; return this; }
    run(single) {
      const all = (tables[this.t] ??= []);
      if (this.op === 'upsert') {
        const out = this.rows.map(row => {
          const i = all.findIndex(r => r.workspace_id === row.workspace_id && r.topic_key === row.topic_key);
          if (i >= 0) { all[i] = { ...all[i], ...row }; return all[i]; }
          const nr = { id: `p${++n}`, status: 'new', ...row }; all.push(nr); return nr;
        });
        return { data: structuredClone(out), error: null };
      }
      if (this.op === 'insert') { all.push(...this.rows.map(r => ({ ...r }))); return { data: null, error: null }; }
      const hit = all.filter(r => this.f.every(f => f(r)));
      if (this.op === 'update') { for (const r of hit) Object.assign(r, this.v); return { data: structuredClone(hit), error: null }; }
      if (this.op === 'delete') { tables[this.t] = all.filter(r => !hit.includes(r)); return { data: null, error: null }; }
      return { data: structuredClone(single ? hit[0] ?? null : hit), error: null };
    }
    maybeSingle() { return Promise.resolve(this.run(true)); }
    then(res, rej) { return Promise.resolve(this.run(false)).then(res, rej); }
  }
  return { tables, from: t => new Q(t), rpc: async () => ({ data: [], error: null }) };
}
const about = (id, co, o = {}) => ({ id, workspace_id: WS, kind: 'feature', what: 'Date filter', content: `wants a date filter (${id})`, quote: `a date filter ${id}`, quote_private: false,
  company_id: co, contact_id: `p-${co}`, speaker: null, source_ref: `source://granola/${id}`, source_system: 'granola', occurred_at: '2026-10-15T10:00:00Z', created_at: '2026-10-15T10:00:00Z', embedding: null, retired_at: null, ...o });

test('rebuild: under the bar nothing is listed; at 5 accounts it is titled, listed and fires once', async () => {
  const sb = database({ about_us_claims: [0, 1, 2, 3].map(k => about(`a${k}`, `co-${k}`)) });
  const events = [];
  const emit = async e => { events.push(e); };
  let asked = 0;
  const ask = async () => { asked++; return '{"title":"Teams want to filter the inbox by date"}'; };
  let r = await rebuildInsightPatterns(sb, WS, { today: TODAY, ask, emit });
  assert.equal(r.atBar, 0);
  assert.deepEqual(await listInsightPatterns(sb, WS), []);
  assert.equal(asked, 0, 'no title under the bar');

  sb.tables.about_us_claims.push(about('a4', 'co-4'));
  r = await rebuildInsightPatterns(sb, WS, { today: TODAY, ask, emit });
  assert.equal(r.atBar, 1);
  const [p] = await listInsightPatterns(sb, WS);
  assert.equal(p.title, 'Teams want to filter the inbox by date');
  assert.equal(p.accounts, 5);
  assert.deepEqual(p.audiences, ['product', 'gtm']);
  assert.deepEqual(events.map(e => e.type), ['insight.emerged', 'insight.rising']);

  // Again with nothing new: no second event, no second title.
  await rebuildInsightPatterns(sb, WS, { today: TODAY, ask, emit });
  assert.equal(events.length, 2);
  assert.equal(asked, 1);
  assert.equal((await listInsightPatterns(sb, WS, { audience: 'cs' })).length, 0, 'not a CS insight');
});

test('one status per insight, kept across rebuilds; a private quote never comes back', async () => {
  const sb = database({ about_us_claims: [0, 1, 2, 3, 4].map(k => about(`a${k}`, `co-${k}`, k === 0 ? { quote_private: true, quote: 'words from an email' } : {})) });
  await rebuildInsightPatterns(sb, WS, { today: TODAY });
  const [p] = await listInsightPatterns(sb, WS);
  assert.equal(p.status, 'new');
  assert.equal(await setInsightPatternStatus(sb, WS, p.id, 'acting'), true);
  await rebuildInsightPatterns(sb, WS, { today: TODAY });
  assert.equal((await listInsightPatterns(sb, WS))[0].status, 'acting');
  const full = await getInsightPattern(sb, WS, p.id);
  assert.equal(full.evidence.length, 5);
  assert.ok(!JSON.stringify(full).includes('words from an email'));
  assert.equal(full.evidence.find(e => e.id === 'a0').quote, null);
  assert.equal(full.evidence.find(e => e.id === 'a1').quote, 'a date filter a1');
});

test('objections and competitors on the accounts count too; our own people never do', async () => {
  const claim = (id, entity, entityName, o = {}) => ({ id, workspace_id: WS, entity_id: entity, property: `note.${id}`, invalid_at: null, valid_from: '2026-10-10T00:00:00Z', embedding: null,
    value: { category: 'competitor', label: entityName, content: `uses ${entityName}`, metadata: { entity: entityName, stance: 'evaluating' } }, ...o });
  const sb = database({
    claims: [
      ...[0, 1, 2, 3].map(k => claim(`c${k}`, `co-${k}`, 'Clay')),
      claim('c9', 'co-9', 'Clay', { value: { category: 'competitor', content: 'mentions Clay', metadata: { entity: 'Clay', stance: 'mentioned' } } }),
      { id: 'tm', workspace_id: WS, entity_id: 'w-self', property: 'team_member', value: {}, invalid_at: null },
    ],
    about_us_claims: [about('x', 'co-5', { kind: 'partners', what: 'clay' })],
    entity_list_rows: [0, 1, 2, 3, 5, 9].map(k => ({ workspace_id: WS, entity_id: `co-${k}`, kind: 'account', company_id: null })),
  });
  const r = await rebuildInsightPatterns(sb, WS, { today: TODAY });
  assert.equal(r.atBar, 1, '4 accounts on file plus one said to us is 5; a passing mention is not one');
  const [p] = await listInsightPatterns(sb, WS);
  assert.equal(p.type, 'partners');
  assert.equal(p.topic, 'Clay');
  assert.equal(p.accounts, 5);
});

test('before the migration the rebuild says so and writes nothing', async () => {
  const sb = database();
  const real = sb.from;
  const missing = { data: null, error: { code: '42P01', message: 'relation "public.insight_patterns" does not exist' } };
  sb.from = (t) => (t === 'insight_patterns' ? { select: () => ({ eq: () => ({ order: () => ({ range: async () => missing }) }) }) } : real(t));
  assert.equal((await rebuildInsightPatterns(sb, WS, { today: TODAY })).status, 'not_set_up');
});

test('identity: a regrouped insight keeps its key, so its status and its one emerged event stay', async () => {
  const { keepIdentity } = await import('../dist/db/insightEngine.js');
  const groups = [
    { type: 'feature', topicKey: 'feature|k:filter by date', label: 'Filter by date', members: ['a', 'b', 'c', 'x', 'y'].map(id => m(id)) },
    { type: 'feature', topicKey: 'feature|k:date filter', label: 'Date filter', members: [m('z')] },
  ];
  const out = keepIdentity(groups,
    [{ id: 'p1', topic_key: 'feature|k:date filter' }],
    ['a', 'b', 'c'].map(id => ({ pattern_id: 'p1', source_table: 'about_us_claims', source_id: id })));
  assert.equal(out[0].topicKey, 'feature|k:date filter', 'renamed by a larger name, still the same insight');
  assert.equal(out[1].topicKey, 'feature|k:date filter#z', 'the newcomer with the old name gets a key of its own');
});

test('a title naming a customer or person is not used', async () => {
  const { namesSomeone } = await import('../dist/db/insightEngine.js');
  assert.equal(namesSomeone('Hollis Co wants a date filter', ['Hollis Co']), true);
  assert.equal(namesSomeone('Teams want a date filter', ['Hollis Co', 'Dana Reyes']), false);
  assert.equal(namesSomeone('Dana wants exports', ['Dana Reyes']), true);
});

test('the list filters by team in the query, so a page is never short', async () => {
  const sb = database({ about_us_claims: [0, 1, 2, 3, 4].map(k => about(`a${k}`, `co-${k}`)) });
  await rebuildInsightPatterns(sb, WS, { today: TODAY });
  assert.equal((await listInsightPatterns(sb, WS, { audience: 'gtm' })).length, 1);
  assert.equal((await listInsightPatterns(sb, WS, { audience: 'cs' })).length, 0);
});
