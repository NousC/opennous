// The tools against a mocked API: each call goes over a real MCP client/server pair to a local
// HTTP server standing in for api.opennous.cloud, so what is checked is the request each tool
// sends (method, path, query, body) and the text the agent reads back.
//
// Run: node --test apps/mcp/tests/tools.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync } from 'node:fs';

const HAS_CLOUD = existsSync(new URL('../src/cloud/index.js', import.meta.url));

const calls = [];
let routes = {};
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const url = new URL(req.url, 'http://x');
    const call = { method: req.method, path: decodeURIComponent(url.pathname), query: Object.fromEntries(url.searchParams), body: body ? JSON.parse(body) : null };
    calls.push(call);
    const handler = routes[`${req.method} ${call.path}`];
    const [status, json] = handler ? handler(call) : [404, { error: 'not_mocked' }];
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(json));
  });
});

let client;
before(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  process.env.NOUS_API_URL = `http://127.0.0.1:${server.address().port}`;
  process.env.NOUS_API_KEY = 'pk_test';
  const { createServer } = await import('../src/server.js');
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createServer().connect(a);
  client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(b);
});
after(async () => { await client?.close(); server.close(); });

async function callTool(name, args, r) {
  routes = r; calls.length = 0;
  const out = await client.callTool({ name, arguments: args });
  return { text: out.content.map((c) => c.text).join('\n'), isError: !!out.isError, calls: [...calls] };
}

const UUID = '11111111-1111-4111-8111-111111111111';
const ACC = '22222222-2222-4222-8222-222222222222';

test('tools/list leads with the documented core, list_people is gone', async () => {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  // Cloud's module adds read_brain and write_brain after score (GET-839); the open-source edition has neither.
  const core = ['whoami', 'find', 'get_context', 'query', 'attention', 'tasks', 'rules', 'get_insights',
    'add_note', 'enrich', 'score', ...(HAS_CLOUD ? ['read_brain', 'write_brain'] : []), 'set_icp', 'webhooks'];
  assert.deepEqual(names.slice(0, core.length), core);
  assert.ok(!names.includes('list_people'));
  assert.equal(names.length, HAS_CLOUD ? 23 : 21);
});

test('find deals: filters map to GET /v2/deals and rows render on one line', async () => {
  const { text, calls } = await callTool('find', { kind: 'deals', filters: { status: 'open', closing_within_days: 30 }, sort: 'close_date', limit: 10 }, {
    'GET /v2/deals': () => [200, { deals: [{
      id: UUID, name: 'Acme renewal', account: { entity_id: ACC, name: 'Acme', domain: 'acme.com' }, stage: 'Negotiation',
      canonical_stage: 'negotiation', status: 'open', amount: 48000, currency: 'USD', close_date: '2026-10-15',
      owner: { name: 'Odile', email: null }, pipeline: null, health: 62, win_probability: 0.42, close_within_30d: 0.18,
      last_activity_at: null, implied: false,
    }], limit: 10, offset: 0, has_more: true }],
  });
  assert.deepEqual(calls[0].query, { status: 'open', closing_within_days: '30', sort: 'close_date', limit: '10' });
  assert.match(text, /^1 deal · sorted by close_date · more available, page with offset 1/);
  assert.match(text, /• Acme renewal — Acme · Negotiation · open · \$48,000 · closes 2026-10-15 · win 42% \(18% in 30d\) · health 62 · owner Odile {2}\[1111/);
});

test('find deals: a deal with no currency reads as dollars, another currency keeps its code (GET-831)', async () => {
  const deal = (over) => ({ id: UUID, name: 'Acme pilot', account: { entity_id: ACC, name: 'Acme', domain: 'acme.com' }, stage: 'Demo',
    canonical_stage: 'demo', status: 'open', amount: 450, currency: null, close_date: null, owner: null, pipeline: null,
    health: null, win_probability: null, close_within_30d: null, last_activity_at: null, implied: false, ...over });
  const { text } = await callTool('find', { kind: 'deals' }, {
    'GET /v2/deals': () => [200, { deals: [deal({}), deal({ currency: 'EUR', amount: 1200 })], offset: 0, has_more: false }],
  });
  assert.match(text, /Acme · Demo · open · \$450 /);
  assert.match(text, /Acme · Demo · open · 1,200 EUR /);
  assert.doesNotMatch(text, /· 450 /);
});

test('deals: on default weights the odds are a rank with what helps and hurts, never a percentage (GET-832)', async () => {
  const one = await callTool('deals', { account: 'acme.com' }, {
    'GET /v2/accounts/acme.com/outlook': () => [200, {
      entity_id: ACC, name: 'Acme', status: 'open', stage: 'demo', days_in_stage: 41, typical_days_in_stage: 21,
      odds: 'rank', rank: 3, of: 12, helping: ['engagement rising'], hurting: ['41d in demo (typical 21d)'],
      health: { score: 79, band: 'Healthy', signals: [], engagement: {} },
      model: { notes: ['Odds are a rank among the open deals, not a percentage: there are not enough won and lost deals yet.'] },
    }],
  });
  assert.match(one.text, /ODDS TO CLOSE: 3rd most likely of 12 open deals/);
  assert.match(one.text, /HELPING: engagement rising/);
  assert.match(one.text, /HURTING: 41d in demo \(typical 21d\)/);
  assert.doesNotMatch(one.text, /%|unknown|^CLOSE:/m);

  const list = await callTool('deals', {}, {
    'GET /v2/accounts/outlook': () => [200, {
      within_days: 30, odds: 'rank', ranked_by: 'how likely each is to close, compared with the other open deals', open_deals: 12, timing_known: 0,
      deals: [{ entity_id: ACC, name: 'Acme', stage: 'demo', days_in_stage: 41, odds: 'rank', rank: 1, of: 12,
        helping: ['ICP fit 88'], hurting: [], health: { score: 79, band: 'Healthy', watch: [] } }],
      model: { notes: [] },
    }],
  });
  assert.match(list.text, /1\. Acme \[2222[^\]]*\] — demo, 41d · health 79 Healthy/);
  assert.match(list.text, /helping: ICP fit 88/);
  assert.doesNotMatch(list.text, /%|unknown within/);
});

