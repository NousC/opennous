// Hybrid search over facts (GET-1056): the date-window table, reciprocal rank fusion, the window
// boost, token-budget packing, same-account expansion, and a small found/ranked eval over an
// in-memory fact set with fake RPCs (no network, no OpenAI key: the semantic arm is absent, which
// is exactly the case this search exists for). The SQL itself was checked on a throwaway local
// Postgres (see the PR); these fakes follow its contract, not its ranking maths.
//
// Run: pnpm --filter @nous/core build && node --test packages/core/test/hybridSearch.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseTemporalWindow, stripTemporal, claimInWindow,
} from '../dist/db/temporalWindow.js';
import {
  rrfFuse, applyWindowBoost, selectWithinBudget, expansionAccountScores, nameTerms, keywordQuery,
  hybridSearchClaims, estimateTokens, RRF_K,
} from '../dist/db/hybridSearch.js';
import { runQuery } from '../dist/query.js';

delete process.env.OPENAI_API_KEY;   // the no-key path: embed() returns null, the semantic arm is empty

// ── The date window ─────────────────────────────────────────────────────────────────────────────

// 2026-10-27 is a Tuesday; its week is Mon 26 Oct .. Sun 1 Nov.
const ANCHOR = '2026-10-27T15:00:00Z';
const WINDOWS = [
  ['what happened yesterday', '2026-10-26', '2026-10-26'],
  ['calls today', '2026-10-27', '2026-10-27'],
  ['pricing last week', '2026-10-19', '2026-10-25'],
  ['this week', '2026-10-26', '2026-11-01'],
  ['next week', '2026-11-02', '2026-11-08'],
  ['objections last month', '2026-09-01', '2026-09-30'],
  ['this month', '2026-10-01', '2026-10-31'],
  ['next month', '2026-11-01', '2026-11-30'],
  ['last quarter', '2026-07-01', '2026-09-30'],
  ['this quarter', '2026-10-01', '2026-12-31'],
  ['next quarter', '2027-01-01', '2027-03-31'],
  ['last year', '2025-01-01', '2025-12-31'],
  ['this year', '2026-01-01', '2026-12-31'],
  ['next year', '2027-01-01', '2027-12-31'],
  ['a few weeks ago', '2026-09-22', '2026-10-13'],
  ['a couple of weeks ago', '2026-10-06', '2026-10-20'],
  ['a couple of months ago', '2026-07-29', '2026-09-27'],
  ['a few months ago', '2026-05-30', '2026-08-28'],
  ['a few days ago', '2026-10-22', '2026-10-25'],
  ['what did Harborline say in May 2024', '2024-05-01', '2024-05-31'],
  ['budget in Sept 2025', '2025-09-01', '2025-09-30'],
  ['renewals in Q3 2025', '2025-07-01', '2025-09-30'],
  ["Q1'27 pipeline", '2027-01-01', '2027-03-31'],
  ['Q2 targets', '2026-04-01', '2026-06-30'],
  ['security review in 2025', '2025-01-01', '2025-12-31'],
  ['what changed in 1910', '1910-01-01', '1910-12-31'],
  ['last weekend', '2026-10-24', '2026-10-25'],
  ['pricing since 2024', '2024-01-01', '2026-10-27'],     // an open interval to now, not Jan-Dec
  ['what did they say on 12 May 2024', '2024-01-01', '2024-12-31'],   // an exact date: its year holds it
];
const NO_WINDOW = [
  'who mentioned SOC 2',
  'what did they say on port 2019',      // a number, not a year (Hindsight #3250)
  'ticket 2024 is blocked',
  'listening in 8080',                   // implausible year
  'founded 1850',                        // > 120 years back
  'they may sign soon',                  // "may" the verb, no year beside it
  'call on 2025-03-04',                  // part of a date, not a bare year
  '',
];

