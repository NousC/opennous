// GTM insights: our interpretation of an insight engine insight (GET-1006). Written once it is over
// its bar (5 accounts), against our own company context, cited by conversation; again at 10, 15,
// 20; never blind; never from words said in a private message.
//
// Run: node --test packages/core/test/insightInterpretation.test.mjs   (after tsc)
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  needsInterpretation, patternSources, interpretPattern, patternsToInterpret, registerCompanyContextSource, ourCompanyContext,
} from '../dist/db/insightInterpretation.mjs';

const WS = 'ws-1';
const ICP = 'We sell revenue infrastructure: one record per account from calls, email and CRM, for B2B SaaS teams of 10 to 200.';

// A small PostgREST-like fake: the filters these reads use. `missing` tables answer 42703.
function database(seed = {}, { missing = [] } = {}) {
  const tables = { workspaces: [{ id: WS, name: 'Quillbox' }], entities: [], claims: [], foundations: [], insight_patterns: [], insight_pattern_members: [], about_us_claims: [], entity_list_rows: [], ...seed };
  class Query {
    constructor(t) { this.t = t; this.f = []; }
    select() { return this; } order() { return this; } limit() { return this; } range() { return this; } or() { return this; }
    eq(k, v) { this.f.push((r) => r[k] === v); return this; }
    neq(k, v) { this.f.push((r) => r[k] !== v); return this; }
    gte(k, v) { this.f.push((r) => r[k] >= v); return this; }
    is(k, v) { this.f.push((r) => (v === null ? r[k] == null : r[k] === v)); return this; }
    in(k, vs) { this.f.push((r) => vs.includes(r[k])); return this; }
    like() { return this; }
    not(k, op) { if (op === 'is') this.f.push((r) => r[k] != null); return this; }
    update(v) { this.op = 'update'; this.v = v; return this; }
    run(single) {
      if (missing.includes(this.t)) return { data: null, error: { code: '42703', message: 'column insight_patterns.interpretation_account_count does not exist' } };
      const all = (tables[this.t] ??= []);
      const rows = all.filter((r) => this.f.every((f) => f(r)));
      if (this.op === 'update') { for (const r of rows) Object.assign(r, this.v); return { data: null, error: null }; }
      return { data: structuredClone(single ? rows[0] ?? null : rows), error: null };
    }
    maybeSingle() { return Promise.resolve(this.run(true)); } single() { return this.maybeSingle(); }
    then(res, rej) { return Promise.resolve(this.run(false)).then(res, rej); }
  }
  return { tables, from: (t) => new Query(t) };
}

const pattern = (o = {}) => ({ id: 'p1', workspace_id: WS, topic_key: 'feature|k:date filter', type: 'feature', label: 'Date filter', title: 'Teams want a date filter on the inbox', account_count: 5, at_bar: true, interpretation_account_count: null, ...o });
const claim = (k, o = {}) => ({ id: `a${k}`, workspace_id: WS, content: `Wants a date filter (${k})`, quote: `we need to filter by date ${k}`, quote_private: false, source_ref: `source://granola/m${k}`, ...o });
const seed = (n, o = {}) => ({
  foundations: [{ workspace_id: WS, kind: 'icp', title: 'ICP', body_md: ICP }],
  insight_patterns: [pattern({ account_count: n })],
  about_us_claims: Array.from({ length: n }, (_, k) => claim(k)),
  insight_pattern_members: Array.from({ length: n }, (_, k) => ({ workspace_id: WS, pattern_id: 'p1', source_table: 'about_us_claims', source_id: `a${k}`, company_id: `co-${k}`, occurred_at: '2026-10-01T10:00:00Z' })),
  entity_list_rows: Array.from({ length: n }, (_, k) => ({ workspace_id: WS, entity_id: `co-${k}`, name: `Account ${k}` })),
  ...o,
});
const answer = '{"meaning":"Teams sort their inbox by time [1] [2]; we file by account [9].","direction":"Let time be a way in, beside the account."}';

test('an insight is interpreted over its bar, and again only at the next step', () => {
  assert.equal(needsInterpretation({ at_bar: false, account_count: 9 }), false);
  assert.equal(needsInterpretation({ at_bar: true, account_count: 5, interpretation_account_count: null }), true);
  assert.equal(needsInterpretation({ at_bar: true, account_count: 9, interpretation_account_count: 5 }), false);
  assert.equal(needsInterpretation({ at_bar: true, account_count: 10, interpretation_account_count: 5 }), true);
  assert.equal(needsInterpretation({ at_bar: true, account_count: 8, interpretation_account_count: 12 }), true, 'shrank under 10: the reading said 12');
  const now = Date.parse('2026-10-22T00:00:00Z');
  assert.equal(needsInterpretation({ at_bar: true, account_count: 5, interpretation_failed_at: '2026-10-20T00:00:00Z' }, now), false, 'failed two days ago');
  assert.equal(needsInterpretation({ at_bar: true, account_count: 5, interpretation_failed_at: '2026-10-10T00:00:00Z' }, now), true, 'failed 12 days ago');
});

