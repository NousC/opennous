// The self-host owner claim (setup token, one atomic row), the public auth config that
// mirrors it, and what counts as a proven email on Supabase Auth.
// Cloud (Clerk, DISABLE_SIGNUPS unset) must get exactly what it got before.
// No network and no database: fake clients that mimic PostgREST's answers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertMayCreateOwnTeam,
  setupTokenMatches,
  configuredSetupToken,
  ownerExists,
} from '../src/lib/instanceOwner.mjs';
import { buildAuthConfig } from '../src/lib/authConfig.mjs';
import { emailProvenByRoundTrip } from '../src/lib/authProvider/supabase.mjs';

const TOKEN = 'st_0123456789abcdef0123456789abcdef';
const SELFHOST = { DISABLE_SIGNUPS: 'true', SELFHOST_SETUP_TOKEN: TOKEN, AUTH_PROVIDER: 'supabase' };

// A tiny stand-in for the two tables involved. `selfhost_instance_owner` has a unique
// primary key, so a second insert fails with 23505 like Postgres would.
function fakeDb({ users = 0, claim = null, claimError = null } = {}) {
  const state = { users, claim, inserts: [] };
  const from = (table) => {
    const q = {
      select(_cols, opts) { q.head = opts?.head; return q; },
      eq() { return q; },
      async maybeSingle() {
        if (claimError) return { data: null, error: claimError };
        return { data: table === 'selfhost_instance_owner' ? state.claim : null, error: null };
      },
      async insert(row) {
        state.inserts.push([table, row]);
        // Let a concurrent caller run between the check and the insert.
        await new Promise((r) => setImmediate(r));
        if (table === 'selfhost_instance_owner') {
          if (state.claim) return { data: null, error: { code: '23505', message: 'duplicate key' } };
          state.claim = { auth_user_id: row.auth_user_id };
        }
        return { data: null, error: null };
      },
      then(resolve) {
        // users count (head: true)
        resolve({ count: state.users, data: null, error: null });
      },
    };
    return q;
  };
  return { client: { from }, state };
}

const refusedWith = (re) => (err) => err?.code === 'SIGNUPS_DISABLED' && re.test(err.message);

// ── The token ───────────────────────────────────────────────────────────────

test('setup token: exact match only, trimmed, never empty', () => {
  assert.equal(setupTokenMatches(TOKEN, TOKEN), true);
  assert.equal(setupTokenMatches(` ${TOKEN}\n`, TOKEN), true);
  assert.equal(setupTokenMatches(TOKEN.slice(0, -1), TOKEN), false);
  assert.equal(setupTokenMatches('', TOKEN), false);
  assert.equal(setupTokenMatches(null, TOKEN), false);
  assert.equal(setupTokenMatches(TOKEN, null), false);
  assert.equal(configuredSetupToken({}), null);
  assert.equal(configuredSetupToken({ SELFHOST_SETUP_TOKEN: '  ' }), null);
});

// ── The claim ───────────────────────────────────────────────────────────────

test('owner claim: refused without the token, even on an empty instance, nothing written', async () => {
  const { client, state } = fakeDb();
  await assert.rejects(
    assertMayCreateOwnTeam(client, 'auth-a', { env: SELFHOST, readPresentedToken: async () => null }),
    refusedWith(/setup link/),
  );
  await assert.rejects(
    assertMayCreateOwnTeam(client, 'auth-a', { env: SELFHOST, readPresentedToken: async () => 'st_wrong' }),
    refusedWith(/setup link/),
  );
  assert.deepEqual(state.inserts, []);
});

test('owner claim: the right token claims the single row', async () => {
  const { client, state } = fakeDb();
  let cleared = 0;
  await assertMayCreateOwnTeam(client, 'auth-a', {
    env: SELFHOST, readPresentedToken: async () => TOKEN, afterClaim: async () => { cleared++; },
  });
  assert.deepEqual(state.claim, { auth_user_id: 'auth-a' });
  assert.equal(cleared, 1);
});

