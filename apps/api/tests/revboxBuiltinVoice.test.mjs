// GET-902: a box holding an email-drafting built-in gets its "Email voice" context file on its read,
// once, and names it so the rail keeps it; a box without one is never touched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withBoxEmailVoice } from '../src/routes/api/revboxes.mjs';

const detail = (builtin_jobs, context = []) => ({ box: { id: 'b1', owner_id: 'u1', builtin_jobs }, context, jobs: [], people: [] });

test('a box with a built-in and no voice file gets one, and the read carries it', async () => {
  const calls = [];
  const ensure = async (_sb, ws, box) => { calls.push([ws, box.id]); return { id: 'f1', body: 'seed', created: true }; };
  const out = await withBoxEmailVoice({}, 'ws', detail(['sales_follow_up']), { ensure, reread: async () => [{ id: 'f1', title: 'Email voice', kind: 'instructions', body: 'seed' }] });
  assert.deepEqual(calls, [['ws', 'b1']]);
  assert.equal(out.email_voice_id, 'f1');
  assert.equal(out.context[0].id, 'f1');
});

test('a box that has it is not written to; a box without a built-in has none; a failure never fails the read', async () => {
  const ensure = async () => { throw new Error('should not be called'); };
  const had = await withBoxEmailVoice({}, 'ws', detail(['stale_deal'], [{ id: 'f9', title: 'Email Voice', kind: 'instructions' }]), { ensure });
  assert.equal(had.email_voice_id, 'f9');
  const plain = await withBoxEmailVoice({}, 'ws', detail([], [{ id: 'f9', title: 'Email voice', kind: 'instructions' }]), { ensure });
  assert.equal(plain.email_voice_id, null);
  const failed = await withBoxEmailVoice({}, 'ws', detail(['expansion']), { ensure });
  assert.equal(failed.email_voice_id, null);
  assert.deepEqual(failed.context, []);
});
