// Retargeting a job's Gmail step from the Delivery rail (GET-872): only the owner of the mailbox a step
// sends from may change who it goes to, so nobody can send from a colleague's Gmail to new people.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stepWithTarget } from '../src/routes/api/revboxes.mjs';

const step = (mailboxId) => ({ id: 'mail', type: 'gmail', config: { mode: 'send', to: 'dana@acme.example', cc: '', send_from: { id: mailboxId, kind: 'gmail', email: 'x@acme.example' } } });
const deps = (ids) => ({ mailboxes: async () => ids.map((id) => ({ id, email: `${id}@acme.example` })) });

test("changing recipients of a step that sends from someone else's mailbox is refused", async () => {
  await assert.rejects(
    () => stepWithTarget(step('theirs'), { kind: 'gmail', to: 'new@else.example' }, deps(['mine'])),
    (e) => e.status === 403 && /mailbox/i.test(e.message));
});

test("the mailbox owner can change the recipients", async () => {
  const out = await stepWithTarget(step('mine'), { kind: 'gmail', to: 'new@else.example' }, deps(['mine']));
  assert.equal(out.config.to, 'new@else.example');
});

test("keeping the same recipients on someone else's mailbox is allowed (nothing changes who it reaches)", async () => {
  const out = await stepWithTarget(step('theirs'), { kind: 'gmail', to: 'dana@acme.example' }, deps(['mine']));
  assert.equal(out.config.to, 'dana@acme.example');
});

test("moving the step to your own mailbox and changing recipients is allowed", async () => {
  const out = await stepWithTarget(step('theirs'), { kind: 'gmail', to: 'new@else.example', mailbox_id: 'mine' }, deps(['mine']));
  assert.equal(out.config.send_from.id, 'mine');
  assert.equal(out.config.to, 'new@else.example');
});
