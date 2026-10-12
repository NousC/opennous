// Signing-secret rotation is admin-only (GET-620 review). A member's PATCH with rotate_secret is
// refused before anything is written. Run: cd apps/api && node --test tests/triggerSecretRoutes.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { triggersRouter, canRotateSecret } from '../src/routes/api/triggers.mjs';

const patchHandler = triggersRouter.stack
  .find((l) => l.route?.path === '/:id' && l.route.methods.patch).route.stack[0].handle;

function fakeRes() {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

test('only admin-scoped viewers may rotate a signing secret', () => {
  assert.equal(canRotateSecret({ viewerScope: 'admin' }), true);
  assert.equal(canRotateSecret({ viewerScope: 'member' }), false);
  assert.equal(canRotateSecret({}), false);
});

test('a member\'s rotate is a 403 and touches nothing', async () => {
  const res = fakeRes();
  await patchHandler({ workspaceId: 'ws', viewerScope: 'member', params: { id: 't1' }, body: { rotate_secret: true } }, res);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error, 'admin_required');
});
