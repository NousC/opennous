// The public API's read surface: GET /v2/people/:id, GET /v2/people?include=all, GET /v2/accounts,
// GET /v2/accounts/:id (people + deals), the account outlook paths, GET /v2/deals, GET /v2/deals/:id
// (CRM, implied, and the back-compat outlook fallback), GET /v2/pipelines, and POST /v2/context with
// a deal focus.
//
// Same harness as publicApiCore.test.mjs: real Express routers against an in-process fake
// PostgREST (globalThis.fetch answers the Supabase REST calls from in-memory tables), so the tests
// pin the real query-builder calls. The deal outlook (a workspace-wide model run) is replaced
// through its test seam. No network, no database.
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = 'http://fake-supabase.test';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-test';
process.env.SELF_HOSTED = 'true';
process.env.ENCRYPTION_KEY = 'a'.repeat(64);

const { default: express } = await import('express');
const { peopleV2Router } = await import('../src/routes/v2/people.mjs');
const { accountsV2Router } = await import('../src/routes/v2/accounts.mjs');
const { dealsV2Router } = await import('../src/routes/v2/deals.mjs');
const { pipelinesV2Router } = await import('../src/routes/v2/pipelines.mjs');
const { contextV2Router } = await import('../src/routes/v2/context.mjs');
const { __setOutlookRunnerForTests, parsePaging, unknownParams, stageResolver } = await import('../src/lib/publicApi.mjs');

// ── fake PostgREST ───────────────────────────────────────────────────────────
let tables = {};
let outlookCalls = 0;

