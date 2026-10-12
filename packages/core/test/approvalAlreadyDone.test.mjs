// An approval whose email already went out leaves the list (GET-834). The pure half.
//
// Run: node --test packages/core/test/approvalAlreadyDone.test.mjs   (after `tsc`)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { approvalAlreadyDone } from '../dist/services/automationRun.mjs';

const emailItem = { index: 2, type: 'gmail', email: { to: 'dana@harborline.example', subject: 'Next step', body: 'Hi' } };
const sentLog = [{ step: 1, status: 'ok', mail: { kind: 'sent' } }];
const draftLog = [{ step: 1, status: 'ok', mail: { kind: 'draft' } }];

test('waiting only on an email, and an email was sent: done', () => {
  assert.equal(approvalAlreadyDone({ state: { bundle: [emailItem] }, step_log: sentLog }), true);
  assert.equal(approvalAlreadyDone({ state: { preview: { type: 'gmail' } }, step_index: 2, step_log: sentLog }), true);
});

test('still a draft: not done', () => {
  assert.equal(approvalAlreadyDone({ state: { bundle: [emailItem] }, step_log: draftLog }), false);
});

test('tasks still to decide: not done, even with the email sent', () => {
  const tasks = { index: 3, type: 'hubspot', tasks: [{ key: 0, title: 'Book the review', due_at: null }] };
  assert.equal(approvalAlreadyDone({ state: { bundle: [emailItem, tasks] }, step_log: sentLog }), false);
});

test('nothing waiting at all: not this rule\'s call', () => {
  assert.equal(approvalAlreadyDone({ state: {}, step_log: sentLog }), false);
});
