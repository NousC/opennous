// What an agent reads about a deal (GET-798): the current position is the DEAL's (every open
// blocker, every live requirement, the newest of each other deal topic), a person's read carries
// their company's deal and stack facts, the stack is grouped by tool, and what a newer claim
// replaced lately is listed old → new.
//
// Run: pnpm --filter @nous/core build && node --test packages/core/test/dealContext.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  dealPosition, techStackGroups, pairReplacements, shapeContextFacts, DEAL_POSITION_CATEGORIES,
} from '../dist/db/claimTime.js';
import { listDealScopeNotes, listRecentlyReplaced } from '../dist/db/notes.js';
import { getAccountRecord } from '../dist/db/claims.js';
import { assembleContext } from '../dist/context.js';
import { compressAccount } from '../dist/evidence.js';

const NOW = Date.now();
const daysAgo = (n) => new Date(NOW - n * 86_400_000).toISOString();
const fact = (category, content, date, extra = {}) => ({ category, content, date, ...extra });

// ── pure ─────────────────────────────────────────────────────────────────────

test('the current position is deal topics only: status quo, adoption and pain stay out', () => {
  const pos = dealPosition([
    fact('buying_signal', 'Dana Reyes wants to present Nous to the other stakeholders.', daysAgo(1)),
    fact('buying_signal', 'Dana Reyes asked for the DPA.', daysAgo(10)),
    fact('status_quo', 'Acme routes leads by hand.', daysAgo(1)),
    fact('adoption', 'Acme reps open the app daily.', daysAgo(1)),
    fact('pain', 'Acme finds reporting slow.', daysAgo(1)),
    fact('goal', 'Acme wants daily stats in Slack.', daysAgo(1)),
    fact('timeline', 'Acme wants it live this quarter.', daysAgo(3)),
  ], NOW);
  assert.deepEqual(pos.map(f => f.category).sort(), ['buying_signal', 'timeline']);
  assert.equal(pos.find(f => f.category === 'buying_signal').content,
    'Dana Reyes wants to present Nous to the other stakeholders.');
  assert.ok(DEAL_POSITION_CATEGORIES.includes('blocker') && DEAL_POSITION_CATEGORIES.includes('requirement'));
});

test('every open blocker and every live requirement, not only the newest; resolved and stale drop', () => {
  const pos = dealPosition([
    fact('blocker', 'Security review is pending.', daysAgo(2), { status: 'open' }),
    fact('blocker', 'Legal has not signed the DPA.', daysAgo(5)),
    fact('blocker', 'Budget freeze.', daysAgo(4), { status: 'resolved' }),
    fact('blocker', 'An old procurement hold.', daysAgo(200), { status: 'open' }),
    fact('requirement', 'Needs SSO.', daysAgo(6)),
    fact('requirement', 'Needs EU data residency.', daysAgo(20)),
  ], NOW);
  assert.deepEqual(pos.filter(f => f.category === 'blocker').map(f => f.content),
    ['Security review is pending.', 'Legal has not signed the DPA.']);
  assert.deepEqual(pos.filter(f => f.category === 'requirement').map(f => f.content),
    ['Needs SSO.', 'Needs EU data residency.']);
});

test('the stack groups by canonical tool, newest fact as the summary, unnamed tools under Other', () => {
  const groups = techStackGroups([
    fact('tech_stack', 'Acme moved its pipeline into HubSpot.', daysAgo(2), { tool: 'Hubspot CRM' }),
    fact('tech_stack', 'Acme runs HubSpot for marketing email.', daysAgo(30), { tool: 'HubSpot' }),
    fact('tech_stack', 'Acme dials through RingCentral.', daysAgo(5), { tool: 'ring central' }),
    fact('tech_stack', 'Acme keeps a spreadsheet of renewals.', daysAgo(1)),
    fact('timeline', 'Not a tool.', daysAgo(1)),
  ]);
  assert.deepEqual(groups.map(g => g.tool), ['HubSpot', 'RingCentral', 'Other']);
  assert.equal(groups[0].summary, 'Acme moved its pipeline into HubSpot.');
  assert.equal(groups[0].facts.length, 2);
});

test('facts leave out what the position and the stack already show, and count only the rest', () => {
  const shaped = shapeContextFacts([
    fact('buying_signal', 'Wants to sign.', daysAgo(1)),
    fact('buying_signal', 'Asked for the DPA.', daysAgo(10)),
    fact('tech_stack', 'Uses HubSpot.', daysAgo(1), { tool: 'HubSpot' }),
    fact('pain', 'Reporting is slow.', daysAgo(2)),
  ], { now: NOW });
  assert.deepEqual(shaped.facts.map(f => f.content).sort(), ['Asked for the DPA.', 'Reporting is slow.']);
  assert.equal(shaped.total, 2);
  assert.equal(shaped.current_position.length, 1);
  assert.equal(shaped.tech_stack.length, 1);
});