test('sources: one per conversation, no fact without a sentence, and a private quote never reaches the model', () => {
  const s = patternSources([
    { id: 'x', content: 'Wants a date filter', quote: null, source_ref: 'source://gmail/t1', account_id: 'co-1', date: '2026-10-01T00:00:00Z' },
    { id: 'y', content: 'Also wants it on tasks', quote: 'tasks too', source_ref: 'source://gmail/t1', account_id: 'co-1' },
    { id: 'z', content: null, source_ref: 'source://granola/m2' },
  ], new Map([['co-1', 'Account 1']]));
  assert.equal(s.length, 1);
  assert.deepEqual(s[0].items.map((i) => [i.quote, i.account]), [[null, 'Account 1'], ['tasks too', 'Account 1']]);
});

test('at the bar it is written against our company context, cited, and kept on the insight', async () => {
  let prompt = '';
  const sb = database(seed(5));
  const r = await interpretPattern(sb, WS, 'p1', { ask: async (p) => { prompt = p; return answer; } });
  assert.equal(r.status, 'written');
  assert.match(prompt, /one record per account/, 'our ICP is in the prompt');
  assert.match(prompt, /Across 5 different accounts/);
  assert.match(prompt, /\[1\] Wants a date filter .*we need to filter by date/);
  const row = sb.tables.insight_patterns[0];
  assert.equal(row.interpretation_direction, 'Let time be a way in, beside the account.');
  assert.doesNotMatch(row.interpretation_meaning, /\[9\]/, 'a citation past the sources is dropped');
  assert.equal(row.interpretation_account_count, 5);
  assert.equal(row.interpretation_refs.length, 5);
  assert.equal((await interpretPattern(sb, WS, 'p1', { ask: async () => answer })).status, 'current');
});

test('a quote from a private message is not in the prompt; the fact is', async () => {
  let prompt = '';
  const sb = database(seed(5));
  sb.tables.about_us_claims[0].quote_private = true;
  await interpretPattern(sb, WS, 'p1', { ask: async (p) => { prompt = p; return answer; } });
  assert.match(prompt, /Wants a date filter \(0\)/);
  assert.doesNotMatch(prompt, /filter by date 0/);
});

test('never under the bar, never blind, never before the columns exist', async () => {
  let asked = 0;
  const ask = async () => { asked++; return answer; };
  assert.equal((await interpretPattern(database(seed(4, { insight_patterns: [pattern({ account_count: 4, at_bar: false })] })), WS, 'p1', { ask })).status, 'too_few');
  assert.equal((await interpretPattern(database(seed(5, { foundations: [], workspaces: [{ id: WS, name: null }] })), WS, 'p1', { ask })).status, 'no_context');
  assert.equal((await interpretPattern(database(seed(5), { missing: ['insight_patterns'] }), WS, 'p1', { ask })).status, 'not_set_up');
  assert.equal(await patternsToInterpret(database(seed(5), { missing: ['insight_patterns'] }), WS), null);
  assert.equal(asked, 0);
  const bad = database(seed(5));
  assert.equal((await interpretPattern(bad, WS, 'p1', { ask: async () => 'no json' })).status, 'unusable');
  assert.ok(bad.tables.insight_patterns[0].interpretation_failed_at, 'a failed read is marked, so it waits a week');
  assert.deepEqual(await patternsToInterpret(bad, WS), []);
  const down = database(seed(5));
  assert.equal((await interpretPattern(down, WS, 'p1', { ask: async () => { throw new Error('overloaded'); } })).status, 'model_unavailable');
  assert.ok(down.tables.insight_patterns[0].interpretation_failed_at);
});

test('what the Cloud layer registers joins who we are', async () => {
  registerCompanyContextSource(async () => ({ icp: 'Our marked ICP file: B2B SaaS revenue teams.', files: [{ title: 'Positioning', body: 'The data layer under agents.' }] }));
  try {
    const text = await ourCompanyContext(database(seed(5)), WS);
    assert.match(text, /Our marked ICP file/);
    assert.match(text, /## Positioning\nThe data layer under agents/);
    assert.doesNotMatch(text, /one record per account/, 'the registered ICP wins over the foundation');
  } finally { registerCompanyContextSource(null); }
});

test('the nightly list is the insights a step behind, most accounts first', async () => {
  const sb = database({ insight_patterns: [pattern({ id: 'a', account_count: 12, interpretation_account_count: 5 }), pattern({ id: 'b', account_count: 7, interpretation_account_count: 5 }), pattern({ id: 'c', account_count: 3, at_bar: false })] });
  assert.deepEqual((await patternsToInterpret(sb, WS)).map((p) => p.id), ['a']);
});

test('an insight back under its bar does not show its old reading', async () => {
  const { patternView } = await import('../dist/db/insightEngine.js');
  const row = pattern({ interpretation_meaning: 'It means X [1].', interpretation_account_count: 5 });
  assert.equal(patternView(row).interpretation.meaning, 'It means X [1].');
  assert.equal(patternView({ ...row, at_bar: false }).interpretation, null);
});