test('find: rows on a rank basis say the rank, not a percentage (GET-832)', async () => {
  const deals = await callTool('find', { kind: 'deals' }, {
    'GET /v2/deals': () => [200, { deals: [{ id: UUID, name: 'Acme pilot', account: { entity_id: ACC, name: 'Acme', domain: 'acme.com' },
      stage: 'Demo', canonical_stage: 'demo', status: 'open', amount: 450, currency: null, close_date: null, owner: null, pipeline: null,
      health: 79, win_probability: 0.08, close_within_30d: null, win_rank: 3, win_rank_of: 12, odds_basis: 'rank',
      last_activity_at: null, implied: false }], offset: 0, has_more: false }],
  });
  assert.match(deals.text, /· odds 3rd of 12 open · health 79/);
  assert.doesNotMatch(deals.text, /win 8%/);
  const accounts = await callTool('find', { kind: 'accounts', sort: 'win_chance' }, {
    'GET /v2/accounts': () => [200, { accounts: [{ entity_id: ACC, name: 'Acme', domain: 'acme.com', open_deals: 1,
      win_probability: 0.08, close_within_30d: null, win_rank: 1, win_rank_of: 12, odds_basis: 'rank' }], offset: 0, has_more: false }],
  });
  assert.match(accounts.text, /· odds 1st of 12 open/);
  assert.doesNotMatch(accounts.text, /win 8%/);
});

test('find people: stage → pipeline_stage, include_all → include=all', async () => {
  const { text, calls } = await callTool('find', { kind: 'people', filters: { account: 'acme.com', stage: 'demo', include_all: true } }, {
    'GET /v2/people': () => [200, { people: [{ id: UUID, name: 'Sarah Lee', job_title: 'VP Sales', company: 'Acme', email: 'sarah@acme.com', pipeline_stage: 'demo', icp_score: 81, icp_fit: true }], offset: 0, has_more: false }],
  });
  assert.deepEqual(calls[0].query, { account: 'acme.com', pipeline_stage: 'demo', include: 'all' });
  assert.match(text, /• Sarah Lee — VP Sales at Acme · sarah@acme\.com · demo · ICP 81 fit/);
});

test('find accounts with win_chance caps limit at 50 and shows odds', async () => {
  const { text, calls } = await callTool('find', { kind: 'accounts', filters: { icp_fit: true }, sort: 'win_chance', limit: 500 }, {
    'GET /v2/accounts': () => [200, { accounts: [{ entity_id: ACC, name: 'Acme', domain: 'acme.com', icp_score: 80, icp_tier: 'tier_1', open_deals: 1, pipeline_value: 48000, win_probability: 0.5, close_within_30d: null }], offset: 0, has_more: false }],
  });
  assert.equal(calls[0].query.limit, '50');
  assert.equal(calls[0].query.icp_fit, 'true');
  assert.match(text, /Acme — acme\.com · ICP 80 tier 1 · 1 open deal · \$48,000 pipeline · win 50%/);
});

