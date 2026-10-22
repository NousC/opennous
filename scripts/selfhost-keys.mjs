#!/usr/bin/env node
// Generate the secrets for the bundled self-host stack (docker-compose.selfhost.yaml)
// and write them into an env file (default: nous.env).
//
//   node scripts/selfhost-keys.mjs [env-file] [--force]
//
// Writes:
//   POSTGRES_PASSWORD          database password (postgres, GoTrue, PostgREST)
//   SUPABASE_JWT_SECRET        HS256 secret GoTrue signs sessions with; the API and
//                              PostgREST verify with it
//   SUPABASE_ANON_KEY          JWT {role: anon}, the browser's public key
//   VITE_SUPABASE_ANON_KEY     same value, for the frontend build
//   SUPABASE_SERVICE_ROLE_KEY  JWT {role: service_role}, server-side only
//   ENCRYPTION_KEY             32-byte hex, encrypts OAuth tokens at rest
//   WORKER_SECRET              shared secret for the api <-> worker internal calls (deal
//                              overview, account summary, automations, backfill kicks)
//   SELFHOST_SETUP_TOKEN       one-time secret for the first account: only a sign-up
//                              that presents it (https://$APP_DOMAIN/signup?setup=<token>)
//                              becomes the owner. Useless once the owner exists.
// and sets APP_COMMIT (this checkout's commit, when it is a git checkout),
// SUPABASE_URL (internal gateway), VITE_SUPABASE_URL (https://$APP_DOMAIN),
// SELF_HOSTED=true, AUTH_PROVIDER=supabase, VITE_AUTH_PROVIDER=supabase, and
// COMPOSE_FILE=docker-compose.yaml:docker-compose.selfhost.yaml with COMPOSE_PATH_SEPARATOR=:
// (so Windows reads it too), so the plain
// `docker compose --env-file nous.env ...` (and ./update.sh) runs the bundled stack.
//
// Safe defaults, written only when unset (an explicit value is kept):
//   DISABLE_SIGNUPS=true            the first account becomes the owner; after that
//                                   only invited people get in (the API enforces it)
//   GOTRUE_MAILER_AUTOCONFIRM       false when SMTP_HOST is set (addresses are confirmed
//                                   by email), true when not (no way to send one)
// GOTRUE_DISABLE_SIGNUP stays false on purpose: the owner and every invitee create
// their login at GoTrue. A GoTrue login alone gets nothing; the API gives it no
// account, workspace or model access unless it is the first user or holds an invite.
//
// The file is left mode 600. Values already set are kept, so re-running is safe.
// --force regenerates all secrets; do not do that on a running install (the database
// password is fixed at first boot, and every session and API key signed with the old
// secret stops working).
//
// Refuses to touch an env file that looks like a Nous Cloud / external-Supabase one
// (SUPABASE_URL on *.supabase.co, or any CLERK_* key set): nous.env is also the
// default name of that file. --force overrides this too.
// No dependencies: Node 18+ only.

import { createHmac, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, copyFileSync, chmodSync } from 'node:fs';

const args = process.argv.slice(2);
const force = args.includes('--force');
const file = args.find((a) => !a.startsWith('--')) || 'nous.env';

