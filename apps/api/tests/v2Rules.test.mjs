// /v2/rules (GET-846): what a request becomes, and what a caller sees of a rule.
//
// Run: node --test apps/api/tests/v2Rules.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRuleInput, ruleView } from '../src/routes/v2/rules.mjs';

test('a statement with a check, in the shapes an agent sends', () => {
  const a = parseRuleInput({ statement: 'Every meeting ends with a dated next step within 48 hours', check: { type: 'next_step_after_meeting', params: { hours: 48 } }, weight: 'high' });
  assert.deepEqual(a, { ok: true, input: { statement: 'Every meeting ends with a dated next step within 48 hours', check: { type: 'next_step_after_meeting', params: { hours: 48 } }, weight: 'high' } });
  // Flat form: check_type + params.
  const b = parseRuleInput({ statement: 'Reply within a day', check_type: 'reply_to_buyer_email', params: { hours: 24 } });
  assert.deepEqual(b.input.check, { type: 'reply_to_buyer_email', params: { hours: 24 } });
  // No check: guidance.
  assert.equal(parseRuleInput({ statement: 'Lead with ROI for CFOs' }).input.check, null);
});

test('refusals name what is wrong', () => {
  assert.deepEqual(parseRuleInput({}), { ok: false, error: 'statement_required' });
  assert.deepEqual(parseRuleInput({ statement: 'x', check: { type: 'send_flowers' } }), { ok: false, error: 'unknown_check', checks: ['next_step_after_meeting', 'reply_to_buyer_email', 'stage_without_meeting'] });
  assert.deepEqual(parseRuleInput({ statement: 'x', weight: 'urgent' }), { ok: false, error: 'invalid_weight' });
  assert.deepEqual(parseRuleInput({ statement: 'x', colour: 'red' }), { ok: false, error: 'unknown_field', field: 'colour' });
});

test('a rule reads back with what its check verifies, and without the bookkeeping', () => {
  const v = ruleView({ id: 'r1', workspace_id: 'ws', user_id: 'u1', scope: 'person', statement: 'Every meeting…', kind: 'checked', check_type: 'next_step_after_meeting', params: { hours: 48 }, weight: 'normal', status: 'active', source: 'stated', created_at: 'c', updated_at: 'u', removed_at: null });
  assert.deepEqual(Object.keys(v).sort(), ['check', 'created_at', 'id', 'kind', 'statement', 'status', 'weight']);
  assert.equal(v.check.type, 'next_step_after_meeting');
  assert.deepEqual(v.check.params, { hours: 48 });
  assert.match(v.check.verifies, /Within N hours of a meeting/);
  assert.equal(ruleView({ id: 'r2', statement: 'Lead with ROI', kind: 'guidance', check_type: null, params: {}, weight: 'normal', status: 'active', created_at: 'c' }).check, null);
});
