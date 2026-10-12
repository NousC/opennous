// The auth-provider seam (GET-577): Cloud on Clerk, self-host on Supabase Auth.
// No network and no database: the Supabase token checks run against a local
// HS256 secret, and the user lookup runs against a recording fake client.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SignJWT } from 'jose';
import {
  resolveAuthProviderName,
  identityColumn,
  getAuthProvider,
  findUserByAuthId,
  canJoinByInvitedEmail,
} from '../src/lib/authProvider/index.mjs';
import { verifyTokenLocally } from '../src/lib/authProvider/supabase.mjs';
import { verifyAuth, verifySupabaseAuth, verifyClerkAuth } from '../src/middleware/supabaseAuth.mjs';
import { HAS_CLOUD } from '../src/lib/cloud.mjs';

// Clerk is Cloud's (GET-754): the deployment default is clerk only where the build has src/cloud/;
// an open-source build defaults to supabase whatever SELF_HOSTED says.
const DEPLOYMENT_DEFAULT = HAS_CLOUD ? 'clerk' : 'supabase';

const SECRET = 'super-secret-jwt-token-with-at-least-32-characters-long';
const ENV = { SUPABASE_JWT_SECRET: SECRET };
const USER_ID = '6f1c1d2e-3b4a-4c5d-8e9f-0a1b2c3d4e5f';