test('the date window table (temporal_periods.py rules, anchored)', () => {
  for (const [q, start, end] of WINDOWS) {
    const w = parseTemporalWindow(q, ANCHOR);
    assert.ok(w, `"${q}" should name a window`);
    assert.deepEqual([w.start, w.end], [start, end], `"${q}" (${w.rule})`);
  }
  for (const q of NO_WINDOW) assert.equal(parseTemporalWindow(q, ANCHOR), null, `"${q}" names no window`);
});

test('a Sunday "last weekend" is the one before, not today', () => {
  const w = parseTemporalWindow('last weekend', '2026-11-01T10:00:00Z');   // a Sunday
  assert.deepEqual([w.start, w.end], ['2026-10-24', '2026-10-25']);
});

test('the window words come out of the question for the keyword arm', () => {
  const q = 'pricing objections in Q3 2025';
  assert.equal(stripTemporal(q, parseTemporalWindow(q, ANCHOR)), 'pricing objections');
  const q2 = 'what did Harborline say last week about security';
  assert.equal(stripTemporal(q2, parseTemporalWindow(q2, ANCHOR)), 'what did Harborline say about security');
  assert.equal(stripTemporal('no dates here', null), 'no dates here');
});

test('a fact is in the window by when it was said OR when it happened', () => {
  const w = { start: '2026-09-01', end: '2026-09-30' };
  assert.equal(claimInWindow({ valid_from: '2026-09-15T10:00:00Z' }, w), true);
  assert.equal(claimInWindow({ valid_from: '2026-10-15T10:00:00Z' }, w), false);
  assert.equal(claimInWindow({ valid_from: '2026-10-15T10:00:00Z', value: { metadata: { occurred_start: '2026-09-29', occurred_end: '2026-10-02' } } }, w), true);
  assert.equal(claimInWindow({ valid_from: '2026-10-15', value: { metadata: { occurred_start: '2026-08-01' } } }, w), false);
  assert.equal(claimInWindow({ valid_from: null }, w), null);   // undated: neutral
});

// ── Fusion, boost, budget, expansion ────────────────────────────────────────────────────────────

const h = (id, extra = {}) => ({ id, entity_id: 'e-' + id, value: { content: 'fact ' + id }, ...extra });

test('RRF k=60: a fact found by two arms beats one found first by a single arm', () => {
  const fused = rrfFuse({ keyword: [h('a'), h('b')], names: [h('b'), h('c')] });
  assert.deepEqual(fused.map(f => f.id), ['b', 'a', 'c']);
  const b = fused[0];
  assert.ok(Math.abs(b.fused - (1 / (RRF_K + 2) + 1 / (RRF_K + 1))) < 1e-12);
  assert.deepEqual(b.arms, { keyword: 2, names: 1 });
  // a and c tie on score in different arms: rank 1 vs rank 2 decides; equal scores break on id.
  const tie = rrfFuse({ keyword: [h('z')], names: [h('y')] });
  assert.deepEqual(tie.map(f => f.id), ['y', 'z']);
});

test('RRF counts a fact once per arm and fills fields a later arm has', () => {
  const fused = rrfFuse({
    keyword: [h('a'), h('a')],
    semantic: [h('a', { confidence: 0.9, similarity: 0.7 })],
  });
  assert.equal(fused.length, 1);
  assert.equal(fused[0].arms.keyword, 1);
  assert.equal(fused[0].confidence, 0.9);
  assert.equal(rrfFuse({}).length, 0);
});

test('the window boost: ×2 inside, ×0.5 dated outside, undated unchanged', () => {
  const w = { start: '2026-09-01', end: '2026-09-30' };
  const fused = rrfFuse({ keyword: [h('out', { valid_from: '2026-10-20' }), h('none'), h('in', { valid_from: '2026-09-10' })] });
  const boosted = applyWindowBoost(fused, w);
  assert.deepEqual(boosted.map(f => f.id), ['in', 'none', 'out']);
  assert.equal(boosted[0].in_window, true);
  assert.equal(boosted.find(f => f.id === 'none').in_window, undefined);
  assert.equal(applyWindowBoost(fused, null), fused);
});