const unquote = (v) => (v.startsWith('"') && v.endsWith('"') ? v.slice(1, -1) : v);
function cmp(a, b) {
  const da = Date.parse(a), db = Date.parse(b);
  if (typeof a === 'string' && Number.isFinite(da) && Number.isFinite(db) && /\d{4}-\d{2}-\d{2}/.test(a)) return da - db;
  if (typeof a === 'number' && b !== '' && Number.isFinite(Number(b))) return a - Number(b);
  return a < b ? -1 : a > b ? 1 : 0;
}
const likeRe = (pat, flags) => new RegExp(`^${pat.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/[%*]/g, '.*')}$`, flags);
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
    case 'like': return v != null && likeRe(raw, '').test(String(v));
    case 'ilike': return v != null && likeRe(raw, 'i').test(String(v));
    case 'cs': return Array.isArray(v) && raw.replace(/^\{|\}$/g, '').split(',').every((x) => v.includes(x));
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
function partMatch(row, part) {
  if (part.startsWith('and(')) return splitTop(part.slice(4, -1)).every((p) => partMatch(row, p));
  const i = part.indexOf('.');
  return test1(row, part.slice(0, i), part.slice(i + 1));
}
const orMatch = (row, expr) => splitTop(expr.replace(/^\(|\)$/g, '')).some((p) => partMatch(row, p));
const RESERVED = new Set(['select', 'order', 'limit', 'offset', 'on_conflict', 'columns']);
function filterRows(rows, params) {
  return rows.filter((r) => {
    for (const [k, v] of params) {
      if (RESERVED.has(k)) continue;
      if (k === 'or') { if (!orMatch(r, v)) return false; continue; }
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
async function fakeSupabase(url, init = {}) {
  const u = new URL(url);
  const method = (init.method || 'GET').toUpperCase();
  const headers = new Headers(init.headers || {});
  const json = (body, status = 200, extra = {}) => new Response(body === undefined ? '' : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...extra } });
  if (u.pathname.startsWith('/rest/v1/rpc/')) return json(null);
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
    const list = (Array.isArray(body) ? body : [body]).map((r) => ({ id: r.id ?? `gen-${++idN}`, ...r }));
    tables[table].push(...list);
    if (wantsObject) return json(list[0], 201);
    return json(prefer.includes('return=representation') ? list : null, 201);
  }
  if (method === 'PATCH') {
    const hit = filterRows(tables[table], params);
    for (const r of hit) Object.assign(r, body);
    return json(prefer.includes('return=representation') ? (wantsObject ? hit[0] : hit) : null, 200);
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
const ACME = 'a0000000-0000-4000-8000-00000000000a';      // CRM deals D_OPEN + D_WON
const GLOBEX = 'b0000000-0000-4000-8000-00000000000b';    // no CRM deal -> implied deal
const INITECH = 'c0000000-0000-4000-8000-00000000000c';   // CRM deal D_OTHER, outside the member's book
const SARAH = 'd0000000-0000-4000-8000-00000000000d';     // at Acme, stakeholder on D_OPEN
const BOB = 'e0000000-0000-4000-8000-00000000000e';       // at Globex
const PETER = 'f0000000-0000-4000-8000-00000000000f';     // at Initech
const COLD = '10000000-0000-4000-8000-000000000010';      // cold lead: list rows only, no contacts-view row
const D_OPEN = '20000000-0000-4000-8000-000000000020';
const D_WON = '30000000-0000-4000-8000-000000000030';
const D_OTHER = '40000000-0000-4000-8000-000000000040';
const MEMBER = '55555555-5555-4555-8555-555555555555';

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.workspaceId = WS;
  req.viewerScope = req.get('x-test-scope') || 'admin';
  req.memberUserId = req.viewerScope === 'member' ? MEMBER : null;
  next();
});
app.use('/v2/people', peopleV2Router);
app.use('/v2/accounts', accountsV2Router);
app.use('/v2/deals', dealsV2Router);
app.use('/v2/pipelines', pipelinesV2Router);
app.use('/v2/context', contextV2Router);
const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
const base = `http://127.0.0.1:${server.address().port}`;
after(() => { __setOutlookRunnerForTests(null); server.closeAllConnections?.(); server.close(); });
const call = async (method, path, body, headers = {}) => {
  const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
const member = { 'x-test-scope': 'member' };

const days = (n) => new Date(Date.now() + n * 86400000).toISOString();
const day = (n) => days(n).slice(0, 10);

beforeEach(() => {
  outlookCalls = 0;
  // The outlook scores accounts; Acme's open deal is likely, Globex's implied deal less so.
  __setOutlookRunnerForTests(async () => {
    outlookCalls++;
    return {
      deals: [
        { entityId: ACME, pWin: 0.62, pWinWithin: { 30: 0.31 } },
        { entityId: INITECH, pWin: 0.4, pWinWithin: { 30: null } },
        { entityId: GLOBEX, pWin: 0.2, pWinWithin: { 30: 0.05 } },
      ],
    };
  });
  const noteClaim = (id, entity, category, content, obsIds = []) => ({
    id, workspace_id: WS, entity_id: entity, property: `note.${id}`, invalid_at: null,
    value: { category, content, source: 'agent', metadata: { voiced_by_contact_id: entity, ...(category === 'authority' ? { role: 'champion' } : {}) } },
    supporting_observation_ids: obsIds, valid_from: '2026-09-20T00:00:00Z', computed_at: '2026-09-20T00:00:00Z', confidence: 1,
  });
  const dealClaims = (id, o) => Object.entries(o).map(([property, value], i) => ({ id: `${id}-c${i}`, workspace_id: WS, entity_id: id, property, value, invalid_at: null }));
  tables = {
    workspaces: [{ id: WS, team_id: 'team-1', open_account_visibility: null, focus_country: null }],
    entities: [
      ...[ACME, GLOBEX, INITECH].map((id) => ({ id, workspace_id: WS, type: 'company', status: 'active' })),
      ...[SARAH, BOB, PETER, COLD].map((id) => ({ id, workspace_id: WS, type: 'person', status: 'active' })),
      ...[D_OPEN, D_WON, D_OTHER].map((id) => ({ id, workspace_id: WS, type: 'deal', status: 'active' })),
    ],
    companies: [
      { id: ACME, workspace_id: WS, name: 'Acme', domain: 'acme.com' },
      { id: GLOBEX, workspace_id: WS, name: 'Globex', domain: 'globex.com' },
      { id: INITECH, workspace_id: WS, name: 'Initech', domain: 'initech.com' },
    ],
    contacts: [
      { id: SARAH, workspace_id: WS, first_name: 'Sarah', last_name: 'Lee', email: 'sarah@acme.com', job_title: 'VP Sales', company_id: ACME, company: 'Acme', pipeline_stage: 'discovery', last_activity_at: days(-2), icp_score: 88, icp_fit: true },
      { id: BOB, workspace_id: WS, first_name: 'Bob', last_name: 'Ray', email: 'bob@globex.com', job_title: 'CEO', company_id: GLOBEX, company: 'Globex', pipeline_stage: 'negotiation', last_activity_at: days(-1), deal_value: 12000, icp_score: 60, icp_fit: false },
      { id: PETER, workspace_id: WS, first_name: 'Peter', last_name: 'Gibbons', email: 'peter@initech.com', job_title: 'Engineer', company_id: INITECH, company: 'Initech', pipeline_stage: 'connected', last_activity_at: days(-40), icp_score: 40, icp_fit: false },
    ],
    entity_list_rows: [
      { workspace_id: WS, entity_id: ACME, kind: 'account', name: 'Acme', domain: 'acme.com', industry: 'Software', country: 'US', icp_score: 88, deal_health: 74, people_count: 1, open_deals: 1, pipeline_value: 50000, won_value: 20000, won_deals: 1, child_deals: 0, last_lost_at: null, owner_name: 'Chris Black', owner_email: 'chris@us.com', last_activity_at: days(-2), last_inbound_at: days(-3), last_engaged_at: days(-3) },
      { workspace_id: WS, entity_id: GLOBEX, kind: 'account', name: 'Globex', domain: 'globex.com', industry: 'Manufacturing', country: 'CA', icp_score: 60, deal_health: 55, people_count: 1, open_deals: 0, pipeline_value: null, won_value: null, won_deals: 0, child_deals: 0, last_lost_at: null, owner_name: 'Dana Fox', owner_email: 'dana@us.com', last_activity_at: days(-1), last_inbound_at: days(-1), last_engaged_at: days(-1) },
      { workspace_id: WS, entity_id: INITECH, kind: 'account', name: 'Initech', domain: 'initech.com', industry: 'Software', country: 'US', icp_score: 40, deal_health: 30, people_count: 1, open_deals: 1, pipeline_value: 9000, won_value: null, won_deals: 0, child_deals: 0, last_lost_at: null, owner_name: 'Chris Black', owner_email: 'chris@us.com', last_activity_at: days(-40), last_inbound_at: null, last_engaged_at: null },
      { workspace_id: WS, entity_id: SARAH, kind: 'person', name: 'Sarah Lee', email: 'sarah@acme.com', job_title: 'VP Sales', company_id: ACME, company_name: 'Acme', country: 'US', stage: 'discovery', icp_score: 88, last_activity_at: days(-2) },
      { workspace_id: WS, entity_id: BOB, kind: 'person', name: 'Bob Ray', email: 'bob@globex.com', job_title: 'CEO', company_id: GLOBEX, company_name: 'Globex', country: 'CA', stage: 'negotiation', icp_score: 60, last_activity_at: days(-1) },
      { workspace_id: WS, entity_id: PETER, kind: 'person', name: 'Peter Gibbons', email: 'peter@initech.com', job_title: 'Engineer', company_id: INITECH, company_name: 'Initech', country: 'US', stage: 'connected', icp_score: 40, last_activity_at: days(-40) },
      { workspace_id: WS, entity_id: COLD, kind: 'person', name: 'Cold Lead', email: 'cold@acme.com', job_title: 'Analyst', company_id: ACME, company_name: 'Acme', country: 'US', stage: null, icp_score: 20, last_activity_at: null },
      { workspace_id: WS, entity_id: D_OPEN, kind: 'deal', name: 'Acme expansion', company_id: ACME, company_name: 'Acme', country: 'US', stage: 'Contract Sent', status: 'open', pipeline_value: 50000, close_date: day(20), owner_name: 'Chris Black', pipeline_ref: 'default', pipeline: 'Sales Pipeline', last_activity_at: days(-2) },
      { workspace_id: WS, entity_id: D_WON, kind: 'deal', name: 'Acme pilot', company_id: ACME, company_name: 'Acme', country: 'US', stage: 'Closed Won', status: 'won', pipeline_value: 20000, close_date: day(-100), owner_name: 'Chris Black', pipeline_ref: 'default', pipeline: 'Sales Pipeline', last_activity_at: days(-100) },
      { workspace_id: WS, entity_id: D_OTHER, kind: 'deal', name: 'Initech renewal', company_id: INITECH, company_name: 'Initech', country: 'US', stage: 'Upsell Talk', status: 'open', pipeline_value: 9000, close_date: day(90), owner_name: 'Chris Black', pipeline_ref: 'exp-1', pipeline: 'Expansion', last_activity_at: days(-40) },
    ],
    relationships: [
      { id: 'r1', workspace_id: WS, from_entity_id: D_OPEN, to_entity_id: ACME, type: 'belongs_to', valid_to: null },
      { id: 'r2', workspace_id: WS, from_entity_id: D_WON, to_entity_id: ACME, type: 'belongs_to', valid_to: null },
      { id: 'r3', workspace_id: WS, from_entity_id: D_OTHER, to_entity_id: INITECH, type: 'belongs_to', valid_to: null },
      { id: 'r4', workspace_id: WS, from_entity_id: SARAH, to_entity_id: D_OPEN, type: 'stakeholder_of', valid_to: null },
      { id: 'r5', workspace_id: WS, from_entity_id: SARAH, to_entity_id: ACME, type: 'works_at', valid_to: null },
      { id: 'r6', workspace_id: WS, from_entity_id: BOB, to_entity_id: GLOBEX, type: 'works_at', valid_to: null },
    ],
    claims: [
      ...dealClaims(D_OPEN, { name: 'Acme expansion', stage: 'Contract Sent', status: 'open', value: 50000, close_date: day(20), owner_email: 'chris@us.com', owner_name: 'Chris Black', currency: 'USD' }),
      ...dealClaims(D_WON, { name: 'Acme pilot', stage: 'Closed Won', status: 'won', value: 20000, close_date: day(-100), owner_email: 'chris@us.com' }),
      ...dealClaims(D_OTHER, { name: 'Initech renewal', stage: 'Upsell Talk', status: 'open', value: 9000, close_date: day(90) }),
      noteClaim('n-obj', SARAH, 'objection', 'Worried about the migration effort', ['obs-call']),
      noteClaim('n-comp', SARAH, 'competitor', 'Also looking at Gong'),
      noteClaim('n-auth', SARAH, 'authority', 'Sarah signs off on the budget'),
      noteClaim('n-bob', BOB, 'budget', 'Budget is 12k this year'),
      { id: 'own1', workspace_id: WS, entity_id: SARAH, property: 'relationship_owner', value: { primary: MEMBER, members: [] }, invalid_at: null },
    ],
    observations: [
      { id: 'obs-call', workspace_id: WS, entity_id: SARAH, property: 'interaction.call_held', value: { summary: 'Walked through the contract' }, source: 'fellow', observed_at: days(-2), raw: { body: 'SECRET TRANSCRIPT' }, owner_user_id: null },
      { id: 'obs-old', workspace_id: WS, entity_id: SARAH, property: 'interaction.email_received', value: { summary: 'Intro reply' }, source: 'gmail', observed_at: days(-30), raw: null, owner_user_id: null },
      { id: 'st1', workspace_id: WS, entity_id: D_OPEN, property: 'stage', value: 'Qualified', observed_at: days(-30), raw: { status: 'open' } },
      { id: 'st2', workspace_id: WS, entity_id: D_OPEN, property: 'stage', value: 'Contract Sent', observed_at: days(-10), raw: { status: 'open' } },
    ],
    observation_deals: [{ workspace_id: WS, deal_entity_id: D_OPEN, observation_id: 'obs-call', source: 'crm', confidence: 1, created_at: days(-2) }],
    workspace_stages: [
      { workspace_id: WS, key: 'qualified', label: 'Qualified', canonical: 'discovery', sort_order: 0, kind: 'active', pipeline_ref: null, external_ref: 's1' },
      { workspace_id: WS, key: 'contract_sent', label: 'Contract Sent', canonical: 'negotiation', sort_order: 1, kind: 'active', pipeline_ref: null, external_ref: 's2' },
      { workspace_id: WS, key: 'closed_won', label: 'Closed Won', canonical: 'closed_won', sort_order: 2, kind: 'won', pipeline_ref: null, external_ref: 's3' },
      { workspace_id: WS, key: 'upsell_talk', label: 'Upsell Talk', canonical: 'interested', sort_order: 0, kind: 'active', pipeline_ref: 'exp-1', external_ref: 'x1' },
    ],
    crm_sync_configs: [{ workspace_id: WS, provider: 'hubspot', primary_pipeline_ref: 'default', updated_at: '2026-09-01T00:00:00Z' }],
    predictions: [{ id: 'p1', workspace_id: WS, entity_id: SARAH, kind: 'icp_fit', predicted_value: { score: 88, fit: true, tier: 'tier_1' }, predicted_at: '2026-09-01T00:00:00Z' }],
    workspace_members: [],
    users: [],
    entity_identifiers: [
      { id: 'i1', workspace_id: WS, entity_id: SARAH, kind: 'email', value: 'sarah@acme.com', status: 'active' },
      { id: 'i2', workspace_id: WS, entity_id: ACME, kind: 'domain', value: 'acme.com', status: 'active' },
      { id: 'i3', workspace_id: WS, entity_id: GLOBEX, kind: 'domain', value: 'globex.com', status: 'active' },
    ],
  };
});
const closeWorkspace = () => { tables.workspaces[0].open_account_visibility = false; };

// ── helpers ──────────────────────────────────────────────────────────────────

test('helpers: paging defaults and caps, the allow-list, the stage resolver', async () => {
  assert.deepEqual(parsePaging({}), { limit: 50, offset: 0 });
  assert.deepEqual(parsePaging({ limit: '900', offset: '-4' }), { limit: 200, offset: 0 });
  assert.deepEqual(parsePaging({ limit: '900' }, { max: 50 }), { limit: 50, offset: 0 });
  assert.equal(unknownParams({ limit: '1' }, new Set(['limit'])), null);
  assert.equal(unknownParams({ colour: 'red' }, new Set(['limit'])).error, 'unknown_query_param');
  const { getSupabaseClient } = await import('@nous/core');
  const r = await stageResolver(getSupabaseClient(), WS, 'default', ['default', 'exp-1']);
  assert.equal(r.canonical('Contract Sent', 'default', 'open'), 'negotiation');
  assert.equal(r.canonical('Upsell Talk', 'exp-1', 'open'), 'interested', 'a non-primary pipeline reads its own ladder');
  assert.equal(r.canonical('Proposal Out', 'default', 'open'), 'negotiation', 'unknown labels fall back to the CRM heuristic');
  assert.equal(r.canonical('Contract Sent', 'default', 'won'), 'closed_won', 'the outcome wins over the label');
  assert.equal(r.labelFor('negotiation'), 'Contract Sent', "the workspace's own name for a canonical stage");
  assert.equal(r.labelFor('demo'), 'Demo');
});

// ── people ───────────────────────────────────────────────────────────────────

test('people/:id: by UUID and by email, with account, stage, icp, activity and deals', async () => {
  const r = await call('GET', `/v2/people/${SARAH}`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const p = r.body.person;
  assert.equal(p.entity_id, SARAH);
  assert.equal(p.name, 'Sarah Lee');
  assert.equal(p.title, 'VP Sales');
  assert.deepEqual(p.account, { entity_id: ACME, name: 'Acme', domain: 'acme.com' });
  assert.equal(p.stage, 'discovery');
  assert.deepEqual(p.icp, { score: 88, fit: true, tier: 'tier_1' });
  assert.deepEqual(p.recent_activity.map((a) => a.id), ['obs-call', 'obs-old']);
  assert.equal(p.recent_activity[0].summary, 'Walked through the contract');
  assert.ok(!JSON.stringify(p).includes('SECRET TRANSCRIPT'), 'never the raw message body');
  assert.deepEqual(p.stakeholder_of, [{ deal_id: D_OPEN, name: 'Acme expansion', stage: 'Contract Sent', status: 'open', amount: 50000, close_date: day(20) }]);

  const byEmail = await call('GET', '/v2/people/sarah@acme.com');
  assert.equal(byEmail.status, 200);
  assert.equal(byEmail.body.person.entity_id, SARAH);
});

test('people/:id: a name is 400, a company or unknown id is 404, outside the book is 404', async () => {
  assert.equal((await call('GET', '/v2/people/Sarah%20Lee')).body.error, 'invalid_id');
  const co = await call('GET', `/v2/people/${ACME}`);
  assert.equal(co.status, 404);
  assert.equal(co.body.error, 'person_not_found');
  assert.equal((await call('GET', '/v2/people/99999999-9999-4999-8999-999999999999')).status, 404);
  closeWorkspace();
  const hidden = await call('GET', `/v2/people/${PETER}`, null, member);
  assert.equal(hidden.status, 404);
  assert.equal(hidden.body.error, 'person_not_found');
  assert.equal((await call('GET', `/v2/people/${SARAH}`, null, member)).status, 200, 'in the book');
});

test('people list: include=all adds cold leads; account filters; include=all rejects what it cannot do', async () => {
  const engaged = await call('GET', '/v2/people');
  assert.equal(engaged.status, 200);
  assert.ok(!engaged.body.people.some((p) => p.id === COLD), 'default list unchanged: the contacts view');

  const all = await call('GET', '/v2/people?include=all');
  assert.equal(all.status, 200, JSON.stringify(all.body));
  assert.deepEqual(all.body.people.map((p) => p.id).sort(), [BOB, COLD, PETER, SARAH].sort());
  assert.equal(all.body.limit, 50);
  assert.equal(all.body.has_more, false);
  const cold = all.body.people.find((p) => p.id === COLD);
  assert.equal(cold.company_id, ACME);
  assert.equal(cold.first_name, 'Cold');

  const atAcme = await call('GET', `/v2/people?include=all&account=acme.com`);
  assert.deepEqual(atAcme.body.people.map((p) => p.id).sort(), [COLD, SARAH].sort());
  const atAcmeView = await call('GET', `/v2/people?account=${ACME}`);
  assert.deepEqual(atAcmeView.body.people.map((p) => p.id), [SARAH]);

  const paged = await call('GET', '/v2/people?include=all&limit=1&sort=icp_score');
  assert.deepEqual(paged.body.people.map((p) => p.id), [SARAH]);
  assert.equal(paged.body.has_more, true);

  assert.equal((await call('GET', '/v2/people?include=all&source=hubspot')).body.error, 'unknown_query_param');
  assert.equal((await call('GET', '/v2/people?include=all&sort=recently_added')).body.error, 'unknown_sort');
  assert.equal((await call('GET', '/v2/people?include=some')).body.error, 'invalid_include');
  assert.equal((await call('GET', '/v2/people?account=nowhere.example')).status, 404);
  assert.equal((await call('GET', '/v2/people?colour=red')).body.error, 'unknown_query_param');
});

test('people list include=all: a member key lists only its own book', async () => {
  closeWorkspace();
  const r = await call('GET', '/v2/people?include=all', null, member);
  assert.deepEqual(r.body.people.map((p) => p.id), [SARAH]);
});

test('people list include=all: a filter it cannot read is a 400, never a wider list', async () => {
  const bad = async (qs, code) => {
    const r = await call('GET', `/v2/people?include=all&${qs}`);
    assert.equal(r.status, 400, `${qs}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.error, code);
  };
  await bad('min_icp_score=high', 'invalid_min_icp_score');
  await bad('last_activity_before=30days', 'invalid_duration');
  await bad('last_activity_after=soon', 'invalid_duration');
  assert.equal((await call('GET', '/v2/people?include=all&min_icp_score=80&last_activity_after=30d')).status, 200);
});

// ── accounts ─────────────────────────────────────────────────────────────────

test('accounts list: the windowed list, newest activity first, in the public shape', async () => {
  const r = await call('GET', '/v2/accounts');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  // Initech has an open deal, so it is in the window even though it has been quiet for 40 days.
  assert.deepEqual(r.body.accounts.map((a) => a.entity_id), [GLOBEX, ACME, INITECH]);
  const acme = r.body.accounts.find((a) => a.entity_id === ACME);
  assert.deepEqual(acme, {
    entity_id: ACME, name: 'Acme', domain: 'acme.com', industry: 'Software', country: 'US',
    icp_score: 88, icp_tier: null, icp_fit: true, health: 74, stage: 'discovery', people_count: 1,
    open_deals: 1, pipeline_value: 50000, won_value: 20000, owner: { name: 'Chris Black', email: 'chris@us.com' },
    last_activity_at: acme.last_activity_at, last_inbound_at: acme.last_inbound_at,
  });
  assert.equal(r.body.accounts.find((a) => a.entity_id === GLOBEX).stage, 'negotiation');
  assert.deepEqual([r.body.limit, r.body.offset, r.body.has_more], [50, 0, false]);
});

test('accounts list: filters and sorts', async () => {
  const ids = async (qs) => { const r = await call('GET', `/v2/accounts?${qs}`); assert.equal(r.status, 200, `${qs}: ${JSON.stringify(r.body)}`); return r.body.accounts.map((a) => a.entity_id); };
  assert.deepEqual(await ids('search=glob'), [GLOBEX]);
  assert.deepEqual(await ids('stage=negotiation'), [GLOBEX]);
  assert.deepEqual(await ids('icp_fit=true'), [ACME]);
  assert.deepEqual(await ids('icp_fit=false'), [GLOBEX, INITECH]);
  assert.deepEqual(await ids('min_icp_score=50'), [GLOBEX, ACME]);
  assert.deepEqual(await ids('owner=chris@us.com'), [ACME, INITECH]);
  assert.deepEqual(await ids('owner=nobody@us.com'), [], 'an unknown owner matches nothing, never everything');
  assert.deepEqual(await ids('country=CA'), [GLOBEX]);
  assert.deepEqual(await ids('has_open_deal=true'), [ACME, INITECH]);
  assert.deepEqual(await ids('has_open_deal=false'), [GLOBEX]);
  assert.deepEqual(await ids('last_activity_before=30d'), [INITECH]);
  assert.deepEqual(await ids('last_activity_after=7d'), [GLOBEX, ACME]);
  assert.deepEqual(await ids('sort=icp_score'), [ACME, GLOBEX, INITECH]);
  assert.deepEqual(await ids('sort=pipeline_value'), [ACME, INITECH, GLOBEX]);
  assert.deepEqual(await ids('sort=health'), [ACME, GLOBEX, INITECH]);
  assert.deepEqual(await ids('limit=1&offset=1'), [ACME]);
});

test('accounts list: include=all drops the window', async () => {
  // A never-dealt account that has not answered in 45 days is outside the window.
  tables.entity_list_rows.push({ workspace_id: WS, entity_id: '50000000-0000-4000-8000-000000000050', kind: 'account', name: 'Dormant', domain: 'dormant.com', open_deals: 0, won_deals: 0, child_deals: 0, last_lost_at: null, last_activity_at: days(-200), last_inbound_at: days(-200), last_engaged_at: days(-200), people_count: 0 });
  assert.equal((await call('GET', '/v2/accounts')).body.accounts.length, 3);
  assert.equal((await call('GET', '/v2/accounts?include=all')).body.accounts.length, 4);
});

test('accounts list: sort=win_chance ranks by the outlook, open-deal accounts only, limit capped at 50', async () => {
  const r = await call('GET', '/v2/accounts?sort=win_chance&limit=500');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.accounts.map((a) => a.entity_id), [ACME, INITECH, GLOBEX]);
  assert.equal(r.body.limit, 50);
  assert.equal(r.body.accounts[0].win_probability, 0.62);
  assert.equal(r.body.accounts[0].close_within_30d, 0.31);
  assert.equal(outlookCalls, 1);
});

test('accounts list: parameter errors', async () => {
  const bad = async (qs, code) => { const r = await call('GET', `/v2/accounts?${qs}`); assert.equal(r.status, 400, qs); assert.equal(r.body.error, code, qs); return r.body; };
  const u = await bad('colour=red', 'unknown_query_param');
  assert.ok(u.supported.includes('has_open_deal'));
  await bad('sort=vibes', 'unknown_sort');
  await bad('stage=hot', 'invalid_stage');
  await bad('icp_fit=maybe', 'invalid_icp_fit');
  await bad('has_open_deal=yes', 'invalid_has_open_deal');
  await bad('min_icp_score=lots', 'invalid_min_icp_score');
  await bad('last_activity_before=a%20while', 'invalid_duration');
  await bad('include=everything', 'invalid_include');
});

test('accounts list: a member key lists only its own book', async () => {
  closeWorkspace();
  const r = await call('GET', '/v2/accounts', null, member);
  assert.deepEqual(r.body.accounts.map((a) => a.entity_id), [ACME]);
});

test('accounts/:id: keeps the record and adds people and deals in the list shapes', async () => {
  const r = await call('GET', `/v2/accounts/${ACME}`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.people_count, 2);
  assert.deepEqual(r.body.people.map((p) => p.entity_id).sort(), [COLD, SARAH].sort());
  assert.deepEqual(Object.keys(r.body.people[0]).sort(), ['email', 'entity_id', 'name', 'stage', 'title']);
  assert.deepEqual(r.body.deals.map((d) => d.id), [D_OPEN, D_WON], 'open first');
  const open = r.body.deals[0];
  assert.equal(open.canonical_stage, 'negotiation');
  assert.equal(open.implied, false);
  assert.deepEqual(open.account, { entity_id: ACME, name: 'Acme', domain: 'acme.com' });
  assert.equal(open.pipeline, null, 'listAccountDeals reads the pipeline off observations, none seeded here');
  assert.equal(open.last_activity_at, tables.entity_list_rows.find((x) => x.entity_id === D_OPEN).last_activity_at);

  const globex = await call('GET', `/v2/accounts/globex.com?compress=1`);
  assert.equal(globex.status, 200, JSON.stringify(globex.body));
  assert.equal(globex.body.recent_observations, undefined, 'compress=1 still drops the raw timeline');
  assert.equal(globex.body.deals.length, 1);
  assert.equal(globex.body.deals[0].id, `implied:${GLOBEX}`);
  assert.equal(globex.body.deals[0].implied, true);
  assert.equal(globex.body.deals[0].canonical_stage, 'negotiation');
  assert.equal(globex.body.deals[0].stage, 'Contract Sent', "the implied deal reads in the workspace's own stage names");

  closeWorkspace();
  const hidden = await call('GET', `/v2/accounts/${INITECH}`, null, member);
  assert.equal(hidden.status, 404);
  assert.equal(hidden.body.error, 'entity_not_found');
});

test('accounts outlook: the old account-ranked deal outlook, at its new paths', async () => {
  const list = await call('GET', '/v2/accounts/outlook?within_days=30&limit=2');
  assert.equal(list.status, 200, JSON.stringify(list.body));
  assert.equal(list.body.within_days, 30);
  assert.ok(Array.isArray(list.body.deals));
  assert.equal(list.body.deals[0].entity_id, ACME);
  const one = await call('GET', `/v2/accounts/${ACME}/outlook`);
  assert.equal(one.status, 200, JSON.stringify(one.body));
  assert.equal(one.body.entity_id, ACME);
  assert.equal((await call('GET', '/v2/accounts/nowhere.example/outlook')).body.error, 'entity_not_found');
});

// ── deals ────────────────────────────────────────────────────────────────────

test('deals list: CRM deals and implied deals, in one shape', async () => {
  const r = await call('GET', '/v2/deals');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.deals.map((d) => d.id), [`implied:${GLOBEX}`, D_OPEN, D_OTHER, D_WON], 'most recent activity first');
  const open = r.body.deals.find((d) => d.id === D_OPEN);
  assert.deepEqual(open, {
    id: D_OPEN, name: 'Acme expansion', account: { entity_id: ACME, name: 'Acme', domain: 'acme.com' },
    stage: 'Contract Sent', canonical_stage: 'negotiation', status: 'open', amount: 50000, currency: 'USD',
    close_date: day(20), owner: { name: 'Chris Black', email: 'chris@us.com' },
    pipeline: { id: 'default', name: 'Sales Pipeline' }, health: 74, win_probability: 0.62, close_within_30d: 0.31,
    // No fitted win model in the mock, so the odds are a rank (GET-832): Acme leads 3 open deals.
    win_rank: 1, win_rank_of: 3, odds_basis: 'rank',
    last_activity_at: open.last_activity_at, implied: false,
  });
  const implied = r.body.deals.find((d) => d.implied);
  assert.equal(implied.name, 'Globex deal');
  assert.equal(implied.amount, 12000, 'the value typed on the deal page');
  assert.equal(implied.canonical_stage, 'negotiation');
  assert.equal(implied.status, 'open');
  assert.equal(implied.pipeline, null);
  assert.equal(implied.win_probability, 0.2);
  assert.equal(implied.win_rank, 3);
  assert.equal(r.body.deals.find((d) => d.id === D_WON).win_probability, null, 'a closed deal carries no odds');
  assert.equal(r.body.deals.find((d) => d.id === D_OTHER).canonical_stage, 'interested', "the expansion pipeline's own ladder");
  assert.equal(outlookCalls, 1, 'one outlook run per request');
});

test('deals list: filters and sorts', async () => {
  const ids = async (qs) => { const r = await call('GET', `/v2/deals?${qs}`); assert.equal(r.status, 200, `${qs}: ${JSON.stringify(r.body)}`); return r.body.deals.map((d) => d.id); };
  assert.deepEqual(await ids('account=acme.com'), [D_OPEN, D_WON]);
  assert.deepEqual(await ids(`account=${GLOBEX}`), [`implied:${GLOBEX}`]);
  assert.deepEqual(await ids('pipeline=exp-1'), [D_OTHER]);
  assert.deepEqual(await ids('status=won'), [D_WON]);
  assert.deepEqual(await ids('stage=negotiation'), [`implied:${GLOBEX}`, D_OPEN]);
  assert.deepEqual(await ids('owner=chris@us.com'), [D_OPEN, D_OTHER, D_WON]);
  assert.deepEqual(await ids('owner=Dana%20Fox'), [`implied:${GLOBEX}`]);
  assert.deepEqual(await ids('closing_within_days=30'), [D_OPEN]);
  assert.deepEqual(await ids('min_amount=15000'), [D_OPEN, D_WON]);
  assert.deepEqual(await ids('implied=true'), [`implied:${GLOBEX}`]);
  assert.deepEqual(await ids('implied=false'), [D_OPEN, D_OTHER, D_WON]);
  assert.deepEqual(await ids('sort=close_date&implied=false'), [D_WON, D_OPEN, D_OTHER]);
  assert.deepEqual(await ids('sort=amount'), [D_OPEN, D_WON, `implied:${GLOBEX}`, D_OTHER]);
  assert.deepEqual(await ids('sort=win_probability'), [D_OPEN, D_OTHER, `implied:${GLOBEX}`, D_WON]);
  const page = await call('GET', '/v2/deals?limit=2&offset=1');
  assert.deepEqual(page.body.deals.map((d) => d.id), [D_OPEN, D_OTHER]);
  assert.equal(page.body.has_more, true);
});

test('deals list: parameter errors', async () => {
  const bad = async (qs, code, status = 400) => { const r = await call('GET', `/v2/deals?${qs}`); assert.equal(r.status, status, qs); assert.equal(r.body.error, code, qs); };
  await bad('colour=red', 'unknown_query_param');
  await bad('sort=vibes', 'unknown_sort');
  await bad('status=pending', 'invalid_status');
  await bad('stage=Contract%20Sent', 'invalid_stage');
  await bad('closing_within_days=soon', 'invalid_closing_within_days');
  await bad('min_amount=lots', 'invalid_min_amount');
  await bad('implied=maybe', 'invalid_implied');
  await bad('account=nowhere.example', 'account_not_found', 404);
});

test('deals list: a member key sees only deals on accounts in its book', async () => {
  closeWorkspace();
  const r = await call('GET', '/v2/deals', null, member);
  assert.deepEqual(r.body.deals.map((d) => d.id).sort(), [D_OPEN, D_WON].sort());
  const hidden = await call('GET', `/v2/deals?account=${INITECH}`, null, member);
  assert.equal(hidden.status, 404);
  assert.equal(hidden.body.error, 'account_not_found');
  assert.equal((await call('GET', `/v2/deals?account=${SARAH}`)).body.error, 'account_not_found', 'a person is not an account here');
});

test('deals list: legacy ?within_days still answers the account outlook (old MCP clients)', async () => {
  const r = await call('GET', '/v2/deals?within_days=30&limit=5');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.within_days, 30);
  assert.ok('ranked_by' in r.body);
});

test('deals list: an MCP client before 0.76 gets the outlook even with no within_days', async () => {
  // What @opennous/mcp 0.75 sends for `deals {}`: X-Nous-Client: mcp, no contract header.
  const old = await call('GET', '/v2/deals?limit=5', null, { 'x-nous-client': 'mcp' });
  assert.equal(old.status, 200, JSON.stringify(old.body));
  assert.ok('ranked_by' in old.body && 'open_deals' in old.body);
  // 0.76+ announces the v2 contract and gets the deal list; so does any non-MCP caller.
  const now = await call('GET', '/v2/deals?limit=5', null, { 'x-nous-client': 'mcp', 'x-nous-contract': '2' });
  assert.ok(Array.isArray(now.body.deals) && !('ranked_by' in now.body));
  const rest = await call('GET', '/v2/deals?limit=5');
  assert.ok(!('ranked_by' in rest.body));
});

test('deals/:id: a CRM deal in full', async () => {
  const r = await call('GET', `/v2/deals/${D_OPEN}`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const d = r.body.deal;
  assert.equal(d.id, D_OPEN);
  assert.equal(d.canonical_stage, 'negotiation');
  assert.equal(d.win_probability, 0.62);
  assert.equal(d.currency, 'USD');
  assert.equal(typeof d.health, 'number');
  assert.ok(d.health_detail && 'band' in d.health_detail);
  assert.deepEqual(d.stakeholders, [{ entity_id: SARAH, name: 'Sarah Lee', title: 'VP Sales', role: 'champion', conversations: 2 }]);
  assert.deepEqual(d.stage_history.map((s) => [s.stage, s.canonical_stage, s.current]), [['Qualified', 'discovery', false], ['Contract Sent', 'negotiation', true]]);
  assert.equal(d.activity[0].id, 'obs-call');
  assert.equal(d.activity[0].filed_to_deal, true);
  assert.deepEqual(d.activity[0].person, { entity_id: SARAH, name: 'Sarah Lee' });
  assert.ok(!JSON.stringify(d).includes('SECRET TRANSCRIPT'));
  assert.deepEqual(d.claims.objections.map((c) => c.content), ['Worried about the migration effort'], 'only what is filed to the deal');
  assert.deepEqual(d.claims.competitors, [], 'a roster claim not filed to the deal stays the account’s');
  assert.deepEqual(Object.keys(d.claims).sort(), ['budget', 'competitors', 'objections', 'timeline']);
  assert.ok(Array.isArray(d.line_items));
  assert.equal(d.close_record, null);
});

test('deals/:id: the implied deal of an account with no CRM deal; implied ids on CRM accounts 404', async () => {
  const r = await call('GET', `/v2/deals/implied:${GLOBEX}`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const d = r.body.deal;
  assert.equal(d.id, `implied:${GLOBEX}`);
  assert.equal(d.implied, true);
  assert.equal(d.canonical_stage, 'negotiation');
  assert.equal(d.win_probability, 0.2);
  assert.deepEqual(d.claims.budget.map((c) => c.content), ['Budget is 12k this year'], "the implied deal's claims are the account's");

  const crm = await call('GET', `/v2/deals/implied:${ACME}`);
  assert.equal(crm.status, 404);
  assert.equal(crm.body.error, 'deal_not_found');
  assert.equal((await call('GET', '/v2/deals/implied:not-a-uuid')).body.error, 'deal_not_found');
});

test('deals/:id: invisible or unknown deals are 404 deal_not_found', async () => {
  closeWorkspace();
  const hidden = await call('GET', `/v2/deals/${D_OTHER}`, null, member);
  assert.equal(hidden.status, 404);
  assert.equal(hidden.body.error, 'deal_not_found');
  assert.equal((await call('GET', `/v2/deals/${D_OPEN}`, null, member)).status, 200);
});

test('deals/:id: an account id falls back to the old account outlook (older MCP clients)', async () => {
  const byId = await call('GET', `/v2/deals/${ACME}`);
  assert.equal(byId.status, 200, JSON.stringify(byId.body));
  assert.equal(byId.body.entity_id, ACME);
  assert.equal(byId.body.deal, undefined, 'the outlook shape, not the deal shape');
  const byDomain = await call('GET', '/v2/deals/acme.com');
  assert.equal(byDomain.body.entity_id, ACME);
  assert.equal((await call('GET', '/v2/deals/nowhere.example')).body.error, 'entity_not_found');
});

// ── pipelines ────────────────────────────────────────────────────────────────

test('pipelines: CRM pipelines with their stages, primary first, plus the standard ladder', async () => {
  const r = await call('GET', '/v2/pipelines');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.implied, false);
  assert.equal(r.body.primary_pipeline_ref, 'default');
  assert.deepEqual(r.body.pipelines.map((p) => [p.id, p.name, p.is_primary]), [['default', 'Sales Pipeline', true], ['exp-1', 'Expansion', false]]);
  assert.deepEqual(r.body.pipelines[0].stages, [
    { key: 'qualified', label: 'Qualified', canonical: 'discovery', kind: 'active' },
    { key: 'contract_sent', label: 'Contract Sent', canonical: 'negotiation', kind: 'active' },
    { key: 'closed_won', label: 'Closed Won', canonical: 'closed_won', kind: 'won' },
  ]);
  assert.deepEqual(r.body.pipelines[1].stages.map((s) => s.label), ['Upsell Talk']);
  assert.equal(r.body.pipelines[0].open_deals, 1);
  assert.equal(r.body.standard_stages.length, 11);
  assert.deepEqual(r.body.standard_stages[0], { key: 'identified', label: 'Identified', rank: 0, kind: 'active' });
  assert.equal((await call('GET', '/v2/pipelines?x=1')).body.error, 'unknown_query_param');
});

test('pipelines: a workspace with no CRM gets the standard ladder, implied', async () => {
  tables.entity_list_rows = tables.entity_list_rows.filter((r) => r.kind !== 'deal');
  tables.crm_sync_configs = [];
  tables.workspace_stages = [];
  const r = await call('GET', '/v2/pipelines');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.pipelines, []);
  assert.equal(r.body.implied, true);
  assert.equal(r.body.standard_stages.at(-1).key, 'churned');
});

test('pipelines: a member key on a closed workspace gets no workspace-wide deal counts', async () => {
  closeWorkspace();
  const r = await call('GET', '/v2/pipelines', null, member);
  assert.equal(r.body.pipelines[0].open_deals, undefined);
});

// ── context on a deal ────────────────────────────────────────────────────────

test('context: a deal focus resolves to its account and leads with the deal', async () => {
  const r = await call('POST', '/v2/context', { focus: D_OPEN, intent: 'account_review' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(Object.keys(r.body)[0], 'deal', 'the deal comes first');
  assert.equal(r.body.deal.id, D_OPEN);
  assert.equal(r.body.deal.stakeholders[0].entity_id, SARAH);
  assert.deepEqual(r.body.deal.claims.objections.map((c) => c.content), ['Worried about the migration effort']);
  assert.equal(r.body.deal.stage_history, undefined, 'the block is the list shape + people + claims');

  const implied = await call('POST', '/v2/context', { focus: `implied:${GLOBEX}` });
  assert.equal(implied.status, 200, JSON.stringify(implied.body));
  assert.equal(implied.body.deal.id, `implied:${GLOBEX}`);

  closeWorkspace();
  const hidden = await call('POST', '/v2/context', { focus: D_OTHER }, member);
  assert.equal(hidden.status, 404);
  assert.equal(hidden.body.error, 'deal_not_found');
});

// ── context carries the Intelligence (GET-1042) ──────────────────────────────

test('context: an account focus carries what the workspace has learned, for that account', async () => {
  const { registerIntelligenceSource } = await import('@nous/core');
  const asked = [];
  registerIntelligenceSource(async (_sb, ws, opts) => {
    asked.push({ ws, ...opts });
    return { text: '## Intelligence\n\nLead with the migration plan. [objections:b1]', used: [{ key: 'objections', section: 'migration', blocks: ['b1'] }] };
  });
  try {
    // A person at a company reads it for their company; a draft asks for the draft cut.
    const person = await call('POST', '/v2/context', { focus: SARAH, intent: 'draft_email' });
    assert.equal(person.status, 200, JSON.stringify(person.body));
    assert.match(person.body.intelligence.text, /migration plan\. \[objections:b1\]/);
    assert.deepEqual(person.body.intelligence.used, [{ key: 'objections', section: 'migration', blocks: ['b1'] }]);
    assert.deepEqual(asked.at(-1), { ws: WS, companyId: ACME, purpose: 'draft', budget: 3500 });
    assert.ok(person.body.summary !== undefined, 'the rest of the context is unchanged');

    // A company, and a deal (its account), read it as a brief.
    const company = await call('POST', '/v2/context', { focus: GLOBEX, intent: 'meeting_prep' });
    assert.ok(company.body.intelligence);
    assert.deepEqual({ companyId: asked.at(-1).companyId, purpose: asked.at(-1).purpose }, { companyId: GLOBEX, purpose: 'brief' });
    const deal = await call('POST', '/v2/context', { focus: D_OPEN });
    assert.ok(deal.body.intelligence);
    assert.equal(asked.at(-1).companyId, ACME);

    // A person at no company is no account: null, and nothing asked.
    const n = asked.length;
    const loose = await call('POST', '/v2/context', { focus: COLD });
    assert.equal(loose.status, 200, JSON.stringify(loose.body));
    assert.equal(loose.body.intelligence, null);
    assert.equal(asked.length, n);
  } finally {
    registerIntelligenceSource(null);
  }
  // No source (a self-hosted install): the field is there, null.
  const plain = await call('POST', '/v2/context', { focus: SARAH });
  assert.equal(plain.body.intelligence, null);
});