test('owner claim: two first sign-ups at once, both with the token: exactly one wins', async () => {
  const { client, state } = fakeDb();
  const results = await Promise.allSettled([
    assertMayCreateOwnTeam(client, 'auth-a', { env: SELFHOST, readPresentedToken: async () => TOKEN }),
    assertMayCreateOwnTeam(client, 'auth-b', { env: SELFHOST, readPresentedToken: async () => TOKEN }),
  ]);
  const won = results.filter((r) => r.status === 'fulfilled').length;
  assert.equal(won, 1);
  const lost = results.find((r) => r.status === 'rejected');
  assert.equal(lost.reason.code, 'SIGNUPS_DISABLED');
  assert.equal(state.inserts.filter(([t]) => t === 'selfhost_instance_owner').length, 2);
  assert.ok(['auth-a', 'auth-b'].includes(state.claim.auth_user_id));
});

test('owner claim: once claimed, the owner retries fine and everyone else is refused, token or not', async () => {
  const { client, state } = fakeDb({ claim: { auth_user_id: 'auth-a' }, users: 1 });
  await assertMayCreateOwnTeam(client, 'auth-a', { env: SELFHOST });
  await assert.rejects(
    assertMayCreateOwnTeam(client, 'auth-b', { env: SELFHOST, readPresentedToken: async () => TOKEN }),
    refusedWith(/disabled/),
  );
  assert.deepEqual(state.inserts, []);
});

test('owner claim: a lookup error fails closed', async () => {
  const { client } = fakeDb({ claimError: { message: 'relation does not exist' } });
  await assert.rejects(
    assertMayCreateOwnTeam(client, 'auth-a', { env: SELFHOST, readPresentedToken: async () => TOKEN }),
    /owner claim lookup failed/,
  );
});

test('no setup token configured (external Supabase install): the old first-user rule', async () => {
  const env = { DISABLE_SIGNUPS: 'true', AUTH_PROVIDER: 'supabase' };
  await assertMayCreateOwnTeam(fakeDb({ users: 0 }).client, 'auth-a', { env });
  await assert.rejects(assertMayCreateOwnTeam(fakeDb({ users: 1 }).client, 'auth-b', { env }), refusedWith(/disabled/));
});

// ── /api/auth/config ────────────────────────────────────────────────────────

test('auth config: Cloud (Clerk, nothing set) is exactly what main returns, and never touches the db', async () => {
  let touched = false;
  const getClient = () => { touched = true; throw new Error('no db on this path'); };
  const cfg = await buildAuthConfig({ env: { AUTH_PROVIDER: 'clerk' }, getClient });
  assert.deepEqual(cfg, { signupsDisabled: false, googleEnabled: false, authProvider: 'clerk' });
  const withGoogle = await buildAuthConfig({ env: { GOOGLE_CLIENT_ID: 'x' }, getClient });
  assert.deepEqual(Object.keys(withGoogle), ['signupsDisabled', 'googleEnabled', 'authProvider']);
  assert.equal(withGoogle.googleEnabled, true);
  assert.equal(touched, false);
});

test('auth config: Cloud ignores a stray SELFHOST_SETUP_TOKEN when DISABLE_SIGNUPS is unset', async () => {
  const cfg = await buildAuthConfig({ env: { SELFHOST_SETUP_TOKEN: TOKEN }, getClient: () => fakeDb().client });
  assert.equal('setupRequired' in cfg, false);
  assert.equal(cfg.signupsDisabled, false);
});

test('auth config: external-Supabase self-host keeps the old answer (open until the first user)', async () => {
  const env = { DISABLE_SIGNUPS: 'true', AUTH_PROVIDER: 'supabase' };
  assert.deepEqual(await buildAuthConfig({ env, getClient: () => fakeDb({ users: 0 }).client }),
    { signupsDisabled: false, googleEnabled: false, authProvider: 'supabase' });
  assert.equal((await buildAuthConfig({ env, getClient: () => fakeDb({ users: 2 }).client })).signupsDisabled, true);
  // On error, don't lock the owner out.
  assert.equal((await buildAuthConfig({ env, getClient: () => { throw new Error('down'); } })).signupsDisabled, false);
});

