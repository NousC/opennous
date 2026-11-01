// RevPlay templates on the server (GET-1087), the columns a flow's first AI step becomes, and what a
// scheduled flow reads when no step above it read anything.
//
// Run: pnpm --filter @nous/core build && node --test packages/core/test/revPlayTemplates.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { listRevPlayTemplates, revPlayTemplateById } from '../dist/services/revPlayTemplates.mjs';
import { agentColumnsOf, scheduledRead, JOB_PROMPTS, registerStepHandler } from '../dist/services/automationRun.mjs';

test('every template has a flow the API accepts: a trigger and uniquely named steps', () => {
  const all = listRevPlayTemplates();
  assert.equal(all.length, 10);
  for (const t of all) {
    assert.ok(t.id && t.name && t.does && t.group, t.id);
    assert.equal(typeof t.flow.trigger.kind, 'string');
    assert.ok(t.flow.steps.length > 0, t.id);
    assert.equal(new Set(t.flow.steps.map(s => s.id)).size, t.flow.steps.length, t.id);
    for (const s of t.flow.steps) assert.ok(s.id.length <= 40);
  }
});

test('a step that reads another reads it by this draw\'s id', () => {
  const t = revPlayTemplateById('account_handoff');
  const [a, email] = t.flow.steps;
  assert.equal(email.config.body, `{{steps.${a.id}.output}}`);
  assert.notEqual(revPlayTemplateById('account_handoff').flow.steps[0].id, a.id);
  assert.equal(revPlayTemplateById('nope'), null);
});

test('an action with no artifact carries its own words; one with an artifact does not need them', () => {
  assert.deepEqual(agentColumnsOf([{ type: 'agent', config: { mode: 'pick', job: 'follow_up', extra: '' } }]), { artifact: null, prompt: JOB_PROMPTS.follow_up });
  assert.deepEqual(agentColumnsOf([{ type: 'agent', config: { mode: 'pick', job: 'call_summary', extra: 'Short.' } }]), { artifact: 'call_summary', prompt: 'Short.' });
  assert.deepEqual(agentColumnsOf([{ type: 'agent', config: { mode: 'write', prompt: ' Say who. ' } }]), { artifact: null, prompt: 'Say who.' });
  assert.deepEqual(agentColumnsOf([{ type: 'webhook', config: {} }]), { artifact: null, prompt: null });
});

function fakeDb(tables) {
  return { from(t) {
    const rows = tables[t] ?? [];
    const q = { select: () => q, eq: () => q, not: () => q, gte: () => q, order: () => q, limit: () => q, in: () => q,
      then: (ok) => ok({ data: rows, error: null }) };
    return q;
  } };
}
const INSIGHT = { statement: 'Asked for SSO', quote: 'we need SSO', speaker: 'Ida', occurred_at: '2026-10-30T10:00:00Z', lane: 'product', subtype: 'feature', company_id: 'c1' };
const WEEKLY = { frequency: 'weekly', user_id: 'u1', steps: [{ id: 'a', type: 'agent', config: {} }, { id: 'e', type: 'email', config: {} }] };

test('a scheduled AI step with nothing above it reads the period\'s insights, named', async () => {
  const r = await scheduledRead(fakeDb({ insight_items: [INSIGHT], companies: [{ id: 'c1', name: 'Harborline' }] }), 'ws', WEEKLY);
  assert.match(r.text, /last 7 days \(1\)/);
  assert.match(r.text, /Harborline · product\/feature: Asked for SSO \("we need SSO", Ida\)/);
});

test('an empty period says so, a flow with its own data reads nothing extra', async () => {
  const none = await scheduledRead(fakeDb({}), 'ws', { ...WEEKLY, frequency: 'daily' });
  assert.match(none.text, /Nothing was recorded from customers in the last 1 day\./);
  const withRead = { ...WEEKLY, steps: [{ id: 'r', type: 'hubspot', config: { action: 'read' } }, ...WEEKLY.steps] };
  assert.equal(await scheduledRead(fakeDb({}), 'ws', withRead), null);
  const fixed = { ...WEEKLY, steps: [{ id: 'a', type: 'agent', config: { account_id: 'c1' } }] };
  assert.equal(await scheduledRead(fakeDb({}), 'ws', fixed), null);
});

test('a closed workspace reads only what the owner may see', async () => {
  registerStepHandler('visible_accounts', async () => new Set(['c2']));
  const r = await scheduledRead(fakeDb({ insight_items: [INSIGHT], companies: [] }), 'ws', WEEKLY);
  registerStepHandler('visible_accounts', async () => null);
  assert.match(r.text, /Nothing was recorded/);
});