test('replacements pair old with new, inside the window, newest first, capped', () => {
  const succ = new Map([
    ['n1', { category: 'buying_signal', content: 'Ready to present to stakeholders.', said_at: daysAgo(1) }],
    ['n2', { category: 'budget', content: 'Budget approved.', said_at: daysAgo(10) }],
    ['n3', { category: 'timeline', content: 'Old change.', said_at: daysAgo(120) }],
  ]);
  const pairs = pairReplacements([
    { category: 'budget', content: 'No budget this year.', said_at: daysAgo(40), superseded_by: 'n2', invalid_at: daysAgo(10) },
    { category: 'timeline', content: 'Needs a couple of months.', said_at: daysAgo(9), superseded_by: 'n1', invalid_at: daysAgo(1) },
    { category: 'timeline', content: 'Ancient.', said_at: daysAgo(200), superseded_by: 'n3', invalid_at: daysAgo(119) },
    { category: 'timeline', content: 'Successor unreadable.', said_at: daysAgo(5), superseded_by: 'n-hidden', invalid_at: daysAgo(2) },
  ], succ, { now: NOW });
  assert.deepEqual(pairs.map(p => `${p.old.content} -> ${p.new.content}`), [
    'Needs a couple of months. -> Ready to present to stakeholders.',
    'No budget this year. -> Budget approved.',
  ]);
  const many = Array.from({ length: 10 }, (_, i) => ({ category: 'timeline', content: `c${i}`, said_at: daysAgo(30), superseded_by: 'n1', invalid_at: daysAgo(i) }));
  assert.equal(pairReplacements(many, succ, { now: NOW }).length, 6);
});

// ── through the database ─────────────────────────────────────────────────────

const WS = 'ws', DANA = 'p-dana', ACME = 'co-acme', LEE = 'p-lee', OTHER = 'co-other';

const claim = (id, entity_id, category, content, valid_from, metadata = {}, invalid_at = null) => ({
  id, workspace_id: WS, entity_id, property: `note.${id}`,
  value: { category, content, source: 'signal_extraction', metadata },
  confidence: 0.8, epistemic_class: 'asserted', freshness: 'fresh',
  valid_from, computed_at: valid_from, invalid_at, supporting_observation_ids: [],
});

