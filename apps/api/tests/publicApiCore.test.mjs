// The public API core: POST /v2/people/:id/enrich, the board read behind GET /v2/insights, and the
// agent's write into it (POST /v2/insights).
//
// Both routes are exercised end to end through Express against an in-process fake PostgREST
// (globalThis.fetch answers the Supabase REST calls from in-memory tables), so the tests pin the
// real query-builder calls, not a restatement of them. Provider HTTP (Findymail) is faked on the
// same stub. No network, no database.
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = 'http://fake-supabase.test';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-test';
process.env.SELF_HOSTED = 'true';            // requireEnrichmentQuota passes through, as on self-host
process.env.ENCRYPTION_KEY = 'a'.repeat(64);
delete process.env.ENRICHMENT_BUILTIN_FALLBACK;

const { default: express } = await import('express');
const { peopleV2Router, enrichmentFieldsAdded, isRecentlyEnriched, normaliseEnrichProvider } = await import('../src/routes/v2/people.mjs');
const { insightsV2Router, parseInsightsQuery, shapeInsight, collectWindow } = await import('../src/routes/v2/insights.mjs');
const { encrypt } = await import('../src/utils/encryption.js');

// ── fake PostgREST ───────────────────────────────────────────────────────────
let tables = {};
let providerCalls = [];
let findymailReply = null;