test('budget packing: rank order, skip-not-break, a limit, and never empty', () => {
  const items = [{ id: 1, tokens: 50 }, { id: 2, tokens: 500 }, { id: 3, tokens: 30 }, { id: 4, tokens: 30 }];
  const r = selectWithinBudget(items, 100, 10);
  assert.deepEqual(r.selected.map(x => x.id), [1, 3]);   // 2 is too big and skips ITSELF; 4 no longer fits
  assert.equal(r.total, 80);
  assert.equal(r.truncated, true);
  const floor = selectWithinBudget([{ id: 'big', tokens: 900 }, { id: 'bigger', tokens: 950 }], 100, 10);
  assert.deepEqual(floor.selected.map(x => x.id), ['big']);   // the floor: the top fact, whole, over budget
  assert.equal(floor.total, 900);
  assert.deepEqual(selectWithinBudget(items, undefined, 2).selected.map(x => x.id), [1, 2]);
  assert.equal(selectWithinBudget([], 100, 10).selected.length, 0);
  assert.equal(estimateTokens('abcdefgh'), 2);
});

test('expansion: tanh(shared × 0.5) per account, person seeds vote for their company, capped', () => {
  const accountOf = new Map([['p1', 'acct'], ['p2', 'acct'], ['acct', 'acct']]);
  const s = expansionAccountScores(['p1', 'p2', 'acct', 'loner'], accountOf);
  assert.ok(Math.abs(s.get('acct') - Math.tanh(1.5)) < 1e-12);   // 3 shared → 0.905
  assert.ok(Math.abs(s.get('loner') - Math.tanh(0.5)) < 1e-12);  // its own account → 0.46
  assert.deepEqual([...s.keys()], ['acct', 'loner']);
  const many = expansionAccountScores(['a', 'b', 'c', 'd', 'e', 'f', 'g'], new Map(), 5);
  assert.equal(many.size, 5);
});

test('name spans and keyword terms drop the question words', () => {
  const t = nameTerms('What did Pearl Lantern say about pricing?');
  assert.ok(t.includes('pearl lantern'));
  assert.ok(t.includes('pricing'));
  assert.ok(!t.includes('what') && !t.includes('say about'));
  assert.ok(t.indexOf('pearl lantern') < t.indexOf('pearl'), 'longest span first');
  assert.equal(keywordQuery('who mentioned SOC 2?'), 'soc');   // '2' is a single character; Postgres sees 'soc' only
  assert.equal(keywordQuery('what did they say'), '');
  assert.equal(nameTerms("Harborline's renewal").includes('harborline'), true);
});

// ── The in-memory world and fake RPCs ───────────────────────────────────────────────────────────

const WS = '11111111-1111-4111-8111-111111111111';
const HARBOR = 'a0000000-0000-4000-8000-000000000001';
const FERN = 'a0000000-0000-4000-8000-000000000002';
const MARA = 'b0000000-0000-4000-8000-000000000001';      // at Harborline
const TOMAS = 'b0000000-0000-4000-8000-000000000002';     // at Fernpoint
const LUMEN = 'c0000000-0000-4000-8000-000000000001';     // market entity
const EMAIL_OBS = 'e0000000-0000-4000-8000-000000000001';

const fact = (id, entity_id, category, content, valid_from, metadata = {}, extra = {}) => ({
  id, workspace_id: WS, entity_id, property: `note.${id}`, valid_from, invalid_at: null,
  confidence: 0.8, freshness: 'fresh', supporting_observation_ids: [],
  value: { category, content, metadata }, ...extra,
});

