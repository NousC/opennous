// Webhook signing secrets are write-once to the client (GET-620 review): GET /api/triggers is
// readable by every workspace member, so list/get never select signing_secret. The secret comes
// back only from create and from a rotate.
//
// Run: pnpm --filter @nous/core build && node --test packages/core/test/triggerSecret.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  listTriggers, getTrigger, createTrigger, updateTrigger, TRIGGER_SUB_COLUMNS,
} from '../dist/db/triggers.js';

const WS = 'ws-1';
const ROW = { id: 't1', workspace_id: WS, name: 'n', url: 'https://hook.example/in', events: ['interaction.email_received'], active: true };

function fakeSupabase() {
  const selects = [];
  const writes = [];
  const b = {
    from() { return b; },
    select(c) { selects.push(c); return b; },
    insert(r) { writes.push(r); return b; },
    update(r) { writes.push(r); return b; },
    eq() { return b; },
    order() { return Promise.resolve({ data: [ROW], error: null }); },
    single() { return Promise.resolve({ data: ROW, error: null }); },
    maybeSingle() { return Promise.resolve({ data: ROW, error: null }); },
  };
  return { sb: b, selects, writes };
}

test('the trigger columns read back never include the signing secret', () => {
  assert.doesNotMatch(TRIGGER_SUB_COLUMNS, /signing_secret/);
});

test('list and get select no secret', async () => {
  const { sb, selects } = fakeSupabase();
  const list = await listTriggers(sb, WS);
  const one = await getTrigger(sb, WS, 't1');
  assert.equal(list.length, 1);
  assert.equal(one.id, 't1');
  assert.ok(selects.every((c) => !/signing_secret/.test(c)), selects.join(' | '));
});

test('create and rotate hand the new secret back once, beside the row', async () => {
  const { sb, writes } = fakeSupabase();
  const created = await createTrigger(sb, WS, { name: 'n', url: 'https://hook.example/in', events: ['interaction.email_received'] });
  assert.match(created.secret, /^whsec_/);
  assert.equal(writes[0].signing_secret, created.secret);
  assert.equal('signing_secret' in created.subscription, false);

  const rotated = await updateTrigger(sb, WS, 't1', { rotate_secret: true });
  assert.match(rotated.secret, /^whsec_/);
  assert.notEqual(rotated.secret, created.secret);
  const plain = await updateTrigger(sb, WS, 't1', { active: false });
  assert.equal(plain.secret, undefined);
});
