// The market-entity backfill's plan (GET-1049): what a dry run prints, grouped by the same matcher
// that resolves on write. Pure; no database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planGroups, renderPlan } from '../scripts/backfillMarketEntities.mjs';

const c = (category, name, n = 1) => Array.from({ length: n }, (_, i) => ({ id: `${name}-${i}`, category, name }));

test('variants group under the most-said spelling; a sub-product is left to decide; kinds stay apart', () => {
  const plan = planGroups([
    ...c('competitor', 'Pearl Lantern', 3), ...c('competitor', 'pearl-lantern'), ...c('competitor', "Pearl Lantern's", 2),
    ...c('competitor', 'Pearl Lantern Pro'), ...c('competitor', 'Fernpoint'),
    ...c('tech_stack', 'Lumen Desk', 2), ...c('tech_stack', 'Lumen Desks'), ...c('tech_stack', 'Pearl Lantern'),
    ...c('objection', 'ignored'), ...c('competitor', '  '),
  ]);
  const comp = plan.competitor;
  assert.equal(comp.groups[0].canonical, 'Pearl Lantern');
  assert.equal(comp.groups[0].claims, 6);
  assert.deepEqual(comp.groups.map(g => g.canonical).sort(), ['Fernpoint', 'Pearl Lantern', 'Pearl Lantern Pro']);
  assert.deepEqual(comp.asks.map(a => [a.name, a.of, a.reason]), [['Pearl Lantern Pro', 'Pearl Lantern', 'parent_child']]);
  assert.equal(plan.tool.groups.length, 2);
  assert.equal(plan.tool.groups[0].canonical, 'Lumen Desk');
  assert.equal(plan.tool.groups[0].claims, 3);
  const text = renderPlan(plan).join('\n');
  assert.match(text, /Pearl Lantern \(6\) ← Pearl Lantern ×3/);
  assert.match(text, /Pearl Lantern Pro ~ Pearl Lantern \(parent_child/);
});
