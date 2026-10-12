// Someone selling TO us is not a customer (GET-327 mining, 2026-09).
//
// Without this rule a mailbox yields "competitive intel" about companies that cold-emailed
// Harborline: a vendor's AI agent pitch, a sales workshop invite, a developer tool, a staffing
// agency's terms. It reads as account knowledge. None of it is — it is a stranger's product pitch
// filed on our own record, and it costs a model call each time.
//
// This is a LANGUAGE judgement, so the model makes it: a thread where the other side is selling is
// obvious to read and awkward to detect deterministically, because a genuine inbound lead — a
// prospect asking about Harborline — looks identical to a vendor on every structural signal
// available (no prior outbound, no deal, they initiated).
//
// These tests pin the instruction into the prompt rather than the behaviour, which needs a model.
//
// Run: node --test apps/worker/tests/vendorInbound.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildActivitySignalsPrompt } from '../src/signals/index.mjs';

// It returns { prompt, maxFacts, maxTokens }, not a string.
const { prompt } = buildActivitySignalsPrompt({
  contactName: 'Juniper Calloway', company: 'Thimbleway Studio', type: 'email_thread',
  summary: 'Hi Theo, quick question about your spring catalogue.',
});

test('the extractor is told that inbound selling is not intelligence', () => {
  assert.match(prompt, /SOMEONE SELLING TO US IS NOT A CUSTOMER/);
  assert.match(prompt, /return \[\]/,
    'and told what to do about it, not merely that it is true');
});

test('it names the shapes actually seen in the corpus', () => {
  // Named rather than described, because "irrelevant email" is a judgement a model will not share
  // and "a vendor cold email" is one it will.
  for (const shape of ['vendor cold email', 'recruiter', 'staffing']) {
    assert.ok(prompt.includes(shape), `the rule should name: ${shape}`);
  }
});

test('the title rule is still there, and both come before the category list', () => {
  // Order matters in a prompt: a model that has already chosen a category is less likely to
  // reconsider whether the thing should have been a fact at all.
  const selling = prompt.indexOf('SOMEONE SELLING TO US');
  const title = prompt.indexOf('A JOB TITLE ON ITS OWN');
  const cats = prompt.indexOf('Set "category" to exactly one of');
  assert.ok(selling > 0 && title > 0 && cats > 0);
  assert.ok(selling < cats && title < cats, 'both exclusions precede the category choice');
});