function tables() {
  return {
    entities: [
      { id: DANA, workspace_id: WS, type: 'person' },
      { id: ACME, workspace_id: WS, type: 'company' },
      { id: LEE, workspace_id: WS, type: 'person' },
      { id: 'ws-entity', workspace_id: WS, type: 'workspace' },
    ],
    relationships: [
      { workspace_id: WS, from_entity_id: DANA, to_entity_id: ACME, type: 'works_at', valid_to: null },
      { workspace_id: WS, from_entity_id: LEE, to_entity_id: ACME, type: 'works_at', valid_to: null },
    ],
    claims: [
      // Dana's own
      claim('d1', DANA, 'buying_signal', 'Dana Reyes wants to present Nous to the other stakeholders.', daysAgo(1), {}),
      claim('d2', DANA, 'status_quo', 'Dana Reyes routes leads by hand today.', daysAgo(1)),
      claim('d3', DANA, 'preference', 'Dana Reyes prefers short calls.', daysAgo(3)),
      claim('d0', DANA, 'timeline', 'Dana Reyes needs another couple of months.', daysAgo(9), { superseded_by: 'd1' }, daysAgo(1)),
      // Acme's: two open blockers, a resolved one, a requirement, the stack, and a personal-ish
      // category a person's read does not borrow.
      claim('a1', ACME, 'blocker', 'Security review is pending.', daysAgo(2), { status: 'open' }),
      claim('a2', ACME, 'blocker', 'Legal has not signed the DPA.', daysAgo(4), { status: 'open' }),
      claim('a3', ACME, 'blocker', 'Budget freeze.', daysAgo(6), { status: 'resolved' }),
      claim('a4', ACME, 'requirement', 'Acme needs SSO.', daysAgo(5)),
      claim('a5', ACME, 'tech_stack', 'Acme moved its pipeline into HubSpot.', daysAgo(2), { tool: 'HubSpot' }),
      claim('a6', ACME, 'tech_stack', 'Acme dials through RingCentral.', daysAgo(8), { tool: 'RingCentral' }),
      claim('a7', ACME, 'firmographic', 'Acme has about 400 customers.', daysAgo(20)),
      claim('a8', ACME, 'meeting_notes', 'Call notes', daysAgo(3), { doc_type: 'meeting_notes' }),
      // Lee (Acme's other person): a deal fact, and a personal one.
      claim('l1', LEE, 'objection', 'Lee pushed back on the annual commitment.', daysAgo(3)),
      claim('l2', LEE, 'preference', 'Lee likes email.', daysAgo(3)),
      // Another account's: never in Dana's read.
      claim('o1', OTHER, 'blocker', 'Another account is blocked.', daysAgo(1), { status: 'open' }),
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

test('a person\'s deal scope borrows the company\'s deal and stack facts, never its documents or firmographics', async () => {
  const scope = await listDealScopeNotes(fakeSupabase(), WS, { id: DANA, type: 'person' });
  assert.deepEqual(scope.own.map(n => n.id).sort(), ['d1', 'd2', 'd3']);
  assert.deepEqual(scope.related.map(n => n.id).sort(), ['a1', 'a2', 'a3', 'a4', 'a5', 'a6']);
  assert.deepEqual(scope.relatedIds, [ACME]);
});

test('a company\'s deal scope is the account read: its own notes plus its people\'s deal facts', async () => {
  const scope = await listDealScopeNotes(fakeSupabase(), WS, { id: ACME, type: 'company' });
  assert.ok(scope.own.every(n => n.entity_id === ACME));
  assert.deepEqual(scope.related.map(n => n.id).sort(), ['d1', 'l1']);
});

test('recently replaced: old → new, only where the successor is readable', async () => {
  const t = tables();
  t.claims.push(claim('x0', DANA, 'budget', 'No budget this year.', daysAgo(30), { superseded_by: 'gone' }, daysAgo(2)));
  const pairs = await listRecentlyReplaced(fakeSupabase(t), WS, { entityId: DANA, relatedIds: [ACME] });
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].old.content, 'Dana Reyes needs another couple of months.');
  assert.equal(pairs[0].new.category, 'buying_signal');
});

test('get_account on a person: deal position across the account, tech stack, recently replaced, slimmer facts', async () => {
  const rec = await getAccountRecord(fakeSupabase(), WS, DANA);
  const pos = rec.current_position.map(f => f.content);
  assert.ok(pos.includes('Security review is pending.') && pos.includes('Legal has not signed the DPA.'));
  assert.ok(pos.includes('Acme needs SSO.'));
  assert.ok(pos.includes('Dana Reyes wants to present Nous to the other stakeholders.'));
  assert.ok(!pos.includes('Budget freeze.'));
  assert.ok(!rec.current_position.some(f => f.category === 'status_quo'));
  assert.deepEqual(rec.tech_stack.map(g => g.tool), ['HubSpot', 'RingCentral']);
  assert.equal(rec.tech_stack[0].summary, 'Acme moved its pipeline into HubSpot.');
  assert.equal(rec.recently_replaced.length, 1);
  // Nothing shown above is repeated in facts; another account's blocker never appears.
  const factText = rec.facts.map(f => f.content);
  assert.ok(!factText.includes('Security review is pending.'));
  assert.ok(!factText.includes('Acme moved its pipeline into HubSpot.'));
  assert.ok(factText.includes('Dana Reyes routes leads by hand today.'));
  assert.ok(![...pos, ...factText].includes('Another account is blocked.'));
  // compressAccount carries the new sections to the in-app chat.
  const c = compressAccount(rec);
  assert.equal(c.tech_stack.length, 2);
  assert.equal(c.recently_replaced.length, 1);
  assert.match(c.facts_note, /tech_stack/);
  assert.match(c.facts_note, /recently_replaced/);
});

test('get_context on a person carries the same position, stack and replacements', async () => {
  const ctx = await assembleContext(fakeSupabase(), WS, DANA, 'account_review');
  assert.equal(ctx.current_position.filter(f => f.category === 'blocker').length, 2);
  assert.ok(ctx.current_position.every(f => DEAL_POSITION_CATEGORIES.includes(f.category)));
  assert.deepEqual(ctx.tech_stack.map(g => g.tool), ['HubSpot', 'RingCentral']);
  assert.equal(ctx.recently_replaced[0].new.content, 'Dana Reyes wants to present Nous to the other stakeholders.');
  assert.equal(ctx.meta.facts_total, ctx.facts.length);
});

test('get_context on a company includes its people\'s deal facts', async () => {
  const ctx = await assembleContext(fakeSupabase(), WS, ACME, 'account_review');
  const pos = ctx.current_position.map(f => f.content);
  assert.ok(pos.includes('Lee pushed back on the annual commitment.'));
  assert.ok(pos.includes('Dana Reyes wants to present Nous to the other stakeholders.'));
  assert.ok(![...pos, ...ctx.facts.map(f => f.content)].includes('Lee likes email.'));
});
