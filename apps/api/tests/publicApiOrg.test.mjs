// The public API, organization half: /v2/members, /v2/icp, /v2/usage, /v2/workflows,
// and the usage block on /v2/workspace/whoami.
//
// Same harness as publicApiCore.test.mjs: every route runs end to end through Express against an
// in-process fake PostgREST (globalThis.fetch answers the Supabase REST calls from in-memory
// tables), so the tests pin the real query-builder calls. No network, no database. Auth is a
// stand-in middleware setting what verifyApiKey sets: workspace, scope, the key's person.
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = 'http://fake-supabase.test';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-test';
delete process.env.SELF_HOSTED;              // cloud: the invite flow's plan gate is live
delete process.env.RESEND_API_KEY;           // no email provider: invites return the link
delete process.env.STRIPE_SECRET_KEY;
process.env.ENCRYPTION_KEY = 'a'.repeat(64);

const { default: express } = await import('express');
const { membersV2Router } = await import('../src/routes/v2/members.mjs');
const { icpV2Router } = await import('../src/routes/v2/icp.mjs');
const { usageV2Router, groupOps } = await import('../src/routes/v2/usage.mjs');
const { workflowsV2Router } = await import('../src/routes/v2/workflows.mjs');
const { workspaceStatusV2Router } = await import('../src/routes/v2/workspaceStatus.mjs');
const { apiUsageBody } = await import('../src/routes/api/usage.mjs');
const { getSupabaseClient } = await import('@nous/core');
const { periodStartFor } = await import('../src/lib/plans.mjs');
const { HAS_CLOUD } = await import('../src/lib/cloud.mjs');
const { hasLearnedIcpScorer } = await import('@nous/core');
// An open-source build is self-hosted whatever SELF_HOSTED says (GET-754), and there the email
// invite is closed (teammates join over the CLI): 402 invite_requires_team_plan.
const assertSelfHostInviteClosed = (r) => {
  assert.equal(r.status, 402);
  assert.equal(r.body.error, 'invite_requires_team_plan');
};

// ── fake PostgREST (as publicApiCore.test.mjs) ───────────────────────────────
let tables = {};

const unquote = (v) => (v.startsWith('"') && v.endsWith('"') ? v.slice(1, -1) : v);
function cmp(a, b) {
  const da = Date.parse(a), db = Date.parse(b);
  if (typeof a === 'string' && Number.isFinite(da) && Number.isFinite(db) && /\d{4}-\d{2}-\d{2}/.test(a)) return da - db;
  if (typeof a === 'number' || typeof b === 'number') return Number(a) - Number(b);
  return a < b ? -1 : a > b ? 1 : 0;
}
function test1(row, col, expr) {
  if (expr.startsWith('not.')) return !test1(row, col, expr.slice(4));
  const dot = expr.indexOf('.');
  const op = expr.slice(0, dot);
  const raw = unquote(expr.slice(dot + 1));
  const v = row[col];
  switch (op) {
    case 'eq': return v != null && String(v) === raw;
    case 'neq': return String(v) !== raw;
    case 'is': return raw === 'null' ? v == null : String(v) === raw;
    case 'in': return raw.replace(/^\(|\)$/g, '').split(',').map(unquote).includes(String(v));
    case 'gte': return v != null && cmp(v, raw) >= 0;
    case 'gt': return v != null && cmp(v, raw) > 0;
    case 'lte': return v != null && cmp(v, raw) <= 0;
    case 'lt': return v != null && cmp(v, raw) < 0;
    case 'like': return v != null && new RegExp('^' + raw.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/[%*]/g, '.*') + '$').test(String(v));
    default: return true;
  }
}
function splitTop(s) {
  const out = []; let depth = 0, cur = '';
  for (const ch of s) {
    if (ch === '(') depth++; if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; } else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}
