// Self-host (Supabase Auth) with autoconfirm: email_confirmed_at is stamped for any
// address typed at sign-up, so it proves nothing. Nothing addressed to an email
// (a team invitation, a pending seat, an imported users row) may be handed over on
// the strength of the email alone. Cloud (Clerk) keeps its old behaviour.
// No network and no database: env patches and a recording fake client.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  emailConfirmedWithoutRoundTrip,
  canClaimByEmailMatch,
  canBindEmailIdentity,
  canJoinByInvitedEmail,
} from '../src/lib/authProvider/index.mjs';
import { claimPendingSeat } from '../src/lib/pendingSeats.mjs';
import { HAS_CLOUD } from '../src/lib/cloud.mjs';

const USER_ID = '6f1c1d2e-3b4a-4c5d-8e9f-0a1b2c3d4e5f';

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

const SUPABASE_AUTOCONFIRM = { AUTH_PROVIDER: 'supabase', AUTH_EMAIL_AUTOCONFIRM: 'true' };

// ── The flag ────────────────────────────────────────────────────────────────

test('autoconfirm flag: only on the supabase provider with AUTH_EMAIL_AUTOCONFIRM=true', () => {
  assert.equal(emailConfirmedWithoutRoundTrip({ AUTH_PROVIDER: 'supabase', AUTH_EMAIL_AUTOCONFIRM: 'true' }), true);
  assert.equal(emailConfirmedWithoutRoundTrip({ SELF_HOSTED: 'true', AUTH_EMAIL_AUTOCONFIRM: 'TRUE' }), true);
  assert.equal(emailConfirmedWithoutRoundTrip({ AUTH_PROVIDER: 'supabase', AUTH_EMAIL_AUTOCONFIRM: 'false' }), false);
  assert.equal(emailConfirmedWithoutRoundTrip({ AUTH_PROVIDER: 'supabase' }), false);
});

test('autoconfirm flag: never on clerk, even if the variable leaks into a Cloud env', () => {
  assert.equal(emailConfirmedWithoutRoundTrip({ AUTH_PROVIDER: 'clerk', AUTH_EMAIL_AUTOCONFIRM: 'true' }), false);
  // With no AUTH_PROVIDER the deployment default decides: clerk on Cloud, supabase on an
  // open-source build (GET-754), where the flag does apply.
  assert.equal(emailConfirmedWithoutRoundTrip({ AUTH_EMAIL_AUTOCONFIRM: 'true' }), !HAS_CLOUD);
});

// ── Email-match claims ──────────────────────────────────────────────────────

test('email-match claim: clerk always allowed (Cloud unchanged)', async () => {
  await withEnv({ AUTH_PROVIDER: 'clerk', AUTH_EMAIL_AUTOCONFIRM: 'true' }, async () => {
    assert.equal(await canClaimByEmailMatch('user_2abc', 'x@y.example'), true);
  });
});

test('email-match claim: supabase with autoconfirm refuses, no lookup needed', async () => {
  await withEnv(SUPABASE_AUTOCONFIRM, async () => {
    assert.equal(await canClaimByEmailMatch(USER_ID, 'x@y.example'), false);
  });
});

test('email-match claim: supabase without autoconfirm still needs an identity', async () => {
  await withEnv({ AUTH_PROVIDER: 'supabase', AUTH_EMAIL_AUTOCONFIRM: 'false' }, async () => {
    assert.equal(await canClaimByEmailMatch(null, 'x@y.example'), false);
    assert.equal(await canClaimByEmailMatch(USER_ID, null), false);
  });
});

test('token accept: canJoinByInvitedEmail is unchanged on clerk', async () => {
  await withEnv({ AUTH_PROVIDER: 'clerk', AUTH_EMAIL_AUTOCONFIRM: 'true' }, async () => {
    assert.equal(await canJoinByInvitedEmail('user_2abc', 'x@y.example'), true);
  });
});

test('email bind onto an existing users row: refused under autoconfirm', async () => {
  await withEnv(SUPABASE_AUTOCONFIRM, async () => {
    assert.equal(await canBindEmailIdentity(USER_ID, 'x@y.example'), false);
  });
});

// ── Pending seats ───────────────────────────────────────────────────────────

function fakeSeatClient(seat) {
  const writes = [];
  const make = (table) => {
    const b = {
      select() { return b; },
      ilike() { return b; },
      is() { return b; },
      eq() { return b; },
      async maybeSingle() { return { data: table === 'pending_seats' ? seat : null, error: null }; },
      update(patch) { writes.push(['update', table, patch]); return b; },
      insert(row) { writes.push(['insert', table, row]); return b; },
      then(resolve) { resolve({ data: null, error: null }); },
    };
    return b;
  };
  return { client: { from: make }, writes };
}

const SEAT = {
  id: 'seat-1', plan_id: 'custom', member_role: 'admin', job_roles: ['ambassador'],
  workspace_id: 'victim-ws', expires_at: null, person_name: null, company_name: null, company_site: null,
};

test('pending seat: refused when the email is not proven, nothing written', async () => {
  const { client, writes } = fakeSeatClient(SEAT);
  const applied = await claimPendingSeat(
    client,
    { email: 'x@y.example', userId: 'u1', teamId: 't1', workspaceId: 'ws1', authUserId: USER_ID },
    { canClaim: async () => false },
  );
  assert.equal(applied, null);
  assert.deepEqual(writes, []);
});

test('pending seat: supabase autoconfirm refuses by default', async () => {
  await withEnv(SUPABASE_AUTOCONFIRM, async () => {
    const { client, writes } = fakeSeatClient(SEAT);
    const applied = await claimPendingSeat(client, { email: 'x@y.example', userId: 'u1', teamId: 't1', workspaceId: 'ws1', authUserId: USER_ID });
    assert.equal(applied, null);
    assert.deepEqual(writes, []);
  });
});

test('pending seat: clerk still claims by email (Cloud unchanged)', async () => {
  await withEnv({ AUTH_PROVIDER: 'clerk' }, async () => {
    const { client, writes } = fakeSeatClient(SEAT);
    const applied = await claimPendingSeat(client, { email: 'x@y.example', userId: 'u1', teamId: 't1', workspaceId: 'ws1' });
    assert.equal(applied?.plan_id, 'custom');
    assert.equal(applied?.workspace_id, 'victim-ws');
    assert.ok(writes.some(([op, table]) => op === 'update' && table === 'pending_seats'));
  });
});

// ── The join command shown in Settings → Team ───────────────────────────────

test('join command: Cloud unchanged; self-host names its own API', async () => {
  const { joinCommand } = await import('../src/routes/api/teams.mjs');
  assert.equal(joinCommand('tj_abc', { selfHosted: false }), 'npx @opennous/cli join tj_abc');
  assert.equal(
    joinCommand('tj_abc', { selfHosted: true, apiBase: () => 'https://api.example.org' }),
    'npx @opennous/cli join tj_abc --url https://api.example.org',
  );
});