async function supabaseToken({ secret = SECRET, exp = '1h', claims = {} } = {}) {
  const jwt = new SignJWT({
    email: 'owner@example.com',
    role: 'authenticated',
    user_metadata: { full_name: 'Owner Person', email_verified: true },
    ...claims,
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(USER_ID)
    .setAudience('authenticated')
    .setIssuedAt()
    .setExpirationTime(exp); // a duration string, or an absolute epoch-seconds number
  return jwt.sign(new TextEncoder().encode(secret));
}

// Runs fn with process.env patched, restoring every touched key afterwards.
async function withEnv(patch, fn) {
  const saved = {};
  for (const k of Object.keys(patch)) {
    saved[k] = process.env[k];
    if (patch[k] === undefined) delete process.env[k];
    else process.env[k] = patch[k];
  }
  try {
    return await fn();
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

// ── Provider selection ──────────────────────────────────────────────────────

test('provider: Cloud (no SELF_HOSTED) defaults to clerk', () => {
  assert.equal(resolveAuthProviderName({}), DEPLOYMENT_DEFAULT);
  assert.equal(resolveAuthProviderName({ SELF_HOSTED: 'false' }), DEPLOYMENT_DEFAULT);
});

test('provider: self-host defaults to supabase', () => {
  assert.equal(resolveAuthProviderName({ SELF_HOSTED: 'true' }), 'supabase');
});

test('provider: AUTH_PROVIDER wins over the deployment default, case-insensitively', () => {
  assert.equal(resolveAuthProviderName({ AUTH_PROVIDER: 'supabase' }), 'supabase');
  assert.equal(resolveAuthProviderName({ AUTH_PROVIDER: 'Clerk', SELF_HOSTED: 'true' }), 'clerk');
  assert.equal(resolveAuthProviderName({ AUTH_PROVIDER: ' SUPABASE ' }), 'supabase');
});

test('provider: an unknown AUTH_PROVIDER falls back to the deployment default', () => {
  assert.equal(resolveAuthProviderName({ AUTH_PROVIDER: 'auth0' }), DEPLOYMENT_DEFAULT);
  assert.equal(resolveAuthProviderName({ AUTH_PROVIDER: 'auth0', SELF_HOSTED: 'true' }), 'supabase');
});

test('identity column: clerk keeps clerk_user_id, supabase uses supabase_user_id', () => {
  assert.equal(identityColumn('clerk'), 'clerk_user_id');
  assert.equal(identityColumn('supabase'), 'supabase_user_id');
});

test('both adapters implement the provider contract', async () => {
  // Without src/cloud/ there is no Clerk adapter, and asking for it says so.
  if (!HAS_CLOUD) await assert.rejects(getAuthProvider('clerk'), /Workspace \(Cloud\) layer/);
  for (const name of HAS_CLOUD ? ['clerk', 'supabase'] : ['supabase']) {
    const p = await getAuthProvider(name);
    assert.equal(p.name, name);
    assert.equal(p.identityColumn, identityColumn(name));
    for (const fn of ['verifyToken', 'getProfile', 'isEmailVerified', 'deleteUser', 'createSignInLink', 'findOrCreateUserByEmail']) {
      assert.equal(typeof p[fn], 'function', `${name}.${fn}`);
    }
  }
});

// ── Supabase token verification (local HS256) ───────────────────────────────

test('supabase verifyToken: a valid HS256 token resolves the identity', async () => {
  const v = await verifyTokenLocally(await supabaseToken(), ENV);
  assert.equal(v.authUserId, USER_ID);
  assert.equal(v.email, 'owner@example.com');
  assert.equal(v.name, 'Owner Person');
  assert.equal(v.emailVerified, true);
});

test('supabase verifyToken: email_verified absent means unknown, not false', async () => {
  const v = await verifyTokenLocally(await supabaseToken({ claims: { user_metadata: {} } }), ENV);
  assert.equal(v.emailVerified, null);
});

test('supabase verifyToken: an expired token is rejected', async () => {
  const past = Math.floor(Date.now() / 1000) - 3600;
  await assert.rejects(verifyTokenLocally(await supabaseToken({ exp: past }), ENV), /exp/i);
});

test('supabase verifyToken: a token signed with the wrong secret is rejected', async () => {
  const forged = await supabaseToken({ secret: 'not-the-project-secret-but-still-32-chars-long' });
  await assert.rejects(verifyTokenLocally(forged, ENV), /signature/i);
});

test('supabase verifyToken: the anon / service_role API keys never authenticate as a user', async () => {
  const anon = await supabaseToken({ claims: { role: 'anon' } });
  await assert.rejects(verifyTokenLocally(anon, ENV), /not a user token/);
  const service = await supabaseToken({ claims: { role: 'service_role' } });
  await assert.rejects(verifyTokenLocally(service, ENV), /not a user token/);
});

test('supabase verifyToken: anonymous sessions are rejected', async () => {
  const t = await supabaseToken({ claims: { is_anonymous: true } });
  await assert.rejects(verifyTokenLocally(t, ENV), /anonymous/);
});

test('supabase verifyToken: a token for another audience is rejected', async () => {
  const t = await new SignJWT({ role: 'authenticated' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(USER_ID)
    .setAudience('somebody-else')
    .setExpirationTime('1h')
    .sign(new TextEncoder().encode(SECRET));
  await assert.rejects(verifyTokenLocally(t, ENV), /aud/i);
});

test('supabase verifyToken: refuses to run without SUPABASE_JWT_SECRET', async () => {
  await assert.rejects(verifyTokenLocally(await supabaseToken(), {}), /SUPABASE_JWT_SECRET/);
});

test('supabase adapter verifyToken uses the local path when the secret is set', async () => {
  await withEnv({ SUPABASE_JWT_SECRET: SECRET }, async () => {
    const p = await getAuthProvider('supabase');
    const v = await p.verifyToken(await supabaseToken());
    assert.equal(v.authUserId, USER_ID);
    // getProfile needs no network when the token carries the email.
    assert.deepEqual(await p.getProfile(v), { email: 'owner@example.com', name: 'Owner Person', avatarUrl: null });
  });
});

// ── The users lookup ────────────────────────────────────────────────────────

function fakeSupabase(row) {
  const calls = [];
  const builder = {
    from(table) { calls.push(['from', table]); return builder; },
    select(cols) { calls.push(['select', cols]); return builder; },
    eq(col, val) { calls.push(['eq', col, val]); return builder; },
    async maybeSingle() { calls.push(['maybeSingle']); return { data: row, error: null }; },
  };
  return { client: builder, calls };
}

test('user lookup: supabase matches users.supabase_user_id', async () => {
  const { client, calls } = fakeSupabase({ id: 'internal-1', supabase_user_id: USER_ID });
  const { data, error } = await findUserByAuthId(client, USER_ID, 'id, supabase_user_id', 'supabase');
  assert.equal(error, null);
  assert.equal(data.id, 'internal-1');
  assert.deepEqual(calls, [
    ['from', 'users'],
    ['select', 'id, supabase_user_id'],
    ['eq', 'supabase_user_id', USER_ID],
    ['maybeSingle'],
  ]);
});

test('user lookup: clerk still matches users.clerk_user_id', async () => {
  const { client, calls } = fakeSupabase({ id: 'internal-2' });
  await findUserByAuthId(client, 'user_2abc', 'id', 'clerk');
  assert.deepEqual(calls.find((c) => c[0] === 'eq'), ['eq', 'clerk_user_id', 'user_2abc']);
});

test('user lookup: the provider follows the env when no name is passed', async () => {
  await withEnv({ AUTH_PROVIDER: undefined, SELF_HOSTED: 'true' }, async () => {
    const { client, calls } = fakeSupabase(null);
    await findUserByAuthId(client, USER_ID);
    assert.deepEqual(calls.find((c) => c[0] === 'eq'), ['eq', 'supabase_user_id', USER_ID]);
  });
});

test('user lookup: no auth id means no query', async () => {
  const { client, calls } = fakeSupabase({ id: 'x' });
  assert.deepEqual(await findUserByAuthId(client, null, 'id', 'supabase'), { data: null, error: null });
  assert.equal(calls.length, 0);
});

// ── Cloud is untouched ──────────────────────────────────────────────────────

test('invitation join by email: unchanged (always allowed) on clerk', async () => {
  await withEnv({ AUTH_PROVIDER: 'clerk' }, async () => {
    assert.equal(await canJoinByInvitedEmail('user_2abc', 'a@b.com'), true);
  });
});

test('invitation join by email: supabase fails closed without an identity', async () => {
  await withEnv({ AUTH_PROVIDER: 'supabase' }, async () => {
    assert.equal(await canJoinByInvitedEmail(null, 'a@b.com'), false);
    assert.equal(await canJoinByInvitedEmail(USER_ID, null), false);
  });
});

test('middleware: the three exported names are one function', () => {
  assert.equal(verifySupabaseAuth, verifyAuth);
  assert.equal(verifyClerkAuth, verifyAuth);
});

function mockRes() {
  return {
    statusCode: 200,
    body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

test('middleware: no bearer token → 401 auth_required', async () => {
  const res = mockRes();
  let nexted = false;
  await verifyAuth({ headers: {}, query: {}, body: {} }, res, () => { nexted = true; });
  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.body, { error: 'auth_required' });
  assert.equal(nexted, false);
});

test('middleware (supabase): a forged token → 401 invalid_token before any DB call', async () => {
  await withEnv({ AUTH_PROVIDER: 'supabase', SUPABASE_JWT_SECRET: SECRET }, async () => {
    const forged = await supabaseToken({ secret: 'not-the-project-secret-but-still-32-chars-long' });
    const res = mockRes();
    let nexted = false;
    await verifyAuth({ headers: { authorization: `Bearer ${forged}` }, query: {}, body: {} }, res, () => { nexted = true; });
    assert.equal(res.statusCode, 401);
    assert.deepEqual(res.body, { error: 'invalid_token' });
    assert.equal(nexted, false);
  });
});

test('middleware (supabase): an expired token → 401 invalid_token', async () => {
  await withEnv({ AUTH_PROVIDER: 'supabase', SUPABASE_JWT_SECRET: SECRET }, async () => {
    const expired = await supabaseToken({ exp: Math.floor(Date.now() / 1000) - 60 });
    const res = mockRes();
    await verifyAuth({ headers: { authorization: `Bearer ${expired}` }, query: {}, body: {} }, res, () => {});
    assert.equal(res.statusCode, 401);
    assert.deepEqual(res.body, { error: 'invalid_token' });
  });
});