function orMatch(row, expr) {
  return splitTop(expr.replace(/^\(|\)$/g, '')).some((part) => {
    const i = part.indexOf('.');
    return test1(row, part.slice(0, i), part.slice(i + 1));
  });
}
const RESERVED = new Set(['select', 'order', 'limit', 'offset', 'on_conflict', 'columns']);
function filterRows(rows, params) {
  return rows.filter((r) => {
    for (const [k, v] of params) {
      if (RESERVED.has(k)) continue;
      if (k === 'or') { if (!orMatch(r, v)) return false; continue; }
      if (k.includes('->')) continue; // json-path filters: not modelled
      if (!test1(r, k, v)) return false;
    }
    return true;
  });
}
function orderRows(rows, spec) {
  if (!spec) return rows;
  const keys = spec.split(',').map((s) => { const [col, dir = 'asc', nulls] = s.split('.'); return { col, desc: dir === 'desc', nullsLast: nulls ? nulls === 'nullslast' : dir === 'desc' ? false : true }; });
  return [...rows].sort((a, b) => {
    for (const k of keys) {
      const av = a[k.col], bv = b[k.col];
      if (av == null && bv == null) continue;
      if (av == null) return k.nullsLast ? 1 : -1;
      if (bv == null) return k.nullsLast ? -1 : 1;
      const c = cmp(av, bv);
      if (c) return k.desc ? -c : c;
    }
    return 0;
  });
}
let idN = 0;
let rpcCalls = [];
async function fakeSupabase(url, init = {}) {
  const u = new URL(url);
  const method = (init.method || 'GET').toUpperCase();
  const headers = new Headers(init.headers || {});
  const json = (body, status = 200, extra = {}) => new Response(body === undefined ? '' : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...extra } });
  if (u.pathname.startsWith('/rest/v1/rpc/')) { rpcCalls.push(u.pathname.slice('/rest/v1/rpc/'.length)); return json(null); }
  const table = u.pathname.replace('/rest/v1/', '');
  tables[table] ??= [];
  const params = [...u.searchParams.entries()];
  const wantsObject = (headers.get('accept') || '').includes('vnd.pgrst.object');
  const prefer = headers.get('prefer') || '';
  if (method === 'GET' || method === 'HEAD') {
    let rows = orderRows(filterRows(tables[table], params), u.searchParams.get('order'));
    const total = rows.length;
    const off = parseInt(u.searchParams.get('offset') || '0', 10);
    const lim = u.searchParams.get('limit');
    rows = rows.slice(off, lim != null ? off + parseInt(lim, 10) : undefined);
    if (wantsObject) return rows.length === 1 ? json(rows[0]) : json({ code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' }, 406);
    return json(method === 'HEAD' ? undefined : rows, 200, { 'content-range': `${off}-${off + rows.length - 1}/${total}` });
  }
  const body = init.body ? JSON.parse(init.body) : null;
  if (method === 'POST') {
    const now = new Date().toISOString();
    const list = (Array.isArray(body) ? body : [body]).map((r) => ({ id: r.id ?? `gen-${++idN}`, created_at: r.created_at ?? now, ...r }));
    tables[table].push(...list);
    const ret = prefer.includes('return=representation') ? list : undefined;
    if (wantsObject) return json(list[0], 201);
    return json(ret ?? null, 201);
  }
  if (method === 'PATCH') {
    const hit = filterRows(tables[table], params);
    for (const r of hit) Object.assign(r, body);
    if (wantsObject) return hit.length === 1 ? json(hit[0]) : json({ code: 'PGRST116', message: 'no rows' }, 406);
    return json(prefer.includes('return=representation') ? hit : null, 200);
  }
  if (method === 'DELETE') {
    const hit = new Set(filterRows(tables[table], params));
    tables[table] = tables[table].filter((r) => !hit.has(r));
    return json(null, 200);
  }
  return json(null);
}
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const s = String(url);
  if (s.startsWith('http://fake-supabase.test')) return fakeSupabase(s, init);
  if (s.includes('127.0.0.1')) return realFetch(url, init);
  throw new Error(`unexpected network call in test: ${s}`);
};

// ── app under test ───────────────────────────────────────────────────────────
const WS = '11111111-1111-4111-8111-111111111111';
const TEAM = 'team-1';
const FOUNDER = 'aaaaaaaa-0000-4000-8000-000000000001';
const ADMIN = 'aaaaaaaa-0000-4000-8000-000000000002';
const MEMBER = 'aaaaaaaa-0000-4000-8000-000000000003';
const OTHER = 'aaaaaaaa-0000-4000-8000-000000000004';

const app = express();
app.use(express.json());
// Stand-in for verifyApiKey: x-test-scope admin (workspace key, no person) | member | admin-bound.
app.use((req, _res, next) => {
  req.workspaceId = WS;
  const scope = req.get('x-test-scope') || 'admin';
  req.viewerScope = scope === 'admin-bound' ? 'admin' : scope;
  req.memberUserId = scope === 'member' ? MEMBER : scope === 'admin-bound' ? ADMIN : null;
  req.isApiKeyAuth = true;
  req.apiKeyId = 'key-1';
  next();
});
app.use('/v2/members', membersV2Router);
app.use('/v2/icp', icpV2Router);
app.use('/v2/usage', usageV2Router);
app.use('/v2/workflows', workflowsV2Router);
app.use('/v2/workspace', workspaceStatusV2Router);
const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
const base = `http://127.0.0.1:${server.address().port}`;
after(() => { server.closeAllConnections?.(); server.close(); });
const call = async (method, path, body, scope = 'admin') => {
  const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', 'x-test-scope': scope }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : null };
};

const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();