test('auth config: bundled stack is closed from the start and says whether set-up is pending', async () => {
  const empty = await buildAuthConfig({ env: SELFHOST, getClient: () => fakeDb().client });
  assert.deepEqual(empty, { signupsDisabled: true, googleEnabled: false, authProvider: 'supabase', setupRequired: true });
  const claimed = await buildAuthConfig({ env: SELFHOST, getClient: () => fakeDb({ claim: { auth_user_id: 'a' } }).client });
  assert.equal(claimed.setupRequired, false);
  assert.equal(claimed.signupsDisabled, true);
  assert.equal(await ownerExists(fakeDb({ claimError: { message: 'x' } }).client, { env: SELFHOST, fallback: false }), false);
});

// ── Proven email (Supabase Auth) ────────────────────────────────────────────

const at = (iso) => new Date(iso).toISOString();
const base = { email: 'ceo@corp.example', app_metadata: { provider: 'email' }, identities: [{ provider: 'email', identity_data: { email: 'ceo@corp.example', email_verified: false } }] };

test('proven email: an autoconfirmed sign-up is not proof, even after autoconfirm is turned off', () => {
  // What GoTrue stores for GOTRUE_MAILER_AUTOCONFIRM=true: confirmed, nothing ever sent.
  const squatter = { ...base, email_confirmed_at: at('2026-10-01T10:00:00Z'), confirmation_sent_at: null, invited_at: null };
  assert.equal(emailProvenByRoundTrip(squatter, 'ceo@corp.example'), false);
  // A confirmation email sent AFTER that stamp (e.g. a resend) proves nothing about it.
  assert.equal(emailProvenByRoundTrip({ ...squatter, confirmation_sent_at: at('2026-10-05T10:00:00Z') }, 'ceo@corp.example'), false);
});

test('proven email: a confirmation (or invite) email that was sent and then followed is proof', () => {
  const real = { ...base, confirmation_sent_at: at('2026-10-05T10:00:00Z'), email_confirmed_at: at('2026-10-05T10:03:00Z') };
  assert.equal(emailProvenByRoundTrip(real, 'CEO@corp.example'), true);
  assert.equal(emailProvenByRoundTrip(real, 'other@corp.example'), false);
  assert.equal(emailProvenByRoundTrip({ ...real, email_confirmed_at: null }, 'ceo@corp.example'), false);
  const invited = { ...base, invited_at: at('2026-10-05T10:00:00Z'), email_confirmed_at: at('2026-10-05T11:00:00Z') };
  assert.equal(emailProvenByRoundTrip(invited, 'ceo@corp.example'), true);
});

test('proven email: a verified OAuth identity, or an operator-vouched account, is proof', () => {
  const google = {
    ...base, email_confirmed_at: at('2026-10-05T10:00:00Z'),
    identities: [{ provider: 'google', identity_data: { email: 'ceo@corp.example', email_verified: true } }],
  };
  assert.equal(emailProvenByRoundTrip(google, 'ceo@corp.example'), true);
  const unverifiedGoogle = { ...google, identities: [{ provider: 'google', identity_data: { email: 'ceo@corp.example', email_verified: false } }] };
  assert.equal(emailProvenByRoundTrip(unverifiedGoogle, 'ceo@corp.example'), false);
  const vouched = { ...base, email_confirmed_at: at('2026-10-05T10:00:00Z'), app_metadata: { nous_email_vouched: true } };
  assert.equal(emailProvenByRoundTrip(vouched, 'ceo@corp.example'), true);
  // user_metadata is the user's own to write: it is never read for this.
  const selfClaimed = { ...base, email_confirmed_at: at('2026-10-05T10:00:00Z'), user_metadata: { nous_email_vouched: true } };
  assert.equal(emailProvenByRoundTrip(selfClaimed, 'ceo@corp.example'), false);
});