const CLAIMS = [
  fact('f-price-oct', HARBOR, 'pain', 'Per seat pricing is too expensive for the ops team', '2026-10-20T10:00:00Z'),
  fact('f-price-sep', FERN, 'objection', 'Pushed back on pricing during the renewal call', '2026-09-12T10:00:00Z'),
  fact('f-soc2', MARA, 'requirement', 'Needs a SOC 2 report before procurement signs', '2026-10-01T10:00:00Z'),
  fact('f-lumen', TOMAS, 'competitor', 'Running a pilot of the other tool alongside us', '2026-08-15T10:00:00Z', { market_entity_id: LUMEN }),
  fact('f-harbor-timeline', HARBOR, 'timeline', 'Budget review with procurement in Q4', '2026-10-22T10:00:00Z'),
  fact('f-harbor-champion', MARA, 'authority', 'Mara owns the evaluation and reports to the COO', '2026-07-01T10:00:00Z'),
  fact('f-event-sep', FERN, 'general', 'Kickoff workshop with the data team', '2026-10-05T10:00:00Z', { occurred_start: '2026-09-28', occurred_end: '2026-09-29' }),
  fact('f-quote', MARA, 'pain', 'Exports break every Monday', '2026-10-10T10:00:00Z', { quote: 'honestly the exports are a mess', signal_type: 'email_received' }, { supporting_observation_ids: [EMAIL_OBS] }),
  // Never returned: invalidated, a document, another workspace.
  fact('f-dead', FERN, 'pain', 'Old pricing complaint', '2026-01-10T10:00:00Z', {}, { invalid_at: '2026-02-01T00:00:00Z' }),
  fact('f-doc', FERN, 'general', 'Pricing call transcript', '2026-10-20T10:00:00Z', { doc_type: 'transcript' }),
  { ...fact('f-other-ws', HARBOR, 'pain', 'Pricing too high', '2026-10-20T10:00:00Z'), workspace_id: '22222222-2222-4222-8222-222222222222' },
  // Name claims, for resolveEntityNames in runQuery.
  { id: 'n1', workspace_id: WS, entity_id: HARBOR, property: 'name', value: 'Harborline', invalid_at: null },
  { id: 'n2', workspace_id: WS, entity_id: FERN, property: 'name', value: 'Fernpoint', invalid_at: null },
  { id: 'n3', workspace_id: WS, entity_id: MARA, property: 'name', value: 'Mara Okafor', invalid_at: null },
];
const LIST_ROWS = [
  { workspace_id: WS, entity_id: HARBOR, kind: 'account', name: 'Harborline', company_id: null },
  { workspace_id: WS, entity_id: FERN, kind: 'account', name: 'Fernpoint', company_id: null },
  { workspace_id: WS, entity_id: MARA, kind: 'person', name: 'Mara Okafor', company_id: HARBOR },
  { workspace_id: WS, entity_id: TOMAS, kind: 'person', name: 'Tomas Reyes', company_id: FERN },
];
const MARKET = [{ id: LUMEN, workspace_id: WS, canonical_name: 'Lumen Relay', aliases: ['lumen'] }];
const OBSERVATIONS = [{ id: EMAIL_OBS, workspace_id: WS, property: 'interaction.email_received', owner_user_id: 'u-rep', mailbox_owner_ids: ['u-rep'], participants: [], from: 'mara@harborline.example', to: ['rep@ours.example'], cc: [] }];