beforeEach(() => {
  rpcCalls = [];
  tables = {
    workspaces: [{ id: WS, team_id: TEAM, name: 'Acme GTM', onboarding_activated_at: null }],
    teams: [{ id: TEAM, name: 'Acme' }],
    subscriptions: [],
    users: [
      { id: FOUNDER, name: 'Fran Founder', email: 'fran@acme.com', team_id: TEAM },
      { id: ADMIN, name: 'Ada Admin', email: 'ada@acme.com', team_id: TEAM },
      { id: MEMBER, name: 'Mo Member', email: 'mo@acme.com', team_id: TEAM },
      { id: OTHER, name: 'Oli Other', email: 'oli@acme.com', team_id: TEAM },
    ],
    team_members: [
      { id: 'tm1', team_id: TEAM, user_id: FOUNDER, role: 'founder' },
      { id: 'tm2', team_id: TEAM, user_id: ADMIN, role: 'admin' },
      { id: 'tm3', team_id: TEAM, user_id: MEMBER, role: 'member' },
      { id: 'tm4', team_id: TEAM, user_id: OTHER, role: 'member' },
    ],
    workspace_members: [
      { workspace_id: WS, user_id: FOUNDER, role: 'owner', users: null },
      { workspace_id: WS, user_id: ADMIN, role: 'admin' },
      { workspace_id: WS, user_id: MEMBER, role: 'member' },
      { workspace_id: WS, user_id: OTHER, role: 'member' },
    ],
    team_invitations: [],
    audit_log: [],
    agent_routines: [],
    agent_routine_runs: [],
    documents: [],
    workspace_system_log: [],
    foundations: [],
    brains: [],
  };
});

// ── Members ──────────────────────────────────────────────────────────────────

test('members: GET /v2/members is the same handler as GET /v2/workspace/members', async () => {
  const a = await call('GET', '/v2/members');
  const b = await call('GET', '/v2/workspace/members');
  assert.equal(a.status, 200);
  assert.deepEqual(a.body, b.body);
  assert.equal(a.body.count, 4);
  const m = await call('GET', '/v2/members?role=admin');
  assert.equal(m.status, 400);
  assert.equal(m.body.error, 'unknown_query_param');
  assert.deepEqual(m.body.supported, []);
});

test('members: invite and remove are admin-key only', async () => {
  const inv = await call('POST', '/v2/members', { email: 'new@acme.com' }, 'member');
  assert.equal(inv.status, 403);
  assert.equal(inv.body.error, 'admin_key_required');
  const del = await call('DELETE', `/v2/members/${OTHER}`, null, 'member');
  assert.equal(del.status, 403);
  assert.equal(del.body.error, 'admin_key_required');
  assert.equal(tables.team_invitations.length, 0);
  assert.equal(tables.team_members.length, 4);
});

test('members: an admin key invites through the app flow, from the founder', async () => {
  const r = await call('POST', '/v2/members', { email: '  New@Acme.com ', role: 'viewer' });
  if (!HAS_CLOUD) {
    assertSelfHostInviteClosed(r);
    assert.equal(tables.team_invitations.length, 0);
    return;
  }
  assert.equal(r.status, 201);
  assert.equal(r.body.invitation.email, 'new@acme.com');
  assert.equal(r.body.invitation.role, 'viewer');
  assert.equal(r.body.invitation.status, 'pending');
  assert.equal(r.body.email_sent, false);
  assert.equal(r.body.email_error, 'not_configured');
  assert.match(r.body.invite_link, /accept-invitation\?token=[0-9a-f]{64}$/);
  assert.equal(tables.team_invitations.length, 1);
  assert.equal(tables.team_invitations[0].invited_by_user_id, FOUNDER);
  assert.equal(tables.team_invitations[0].team_id, TEAM);

  const dup = await call('POST', '/v2/members', { email: 'new@acme.com' });
  assert.equal(dup.status, 400);
  assert.equal(dup.body.error, 'invitation_already_exists');
});

test('members: invite validation — role, email; a person-bound admin key invites as that person', async () => {
  const owner = await call('POST', '/v2/members', { email: 'x@acme.com', role: 'owner' });
  assert.equal(owner.status, 400);
  assert.equal(owner.body.error, 'invalid_role');
  assert.deepEqual(owner.body.supported, ['admin', 'member', 'viewer']);
  const bad = await call('POST', '/v2/members', { email: 'not-an-email' });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error, 'invalid_email_format');
  const none = await call('POST', '/v2/members', {});
  assert.equal(none.body.error, 'email_required');

  const bound = await call('POST', '/v2/members', { email: 'y@acme.com' }, 'admin-bound');
  if (HAS_CLOUD) {
    assert.equal(bound.status, 201);
    assert.equal(tables.team_invitations[0].invited_by_user_id, ADMIN);
  } else {
    assertSelfHostInviteClosed(bound);
  }

  // The bound person lost admin: the key can no longer invite.
  tables.team_members.find(m => m.user_id === ADMIN).role = 'member';
  const lost = await call('POST', '/v2/members', { email: 'z@acme.com' }, 'admin-bound');
  assert.equal(lost.status, 403);
  assert.equal(lost.body.error, 'insufficient_permissions');
});

