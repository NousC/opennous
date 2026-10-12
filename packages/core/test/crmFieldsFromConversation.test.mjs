// "Based on what was discussed" (GET-715): the model may only fill the fields the step allows, each
// with the words that support it, and each value must fit its field.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFieldsAnswer, buildFieldsPrompt, AI_FIELD_DEFAULTS } from '../dist/services/crmFieldsFromConversation.mjs';

const allow = AI_FIELD_DEFAULTS.update_deal;

test('only allowed fields, with a quote, survive', () => {
  const out = parseFieldsAnswer(JSON.stringify({ fields: [
    { name: 'hs_next_step', value: 'Send SOC 2 report by Friday', quote: "I'll get you the SOC 2 by Friday" },
    { name: 'dealstage', value: 'closedwon', quote: 'we are in' },            // not allowed
    { name: 'amount', value: '$48,000', quote: 'budget is 48k' },
    { name: 'description', value: 'Wants SSO', quote: '' },                    // no quote
  ] }), allow);
  assert.deepEqual(out.map(f => [f.name, f.value]), [['hs_next_step', 'Send SOC 2 report by Friday'], ['amount', '48000']]);
});

test('a value that does not fit its field is dropped', () => {
  const out = parseFieldsAnswer('{"fields":[{"name":"closedate","value":"end of Q4","quote":"by end of Q4"},{"name":"amount","value":"a lot","quote":"x"}]}', allow);
  assert.deepEqual(out, []);
});

test('garbage or nothing said is an empty answer, not an error', () => {
  assert.deepEqual(parseFieldsAnswer('sorry, no idea', allow), []);
  assert.deepEqual(parseFieldsAnswer('{"fields":[]}', allow), []);
});

test('the prompt lists only the allowed fields and carries the call', () => {
  const p = buildFieldsPrompt({ object: 'update_deal', fields: ['hs_next_step'], call: { title: 'Pricing review', transcript: 'Sarah: we sign in March' } });
  assert.match(p.system, /- hs_next_step:/);
  assert.doesNotMatch(p.system, /closedate/);
  assert.match(p.user, /Pricing review/);
  assert.match(p.user, /we sign in March/);
});
