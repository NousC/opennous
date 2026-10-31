// An approval needs a person, and not the key that started the run (GET-1062).
//
// Run: cd apps/api && node --test tests/approvalGuard.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { refuseApproval, decidedBy, stampRunStarter } from '../src/lib/approvalGuard.mjs';

const client = (row) => {
  const rows = { ...row };
  const b = {
    select() { return b; }, eq() { return b; },
    update(v) { Object.assign(rows, v); return b; },
    maybeSingle() { return Promise.resolve({ data: rows, error: null }); },
    then(ok) { return Promise.resolve({ data: null, error: null }).then(ok); },
  };
  return {
    rows,
    from(table) {
      if (table !== 'api_keys') return b;
      const k = { select() { return k; }, eq() { return k; }, maybeSingle: () => Promise.resolve({ data: { owner_user_id: row?.starter_owner ?? null } }) };
      return k;
    },
  };
};

function run(req, row) {
  const out = {};
  const res = { status(c) { out.status = c; return this; }, json(b) { out.body = b; return this; } };
  return refuseApproval(client(row), { workspaceId: 'w', ...req }, res, 'r').then((answered) => ({ answered, ...out }));
}

test('a person in the app approves', async () => {
  assert.equal((await run({ internalUserId: 'rep' }, {})).answered, false);
});

test('a member key approves a run it did not start', async () => {
  const out = await run({ isApiKeyAuth: true, apiKeyId: 'k1', memberUserId: 'rep' }, { started_by_key: 'k2', starter_owner: 'lead' });
  assert.equal(out.answered, false);
  assert.equal((await run({ isApiKeyAuth: true, apiKeyId: 'k1', memberUserId: 'rep' }, {})).answered, false);
});

test('a key cannot approve the run it started', async () => {
  const out = await run({ isApiKeyAuth: true, apiKeyId: 'k1', memberUserId: 'rep' }, { started_by_key: 'k1' });
  assert.equal(out.status, 403);
  assert.equal(out.body.error, 'cannot_approve_own_run');
});

test('a person\'s rotated key or other connector counts as the same starter', async () => {
  const out = await run({ isApiKeyAuth: true, apiKeyId: 'k2', memberUserId: 'rep' }, { started_by_key: 'k1', starter_owner: 'rep' });
  assert.equal(out.body.error, 'cannot_approve_own_run');
  const other = await run({ isApiKeyAuth: true, apiKeyId: 'k2', memberUserId: 'lead' }, { started_by_key: 'k1', starter_owner: 'rep' });
  assert.equal(other.answered, false);
});

test('a workspace key cannot approve at all', async () => {
  const out = await run({ isApiKeyAuth: true, apiKeyId: 'k1', noContent: true, memberUserId: null }, {});
  assert.equal(out.status, 403);
  assert.equal(out.body.error, 'approver_must_be_person');
});

test('the log names the person, for a key and for a session', () => {
  assert.equal(decidedBy({ memberUserId: 'rep' }), 'rep');
  assert.equal(decidedBy({ internalUserId: 'founder' }), 'founder');
  assert.equal(decidedBy({ noContent: true, memberUserId: 'nobody' }), null);
});

test('a run started with a key remembers it, and one started in the app does not', async () => {
  const sb = client({});
  await stampRunStarter(sb, { internalUserId: 'rep' }, 'r');
  assert.equal(sb.rows.started_by_key, undefined);
  await stampRunStarter(sb, { apiKeyId: 'k1' }, 'r');
  assert.equal(sb.rows.started_by_key, 'k1');
});