test('members: remove — the safe rules, then the member is gone from team and workspace', async () => {
  const founder = await call('DELETE', `/v2/members/${FOUNDER}`);
  assert.equal(founder.status, 400);
  assert.equal(founder.body.error, 'cannot_remove_founder');
  const self = await call('DELETE', `/v2/members/${ADMIN}`, null, 'admin-bound');
  assert.equal(self.status, 400);
  assert.equal(self.body.error, 'cannot_remove_self');
  const ghost = await call('DELETE', '/v2/members/bbbbbbbb-0000-4000-8000-000000000009');
  assert.equal(ghost.status, 404);
  assert.equal(ghost.body.error, 'member_not_found');

  const ok = await call('DELETE', `/v2/members/${OTHER}`);
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body, { removed: true, user_id: OTHER });
  assert.ok(!tables.team_members.some(m => m.user_id === OTHER));
  assert.ok(!tables.workspace_members.some(m => m.user_id === OTHER));
  assert.equal(tables.audit_log.at(-1)?.action, 'member.removed');
});

test('members: never removes the last founder/owner/admin', async () => {
  tables.team_members = tables.team_members.filter(m => m.role !== 'founder');
  const r = await call('DELETE', `/v2/members/${ADMIN}`);
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'cannot_remove_last_admin');
  assert.ok(tables.team_members.some(m => m.user_id === ADMIN));
});

// ── Brain ────────────────────────────────────────────────────────────────────

test('icp: GET returns the foundation and the model status; PUT validates like POST /v2/foundations/icp', async () => {
  tables.foundations.push({ workspace_id: WS, kind: 'icp', title: 'ICP', body_md: '# ICP\nSeries A SaaS', source: 'nous', file_path: null, version: 3, synced_at: null, updated_at: '2026-09-01T00:00:00Z' });
  const r = await call('GET', '/v2/icp');
  assert.equal(r.status, 200);
  assert.equal(r.body.icp.body_md, '# ICP\nSeries A SaaS');
  assert.equal(r.body.icp.version, 3);
  assert.equal(typeof r.body.model.has_model, 'boolean');
  assert.ok(Array.isArray(r.body.model.signals));

  const bad = await call('PUT', '/v2/icp', { body_md: '   ' });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error, 'body_md_required');

  const extra = await call('GET', '/v2/icp?kind=icp');
  assert.equal(extra.status, 400);
  assert.equal(extra.body.error, 'unknown_query_param');
});

test("icp: PUT /v2/icp/scorer 'nous' needs the learned scorer; 'external' always works", async () => {
  const ext = await call('PUT', '/v2/icp/scorer', { scorer: 'external' });
  assert.equal(ext.status, 200);
  assert.equal(ext.body.scorer, 'external');

  const nous = await call('PUT', '/v2/icp/scorer', { scorer: 'nous' });
  if (hasLearnedIcpScorer()) {
    assert.equal(nous.status, 200);
    assert.deepEqual(nous.body, { scorer: 'nous', source: 'workspace' });
  } else {
    // The open-source build has no learned scorer (GET-754 slice 8): refused, nothing switched on.
    assert.equal(nous.status, 403);
    assert.equal(nous.body.error, 'cloud_only_feature');
    assert.equal(nous.body.feature, 'icpScoring');
    const now = await call('GET', '/v2/icp/scorer');
    assert.equal(now.body.scorer, 'external');
  }
});

test('icp: POST /v2/icp/closed-deals is the record_closed_deals handler', async () => {
  const r = await call('POST', '/v2/icp/closed-deals', { won: [], lost: [] });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'need_more_deals');
});

// ── Usage ────────────────────────────────────────────────────────────────────

function seedOps() {
  const inPeriod = new Date(Math.max(periodStartFor(null).getTime() + 3600_000, Date.now() - 3600_000)).toISOString();
  const before = new Date(periodStartFor(null).getTime() - 86400000).toISOString();
  tables.agent_routines.push({ id: 'r-brief', workspace_id: WS, name: 'Morning brief', trigger_kind: 'clock', enabled: true });
  tables.workspace_system_log.push(
    { id: 'l1', workspace_id: WS, source: 'mcp', event_type: 'v2.context', billable_ops: 1, occurred_at: inPeriod },
    { id: 'l2', workspace_id: WS, source: 'mcp', event_type: 'v2.query', billable_ops: 1, occurred_at: inPeriod },
    { id: 'l3', workspace_id: WS, source: 'sdk', event_type: 'v2.account.get', billable_ops: 1, occurred_at: inPeriod },
    { id: 'l4', workspace_id: WS, source: 'sdk', event_type: 'v2.observations.write', billable_ops: 1, occurred_at: inPeriod },
    { id: 'l5', workspace_id: WS, source: 'schedule', event_type: 'routine.run', billable_ops: 1, occurred_at: inPeriod, metadata: { routine_id: 'r-brief' } },
    { id: 'l6', workspace_id: WS, source: 'api', event_type: 'enrichment_run', billable_ops: 0, occurred_at: inPeriod },
    { id: 'l7', workspace_id: WS, source: 'mcp', event_type: 'v2.context', billable_ops: 1, occurred_at: before },
  );
}