// The footgun guard, on the file as it is before anything is written.
if (existsSync(file) && !force) {
  const existing = readFileSync(file, 'utf8');
  const val = (key) => {
    const m = [...existing.matchAll(new RegExp(`^\\s*${key}\\s*=(.*)$`, 'gm'))].pop();
    return m ? m[1].trim().replace(/^["']|["']$/g, '') : '';
  };
  const reasons = [];
  const url = val('SUPABASE_URL');
  if (/^https?:\/\/[^/]*\.supabase\.co(\/|$)/i.test(url) && !url.includes('yourproject')) {
    reasons.push(`SUPABASE_URL is ${url}, an external Supabase project`);
  }
  const clerk = [...existing.matchAll(/^\s*((?:VITE_)?CLERK_[A-Z0-9_]*)\s*=\s*(\S.*)$/gm)]
    .filter((m) => !/^["']?["']?$/.test(m[2].trim()))
    .map((m) => m[1]);
  if (clerk.length) reasons.push(`Clerk keys are set (${[...new Set(clerk)].join(', ')})`);
  if (reasons.length) {
    console.error(`refusing to write ${file}: it looks like a Nous Cloud or external-Supabase env file.`);
    for (const r of reasons) console.error(`  - ${r}`);
    console.error('The bundled stack would replace SUPABASE_URL, the auth provider and every secret in it.');
    console.error('Use a separate file for the bundled stack, or pass --force if this really is the one');
    console.error('(--force also regenerates every secret).');
    process.exit(2);
  }
}

if (!existsSync(file)) {
  if (existsSync('nous.env.example')) {
    copyFileSync('nous.env.example', file);
    console.log(`created ${file} from nous.env.example`);
  } else {
    writeFileSync(file, '');
  }
}

// LF only: a nous.env saved by a Windows editor has CRLF, and Docker Compose would read every
// value with a trailing \r (a password that never matches, a domain Caddy cannot serve).
let text = readFileSync(file, 'utf8').replace(/\r\n?/g, '\n');

// Last assignment wins, as in docker compose.
function get(key) {
  const m = [...text.matchAll(new RegExp(`^${key}=(.*)$`, 'gm'))].pop();
  return m ? m[1].trim().replace(/^["']|["']$/g, '') : '';
}

// Placeholders from nous.env.example count as unset.
function isUnset(v) {
  return !v || v === 'eyJ...' || v.includes('yourproject') || v.includes('yourdomain');
}

function set(key, value) {
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, 'gm');
  if (re.test(text)) text = text.replace(re, line);
  else text += (text.endsWith('\n') || text === '' ? '' : '\n') + line + '\n';
}

const b64url = (buf) => Buffer.from(buf).toString('base64url');

function signJwt(payload, secret) {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));
  const sig = createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${sig}`;
}

const changed = [];
function ensure(key, make) {
  if (!force && !isUnset(get(key))) return get(key);
  const v = make();
  set(key, v);
  changed.push(key);
  return v;
}

ensure('POSTGRES_PASSWORD', () => randomBytes(24).toString('hex'));
const secretWasSet = !isUnset(get('SUPABASE_JWT_SECRET'));
const secret = ensure('SUPABASE_JWT_SECRET', () => randomBytes(32).toString('hex'));
// A new secret invalidates any existing keys, so re-sign them.
const resign = force || !secretWasSet;

const iat = Math.floor(Date.now() / 1000);
const exp = iat + 10 * 365 * 24 * 3600;
const mint = (role) => signJwt({ role, iss: 'supabase', iat, exp }, secret);

let anon = get('SUPABASE_ANON_KEY');
if (resign || isUnset(anon)) { anon = mint('anon'); set('SUPABASE_ANON_KEY', anon); changed.push('SUPABASE_ANON_KEY'); }
if (resign || get('VITE_SUPABASE_ANON_KEY') !== anon) { set('VITE_SUPABASE_ANON_KEY', anon); changed.push('VITE_SUPABASE_ANON_KEY'); }
if (resign || isUnset(get('SUPABASE_SERVICE_ROLE_KEY'))) {
  set('SUPABASE_SERVICE_ROLE_KEY', mint('service_role'));
  changed.push('SUPABASE_SERVICE_ROLE_KEY');
}

ensure('ENCRYPTION_KEY', () => randomBytes(32).toString('hex'));
// Without it every api <-> worker internal route stays off (they are dormant when unset).
ensure('WORKER_SECRET', () => randomBytes(32).toString('hex'));
const setupToken = ensure('SELFHOST_SETUP_TOKEN', () => `st_${randomBytes(24).toString('hex')}`);

// Wiring for the bundled stack. The compose file sets these too; writing them here
// keeps nous.env honest about what the app runs against. Each one that changes is named in
// the summary, like the secrets (GET-1011: the summary used to leave these out).
function wire(key, value) {
  if (get(key) === value) return;
  set(key, value);
  changed.push(key);
}
wire('COMPOSE_FILE', 'docker-compose.yaml:docker-compose.selfhost.yaml');
// Compose splits COMPOSE_FILE on the OS path separator, ';' on Windows. Naming ':' makes the
// same line work everywhere (GET-1013).
wire('COMPOSE_PATH_SEPARATOR', ':');
wire('SUPABASE_URL', 'http://supabase:8000');
wire('SELF_HOSTED', 'true');
wire('AUTH_PROVIDER', 'supabase');
wire('VITE_AUTH_PROVIDER', 'supabase');
// The build this checkout is, so the sidebar's version widget can say whether an update is out.
// ./update.sh keeps it current after that. No git (a tarball install): leave it unset.
try {
  const commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  if (/^[0-9a-f]{7,40}$/.test(commit)) wire('APP_COMMIT', commit);
} catch { /* not a git checkout */ }
const appDomain = get('APP_DOMAIN');
if (!isUnset(appDomain)) wire('VITE_SUPABASE_URL', `https://${appDomain}`);

// Closed by default. Kept when the operator has set either on purpose.
if (!get('DISABLE_SIGNUPS')) { set('DISABLE_SIGNUPS', 'true'); changed.push('DISABLE_SIGNUPS'); }
const smtp = get('SMTP_HOST');
if (!get('GOTRUE_MAILER_AUTOCONFIRM')) {
  set('GOTRUE_MAILER_AUTOCONFIRM', smtp ? 'false' : 'true');
  changed.push('GOTRUE_MAILER_AUTOCONFIRM');
}

writeFileSync(file, text, { mode: 0o600 });
// The mode above only applies when the file is created; an existing (or freshly
// copied) file keeps its old mode, and this one holds the secrets.
chmodSync(file, 0o600);

console.log(changed.length ? `wrote ${changed.join(', ')} to ${file}` : `${file}: all secrets and settings already set`);
if (isUnset(appDomain)) {
  console.log(`note: set APP_DOMAIN, API_DOMAIN and MCP_DOMAIN in ${file}, then run this again`);
}
if (smtp && get('GOTRUE_MAILER_AUTOCONFIRM') === 'true') {
  console.log(`note: SMTP_HOST is set but GOTRUE_MAILER_AUTOCONFIRM=true. Set it to false in ${file} so`);
  console.log('      addresses are confirmed by email; invitations then also work by email match.');
}
console.log(`next: docker compose --env-file ${file} up -d --build`);
console.log(`then create the owner account at https://${isUnset(appDomain) ? '<APP_DOMAIN>' : appDomain}/signup?setup=${setupToken}`);
console.log('      (only a sign-up with this token becomes the owner; it is also in nous.env and in `docker compose logs db-schema`)');
