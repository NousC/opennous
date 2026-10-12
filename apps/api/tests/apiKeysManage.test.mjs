// Who may rotate or revoke an API key (GET-620 review): workspace owners/admins, the person the
// key acts as, and the person who minted it. Anyone else gets 403; the key list carries
// can_manage so the page hides the actions. Supabase is faked.
//
// Run: cd apps/api && node --test tests/apiKeysManage.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canManageKey, keyForChange, withCanManage } from '../src/routes/api/apiKeys.mjs';

const WS = '11111111-1111-4111-8111-111111111111';
const KEY_ID = '22222222-2222-4222-8222-222222222222';
const ME = 'user-me';

function fakeSupabase(answer) {
  const q = { filters: [] };
  const b = {
    q,
    from(t) { q.table = t; return b; },
    select(c) { q.select = c; return b; },
    eq(c, v) { q.filters.push(['eq', c, v]); return b; },
    is(c, v) { q.filters.push(['is', c, v]); return b; },
    maybeSingle() { return Promise.resolve(answer); },
  };
  return b;
}

const someoneElses = { id: KEY_ID, name: 'theirs', owner_user_id: 'u2', created_by_user_id: 'u2' };

test('canManageKey: admins any key, members only keys that act as them or that they minted', () => {
  assert.equal(canManageKey({ workspaceRole: 'owner', internalUserId: ME }, someoneElses), true);
  assert.equal(canManageKey({ workspaceRole: 'admin', internalUserId: ME }, someoneElses), true);
  assert.equal(canManageKey({ workspaceRole: 'member', internalUserId: ME }, someoneElses), false);
  assert.equal(canManageKey({ workspaceRole: 'member', internalUserId: ME }, { owner_user_id: ME, created_by_user_id: 'u2' }), true);
  assert.equal(canManageKey({ workspaceRole: 'member', internalUserId: ME }, { owner_user_id: null, created_by_user_id: ME }), true);
  // A shared workspace key minted by an admin: members can't touch it.
  assert.equal(canManageKey({ workspaceRole: 'member', internalUserId: ME }, { owner_user_id: null, created_by_user_id: 'u2' }), false);
});

test('keyForChange: a member changing someone else\'s key is 403', async () => {
  const sb = fakeSupabase({ data: someoneElses, error: null });
  const out = await keyForChange(sb, { workspaceId: WS, workspaceRole: 'member', internalUserId: ME }, KEY_ID);
  assert.deepEqual(out, { status: 403, error: 'forbidden' });
  assert.deepEqual(sb.q.filters, [['eq', 'id', KEY_ID], ['eq', 'workspace_id', WS], ['is', 'revoked_at', null]]);
  assert.match(sb.q.select, /created_by_user_id/);
});

test('keyForChange: own key and admin pass; a missing key is 404; a read error throws', async () => {
  const mine = { ...someoneElses, owner_user_id: ME };
  assert.deepEqual(await keyForChange(fakeSupabase({ data: mine, error: null }), { workspaceId: WS, workspaceRole: 'member', internalUserId: ME }, KEY_ID), { key: mine });
  assert.deepEqual(await keyForChange(fakeSupabase({ data: someoneElses, error: null }), { workspaceId: WS, workspaceRole: 'admin', internalUserId: ME }, KEY_ID), { key: someoneElses });
  assert.deepEqual(await keyForChange(fakeSupabase({ data: null, error: null }), { workspaceId: WS, workspaceRole: 'owner' }, KEY_ID), { status: 404, error: 'not_found' });
  await assert.rejects(keyForChange(fakeSupabase({ data: null, error: { message: 'boom' } }), { workspaceId: WS, workspaceRole: 'owner' }, KEY_ID));
});

test('withCanManage marks each list row for the viewer', () => {
  const rows = [someoneElses, { id: 'k2', owner_user_id: ME, created_by_user_id: ME }];
  assert.deepEqual(withCanManage({ workspaceRole: 'member', internalUserId: ME }, rows).map((r) => r.can_manage), [false, true]);
  assert.deepEqual(withCanManage({ workspaceRole: 'owner', internalUserId: ME }, rows).map((r) => r.can_manage), [true, true]);
  assert.deepEqual(withCanManage({}, null), []);
});