test('usage: GET /v2/usage carries the billing panel numbers (parity with /api/usage)', async () => {
  seedOps();
  const r = await call('GET', '/v2/usage');
  assert.equal(r.status, 200);
  const panel = await apiUsageBody(getSupabaseClient(), { id: TEAM }, null);
  assert.deepEqual(r.body.plan, { id: panel.plan, name: panel.planName });
  assert.equal(r.body.self_hosted, panel.selfHosted);
  assert.equal(r.body.period.start, panel.ops.periodStart);
  assert.ok(Date.parse(r.body.period.end) > Date.parse(r.body.period.start));
  assert.equal(r.body.ops.used, panel.ops.used);
  assert.equal(r.body.ops.used, 3);                      // three retrievals this period
  assert.equal(r.body.ops.limit, panel.ops.included);
  assert.equal(r.body.ops.left, panel.ops.remaining);
  assert.equal(r.body.credits.used, panel.aiCredits.used);
  assert.equal(r.body.credits.limit, panel.aiCredits.included);
  assert.equal(r.body.credits.left, panel.aiCredits.remaining);
  assert.equal(r.body.credits.state, panel.aiCredits.state);
  assert.equal(r.body.enrichments.used, panel.enrichments.used);
  assert.equal(r.body.enrichments.used, 1);
  assert.equal(r.body.enrichments.limit, panel.enrichments.included);
  assert.equal(r.body.active_accounts.used, panel.activeAccounts.used);
  assert.equal(r.body.active_accounts.limit, panel.activeAccounts.included);
  assert.equal(r.body.active_accounts.left, panel.activeAccounts.remaining);

  const extra = await call('GET', '/v2/usage?team=x');
  assert.equal(extra.status, 400);
  assert.equal(extra.body.error, 'unknown_query_param');
});

test('usage: whoami carries the budget block, from the same read', async () => {
  seedOps();
  const r = await call('GET', '/v2/workspace/whoami');
  assert.equal(r.status, 200);
  const u = (await call('GET', '/v2/usage')).body;
  assert.deepEqual(Object.keys(r.body.usage).sort(), ['credits_left', 'ops_left', 'ops_limit', 'ops_used', 'period_end', 'period_start', 'plan'].sort());
  assert.equal(r.body.usage.plan, u.plan.id);
  assert.equal(r.body.usage.ops_used, u.ops.used);
  assert.equal(r.body.usage.period_start, u.period.start);
  assert.equal(r.body.usage.period_end, u.period.end);
  assert.equal(r.body.usage.credits_left, u.credits.unlimited ? null : u.credits.left);
  assert.equal(r.body.workspace.id, WS);
});

test('usage: breakdown by source, workflow and day; billed_total equals ops.used', async () => {
  seedOps();
  const used = (await call('GET', '/v2/usage')).body.ops.used;

  const s = await call('GET', '/v2/usage/breakdown?by=source');
  assert.equal(s.status, 200);
  assert.equal(s.body.by, 'source');
  assert.equal(s.body.total, 5);           // every weighted op this period (enrichment is weight 0)
  assert.equal(s.body.billed_total, used); // the retrieval meter
  const mcp = s.body.rows.find(x => x.key === 'mcp');
  assert.deepEqual(mcp, { key: 'mcp', label: 'MCP', ops: 2, billed_ops: 2 });
  assert.equal(s.body.rows.find(x => x.key === 'schedule').label, 'Scheduled workflows');

  const w = await call('GET', '/v2/usage/breakdown?by=workflow');
  assert.deepEqual(w.body.rows.find(x => x.key === 'r-brief'), { key: 'r-brief', label: 'Morning brief', ops: 1, billed_ops: 0 });
  assert.equal(w.body.rows.find(x => x.key === null).label, 'Not from a workflow');

  const d = await call('GET', `/v2/usage/breakdown?by=day&from=${encodeURIComponent(daysAgo(400 - 1))}`);
  assert.equal(d.status, 200);
  assert.equal(d.body.total, 6);           // the earlier-period op now inside the window
  assert.ok(d.body.rows.every(x => /^\d{4}-\d{2}-\d{2}$/.test(x.key)));

  const bad = await call('GET', '/v2/usage/breakdown?by=model');
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error, 'invalid_by');
  assert.deepEqual(bad.body.supported, ['source', 'workflow', 'day']);
  const badFrom = await call('GET', '/v2/usage/breakdown?from=yesterday');
  assert.equal(badFrom.body.error, 'invalid_from');
  const range = await call('GET', `/v2/usage/breakdown?from=${encodeURIComponent(daysAgo(1))}&to=${encodeURIComponent(daysAgo(3))}`);
  assert.equal(range.body.error, 'invalid_range');
  const unk = await call('GET', '/v2/usage/breakdown?group=source');
  assert.equal(unk.body.error, 'unknown_query_param');
  assert.deepEqual(unk.body.supported, ['by', 'from', 'to']);
});