const unquote = (v) => (v.startsWith('"') && v.endsWith('"') ? v.slice(1, -1) : v);
function cmp(a, b) {
  const da = Date.parse(a), db = Date.parse(b);
  if (typeof a === 'string' && Number.isFinite(da) && Number.isFinite(db) && /\d{4}-\d{2}-\d{2}/.test(a)) return da - db;
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
    const ret = prefer.includes('return=representation') ? list : undefined;
    if (wantsObject) return json(list[0], 201);
    return json(ret ?? null, 201);
  }
  if (method === 'PATCH') {
    const hit = filterRows(tables[table], params);
    for (const r of hit) Object.assign(r, body);
    return json(prefer.includes('return=representation') ? (wantsObject ? hit[0] : hit) : null, 200);
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
  if (s.startsWith('https://app.findymail.com')) {
    providerCalls.push({ url: s, body: JSON.parse(init.body) });
    return new Response(JSON.stringify(findymailReply ?? {}), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (s.includes('127.0.0.1')) return realFetch(url, init);
  throw new Error(`unexpected network call in test: ${s}`);
};

// ── app under test ───────────────────────────────────────────────────────────
const WS = '11111111-1111-4111-8111-111111111111';
const PERSON = '22222222-2222-4222-8222-222222222222';
const COMPANY = '33333333-3333-4333-8333-333333333333';
const OTHER_CO = '44444444-4444-4444-8444-444444444444';
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
app.use('/v2/insights', insightsV2Router);
const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
const base = `http://127.0.0.1:${server.address().port}`;
after(() => { server.closeAllConnections?.(); server.close(); });
const call = async (method, path, body, headers = {}) => {
  const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};

const findymailKeyRow = () => ({ workspace_id: WS, provider_id: 'prov-findymail', is_verified: true, created_at: '2026-01-01T00:00:00Z', encrypted_credentials: { api_key: encrypt('fm_test_key') } });

beforeEach(() => {
  providerCalls = [];
  findymailReply = null;
  tables = {
    workspaces: [{ id: WS, team_id: 'team-1', business_type: null, open_account_visibility: null }],
    entities: [
      { id: PERSON, workspace_id: WS, type: 'person', status: 'active' },
      { id: COMPANY, workspace_id: WS, type: 'company', status: 'active' },
      { id: OTHER_CO, workspace_id: WS, type: 'company', status: 'active' },
    ],
    contacts: [{
      id: PERSON, workspace_id: WS, email: 'sarah@acme.com', linkedin_url: null, first_name: 'Sarah', last_name: 'Lee',
      company: null, domain: 'acme.com', job_title: null, enrichment_status: null, enrichment_source: null, enriched_at: null,
    }],
    workflow_providers: [{ id: 'prov-findymail', name: 'findymail' }, { id: 'prov-apollo', name: 'apollo' }, { id: 'prov-prospeo', name: 'prospeo' }],
    workflow_provider_connections: [],
    observations: [],
    claims: [],
    entity_identifiers: [],
    relationships: [],
    insight_tags: [],
    insight_items: [],
  };
});

// ── POST /v2/people/:id/enrich ───────────────────────────────────────────────

test('enrich: pure helpers', () => {
  assert.deepEqual(enrichmentFieldsAdded({ email: 'a@b.co', job_title: '', domain: null }, { email: 'a@b.co', job_title: 'CTO', domain: 'b.co', enrichment_status: 'complete' }), ['job_title', 'domain']);
  assert.equal(isRecentlyEnriched(new Date(Date.now() - 5 * 86400000).toISOString()), true);
  assert.equal(isRecentlyEnriched(new Date(Date.now() - 120 * 86400000).toISOString()), false);
  assert.equal(isRecentlyEnriched(null), false);
  assert.equal(normaliseEnrichProvider('Apollo'), 'apollo');
  assert.equal(normaliseEnrichProvider('hubspot'), null);
});

test('enrich: a non-UUID id is 400 invalid_id', async () => {
  const r = await call('POST', '/v2/people/sarah@acme.com/enrich', {});
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'invalid_id');
});

test('enrich: unknown id, or a company id, is 404 person_not_found', async () => {
  const a = await call('POST', `/v2/people/99999999-9999-4999-8999-999999999999/enrich`, {});
  assert.equal(a.status, 404);
  assert.equal(a.body.error, 'person_not_found');
  const b = await call('POST', `/v2/people/${COMPANY}/enrich`, {});
  assert.equal(b.status, 404);
  assert.equal(b.body.error, 'person_not_found');
});

test('enrich: a member key on a closed workspace cannot reach someone outside its book (404)', async () => {
  tables.workspaces[0].open_account_visibility = false;
  const r = await call('POST', `/v2/people/${PERSON}/enrich`, {}, { 'x-test-scope': 'member' });
  assert.equal(r.status, 404);
  assert.equal(r.body.error, 'person_not_found');
});

test('enrich: no provider key connected is 409 no_enrichment_provider', async () => {
  const r = await call('POST', `/v2/people/${PERSON}/enrich`, {});
  assert.equal(r.status, 409);
  assert.equal(r.body.error, 'no_enrichment_provider');
  assert.equal(providerCalls.length, 0);
});

test('enrich: a recent enrichment is reused without calling a provider, unless force', async () => {
  tables.workflow_provider_connections.push(findymailKeyRow());
  tables.observations.push({ id: 'o1', workspace_id: WS, entity_id: PERSON, method: 'enrichment', source: 'findymail', observed_at: new Date(Date.now() - 3 * 86400000).toISOString() });
  const r = await call('POST', `/v2/people/${PERSON}/enrich`, {});
  assert.equal(r.status, 200);
  assert.equal(r.body.enriched, false);
  assert.equal(r.body.cached, true);
  assert.equal(r.body.provider, null);
  assert.deepEqual(r.body.fields_added, []);
  assert.equal(r.body.person.id, PERSON);
  assert.equal(r.body.last_provider, 'findymail');
  assert.equal(providerCalls.length, 0, 'nothing spent inside the reuse window');

  findymailReply = { contact: { email: 'sarah@acme.com', linkedin_url: 'https://www.linkedin.com/in/sarahlee' } };
  const f = await call('POST', `/v2/people/${PERSON}/enrich`, { force: true });
  assert.equal(f.status, 200);
  assert.equal(f.body.cached, false);
  assert.equal(providerCalls.length, 1, 'force re-runs the waterfall');
});

test('enrich: runs the waterfall once and reports provider + fields added', async () => {
  tables.workflow_provider_connections.push(findymailKeyRow());
  findymailReply = { contact: { email: 'sarah@acme.com', linkedin_url: 'https://www.linkedin.com/in/sarahlee', company: 'Acme Inc' } };
  const r = await call('POST', `/v2/people/${PERSON}/enrich`, {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(providerCalls.length, 1);
  assert.match(providerCalls[0].url, /findymail\.com\/api\/search\/name/);
  assert.deepEqual(providerCalls[0].body, { name: 'Sarah Lee', domain: 'acme.com' });
  assert.equal(r.body.enriched, true);
  assert.equal(r.body.provider, 'findymail');
  assert.deepEqual(r.body.fields_added, ['linkedin_url']);
  assert.equal(r.body.person.linkedin_url, 'https://www.linkedin.com/in/sarahlee');
  // The provider's attributes land as enrichment observations with the true source.
  assert.ok(tables.observations.some((o) => o.method === 'enrichment' && o.source === 'findymail' && o.property === 'company'));
  assert.equal(r.body.person.enrichment_source, 'findymail');
  // The enrichment allowance counts this row; billable as its own unit, not an op.
  const log = tables.workspace_system_log.filter((l) => l.event_type === 'enrichment_run' && l.metadata?.from === 'v2_people');
  assert.equal(log.length, 1);
  assert.equal(log[0].billable_ops, 0);
});

test('enrich: a person with no usable identifier is 422, before any provider call', async () => {
  tables.workflow_provider_connections.push(findymailKeyRow());
  Object.assign(tables.contacts[0], { email: null, linkedin_url: null, domain: null });
  const r = await call('POST', `/v2/people/${PERSON}/enrich`, {});
  assert.equal(r.status, 422);
  assert.equal(r.body.error, 'no_usable_identifier');
  assert.equal(providerCalls.length, 0);
});

// ── GET /v2/insights ─────────────────────────────────────────────────────────

test('insights: query validation against the board taxonomy', () => {
  assert.equal(parseInsightsQuery({ lane: 'engineering' }).error, 'invalid_lane');
  assert.equal(parseInsightsQuery({ subtype: 'complaint' }).error, 'invalid_subtype');
  assert.equal(parseInsightsQuery({ lane: 'product', subtype: 'objection' }).error, 'subtype_not_in_lane');
  assert.equal(parseInsightsQuery({ since: 'last tuesday' }).error, 'invalid_since');
  assert.equal(parseInsightsQuery({ color: 'red' }).error, 'unknown_query_param');
  const ok = parseInsightsQuery({ lane: 'sales', subtype: 'objection', limit: '500', offset: '-3', since: '2026-09-01' });
  assert.equal(ok.error, undefined);
  assert.equal(ok.limit, 200, 'limit caps at 200');
  assert.equal(ok.offset, 0);
  assert.equal(ok.since, '2026-09-01T00:00:00.000Z');
  assert.equal(parseInsightsQuery({}).limit, 50, 'default limit 50');
});

test('insights: shapeInsight maps the store onto the public shape', () => {
  const out = shapeInsight(
    { id: 'i1', lane: null, subtype: 'pricing', statement: 'Too expensive per seat', quote: 'q', speaker: 'Bob', company_id: 'c1', source_ref: 'source://fellow/9', occurred_at: '2026-09-02T00:00:00Z', tag_ids: ['t2', 'gone', 't1'] },
    new Map([['t1', 'Seats'], ['t2', 'Pricing page']]), new Map([['c1', 'Acme']]),
  );
  assert.deepEqual(out, {
    id: 'i1', lane: 'sales', subtype: 'pricing', content: 'Too expensive per seat', quote: 'q', speaker: 'Bob',
    account: { entity_id: 'c1', name: 'Acme' }, source_ref: 'source://fellow/9', occurred_at: '2026-09-02T00:00:00Z',
    tags: ['Pricing page', 'Seats'],
    // The board row it sits on: what POST /v2/insights/topics/:key/linear takes (GET-825).
    topic_key: 'pricing|t2',
  });
});

test('insights: POST /topics/:key/linear without a Linear connection is 409, never a 500 (GET-825)', async () => {
  seedBoard();
  const r = await call('POST', `/v2/insights/topics/${encodeURIComponent('objection|t-gong')}/linear`, {});
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.equal(r.body.error, 'linear_not_connected');
});

test('insights: collectWindow pages past rows the filter drops', async () => {
  const src = Array.from({ length: 23 }, (_, i) => ({ n: i }));
  const fetchPage = async (from, to) => src.slice(from, to + 1);
  const keep = (r) => r.n % 2 === 0;                     // 12 kept: 0,2,…,22
  const w = await collectWindow(fetchPage, keep, { offset: 3, limit: 4, pageSize: 5 });
  assert.deepEqual(w.rows.map((r) => r.n), [6, 8, 10, 12]);
  assert.equal(w.has_more, true);
  const end = await collectWindow(fetchPage, keep, { offset: 10, limit: 4, pageSize: 5 });
  assert.deepEqual(end.rows.map((r) => r.n), [20, 22]);
  assert.equal(end.has_more, false);
});

function seedBoard() {
  tables.insight_tags.push(
    { id: 't-gong', workspace_id: WS, name: 'Gong', definition: null, aliases: [], origin: 'model', retired_at: null },
    { id: 't-esign', workspace_id: WS, name: 'E-signature', definition: null, aliases: [], origin: 'model', retired_at: null },
  );
  tables.claims.push(
    { id: 'cl1', workspace_id: WS, entity_id: COMPANY, property: 'name', value: 'Acme', invalid_at: null },
    { id: 'cl2', workspace_id: WS, entity_id: OTHER_CO, property: 'name', value: 'Globex', invalid_at: null },
  );
  const item = (o) => ({ workspace_id: WS, source: 'external', category: 'buyer', quote: null, speaker: null, speaker_id: null, contact_id: null, source_ref: null, tag_ids: [], lane: null, ...o });
  tables.insight_items.push(
    item({ id: 'i-obj', subtype: 'objection', lane: 'sales', statement: 'They already use Gong', company_id: COMPANY, contact_id: PERSON, tag_ids: ['t-gong'], occurred_at: '2026-09-20T10:00:00Z', quote: 'we have gong', speaker: 'Sarah Lee', source_ref: 'source://fellow/1' }),
    item({ id: 'i-bug', subtype: 'bug', lane: 'product', statement: 'E-signature fails on Android', company_id: OTHER_CO, tag_ids: ['t-esign'], occurred_at: '2026-09-10T10:00:00Z' }),
    item({ id: 'i-old', subtype: 'pricing', lane: 'sales', statement: 'Price per seat is too high', company_id: COMPANY, occurred_at: '2026-06-01T10:00:00Z' }),
    item({ id: 'i-unplaced', subtype: null, statement: 'not sorted yet', company_id: COMPANY, occurred_at: '2026-09-25T10:00:00Z' }),
    item({ id: 'i-noacct', subtype: 'feature', lane: 'product', statement: 'Wants a Slack bot', company_id: null, occurred_at: '2026-09-24T10:00:00Z' }),
    item({ id: 'i-team', source: 'team', subtype: 'feature', statement: 'internal decision', company_id: COMPANY, occurred_at: '2026-09-23T10:00:00Z' }),
  );
}

test('insights: GET returns placed, account-tied insights newest first with the taxonomy', async () => {
  seedBoard();
  const r = await call('GET', '/v2/insights');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.insights.map((i) => i.id), ['i-obj', 'i-bug', 'i-old']);
  assert.deepEqual(r.body.insights[0], {
    id: 'i-obj', lane: 'sales', subtype: 'objection', content: 'They already use Gong', quote: 'we have gong', speaker: 'Sarah Lee',
    account: { entity_id: COMPANY, name: 'Acme' }, source_ref: 'source://fellow/1', occurred_at: '2026-09-20T10:00:00Z', tags: ['Gong'],
    topic_key: 'objection|t-gong',
  });
  assert.equal(r.body.limit, 50);
  assert.equal(r.body.offset, 0);
  assert.equal(r.body.has_more, false);
  assert.equal(r.body.taxonomy.lanes.length, 4);
  assert.equal(r.body.taxonomy.subtypes.length, 10);
  const bug = r.body.taxonomy.subtypes.find((s) => s.key === 'bug');
  assert.deepEqual(Object.keys(bug).sort(), ['definition', 'key', 'label', 'lane']);
  assert.equal(bug.label, 'Bug');
});

test('insights: a retired duplicate, or one whose source was removed, is not listed (0.7)', async () => {
  seedBoard();
  tables.insight_items.find((i) => i.id === 'i-bug').status = 'duplicate';
  tables.insight_items.find((i) => i.id === 'i-old').status = 'source_removed';
  const r = await call('GET', '/v2/insights');
  assert.deepEqual(r.body.insights.map((i) => i.id), ['i-obj']);
});

test('insights: lane, subtype, since, focus and paging filter the board', async () => {
  seedBoard();
  const sales = await call('GET', '/v2/insights?lane=sales');
  assert.deepEqual(sales.body.insights.map((i) => i.id), ['i-obj', 'i-old']);
  const bug = await call('GET', '/v2/insights?subtype=bug');
  assert.deepEqual(bug.body.insights.map((i) => i.id), ['i-bug']);
  const since = await call('GET', '/v2/insights?since=2026-09-01');
  assert.deepEqual(since.body.insights.map((i) => i.id), ['i-obj', 'i-bug']);
  const co = await call('GET', `/v2/insights?focus=${COMPANY}`);
  assert.deepEqual(co.body.insights.map((i) => i.id), ['i-obj', 'i-old']);
  const person = await call('GET', `/v2/insights?focus=${PERSON}`);
  assert.deepEqual(person.body.insights.map((i) => i.id), ['i-obj']);
  const page = await call('GET', '/v2/insights?limit=1&offset=1');
  assert.deepEqual(page.body.insights.map((i) => i.id), ['i-bug']);
  assert.equal(page.body.has_more, true);
});

test('insights: errors — bad taxonomy is 400, unknown or bare-name focus is 404/400', async () => {
  const a = await call('GET', '/v2/insights?lane=product&subtype=pricing');
  assert.equal(a.status, 400);
  assert.equal(a.body.error, 'subtype_not_in_lane');
  const b = await call('GET', '/v2/insights?focus=Acme');
  assert.equal(b.status, 400);
  assert.equal(b.body.error, 'invalid_focus');
  const c = await call('GET', '/v2/insights?focus=99999999-9999-4999-8999-999999999999');
  assert.equal(c.status, 404);
  assert.equal(c.body.error, 'focus_not_found');
});

// ── POST /v2/insights: tied to an account (GET-970) ─────────────────────────

test('insights: POST with a person focus ties the insight to them and their company, and GET reads it back', async () => {
  tables.entity_identifiers.push({ entity_id: PERSON, workspace_id: WS, kind: 'email', value: 'sarah@acme.com', status: 'active' });
  tables.relationships.push({ workspace_id: WS, type: 'works_at', from_entity_id: PERSON, to_entity_id: COMPANY, valid_to: null });
  tables.claims.push(
    { id: 'cl1', workspace_id: WS, entity_id: COMPANY, property: 'name', value: 'Acme', invalid_at: null },
    { id: 'cl3', workspace_id: WS, entity_id: PERSON, property: 'name', value: 'Sarah Lee', invalid_at: null },
  );
  const w = await call('POST', '/v2/insights', {
    focus: 'sarah@acme.com', source_ref: 'source://fireflies/m1', occurred_at: '2026-10-20T10:00:00Z',
    insights: [{ category: 'product', content: 'Wants activity pushed into Slack', quote: 'if it is in Slack they read it', speaker: 'Sarah Lee' }],
  });
  assert.equal(w.status, 201, JSON.stringify(w.body));
  assert.deepEqual(w.body.accounts, [COMPANY]);
  const row = tables.insight_items.find((i) => i.statement === 'Wants activity pushed into Slack');
  assert.equal(row.company_id, COMPANY);
  assert.equal(row.contact_id, PERSON);
  assert.equal(row.speaker_id, PERSON);
  assert.equal(row.source_ref, 'source://fireflies/m1');
  assert.equal(row.source_system, 'fireflies');
  // The nightly sort places it on the board; then the agent reads back what it wrote.
  Object.assign(row, { subtype: 'feature', lane: 'product' });
  const r = await call('GET', `/v2/insights?focus=${COMPANY}`);
  assert.deepEqual(r.body.insights.map((i) => i.content), ['Wants activity pushed into Slack']);
  assert.equal(r.body.insights[0].account.name, 'Acme');
});

test('insights: POST with a company domain ties it to the company; a per-insight focus overrides', async () => {
  tables.entity_identifiers.push(
    { entity_id: COMPANY, workspace_id: WS, kind: 'domain', value: 'acme.com', status: 'active' },
    { entity_id: OTHER_CO, workspace_id: WS, kind: 'domain', value: 'globex.com', status: 'active' },
  );
  const w = await call('POST', '/v2/insights', {
    focus: 'acme.com',
    insights: [
      { category: 'market', content: 'Agencies need a shared data layer' },
      { category: 'buyer', content: 'RevOps owns the tooling budget', focus: 'globex.com' },
    ],
  });
  assert.equal(w.status, 201, JSON.stringify(w.body));
  const by = Object.fromEntries(tables.insight_items.map((i) => [i.category, i]));
  assert.equal(by.market.company_id, COMPANY);
  assert.equal(by.market.contact_id ?? null, null);
  assert.equal(by.buyer.company_id, OTHER_CO);
});

test('insights: POST without a focus, with a bare name, or with an unknown one writes nothing', async () => {
  const one = [{ category: 'product', content: 'Wants activity pushed into Slack' }];
  const none = await call('POST', '/v2/insights', { insights: one });
  assert.equal(none.status, 400);
  assert.equal(none.body.error, 'focus_required');
  const name = await call('POST', '/v2/insights', { focus: 'Sarah Lee', insights: one });
  assert.equal(name.status, 400);
  assert.equal(name.body.error, 'invalid_focus');
  const unknown = await call('POST', '/v2/insights', { focus: '99999999-9999-4999-8999-999999999999', insights: one });
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.error, 'focus_not_found');
  // One insight in a batch without a focus refuses the whole batch.
  tables.entity_identifiers.push({ entity_id: COMPANY, workspace_id: WS, kind: 'domain', value: 'acme.com', status: 'active' });
  const half = await call('POST', '/v2/insights', { insights: [{ ...one[0], focus: 'acme.com' }, { category: 'market', content: 'Agencies need a data layer' }] });
  assert.equal(half.status, 400);
  assert.equal(tables.insight_items.length, 0);
});

test('insights: POST refuses a focus that could never be read back, and one of our own', async () => {
  const one = [{ category: 'product', content: 'Wants activity pushed into Slack' }];
  // A person with no company: GET lists account-tied insights only, so it would vanish.
  tables.entity_identifiers.push({ entity_id: PERSON, workspace_id: WS, kind: 'email', value: 'sarah@acme.com', status: 'active' });
  const lone = await call('POST', '/v2/insights', { focus: 'sarah@acme.com', insights: one });
  assert.equal(lone.status, 422);
  assert.equal(lone.body.error, 'focus_has_no_account');
  // Two current employers: no guessing which.
  tables.relationships.push(
    { workspace_id: WS, type: 'works_at', from_entity_id: PERSON, to_entity_id: COMPANY, valid_to: null },
    { workspace_id: WS, type: 'works_at', from_entity_id: PERSON, to_entity_id: OTHER_CO, valid_to: null },
  );
  const two = await call('POST', '/v2/insights', { focus: 'sarah@acme.com', insights: one });
  assert.equal(two.status, 422);
  // Our own domain is not a customer.
  tables.workspace_own_domains = [{ workspace_id: WS, domain: 'acme.com' }];
  const ours = await call('POST', '/v2/insights', { focus: 'acme.com', insights: one });
  assert.equal(ours.status, 400);
  assert.equal(ours.body.error, 'focus_is_internal');
  assert.equal(tables.insight_items.length, 0);
});

test('insights: the same point from two accounts is two insights; a merged id lands on the live one', async () => {
  const MERGED = '66666666-6666-4666-8666-666666666666';
  tables.entities.push({ id: MERGED, workspace_id: WS, type: 'company', status: 'merged', merged_into: OTHER_CO });
  const one = [{ category: 'product', content: 'Wants activity pushed into Slack' }];
  const a = await call('POST', '/v2/insights', { focus: COMPANY, insights: one });
  const b = await call('POST', '/v2/insights', { focus: MERGED, insights: one });
  assert.equal(a.status, 201, JSON.stringify(a.body));
  assert.equal(b.status, 201, JSON.stringify(b.body));
  assert.deepEqual(tables.insight_items.map((i) => i.company_id).sort(), [COMPANY, OTHER_CO].sort());
});

test('insights: a shared person focus is not the speaker of a line credited to someone else', async () => {
  tables.entity_identifiers.push({ entity_id: PERSON, workspace_id: WS, kind: 'email', value: 'sarah@acme.com', status: 'active' });
  tables.relationships.push({ workspace_id: WS, type: 'works_at', from_entity_id: PERSON, to_entity_id: COMPANY, valid_to: null });
  const w = await call('POST', '/v2/insights', { focus: 'sarah@acme.com', insights: [
    { category: 'buyer', content: 'Finance signs off on every tool', speaker: 'their CFO' },
    { category: 'product', content: 'Wants activity pushed into Slack' },
  ] });
  assert.equal(w.status, 201, JSON.stringify(w.body));
  const by = Object.fromEntries(tables.insight_items.map((i) => [i.category, i]));
  assert.equal(by.buyer.speaker_id ?? null, null);
  assert.equal(by.buyer.contact_id, PERSON);
  assert.equal(by.product.speaker_id, PERSON);
});

test('insights: a member key cannot write onto an account it cannot see, and learns nothing about it', async () => {
  tables.workspaces[0].open_account_visibility = false;
  tables.entity_identifiers.push({ entity_id: COMPANY, workspace_id: WS, kind: 'domain', value: 'acme.com', status: 'active' });
  const r = await call('POST', '/v2/insights', { focus: 'acme.com', insights: [{ category: 'product', content: 'Wants activity pushed into Slack' }] }, { 'x-test-scope': 'member' });
  assert.equal(r.status, 404);
  assert.equal(r.body.error, 'focus_not_found');
  assert.equal(tables.insight_items.length, 0);
});

test('insights: GET says why there is nothing yet: no ICP, and where to set one up (0.5)', async () => {
  const r = await call('GET', '/v2/insights');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.readiness.ready, false);
  assert.equal(r.body.readiness.reason, 'no_icp');
  assert.deepEqual(r.body.readiness.fix, { app: '/settings?section=context', mcp: 'set_icp', api: 'PUT /v2/icp' });
  tables.foundations = [{ workspace_id: WS, kind: 'icp', title: 'ICP', body_md: 'We sell revenue infrastructure to B2B SaaS teams of 10 to 200 people who run sales on HubSpot and want one record per account.' }];
  const ok = await call('GET', '/v2/insights');
  assert.deepEqual(ok.body.readiness, { ready: true, reason: null, detail: null, fix: null });
});

test('insights: a service business reads the service labels', async () => {
  seedBoard();
  tables.workspaces[0].business_type = 'service';
  const r = await call('GET', '/v2/insights?limit=1');
  assert.equal(r.body.taxonomy.lanes.find((l) => l.key === 'product').label, 'Delivery');
  assert.equal(r.body.taxonomy.subtypes.find((s) => s.key === 'bug').label, 'Missed results');
});

test('insights: ?category= keeps the old per-category read', async () => {
  tables.insights = [{ id: 'doc1', workspace_id: WS, category: 'product', content: '- a bullet' }];
  const r = await call('GET', '/v2/insights?category=product');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(Array.isArray(r.body.insights));
  assert.equal(r.body.taxonomy, undefined, 'old shape, no board fields');
});