// The SQL's contract: facts only (note.*, live, not documents), the workspace, the window on
// valid_from OR occurred_*. Ranking here is "how many query words appear", enough to test fusion.
const liveFacts = (ws) => CLAIMS.filter(c => c.workspace_id === ws && c.property.startsWith('note.') && !c.invalid_at && !c.value?.metadata?.doc_type);
const words = (s) => String(s).toLowerCase().match(/[a-z0-9]+/g) ?? [];
const stemHit = (text, w) => words(text).some(t => t.startsWith(w.slice(0, Math.max(3, w.length - 2))));
const inWin = (c, since, until) => {
  const said = c.valid_from?.slice(0, 10);
  const os = c.value?.metadata?.occurred_start, oe = c.value?.metadata?.occurred_end ?? os;
  return (said >= since && said <= until) || (!!os && os <= until && oe >= since);
};
const RPC = {
  search_claims_keyword: ({ ws, q, lim, since, until }) => {
    const qw = words(q).slice(0, 16);
    let rows = liveFacts(ws);
    if (since || until) rows = rows.filter(c => inWin(c, since ?? '0000', until ?? '9999'));
    if (!qw.length) return (since || until) ? rows.sort((a, b) => b.valid_from.localeCompare(a.valid_from)).slice(0, lim).map(r => ({ ...r, rank: 0 })) : [];
    return rows.map(c => ({ ...c, rank: qw.filter(w => stemHit(c.value.content + ' ' + (c.value.label ?? ''), w)).length }))
      .filter(c => c.rank > 0).sort((a, b) => (b.rank - a.rank) || a.id.localeCompare(b.id)).slice(0, lim);
  },
  search_names: ({ ws, terms, lim }) => {
    const out = [];
    for (const r of LIST_ROWS.filter(r => r.workspace_id === ws)) {
      const name = r.name.toLowerCase();
      const sim = terms.some(t => t === name) ? 1 : terms.some(t => words(name).includes(t)) ? 0.9 : 0;
      if (sim) for (const c of liveFacts(ws).filter(c => c.entity_id === r.entity_id)) out.push({ ...c, rank: sim, matched_name: r.name, matched_kind: r.kind });
    }
    for (const m of MARKET.filter(m => m.workspace_id === ws)) {
      const names = [m.canonical_name.toLowerCase(), ...m.aliases];
      if (terms.some(t => names.includes(t) || names.some(n => words(n).includes(t)))) {
        for (const c of liveFacts(ws).filter(c => c.value.metadata?.market_entity_id === m.id)) out.push({ ...c, rank: 0.95, matched_name: m.canonical_name, matched_kind: 'market_entity' });
      }
    }
    return out.sort((a, b) => b.rank - a.rank).slice(0, lim);
  },
};

function fakeSupabase({ rpc = RPC, missing = [] } = {}) {
  const calls = [];
  const tables = { claims: CLAIMS, entity_list_rows: LIST_ROWS, observations: OBSERVATIONS };
  return {
    calls,
    async rpc(fn, args) {
      calls.push({ fn, args });
      if (missing.includes(fn) || !rpc[fn]) return { data: null, error: { code: 'PGRST202', message: `function ${fn} not found` } };
      return { data: rpc[fn](args), error: null };
    },
    from(table) {
      const rows = tables[table] ?? [];
      const filters = [];
      let lim = Infinity, ord = null;
      const b = {
        select() { return b; },
        eq(c, v) { filters.push(r => r[c] === v); return b; },
        in(c, vs) { filters.push(r => vs.includes(r[c])); return b; },
        like(c, p) { const re = new RegExp('^' + p.replace(/\./g, '\\.').replace(/%/g, '.*') + '$'); filters.push(r => re.test(String(r[c]))); return b; },
        is(c, v) { filters.push(r => (r[c] ?? null) === v); return b; },
        order(c, o) { ord = { c, asc: o?.ascending !== false }; return b; },
        limit(n) { lim = n; return b; },
        then(res, rej) {
          let out = rows.filter(r => filters.every(f => f(r)));
          if (ord) out = out.slice().sort((x, y) => String(x[ord.c] ?? '').localeCompare(String(y[ord.c] ?? '')) * (ord.asc ? 1 : -1));
          return Promise.resolve({ data: out.slice(0, lim), error: null }).then(res, rej);
        },
      };
      return b;
    },
  };
}

// ── The found/ranked eval ───────────────────────────────────────────────────────────────────────