test('usage: groupOps sums weights, keys routine runs by their routine', () => {
  const g = groupOps([
    { source: 'mcp', event_type: 'v2.context', billable_ops: 2, occurred_at: '2026-09-01T01:00:00Z' },
    { source: 'schedule', event_type: 'routine.run', billable_ops: 1, occurred_at: '2026-09-02T01:00:00Z', routine_id: 'r1' },
    { source: 'api', event_type: 'enrichment_run', billable_ops: 0, occurred_at: '2026-09-02T01:00:00Z' },
  ], 'workflow');
  assert.equal(g.total, 3);
  assert.equal(g.billed_total, 2);
  assert.deepEqual(g.rows.map(r => r.key), [null, 'r1']);
});

// ── Workflows ────────────────────────────────────────────────────────────────

const flow = (over = {}) => ({
  name: 'Monday pipeline note',
  trigger: { type: 'clock', frequency: 'weekly', at: '07:30' },
  steps: [
    { type: 'agent', prompt: 'Summarise what moved in the pipeline last week.' },
    { type: 'slack', channel: '#pipeline', text: '{{steps.step_1.output}}' },
  ],
  ...over,
});

test('workflows: triggers and step types', async () => {
  const r = await call('GET', '/v2/workflows/triggers');
  assert.equal(r.status, 200);
  const manual = r.body.triggers.find(t => t.key === 'manual');
  assert.equal(manual.runs_now, true);
  assert.equal(r.body.triggers.find(t => t.key === 'clock').live, true);
  assert.equal(r.body.triggers.find(t => t.key === 'email_received').runs_now, false);
  assert.deepEqual(r.body.step_types.map(s => s.type).sort(), ['agent', 'approval', 'email', 'gmail', 'hubspot', 'only_if', 'slack', 'wait', 'webhook']);
  assert.ok(r.body.step_types.every(s => s.description.length > 10));
});

test('workflows: create through the app checker, read it back', async () => {
  const r = await call('POST', '/v2/workflows', flow());
  assert.equal(r.status, 201);
  const w = r.body.workflow;
  assert.equal(w.name, 'Monday pipeline note');
  assert.equal(w.enabled, true);
  assert.deepEqual(w.trigger, { type: 'clock', frequency: 'weekly', at: '07:30' });
  assert.equal(w.steps_count, 2);
  // Stored the way the editor writes it (GET-748): an own prompt is a "write" step on OpenNous.
  assert.deepEqual(w.steps[0], { id: 'step_1', type: 'agent', mode: 'write', job: null, prompt: 'Summarise what moved in the pipeline last week.', extra: '', model: 'opennous' });
  assert.equal(w.prompt, 'Summarise what moved in the pipeline last week.');
  assert.equal(w.destination, 'slack');
  const row = tables.agent_routines[0];
  assert.equal(row.workspace_id, WS);
  assert.equal(row.user_id, null);                 // a workspace key owns nothing
  assert.equal(row.trigger_kind, 'clock');
  assert.equal(row.frequency, 'weekly');
  assert.equal(row.at_time, '07:30');
  assert.equal(row.destination_target, '#pipeline');

  const one = await call('GET', `/v2/workflows/${w.id}`);
  assert.equal(one.status, 200);
  assert.equal(one.body.workflow.id, w.id);
  assert.deepEqual(one.body.recent_runs, []);
});

test('workflows: invalid flows are 400 invalid_workflow with the checker reasons', async () => {
  const noSteps = await call('POST', '/v2/workflows', flow({ steps: [] }));
  assert.equal(noSteps.status, 400);
  assert.equal(noSteps.body.error, 'invalid_workflow');
  assert.equal(noSteps.body.reasons[0].code, 'no_steps');

  const badStep = await call('POST', '/v2/workflows', flow({ steps: [{ type: 'carrier_pigeon' }] }));
  assert.equal(badStep.body.error, 'invalid_workflow');
  assert.deepEqual(badStep.body.reasons[0], { code: 'unknown_step', step: 'carrier_pigeon' });

  const badTrig = await call('POST', '/v2/workflows', flow({ trigger: { type: 'full_moon' } }));
  assert.equal(badTrig.body.reasons[0].code, 'unknown_trigger');

  const noTrig = await call('POST', '/v2/workflows', flow({ trigger: 'clock' }));
  assert.equal(noTrig.body.reasons[0].code, 'trigger_required');

  const dupIds = await call('POST', '/v2/workflows', flow({ steps: [{ id: 'a', type: 'agent', prompt: 'x' }, { id: 'a', type: 'wait' }] }));
  assert.equal(dupIds.body.reasons[0].code, 'bad_step_id');

  const art = await call('POST', '/v2/workflows', flow({ steps: [{ type: 'agent', artifact: 'poem' }] }));
  assert.equal(art.body.reasons[0].code, 'unknown_artifact');

  const field = await call('POST', '/v2/workflows', { ...flow(), when: 'clock' });
  assert.equal(field.status, 400);
  assert.equal(field.body.error, 'unknown_field');

  assert.equal(tables.agent_routines.length, 0);
});

