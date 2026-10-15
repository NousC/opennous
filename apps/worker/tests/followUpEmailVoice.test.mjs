// GET-902: the after-call follow-up writes its email in the team's "Email voice" (the context file of
// the box that holds it), read once per workspace pass; without one it writes as it always did.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';

const builder = new URL('../src/cloud/workers/followUpBuilder.mjs', import.meta.url);
const { followUpEmailVoice } = existsSync(builder) ? await import(builder.href) : {};
const skip = !followUpEmailVoice && 'no Workspace layer in this checkout';

test('the follow-up reads the voice of the box that holds it', { skip }, async () => {
  const seen = [];
  const voices = async (_sb, ws) => { seen.push(ws); return new Map([['sales_follow_up', { text: 'More formal.', file_id: 'f', box_id: 'b' }], ['stale_deal', { text: 'Other.' }]]); };
  assert.equal(await followUpEmailVoice({}, 'ws', { voices }), 'More formal.');
  assert.deepEqual(seen, ['ws']);
});

test('no voice, or one that cannot be read: null, and the email reads as before', { skip }, async () => {
  assert.equal(await followUpEmailVoice({}, 'ws', { voices: async () => new Map() }), null);
  assert.equal(await followUpEmailVoice({}, 'ws', { voices: async () => { throw new Error('down'); } }), null);
});