// [question, the fact that must be found, the best rank it must reach]
const EVAL = [
  ['who mentioned SOC 2', 'f-soc2', 1],
  ['what did Harborline say about pricing', 'f-price-oct', 1],
  ['pricing complaints last month', 'f-price-sep', 1],          // Sep 2026: the window outranks October's
  ['who is evaluating Lumen', 'f-lumen', 1],                    // the names arm, through the market entity
  ['anything from Mara', 'f-harbor-champion', 3],
  ['what happened a few weeks ago', 'f-event-sep', 3],          // no terms: the window's facts, occurred_* counts
  ['procurement', 'f-harbor-timeline', 2],
];

test('found/ranked eval with no OpenAI key: every fact found at or above its bar', async () => {
  const sb = fakeSupabase();
  let found = 0, top1 = 0;
  for (const [q, want, bar] of EVAL) {
    const r = await hybridSearchClaims(sb, WS, q, { limit: 10, anchor: ANCHOR });
    const rank = r.hits.findIndex(x => x.id === want) + 1;
    assert.ok(rank > 0 && rank <= bar, `"${q}": ${want} at rank ${rank || 'not found'} (bar ${bar}); got ${r.hits.map(x => x.id).join(', ')}`);
    found += rank > 0 ? 1 : 0;
    top1 += rank === 1 ? 1 : 0;
    // Nothing that may not be returned ever is.
    for (const x of r.hits) assert.ok(!['f-dead', 'f-doc', 'f-other-ws'].includes(x.id), `"${q}" leaked ${x.id}`);
  }
  assert.equal(found, EVAL.length);
  assert.ok(top1 >= 5, `top-1 on ${top1}/${EVAL.length}`);
  assert.ok(!sb.calls.some(c => c.fn === 'search_claims'), 'no key: the semantic RPC is never called');
});

test('the window is a filter on the dates arm and a boost in fusion', async () => {
  const sb = fakeSupabase();
  const r = await hybridSearchClaims(sb, WS, 'pricing last month', { anchor: ANCHOR });
  assert.deepEqual([r.window.start, r.window.end], ['2026-09-01', '2026-09-30']);
  const dated = sb.calls.filter(c => c.fn === 'search_claims_keyword' && c.args.since);
  assert.equal(dated.length, 1);
  assert.equal(dated[0].args.q, 'pricing');                     // "last month" is not a search term
  assert.equal(r.hits[0].id, 'f-price-sep');
  assert.equal(r.hits[0].in_window, true);
  assert.ok(r.hits[0].arms.dates && r.hits[0].arms.keyword);
  const oct = r.hits.find(x => x.id === 'f-price-oct');
  assert.equal(oct.in_window, false);
});

test('same-account expansion pulls the sibling facts of the top hits', async () => {
  const sb = fakeSupabase();
  const r = await hybridSearchClaims(sb, WS, 'SOC 2 report', { limit: 10, anchor: ANCHOR });
  assert.equal(r.hits[0].id, 'f-soc2');
  // f-soc2 is on Mara, at Harborline: Harborline's own facts and Mara's others come with it.
  const exp = r.hits.filter(x => x.arms.expansion).map(x => x.id);
  for (const id of ['f-price-oct', 'f-harbor-timeline', 'f-harbor-champion']) assert.ok(exp.includes(id), `${id} expanded`);
  assert.ok(!exp.includes('f-price-sep'), 'Fernpoint is not a sibling');
  assert.ok(r.arms.expansion > 0);
});

test('the token budget is honoured in rank order', async () => {
  const sb = fakeSupabase();
  const all = await hybridSearchClaims(sb, WS, 'SOC 2 report', { limit: 10, anchor: ANCHOR });
  const budget = all.hits[0].tokens + 1;
  const r = await hybridSearchClaims(sb, WS, 'SOC 2 report', { limit: 10, maxTokens: budget, anchor: ANCHOR });
  assert.equal(r.hits[0].id, 'f-soc2');
  assert.ok(r.total_tokens <= budget);
  assert.equal(r.truncated, true);
  const tiny = await hybridSearchClaims(sb, WS, 'SOC 2 report', { limit: 10, maxTokens: 1, anchor: ANCHOR });
  assert.deepEqual(tiny.hits.map(x => x.id), ['f-soc2']);       // never empty when something matched
});