test('find refuses a filter the kind does not support, without calling the API', async () => {
  const r1 = await callTool('find', { kind: 'deals', filters: { icp_fit: true } }, {});
  assert.equal(r1.calls.length, 0);
  assert.ok(r1.isError);
  assert.match(r1.text, /icp_fit is not a filter on deals\. Supported: account, pipeline/);
  assert.match(r1.text, /find accounts first/);
  const r2 = await callTool('find', { kind: 'deals', search: 'acme' }, {});
  assert.match(r2.text, /deals cannot be searched by text/);
  const r3 = await callTool('find', { kind: 'people', filters: { include_all: true, source: 'hubspot' } }, {});
  assert.match(r3.text, /source is not a filter on people with include_all/);
  const r4 = await callTool('find', { kind: 'accounts', sort: 'close_date' }, {});
  assert.match(r4.text, /sort 'close_date' is not available for accounts/);
  const r5 = await callTool('find', { kind: 'deals', filters: { status: 'active' } }, {});
  assert.match(r5.text, /open, won, lost/);
});

test('enrich resolves an email first, then enriches by entity id', async () => {
  const { text, calls } = await callTool('enrich', { person: 'sarah@acme.com' }, {
    'GET /v2/people/sarah@acme.com': () => [200, { person: { entity_id: UUID } }],
    [`POST /v2/people/${UUID}/enrich`]: () => [200, { person: { first_name: 'Sarah', last_name: 'Lee', job_title: 'VP Sales', company: 'Acme', icp_score: 81 }, enriched: true, provider: 'apollo', fields_added: ['job_title', 'phone'], cached: false }],
  });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].body, {});
  assert.match(text, /Enriched Sarah Lee via apollo: added job_title, phone\./);
});

test('enrich with a UUID skips the lookup; cached says nothing was spent', async () => {
  const { text, calls } = await callTool('enrich', { person: UUID, force: false }, {
    [`POST /v2/people/${UUID}/enrich`]: () => [200, { person: { first_name: 'Sarah' }, enriched: false, provider: null, fields_added: [], cached: true, last_enriched_at: '2026-09-01T00:00:00Z', last_provider: 'prospeo' }],
  });
  assert.equal(calls.length, 1);
  assert.match(text, /already enriched on 2026-09-01 via prospeo .*nothing spent/);
});

test('enrich surfaces the API refusal (no provider)', async () => {
  const { text, isError } = await callTool('enrich', { person: UUID }, {
    [`POST /v2/people/${UUID}/enrich`]: () => [409, { error: 'no_enrichment_provider', detail: 'connect an Apollo, Findymail or Prospeo key to enrich' }],
  });
  assert.ok(isError);
  assert.match(text, /no_enrichment_provider — connect an Apollo/);
});

