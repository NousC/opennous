// One-off cutover migration: move existing Supabase Auth users into Clerk and
// link them to their app account by backfilling public.users.clerk_user_id.
//
// The app keeps its own users.id (uuid) as the app-wide foreign key, so this
// script does NOT touch any app data — it only (1) creates a Clerk user per
// existing person and (2) writes that Clerk id onto the matching public.users
// row, matched by email. After this runs, verifyClerkAuth resolves every
// returning user on the fast path.
//
// SAFE BY DEFAULT: dry-run. Pass --apply to actually create Clerk users and
// write clerk_user_id. Idempotent — rerunning skips users that already have a
// clerk_user_id and reuses any Clerk account that already exists for an email.
//
// PASSWORDS: the Supabase JS admin API does not expose password hashes, so to
// preserve email+password logins you must export the bcrypt hashes yourself and
// pass them in with --hashes=<file>. In the Supabase SQL editor run:
//     SELECT id, email, encrypted_password FROM auth.users;
// and save the result as JSON (array of {email, encrypted_password}). Users
// without a hash (Google-only, or when no file is given) are created
// passwordless: they sign back in with Google (Clerk links by verified email)
// or via Clerk's "forgot password" set-password flow.
//
// Usage (worker container), dry-run first:
//   docker compose exec -T worker node apps/worker/src/migrateUsersToClerk.mjs [--hashes=/path/hashes.json]
//   docker compose exec -T worker node apps/worker/src/migrateUsersToClerk.mjs --apply --hashes=/path/hashes.json
//
// Requires CLERK_SECRET_KEY + SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in env.

import './bootEnv.mjs';
import { readFileSync } from 'node:fs';
import { getSupabaseClient } from '@nous/core';
import { createClerkClient } from '@clerk/backend';

const APPLY = process.argv.includes('--apply');
const hashesArg = process.argv.find(a => a.startsWith('--hashes='));
const HASHES_PATH = hashesArg ? hashesArg.slice('--hashes='.length) : null;

const secretKey = process.env.CLERK_SECRET_KEY;
if (!secretKey) {
  console.error('CLERK_SECRET_KEY is required.');
  process.exit(1);
}
const clerk = createClerkClient({ secretKey });
const supabase = getSupabaseClient();

// email (lowercased) -> bcrypt digest, from the operator-provided export.
function loadHashes() {
  if (!HASHES_PATH) return new Map();
  const rows = JSON.parse(readFileSync(HASHES_PATH, 'utf8'));
  const map = new Map();
  for (const r of rows) {
    const email = (r.email || '').trim().toLowerCase();
    const hash = r.encrypted_password || r.password_hash || null;
    // Supabase stores bcrypt ($2a/$2b). Skip empty/oauth-only rows.
    if (email && hash && hash.startsWith('$2')) map.set(email, hash);
  }
  return map;
}

// Page through every Supabase auth user.
async function listAllAuthUsers() {
  const all = [];
  let page = 1;
  for (;;) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw new Error(`listUsers failed: ${error.message}`);
    const users = data?.users ?? [];
    all.push(...users);
    if (users.length < 1000) break;
    page += 1;
  }
  return all;
}

async function findClerkUserByEmail(email) {
  const res = await clerk.users.getUserList({ emailAddress: [email], limit: 1 });
  const list = Array.isArray(res) ? res : res?.data ?? [];
  return list[0] || null;
}

async function run() {
  const hashes = loadHashes();
  console.log(`[migrate] mode=${APPLY ? 'APPLY' : 'DRY-RUN'} hashes=${hashes.size}`);

  const authUsers = await listAllAuthUsers();
  console.log(`[migrate] ${authUsers.length} Supabase auth users found`);

  const summary = { skipped_no_app_user: 0, already_linked: 0, created: 0, reused_existing: 0, backfilled: 0, errors: 0 };

  for (const au of authUsers) {
    const email = (au.email || '').trim().toLowerCase();
    if (!email) { summary.skipped_no_app_user++; continue; }

    // Only migrate people who actually have an app account.
    const { data: appUser } = await supabase
      .from('users')
      .select('id, email, name, clerk_user_id')
      .ilike('email', email)
      .maybeSingle();

    if (!appUser) { summary.skipped_no_app_user++; continue; }
    if (appUser.clerk_user_id) { summary.already_linked++; continue; }

    const hasGoogle = (au.identities || au.app_metadata?.providers || [])
      .some(i => (i.provider || i) === 'google');
    const digest = hashes.get(email) || null;
    const plan = digest ? 'password' : (hasGoogle ? 'google/passwordless' : 'passwordless');

    if (!APPLY) {
      console.log(`  would migrate ${email} (${plan}) -> users.id ${appUser.id}`);
      summary.created++;
      continue;
    }

    try {
      // Reuse an existing Clerk account for this email if one is already there.
      let clerkUser = await findClerkUserByEmail(email);
      if (clerkUser) {
        summary.reused_existing++;
      } else {
        clerkUser = await clerk.users.createUser({
          emailAddress: [email],
          externalId: appUser.id,
          ...(appUser.name ? { firstName: appUser.name } : {}),
          ...(digest
            ? { passwordDigest: digest, passwordHasher: 'bcrypt' }
            : { skipPasswordRequirement: true }),
          skipPasswordChecks: true,
        });
        summary.created++;
      }

      const { error: updErr } = await supabase
        .from('users')
        .update({ clerk_user_id: clerkUser.id })
        .eq('id', appUser.id);
      if (updErr) throw new Error(`backfill failed: ${updErr.message}`);
      summary.backfilled++;
      console.log(`  migrated ${email} (${plan}) -> clerk ${clerkUser.id}`);
    } catch (e) {
      summary.errors++;
      console.error(`  ERROR ${email}: ${e?.message || e}`);
    }
  }

  console.log('[migrate] summary:', JSON.stringify(summary));
  if (!APPLY) console.log('[migrate] dry-run only — rerun with --apply to execute.');
}

run().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