test('a quote from a message the viewer cannot read is redacted, as in searchClaims', async () => {
  const sb = fakeSupabase();
  const team = { workspaceId: WS, viewerUserId: null, viewerScope: 'admin', teamOnly: true };
  const r = await hybridSearchClaims(sb, WS, 'exports break', { anchor: ANCHOR, readContext: team });
  const q = r.hits.find(x => x.id === 'f-quote');
  assert.ok(q, 'the fact itself is the team\'s');
  assert.equal(q.value.metadata.quote, null);
  assert.equal(q.quote_private, true);
  const sys = await hybridSearchClaims(sb, WS, 'exports break', { anchor: ANCHOR });
  assert.equal(sys.hits.find(x => x.id === 'f-quote').value.metadata.quote, 'honestly the exports are a mess');
});

test('the migration not applied yet: every arm degrades to empty, silently', async () => {
  const sb = fakeSupabase({ missing: ['search_claims_keyword', 'search_names'] });
  let failures = 0;
  const r = await hybridSearchClaims(sb, WS, 'pricing last month', { anchor: ANCHOR, onFailure: () => failures++ });
  assert.deepEqual(r.hits, []);
  assert.equal(failures, 0);
  assert.deepEqual(await hybridSearchClaims(sb, WS, '   '), { hits: [], window: null, arms: {}, total_tokens: 0, truncated: false });
});

test('a failing RPC is reported through onFailure and the other arms still answer', async () => {
  const rpc = { ...RPC, search_names: () => { throw new Error('boom'); } };
  const sb = fakeSupabase({ rpc });
  sb.rpc = async (fn, args) => {
    if (fn === 'search_names') return { data: null, error: { code: '57014', message: 'statement timeout' } };
    return { data: rpc[fn]?.(args) ?? null, error: rpc[fn] ? null : { code: 'PGRST202', message: 'x' } };
  };
  const reasons = [];
  const origError = console.error; console.error = () => {};
  try {
    const r = await hybridSearchClaims(sb, WS, 'who mentioned SOC 2', { anchor: ANCHOR, onFailure: m => reasons.push(m) });
    assert.equal(r.hits[0].id, 'f-soc2');
    assert.ok(reasons.some(m => m.includes('search_names')));
  } finally { console.error = origError; }
});

// ── Wired into /v2/query facts (the MCP query tool, scope.facts) ──────────────────────────────

test('runQuery facts: hybrid with no key, same item shape, best fact per account', async () => {
  const sb = fakeSupabase();
  const r = await runQuery(sb, WS, { facts: true, limit: 5 }, 'who mentioned SOC 2');
  assert.equal(r.corpus, 'facts');
  assert.ok(r.matched >= 1);
  const top = r.items[0];
  assert.deepEqual(Object.keys(top).sort(), ['category', 'content', 'date', 'entity_id', 'entity_name', 'matched_by', 'similarity', 'source']);
  assert.equal(top.content, 'Needs a SOC 2 report before procurement signs');
  assert.equal(top.entity_name, 'Mara Okafor');
  assert.equal(top.similarity, 1);
  assert.ok(top.matched_by.includes('keyword'));
  for (let i = 1; i < r.items.length; i++) assert.ok(r.items[i - 1].similarity >= r.items[i].similarity);

  const ent = await runQuery(sb, WS, { facts: true }, 'pricing', { return: 'entities' });
  const ids = ent.items.map(x => x.entity_id);
  assert.equal(new Set(ids).size, ids.length, 'one fact per account');
  assert.ok(ids.includes(HARBOR) && ids.includes(FERN));
});
