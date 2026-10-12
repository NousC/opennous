// The context graph (GET-815): typed nodes and links, nothing in the middle, and a node's
// neighbourhood for the local graph.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contextGraph, neighbourhood } from '../src/lib/contextGraph.mjs';

const net = {
  nodes: [
    { i: 'acme', t: 1, l: 'Acme Motors', s: 88, a: 3, pc: 2, d: 'acme.com' },
    { i: 'globex', t: 1, l: 'Globex', s: 40, a: 120, pc: 1 },
    { i: 'ann', t: 0, l: 'Ann Lee', jt: 'VP Sales', a: 3, co: 'acme', dm: true },
    { i: 'bo', t: 0, l: 'Bo Chan', a: 10, co: 'acme' },
    { i: 'cy', t: 0, l: 'Cy Park', a: 120, co: 'globex' },
    { i: 'cl0', t: 3, l: 'HubSpot', cat: 'tool', sz: 2 },
    { i: 'cl1', t: 3, l: 'Manual reporting', cat: 'pain', sz: 1 },
    { i: 'cl2', t: 3, l: 'Reached · Seeing · Working', cat: 'other', sz: 4 },
    { i: 'cl3', t: 3, l: 'Clay', cat: 'competitor', sz: 2 },
  ],
  edges: [
    { s: 'ann', t: 'cy', k: 3 }, { s: 'cy', t: 'ann', k: 3 },
    { s: 'acme', t: 'cl0', k: 2 }, { s: 'globex', t: 'cl0', k: 2 }, { s: 'bo', t: 'cl1', k: 2 },
    { s: 'acme', t: 'cl2', k: 2 }, { s: 'globex', t: 'cl3', k: 2 },
  ],
};
const deals = [
  { entity_id: 'd1', name: 'Acme renewal', company_id: 'acme', stage: 'Proposal', status: 'open', pipeline_value: '12000', last_activity_at: '2026-10-01T00:00:00Z' },
  { entity_id: 'd9', name: 'Elsewhere', company_id: 'not-drawn' },
];
const stakes = [{ from_entity_id: 'ann', to_entity_id: 'd1' }, { from_entity_id: 'zed', to_entity_id: 'd1' }];

test('typed nodes, typed links, no hub; deals hang off their account and their people', () => {
  const g = contextGraph(net, deals, stakes, { now: Date.parse('2026-10-08T00:00:00Z') });
  const type = Object.fromEntries(g.nodes.map(n => [n.id, n.type]));
  assert.deepEqual(type, { acme: 'account', globex: 'account', ann: 'person', bo: 'person', cy: 'person', d1: 'deal' });
  assert.equal(g.nodes.find(n => n.id === 'acme').domain, 'acme.com', 'accounts carry their domain, for the logo');
  assert.equal(g.nodes.find(n => n.id === 'd1').value, 12000);
  assert.equal(g.nodes.find(n => n.id === 'd1').days, 7);
  assert.equal(g.nodes.find(n => n.id === 'd1').status, 'open', 'status travels apart from the stage, so a lost deal is not read as open');
  const has = (s, t, ty) => g.edges.some(e => e.type === ty && ((e.s === s && e.t === t) || (e.s === t && e.t === s)));
  assert.ok(has('ann', 'acme', 'works_at'));
  assert.ok(has('ann', 'cy', 'knows'));
  assert.equal(g.edges.filter(e => e.type === 'knows').length, 1, 'one link per pair');
  assert.ok(has('d1', 'acme', 'deal_of') && has('ann', 'd1', 'on_deal'));
  assert.ok(!g.nodes.some(n => n.id === 'd9'), 'a deal of an account not drawn is left out');
  assert.ok(!g.edges.some(e => e.s === 'zed'), 'a person not drawn gets no link');
});

test('patterns are not nodes: their labels are keyword clusters ("Outreach · Pipeline · Uses"), not things (GET-841)', () => {
  const g = contextGraph(net, deals, stakes);
  assert.ok(!g.nodes.some(n => n.id.startsWith('cl')));
  assert.ok(!g.edges.some(e => e.s.startsWith('cl') || e.t.startsWith('cl')));
});

test("an account's own deal is drawn like a CRM deal and says it is implied (GET-844)", () => {
  const g = contextGraph(net, [{ entity_id: 'implied:globex', name: 'Globex deal', company_id: 'globex', stage: 'Demo', status: 'open', pipeline_value: 450, implied: true }],
    [{ from_entity_id: 'cy', to_entity_id: 'implied:globex' }]);
  const d = g.nodes.find(n => n.id === 'implied:globex');
  assert.equal(d.type, 'deal'); assert.equal(d.implied, true); assert.equal(d.value, 450); assert.equal(d.sub, 'Demo');
  assert.ok(g.edges.some(e => e.type === 'deal_of' && e.s === 'implied:globex' && e.t === 'globex'));
  assert.ok(g.edges.some(e => e.type === 'on_deal' && e.s === 'cy' && e.t === 'implied:globex'));
});

test('a neighbourhood grows by hops', () => {
  const g = contextGraph(net, deals, stakes);
  const ids = (d) => neighbourhood(g, 'acme', d).nodes.map(n => n.id).sort();
  assert.deepEqual(ids(1), ['acme', 'ann', 'bo', 'd1']);
  assert.deepEqual(ids(2), ['acme', 'ann', 'bo', 'cy', 'd1']);
});
