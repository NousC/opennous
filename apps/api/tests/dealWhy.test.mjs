// Why won / why lost per deal (GET-1077): read once at close, a few labelled points, kept on the deal.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.ENCRYPTION_KEY ??= 'a'.repeat(64);
const { buildDealWhyPrompt, parseDealWhy, analyzeClosedDeals } = await import('../src/lib/dealWhy.mjs');
const { buildWinLossPrompt } = await import('../src/lib/livingFiles.mjs');

const WS = 'ws1';
const NOW = new Date('2026-10-29T12:00:00Z');

function db(tables) {
  class Q {
    constructor(t) { this.t = t; this.f = []; this.lim = Infinity; }
    select() { return this; } order() { return this; } limit(n) { this.lim = n; return this; }
    eq(k, v) { this.f.push(r => r[k] === v); return this; }
    in(k, vs) { this.f.push(r => vs.includes(r[k])); return this; }
    is(k, v) { if (!k.includes('->')) this.f.push(r => (r[k] ?? null) === v); return this; }
    not(k) { this.f.push(r => r[k] != null); return this; }
    gt(k, v) { this.f.push(r => String(r[k]) > String(v)); return this; }
    gte(k, v) { this.f.push(r => String(r[k]) >= String(v)); return this; }
    lte(k, v) { this.f.push(r => String(r[k]) <= String(v)); return this; }
    like(k, p) { const pre = p.replace('%', ''); this.f.push(r => String(r[k] ?? '').startsWith(pre)); return this; }
    run(one) { const rows = (tables[this.t] ?? []).filter(r => this.f.every(f => f(r))).slice(0, this.lim); return { data: one ? rows[0] ?? null : rows, error: null }; }
    maybeSingle() { return Promise.resolve(this.run(true)); }
    then(a, b) { return Promise.resolve(this.run(false)).then(a, b); }
  }
  return { from: t => new Q(t) };
}

test('the prompt holds the outcome, the CRM reason as testimony, the dated record and what the buyer said', () => {
  const p = buildDealWhyPrompt({ outcome: 'lost', account: 'Fernpoint', value: 46000, closedAt: '2026-10-15T00:00:00Z', repReason: 'Price',
    events: [{ kind: 'budget_constraint', at: '2026-09-25T00:00:00Z', text: 'Above current spend', quote: 'At 40 seats, more than what we have.' }],
    notes: [{ category: 'competitor', content: 'Already pays for a call recorder.' }] });
  assert.match(p, /LOST · Fernpoint · closed 2026-10-15 · \$46,000/);
  assert.match(p, /CRM REASON \(the rep's own word, testimony, not the finding\): Price/);
  assert.match(p, /2026-09-25 \[budget_constraint\] Above current spend \("At 40 seats/);
  assert.match(p, /\[competitor\] Already pays for a call recorder\./);
});

test('an answer is up to four labelled points; anything else is unreadable', () => {
  assert.deepEqual(parseDealWhy('Sure: {"why":[{"label":"**Price at scale**","text":"Above Gong spend at 40 seats."}]}'), [{ label: 'Price at scale', text: 'Above Gong spend at 40 seats.' }]);
  assert.equal(parseDealWhy('{"why":[{"label":"a"},{"label":"b"},{"label":"c"},{"label":"d"},{"label":"e"}]}').length, 4);
  assert.deepEqual(parseDealWhy('{"why":[]}'), [], 'nothing explains it: an empty list, kept so it is not asked again');
  assert.equal(parseDealWhy('no json'), null);
});

test('closes after the cursor are analysed first, oldest first; deals with a why are skipped; each why is kept on the deal', async () => {
  const sb = db({
    deal_outcomes: [
      { workspace_id: WS, entity_id: 'a1', deal_id: 'd1', outcome: 'won', closed_at: '2026-10-20T00:00:00Z' },
      { workspace_id: WS, entity_id: 'a2', deal_id: 'd2', outcome: 'lost', closed_at: '2026-10-10T00:00:00Z' },
      { workspace_id: WS, entity_id: 'a3', deal_id: 'd3', outcome: 'lost', closed_at: '2026-08-01T00:00:00Z' },
      { workspace_id: WS, entity_id: 'a4', deal_id: 'd4', outcome: 'won', closed_at: '2026-10-25T00:00:00Z' },
    ],
    claims: [{ workspace_id: WS, entity_id: 'd4', property: 'deal.close_why', invalid_at: null, value: { why: [] } }],
    entity_list_rows: [{ workspace_id: WS, entity_id: 'a2', name: 'Fernpoint' }],
  });
  const asked = [], kept = [];
  const model = async ({ messages }) => { asked.push(messages[0].content); return { content: [{ type: 'text', text: '{"why":[{"label":"Price at scale","text":"Above current spend."}]}' }] }; };
  const out = await analyzeClosedDeals(sb, WS, { cursor: '2026-10-01T00:00:00Z', limit: 2, model, now: NOW, write: async (_sb, _ws, id, { values }) => kept.push([id, values['deal.close_why']]) });
  assert.deepEqual(out, { written: 2, failed: 0 });
  assert.deepEqual(kept.map(k => k[0]), ['d2', 'd1'], 'after the cursor, oldest first; d4 already has one');
  assert.match(asked[0], /LOST · Fernpoint/);
  assert.deepEqual(kept[0][1].why, [{ label: 'Price at scale', text: 'Above current spend.' }]);
});

test('the win/loss file reads a deal\'s own points instead of its raw notes', () => {
  const p = buildWinLossPrompt({ current: '# Win/loss', deals: [
    { outcome: 'lost', account: 'Fernpoint', closed_at: '2026-10-15T00:00:00Z', notes: [{ category: 'pain', content: 'raw note' }], why: [{ label: 'Price at scale', text: 'Above current spend.' }] },
    { outcome: 'won', account: 'Harborline', closed_at: '2026-10-20T00:00:00Z', notes: [{ category: 'goal', content: 'kept its CRM' }] },
  ] });
  assert.match(p, /why: \*\*Price at scale\*\*: Above current spend\./);
  assert.doesNotMatch(p, /raw note/);
  assert.match(p, /\[goal\] kept its CRM/, 'no why yet: the notes');
});
