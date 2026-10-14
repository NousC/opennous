// POST /internal/automation-steps/gmail-draft (review 5): the worker sends `cc` (a box Gmail
// destination's Cc, an email step's Cc); the route passes it on to automationGmailDraft.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL ??= 'http://127.0.0.1:1';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-key';
const { gmailDraftArgs } = await import('../src/routes/automationSteps.mjs');

test('gmail-draft passes cc through', () => {
  const a = gmailDraftArgs({ workspaceId: 'ws', userId: 'u1', to: 'a@x.example', cc: 'b@x.example, c@x.example', subject: 'S', body: 'B', connectionId: 'conn-1' });
  assert.deepEqual(a, { workspaceId: 'ws', userId: 'u1', to: 'a@x.example', cc: 'b@x.example, c@x.example', subject: 'S', body: 'B', connectionId: 'conn-1' });
  // A list is fine too; nothing given is null, as before.
  assert.deepEqual(gmailDraftArgs({ workspaceId: 'ws', to: 'a@x.example', cc: ['b@x.example'] }).cc, ['b@x.example']);
  const none = gmailDraftArgs({ workspaceId: 'ws', to: 'a@x.example' });
  assert.deepEqual([none.cc, none.userId, none.connectionId], [null, null, null]);
});
