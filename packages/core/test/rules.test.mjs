// Rules (GET-846): the store's pure halves — what a stated rule becomes, and how rules read to the agent.
//
// Run: (cd packages/core && npx tsc) && node --test packages/core/test/rules.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRuleRow, renderRules } from '../dist/db/rules.mjs';

test('a rule with a known check is a checked rule, with the check normalized', () => {
  const row = buildRuleRow('ws', { statement: '  Every meeting ends with a dated next step within 48 hours  ', user_id: 'u1',
    check: { type: 'next_step_after_meeting', params: { hours: 48 } } });
  assert.equal(row.statement, 'Every meeting ends with a dated next step within 48 hours');
  assert.equal(row.kind, 'checked');
  assert.equal(row.check_type, 'next_step_after_meeting');
  assert.deepEqual(row.params, { hours: 48 });
  assert.equal(row.scope, 'person');
  assert.equal(row.user_id, 'u1');
  assert.equal(row.weight, 'normal');
  assert.equal(row.status, 'active');
});

test('a rule without a check, or with one we do not have, is guidance', () => {
  assert.equal(buildRuleRow('ws', { statement: 'Lead with ROI for CFOs', user_id: 'u1' }).kind, 'guidance');
  const odd = buildRuleRow('ws', { statement: 'Send flowers', user_id: 'u1', check: { type: 'send_flowers' } });
  assert.equal(odd.kind, 'guidance');
  assert.equal(odd.check_type, null);
});

test('a rule needs a statement and a person; weight is one of three', () => {
  assert.throws(() => buildRuleRow('ws', { statement: '  ', user_id: 'u1' }), /statement_required/);
  assert.throws(() => buildRuleRow('ws', { statement: 'x' }), /user_id_required/);
  assert.equal(buildRuleRow('ws', { statement: 'x', user_id: 'u1', weight: 'high' }).weight, 'high');
  assert.equal(buildRuleRow('ws', { statement: 'x', user_id: 'u1', weight: 'urgent!!' }).weight, 'normal');
  // Personal only for now: a workspace scope asked for is still a person's rule.
  assert.equal(buildRuleRow('ws', { statement: 'x', user_id: 'u1', scope: 'workspace' }).scope, 'person');
});

test('rules read to the agent as one block; paused rules are left out', () => {
  const text = renderRules([
    { statement: 'Lead with ROI for CFOs', kind: 'guidance', status: 'active' },
    { statement: 'Every meeting ends with a dated next step within 48 hours', kind: 'checked', check_type: 'next_step_after_meeting', params: { hours: 48 }, status: 'active' },
    { statement: 'Paused one', kind: 'guidance', status: 'paused' },
  ]);
  assert.match(text, /^THIS OPERATOR'S RULES/);
  assert.match(text, /- Lead with ROI for CFOs/);
  assert.match(text, /- Every meeting ends with a dated next step within 48 hours \(checked\)/);
  assert.doesNotMatch(text, /Paused one/);
  assert.equal(renderRules([]), '');
});
