// Clients ask before a write only if the tool says it writes, and a read-only grant shouldn't be
// offered tools the API will refuse (GET-1061).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TOOL_HINTS, WRITE_ONLY_TOOLS, toolHints, keyIsReadOnly, keyProfile, OPERATOR_TOOLS, wantsToolList } from '../src/toolHints.js';

test('an unknown tool is assumed to write', () => {
  assert.deepEqual(toolHints('something_new'), { readOnlyHint: false });
});

test('reads say so, and writes never claim to be reads', () => {
  assert.equal(toolHints('get_context').readOnlyHint, true);
  for (const name of WRITE_ONLY_TOOLS) assert.equal(TOOL_HINTS[name].readOnlyHint, false, name);
});

test('tools that overwrite team state are marked destructive', () => {
  assert.equal(toolHints('set_icp').destructiveHint, true);
  assert.equal(toolHints('add_note').destructiveHint, false);
});

test('a key is read-only only when whoami says so, and a failed check hides nothing', async () => {
  assert.equal(await keyIsReadOnly(async () => ({ you: { capability: 'read_only' } })), true);
  assert.equal(await keyIsReadOnly(async () => ({ you: { capability: 'read_write' } })), false);
  assert.equal(await keyIsReadOnly(async () => { throw new Error('down'); }), false);
});

test('a slow check hides nothing and holds nothing up', async () => {
  const never = () => new Promise(() => {});
  assert.equal(await keyIsReadOnly(never, { timeoutMs: 5 }), false);
});

test('score writes, so it is not marked a read', () => {
  assert.equal(toolHints('score').readOnlyHint, false);
});

test('only a tools/list request needs the check', () => {
  assert.equal(wantsToolList({ method: 'tools/list' }), true);
  assert.equal(wantsToolList([{ method: 'initialize' }, { method: 'tools/list' }]), true);
  assert.equal(wantsToolList({ method: 'tools/call' }), false);
  assert.equal(wantsToolList(undefined), false);
});

test('a member key is told apart from an admin one, and a failed check hides nothing (GET-1121)', async () => {
  assert.deepEqual(await keyProfile(async () => ({ you: { scope: 'member', capability: 'read_write' } })), { readOnly: false, member: true });
  assert.deepEqual(await keyProfile(async () => ({ you: { scope: 'admin', capability: 'read_only' } })), { readOnly: true, member: false });
  assert.deepEqual(await keyProfile(async () => { throw new Error('down'); }), { readOnly: false, member: false });
  assert.ok(OPERATOR_TOOLS.has('set_icp') && !OPERATOR_TOOLS.has('get_context') && !OPERATOR_TOOLS.has('documents'));
});