test('get_context with a deal id leads with the deal block', async () => {
  const { text, calls } = await callTool('get_context', { focus: `implied:${ACC}` }, {
    'POST /v2/context': () => [200, {
      deal: { id: `implied:${ACC}`, name: 'Acme deal', implied: true, account: { entity_id: ACC, name: 'Acme', domain: 'acme.com' },
        stage: 'Demo', canonical_stage: 'demo', status: 'open', amount: null, health: 55, days_in_stage: 12,
        stakeholders: [{ entity_id: UUID, name: 'Sarah Lee', title: 'VP Sales', role: 'economic_buyer' }],
        claims: { objections: [{ content: 'too pricey', label: 'Price' }], competitors: [], budget: [], timeline: [] } },
      summary: 'Acme summary', entity: { id: ACC },
    }],
  });
  assert.equal(calls[0].body.focus, `implied:${ACC}`);
  assert.match(text, /^DEAL: Acme deal {2}\[implied:2222.*\(implied: the account has no CRM deal\)/);
  assert.match(text, /stage Demo, 12d in stage · open · health 55/);
  assert.match(text, /Sarah Lee — VP Sales \(economic buyer\)/);
  assert.match(text, /\[objections\] Price: too pricey/);
  assert.ok(text.indexOf('DEAL:') < text.indexOf('ACCOUNT CONTEXT:'));
  assert.match(text, /entity_id: 2222.* · deal_id: implied:2222/);
});

test('get_context without a deal is unchanged', async () => {
  const { text } = await callTool('get_context', { focus: 'sarah@acme.com' }, {
    'POST /v2/context': () => [200, { summary: 'Sarah summary', entity: { id: UUID } }],
  });
  assert.match(text, /^Sarah summary/);
  assert.ok(!text.includes('DEAL:'));
});

test('whoami renders the usage block; null fields read as unlimited', async () => {
  const base = { workspace: { name: 'Acme Co' }, you: { name: 'Theo', scope: 'admin', roles: ['founder'] }, setup: { onboarded: true, accounts: 3, has_icp: true } };
  const a = await callTool('whoami', {}, {
    'GET /v2/workspace/whoami': () => [200, { ...base, usage: { plan: 'pro', ops_used: 1200, ops_limit: null, ops_left: null, credits_left: 450, period_end: '2026-10-15T00:00:00Z' } }],
  });
  assert.match(a.text, /Usage: plan pro · ops unlimited \(1,200 used\) · credits 450 left · period ends 2026-10-15\./);
  const b = await callTool('whoami', {}, { 'GET /v2/workspace/whoami': () => [200, { ...base, usage: null }] });
  assert.match(b.text, /Usage: unavailable right now/);
});

test('set_icp: PUT /v2/icp; reports the version and whether the model was rebuilt', async () => {
  const created = await callTool('set_icp', { body_md: '# ICP' }, {
    'PUT /v2/icp': () => [200, { icp: { version: 2 }, model: { status: 'created', signals: [{}, {}, {}] } }],
  });
  assert.equal(created.calls[0].method, 'PUT');
  assert.deepEqual(created.calls[0].body, { body_md: '# ICP' });
  assert.match(created.text, /ICP saved \(v2\)\.\nScoring model built from it \(3 signals\)/);
  const exists = await callTool('set_icp', { body_md: '# ICP' }, {
    'PUT /v2/icp': () => [200, { icp: { version: 5 }, model: { status: 'exists', signals: [{}] } }],
  });
  assert.match(exists.text, /ICP saved \(v5\)\.\nA scoring model already existed, so it was NOT rebuilt \(1 signal\)/);
  const failed = await callTool('set_icp', { body_md: '# ICP' }, {
    'PUT /v2/icp': () => [200, { icp: { version: 6 }, model: { status: 'build_failed' } }],
  });
  assert.match(failed.text, /building the scoring model failed/);
});

// GET-830: the task list is readable AND closable. Before, an agent told "that's done" had no
// move but to write a note while the task stayed open in every worklist.
test('tasks list: GET /v2/action-items with defaults, every row carries its task id', async () => {
  const TASK = `${ACC}:action_item.meeting_m1_0`;
  const { text, calls } = await callTool('tasks', { focus: 'dana@harborline.example' }, {
    'GET /v2/action-items': () => [200, { items: [{
      id: 'action_item.meeting_m1_0', task_id: TASK, entity_id: ACC, title: 'Send the Lumen pricing sheet',
      owner_kind: 'user', owner_name: 'Odile', status: 'open', due_at: '2026-10-14', source_type: 'meeting',
      recorded_at: '2026-10-09T10:00:00Z', account: 'Dana Wu', company: 'Harborline',
    }], count: 1, truncated: true }],
  });
  assert.equal(calls[0].method, 'GET');
  assert.deepEqual(calls[0].query, { owner: 'me', status: 'open', due: 'all', limit: '50', focus: 'dana@harborline.example' });
  assert.match(text, /1 open task on our side/);
  assert.match(text, /Send the Lumen pricing sheet · due 2026-10-14/);
  assert.match(text, /Harborline · Dana Wu · owner Odile · from meeting 2026-10-09/);
  assert.match(text, /more exist: raise limit/);
  assert.ok(text.includes(`task: ${TASK}`));
});

test('tasks done: POST /v2/action-items/status closes by id, with the reason, and reports misses', async () => {
  const TASK = `${ACC}:action_item.meeting_m1_0`;
  const { text, calls } = await callTool('tasks', { action: 'done', ids: [TASK, 'nope'], reason: 'sent on 10 Oct' }, {
    'POST /v2/action-items/status': () => [200, { status: 'done', results: [
      { id: TASK, ok: true, status: 'done', title: 'Send the Lumen pricing sheet' },
      { id: 'nope', ok: false, error: 'invalid_id' },
    ], counts: { ok: 1, failed: 1 } }],
  });
  assert.equal(calls[0].method, 'POST');
  assert.deepEqual(calls[0].body, { ids: [TASK, 'nope'], status: 'done', reason: 'sent on 10 Oct' });
  assert.match(text, /Closed 1 of 2 tasks/);
  assert.match(text, /✓ Send the Lumen pricing sheet/);
  assert.match(text, /✗ nope: not a task id/);
});

test('tasks reopen sends status open; done without ids asks for them and calls nothing', async () => {
  const TASK = `${ACC}:action_item.manual_x`;
  const re = await callTool('tasks', { action: 'reopen', ids: [TASK] }, {
    'POST /v2/action-items/status': () => [200, { status: 'open', results: [{ id: TASK, ok: true, status: 'open', title: 'Call back' }] }],
  });
  assert.deepEqual(re.calls[0].body, { ids: [TASK], status: 'open' });
  assert.match(re.text, /Reopened 1 of 1 task\./);
  const none = await callTool('tasks', { action: 'done' }, {});
  assert.equal(none.isError, true);
  assert.equal(none.calls.length, 0);
});

test('attention shows the task id on an open commitment', async () => {
  const TASK = `${ACC}:action_item.meeting_m1_0`;
  const { text } = await callTool('attention', {}, {
    'GET /v2/attention': () => [200, { items: [{ kind: 'open_commitment', entity_id: ACC, entity_name: 'Harborline',
      what: 'You owe: Send the Lumen pricing sheet', suggested_action: 'Follow up, or close it if it is already done',
      age_days: 2, task_id: TASK }], meta: { open_commitments: 1 } }],
  });
  assert.ok(text.includes(`task: ${TASK}`));
});

// GET-846: a rep's rules, said once. Checked rules are evaluated in the background; guidance only
// reaches the agent. The tool maps a stated rule onto a check or keeps it guidance.
const RULE = { id: 'r1', statement: 'Every meeting ends with a dated next step within 48 hours', kind: 'checked',
  check: { type: 'next_step_after_meeting', params: { hours: 48 }, label: 'Dated next step after every meeting', verifies: 'x' },
  weight: 'normal', status: 'active', created_at: '2026-10-12T10:00:00Z' };

test('rules add: POST /v2/rules with the mapped check; says whether it is checked', async () => {
  const { text, calls } = await callTool('rules', { action: 'add', statement: RULE.statement, check: 'next_step_after_meeting', hours: 48 }, {
    'POST /v2/rules': () => [201, { rule: RULE }],
  });
  assert.deepEqual(calls[0].body, { statement: RULE.statement, check: { type: 'next_step_after_meeting', params: { hours: 48 } } });
  assert.match(text, /Rule saved, checked in the background: Dated next step after every meeting \(48h\)/);
  const g = await callTool('rules', { action: 'add', statement: 'Lead with ROI for CFOs' }, {
    'POST /v2/rules': () => [201, { rule: { ...RULE, statement: 'Lead with ROI for CFOs', kind: 'guidance', check: null } }],
  });
  assert.deepEqual(g.calls[0].body, { statement: 'Lead with ROI for CFOs' });
  assert.match(g.text, /Rule saved as guidance/);
});

test('rules list, pause and remove; checks lists the catalogue', async () => {
  const list = await callTool('rules', {}, { 'GET /v2/rules': () => [200, { rules: [RULE], count: 1 }] });
  assert.match(list.text, /1 rule/);
  assert.match(list.text, /Every meeting ends with a dated next step within 48 hours/);
  assert.match(list.text, /id: r1/);
  const paused = await callTool('rules', { action: 'pause', id: 'r1' }, { 'PATCH /v2/rules/r1': () => [200, { rule: { ...RULE, status: 'paused' } }] });
  assert.deepEqual(paused.calls[0].body, { status: 'paused' });
  assert.match(paused.text, /Paused/);
  const removed = await callTool('rules', { action: 'remove', id: 'r1' }, { 'DELETE /v2/rules/r1': () => [200, { status: 'removed', id: 'r1' }] });
  assert.equal(removed.calls[0].method, 'DELETE');
  assert.match(removed.text, /Removed/);
  const checks = await callTool('rules', { action: 'checks' }, { 'GET /v2/rules/checks': () => [200, { checks: [{ type: 'reply_to_buyer_email', label: 'Reply to buyer emails', verifies: 'Every thread…', param: 'hours', default: 24 }] }] });
  assert.match(checks.text, /reply_to_buyer_email \(hours, default 24\)/);
  const bad = await callTool('rules', { action: 'pause' }, {});
  assert.match(bad.text, /Pass `id`/);
});