test('workflows: the plan automation limit (402), and a disabled create does not count', async () => {
  for (let i = 0; i < 5; i++) tables.agent_routines.push({ id: `full-${i}`, workspace_id: WS, name: `F${i}`, trigger_kind: 'clock', enabled: true, created_at: daysAgo(10 - i) });
  const r = await call('POST', '/v2/workflows', flow());
  assert.equal(r.status, 402);
  assert.equal(r.body.error, 'automation_limit_reached');
  assert.equal(r.body.limit, 5);
  const off = await call('POST', '/v2/workflows', flow({ enabled: false }));
  assert.equal(off.status, 201);
  assert.equal(off.body.workflow.enabled, false);
  const on = await call('PATCH', `/v2/workflows/${off.body.workflow.id}`, { enabled: true });
  assert.equal(on.status, 402);
  assert.equal(on.body.error, 'automation_limit_reached');
  // The same 402 body POST sends, message and upgrade link included.
  assert.deepEqual(Object.keys(on.body).sort(), Object.keys(r.body).sort());
  assert.ok(on.body.upgrade_url);
});

test('workflows: PATCH steps that are not an array is a 400, not a crash', async () => {
  const made = await call('POST', '/v2/workflows', flow({ enabled: false }));
  assert.equal(made.status, 201);
  for (const steps of [null, 'agent', { type: 'agent' }]) {
    const r = await call('PATCH', `/v2/workflows/${made.body.workflow.id}`, { steps });
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.ok(JSON.stringify(r.body).includes('invalid_steps'));
  }
});

test('workflows: list pages and a member key sees only its own', async () => {
  for (let i = 0; i < 3; i++) tables.agent_routines.push({ id: `mine-${i}`, workspace_id: WS, user_id: MEMBER, name: `Mine ${i}`, trigger_kind: 'manual', prompt: 'go', enabled: false, created_at: daysAgo(10 - i) });
  tables.agent_routines.push({ id: 'theirs', workspace_id: WS, user_id: OTHER, name: 'Theirs', trigger_kind: 'manual', prompt: 'go', enabled: false, created_at: daysAgo(1) });

  const all = await call('GET', '/v2/workflows?limit=2');
  assert.equal(all.status, 200);
  assert.equal(all.body.workflows.length, 2);
  assert.equal(all.body.has_more, true);
  assert.equal(all.body.limit, 2);
  const page2 = await call('GET', '/v2/workflows?limit=2&offset=2');
  assert.equal(page2.body.workflows.length, 2);
  assert.equal(page2.body.has_more, false);
  assert.deepEqual(Object.keys(page2.body.workflows[0]).sort(), ['created_at', 'enabled', 'id', 'last_run_at', 'name', 'steps_count', 'trigger'].sort());

  const mine = await call('GET', '/v2/workflows', null, 'member');
  assert.deepEqual(mine.body.workflows.map(w => w.id), ['mine-0', 'mine-1', 'mine-2']);
  const theirs = await call('GET', '/v2/workflows/theirs', null, 'member');
  assert.equal(theirs.status, 404);
  assert.equal(theirs.body.error, 'workflow_not_found');
  const delTheirs = await call('DELETE', '/v2/workflows/theirs', null, 'member');
  assert.equal(delTheirs.status, 404);

  const created = await call('POST', '/v2/workflows', flow({ enabled: false }), 'member');
  assert.equal(tables.agent_routines.find(r => r.id === created.body.workflow.id).user_id, MEMBER);

  const bad = await call('GET', '/v2/workflows?limit=0');
  assert.equal(bad.body.error, 'invalid_limit');
  const unk = await call('GET', '/v2/workflows?trigger=clock');
  assert.equal(unk.body.error, 'unknown_query_param');
  assert.deepEqual(unk.body.supported, ['enabled', 'limit', 'offset']);
});

