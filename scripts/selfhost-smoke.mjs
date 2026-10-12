#!/usr/bin/env node
// End-to-end smoke test of a running bundled self-host stack (docker-compose.selfhost.yaml):
// the path a new operator walks in the README quickstart. CI runs it on every PR that touches
// self-host (.github/workflows/selfhost-smoke.yml); run it by hand against a laptop install too.
//
//   node scripts/selfhost-smoke.mjs [env-file]        (default nous.env)
//
// Expects a FRESH install (no owner yet) with the Fernpoint demo seed NOT loaded; it loads the
// seed itself. Uses https://$APP_DOMAIN and https://$API_DOMAIN, so on a laptop (Caddy's local
// CA) set NODE_EXTRA_CA_CERTS to Caddy's root certificate first (docs/self-host-bundled.md).
// No dependencies: Node 18+ and the docker CLI.
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

const envFile = process.argv[2] || 'nous.env';
const env = Object.fromEntries(readFileSync(envFile, 'utf8').replace(/\r\n?/g, '\n').split('\n')
  .filter((l) => /^[A-Z_][A-Z0-9_]*=/.test(l)).map((l) => l.split(/=(.*)/s).slice(0, 2)));
const APP = `https://${env.APP_DOMAIN}`;
const API = `https://${env.API_DOMAIN}`;
const ANON = env.SUPABASE_ANON_KEY;
const DEMO_WS = 'f8c10df0-e4aa-4e30-a1b0-90847b243e08';
const DEMO_PERSON = 'juno.whitlock@harborline-freight.example';

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? `\n     ${String(detail).slice(0, 400)}` : ''}`);
  if (!ok) failures++;
  return ok;
}
async function call(method, url, { token, body, apikey } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  if (apikey) headers.apikey = apikey;
  const r = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, json, text };
}
const signup = (email, password, data = {}) =>
  call('POST', `${APP}/auth/v1/signup`, { apikey: ANON, body: { email, password, data } });
const pw = () => `${randomBytes(12).toString('hex')}Aa1`;
const compose = (...a) => execFileSync('docker', ['compose', '--env-file', envFile, ...a], { stdio: ['ignore', 'pipe', 'pipe'] }).toString();

// 1. The app, the API, auth and MCP answer.
check('app serves the frontend', (await call('GET', `${APP}/`)).status === 200);
check('api /health', (await call('GET', `${API}/health`)).json?.ok === true);
check('auth /health', (await call('GET', `${APP}/auth/v1/health`)).status === 200);
const cfg = (await call('GET', `${APP}/api/auth/config`)).json;
check('auth config: closed, setup required', cfg?.signupsDisabled === true && cfg?.setupRequired === true, JSON.stringify(cfg));

// 2. A sign-up without the setup token gets no account; with it, the owner.
const stranger = await signup(`stranger-${Date.now()}@example.com`, pw());
const strangerMe = await call('GET', `${APP}/api/me`, { token: stranger.json?.access_token });
check('sign-up without the setup token is refused', strangerMe.json?.error === 'signups_disabled', strangerMe.text);
const owner = await signup(`owner-${Date.now()}@example.com`, pw(), { name: 'Smoke Owner', company_name: 'Smoke Co', nous_setup_token: env.SELFHOST_SETUP_TOKEN });
const ownerToken = owner.json?.access_token;
const me = await call('GET', `${APP}/api/me`, { token: ownerToken });
check('owner sign-up with the setup token', !!me.json?.user?.id && !!me.json?.workspace?.id, me.text);
check('/api/me reports self_hosted', me.json?.self_hosted === true);
check('the company name names the team and workspace', me.json?.team?.name === 'Smoke Co' && me.json?.workspace?.name === 'Smoke Co', JSON.stringify({ team: me.json?.team?.name, workspace: me.json?.workspace?.name }));
const teamId = me.json?.team?.id;

// 3. The demo seed loads (the README's two commands).
try {
  compose('cp', 'supabase/seed/demo.sql', 'db:/tmp/demo.sql');
  const out = compose('exec', '-T', 'db', 'psql', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-1', '-f', '/tmp/demo.sql');
  check('demo seed loads', /40 \|\s+160 \|\s+35/.test(out), out.slice(-300));
} catch (e) { check('demo seed loads', false, e.stderr?.toString() || e.message); }

// 4. An API key, and the context API and MCP over it.
const key = await call('POST', `${APP}/api/workspace/api-keys?workspaceId=${DEMO_WS}`, { token: ownerToken, body: { name: 'smoke' } });
check('mint an API key', key.status === 201 && /^pk_/.test(key.json?.key || ''), key.text);
const ctx = await call('POST', `${API}/v2/context`, { token: key.json?.key, body: { focus: DEMO_PERSON } });
check('POST /v2/context resolves a demo contact', ctx.status === 200 && ctx.json?.timeline?.length > 0 && ctx.json?.stakeholders?.length > 0, ctx.text);
const mcp = await fetch(`https://${env.MCP_DOMAIN}/mcp`, {
  method: 'POST',
  headers: { authorization: `Bearer ${key.json?.key}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } } }),
});
check('MCP initialize', mcp.status === 200, await mcp.text().catch(() => ''));

// 5. A teammate joins with a join link (Settings -> Members -> Create invite) through the CLI flow.
const jt = await call('POST', `${APP}/api/teams/${teamId}/join-tokens`, { token: ownerToken, body: { role: 'member' } });
const joinToken = jt.json?.command?.split(/\s+/).find((w) => w.startsWith('tj_'));
check('create a join link', !!joinToken, jt.text);
const start = await call('POST', `${API}/api/cli/auth/join/start`, { body: { token: joinToken } });
const mate = await signup(`teammate-${Date.now()}@example.com`, pw(), { name: 'Smoke Teammate' });
const mateToken = mate.json?.access_token;
const before = await call('GET', `${APP}/api/me`, { token: mateToken });
check('teammate has no account before joining', before.json?.error === 'signups_disabled', before.text);
const approve = await call('POST', `${APP}/api/cli/auth/approve`, { token: mateToken, body: { user_code: start.json?.user_code } });
check('teammate approves the join', approve.json?.joined_team_id === teamId, approve.text);
const poll = await call('POST', `${API}/api/cli/auth/poll`, { body: { device_code: start.json?.device_code } });
check('CLI receives the teammate key', poll.json?.status === 'approved' && /^pk_/.test(poll.json?.api_key || ''), poll.text);
const after = await call('GET', `${APP}/api/me`, { token: mateToken });
check('teammate is in the owner team', after.json?.team?.id === teamId, after.text);

// 6. Workspace-only features say so instead of a bare 404; unknown paths still 404.
const tasks = await call('GET', `${APP}/api/tasks?workspaceId=${DEMO_WS}`, { token: ownerToken });
check('Workspace feature answers 403 cloud_only_feature', tasks.status === 403 && tasks.json?.error === 'cloud_only_feature', tasks.text);
check('unknown path answers 404', (await call('GET', `${APP}/api/no-such-route`)).status === 404);

// 7. The api reaches the worker (WORKER_SECRET is set). Without a real model key the worker
// answers 502 from the model call; 503 means the api never tried (the secret is missing).
const people = await call('POST', `${API}/v2/context`, { token: key.json?.key, body: { focus: 'harborline-freight.example' } });
const companyId = people.json?.entity?.id;
const summary = await call('POST', `${APP}/api/companies/${companyId}/summary?workspaceId=${DEMO_WS}`, { token: ownerToken });
check('api -> worker internal call is wired (not 503)', summary.status !== 503, summary.text);

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