test('workflows: patch, duplicate, delete', async () => {
  const { body: { workflow: w } } = await call('POST', '/v2/workflows', flow());

  const renamed = await call('PATCH', `/v2/workflows/${w.id}`, { name: 'Pipeline note' });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.body.workflow.name, 'Pipeline note');

  const moved = await call('PATCH', `/v2/workflows/${w.id}`, { trigger: { type: 'deal_closed_won' } });
  assert.equal(moved.status, 200);
  assert.deepEqual(moved.body.workflow.trigger, { type: 'deal_closed_won' });
  const row = tables.agent_routines.find(r => r.id === w.id);
  assert.equal(row.frequency, null);              // the clock's shape went with the clock
  assert.equal(row.steps.length, 2);              // steps kept

  const badSteps = await call('PATCH', `/v2/workflows/${w.id}`, { steps: [] });
  assert.equal(badSteps.body.error, 'invalid_workflow');
  const nothing = await call('PATCH', `/v2/workflows/${w.id}`, {});
  assert.equal(nothing.body.error, 'nothing_to_change');

  const dup = await call('POST', `/v2/workflows/${w.id}/duplicate`);
  assert.equal(dup.status, 201);
  assert.equal(dup.body.workflow.name, 'Pipeline note (copy)');
  assert.equal(dup.body.workflow.enabled, false);
  assert.notEqual(dup.body.workflow.id, w.id);
  assert.equal(dup.body.workflow.steps_count, 2);

  const del = await call('DELETE', `/v2/workflows/${w.id}`);
  assert.deepEqual(del.body, { deleted: true, id: w.id });
  assert.ok(!tables.agent_routines.some(r => r.id === w.id));
  assert.equal((await call('GET', `/v2/workflows/${w.id}`)).status, 404);
});

test('workflows: run now — unsupported triggers say so; runs history is the app history filtered', async () => {
  tables.agent_routines.push(
    { id: 'wf-call', workspace_id: WS, name: 'After calls', trigger_kind: 'call_ended', artifact: 'call_summary', enabled: true, created_at: daysAgo(5) },
    { id: 'wf-noprompt', workspace_id: WS, name: 'Manual, no prompt', trigger_kind: 'manual', enabled: true, steps: [{ id: 's1', type: 'slack', config: {} }], created_at: daysAgo(4) },
  );
  const call1 = await call('POST', '/v2/workflows/wf-call/run');
  assert.equal(call1.status, 409);
  assert.equal(call1.body.error, 'run_not_supported');
  assert.equal(call1.body.trigger, 'call_ended');
  const noPrompt = await call('POST', '/v2/workflows/wf-noprompt/run');
  assert.equal(noPrompt.status, 409);

  tables.agent_routine_runs.push(
    { id: 'run-1', workspace_id: WS, routine_id: 'wf-call', status: 'ok', started_at: daysAgo(2), document_id: null },
    { id: 'run-2', workspace_id: WS, routine_id: 'wf-call', status: 'error', started_at: daysAgo(1), error: 'boom', document_id: null },
    { id: 'run-3', workspace_id: WS, routine_id: 'wf-noprompt', status: 'ok', started_at: daysAgo(1), document_id: null },
  );
  const runs = await call('GET', '/v2/workflows/wf-call/runs');
  assert.equal(runs.status, 200);
  assert.deepEqual(runs.body.runs.map(r => r.id), ['run-2', 'run-1']);
  assert.equal(runs.body.stats.runs, 2);
  assert.equal(runs.body.stats.failed, 1);
  assert.equal(runs.body.has_more, false);
  const failed = await call('GET', '/v2/workflows/wf-call/runs?status=error');
  assert.deepEqual(failed.body.runs.map(r => r.id), ['run-2']);
  const badStatus = await call('GET', '/v2/workflows/wf-call/runs?status=exploded');
  assert.equal(badStatus.body.error, 'invalid_status');
  const paged = await call('GET', '/v2/workflows/wf-call/runs?limit=1');
  assert.equal(paged.body.runs.length, 1);
  assert.equal(paged.body.has_more, true);

  const detail = await call('GET', '/v2/workflows/wf-call');
  assert.deepEqual(detail.body.recent_runs.map(r => r.id), ['run-2', 'run-1']);
  assert.equal(detail.body.workflow.steps[0].type, 'agent');      // legacy row → [agent]
  assert.equal(detail.body.workflow.steps[0].artifact, 'call_summary');
});

test('workflows: run now on a deal trigger uses the automation engine one-off', async () => {
  tables.agent_routines.push({ id: 'wf-won', workspace_id: WS, name: 'Won write-up', trigger_kind: 'deal_closed_won', artifact: 'account_summary', enabled: false, created_at: daysAgo(3) });
  const r = await call('POST', '/v2/workflows/wf-won/run');
  assert.equal(r.status, 200);
  assert.equal(r.body.status, 'nothing_to_run_on');
  assert.equal(r.body.run_id, null);
  assert.equal(tables.agent_routine_runs.length, 0);
});
