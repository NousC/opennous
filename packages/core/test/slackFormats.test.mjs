// Slack layouts for automation output (GET-858): the AI step before a Slack step with a layout
// writes that layout's JSON; the Slack step hands { format, content } to the poster; JSON that does
// not fit posts as plain words; a step without a layout posts exactly as before.
//
// Run: pnpm --filter @nous/core build && node --test packages/core/test/slackFormats.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SLACK_FORMATS, slackFormatOf, slackFormatInstruction, parseSlackContent, slackContentText, extractJsonObject } from '../dist/services/slackFormats.mjs';
import { runStepsForTest as runSteps, registerStepHandler } from '../dist/services/automationRun.mjs';
import { registerAnthropicClient } from '../dist/llm/modelDoor.mjs';

const REPORT = {
  title: 'Daily usage', period: '13 Oct 2026', source: 'HubSpot', summary: 'Pulls up 8% on the day.',
  sections: [{ heading: 'Movers', body: '• Northwind +5' }], table: { columns: ['Account', 'Pulls'], rows: [['Northwind', '12'], ['Globex', '7']] },
  flags: [{ level: 'red', text: 'Globex went quiet' }, { level: 'green', text: 'Northwind best day' }], extra: 'dropped',
};

test('layouts: the known names, unknown ones are null; plain and none ask the AI for nothing', () => {
  assert.deepEqual(SLACK_FORMATS, ['report', 'approval', 'alert', 'handoff', 'notification', 'digest', 'plain']);
  assert.equal(slackFormatOf('Report'), 'report');
  assert.equal(slackFormatOf('carousel'), null);
  assert.equal(slackFormatInstruction('plain'), null);
  assert.equal(slackFormatInstruction(null), null);
  for (const f of SLACK_FORMATS.filter(x => x !== 'plain')) assert.match(slackFormatInstruction(f), new RegExp(`${f} layout[\\s\\S]*ONE JSON object`));
});

test('parse: bare, fenced and wrapped JSON; unknown keys dropped; plain text rendered', () => {
  const p = parseSlackContent('report', `Here you go:\n\`\`\`json\n${JSON.stringify(REPORT)}\n\`\`\``);
  assert.equal(p.ok, true);
  assert.equal(p.content.extra, undefined);
  assert.deepEqual(p.content.table.rows[1], ['Globex', '7']);
  assert.match(p.text, /^\*Daily usage\*\n13 Oct 2026 · HubSpot\nPulls up 8%/);
  assert.match(p.text, /🔴 Globex went quiet\n🟢 Northwind best day/);
  assert.deepEqual(extractJsonObject('{"a":1}'), { a: 1 });
  assert.equal(extractJsonObject('[1,2]'), null);
});

test('parse: JSON that does not fit, or no JSON at all, is not ok and keeps readable words', () => {
  const broken = parseSlackContent('report', '{"title": "Daily usage", "summary": "Pulls up 8%", "table": {');
  assert.equal(broken.ok, false);
  assert.equal(broken.text, 'Daily usage\nPulls up 8%');
  const prose = parseSlackContent('report', 'Pulls were up 8% yesterday.');
  assert.deepEqual(prose, { ok: false, text: 'Pulls were up 8% yesterday.' });
  // The right JSON for another layout is not this layout's content.
  assert.equal(parseSlackContent('handoff', JSON.stringify({ title: 'x' })).ok, false);
});

test('every layout: its content cleaned and its plain text', () => {
  assert.match(slackContentText('approval', parseSlackContent('approval', { title: 'Send the renewal email', fields: [{ label: 'To', value: 'cfo@northwind.example' }], body: 'Goes out from your Gmail.' }).content), /\*To:\* cfo@northwind/);
  assert.match(parseSlackContent('alert', { title: 'Usage dropped 40%', severity: 'critical', what_happened: 'x' }).text, /^🔴 \*Usage dropped 40%\*/);
  assert.match(parseSlackContent('handoff', { account: 'Northwind', owner: 'Sam', promised: ['SSO by May', 'Weekly check-ins'] }).text, /\*What was promised\*\n• SSO by May\n• Weekly check-ins/);
  assert.equal(parseSlackContent('notification', { text: 'Northwind booked a demo.' }).text, 'Northwind booked a demo.');
  const d = parseSlackContent('digest', { title: 'Accounts to watch', items: [{ name: 'Northwind', status: 'Champion left' }, { status: 'no name' }] });
  assert.equal(d.content.groups[0].items.length, 1);
  assert.match(d.text, /• \*Northwind\*: Champion left/);
});

// ── The step runner ─────────────────────────────────────────────────────────────

function fakeDb() {
  const inserted = [];
  return {
    inserted,
    from(table) {
      let row = null;
      const q = {
        select: () => q, eq: () => q, in: () => q, is: () => q, order: () => q, limit: () => q, update: () => q, upsert: (r) => { row = r; return q; },
        insert: (r) => { row = { id: `${table}-${inserted.length + 1}`, ...r }; inserted.push({ table, row }); return q; },
        single: async () => ({ data: row, error: null }), maybeSingle: async () => ({ data: null, error: null }),
        then: (ok) => Promise.resolve({ data: row ? [row] : [], error: null }).then(ok),
      };
      return q;
    },
  };
}
const auto = (steps, extra = {}) => ({ id: 'r1', name: 'Daily usage', user_id: 'u1', steps, ...extra });
const seed = [{ id: 'read', step: 1, label: 'Stats', text: 'Northwind | 12\nGlobex | 7' }];

/** Run with a scripted model answer; returns what the model was asked and what Slack got. */
async function withModel(answer, fn) {
  const before = process.env.WRITING_MODEL;
  process.env.WRITING_MODEL = 'claude-haiku-4-5-20251001';
  const asks = [];
  const answers = Array.isArray(answer) ? [...answer] : null;
  registerAnthropicClient({ messages: { create: async (a) => { asks.push(a); const t = answers ? answers.shift() ?? '' : answer; return { model: 'm', stop_reason: 'end_turn', usage: {}, content: [{ type: 'text', text: t }] }; } } }, { acceptsFeature: false });
  const posts = [];
  registerStepHandler('slack', async (a) => { posts.push(a); return { ok: true }; });
  try { return await fn({ asks, posts }); } finally {
    if (before === undefined) delete process.env.WRITING_MODEL; else process.env.WRITING_MODEL = before;
    registerAnthropicClient(null);
  }
}
const sys = (a) => (typeof a.system === 'string' ? a.system : JSON.stringify(a.system));

test('a Slack step with a layout: the AI step writes that layout\'s JSON and Slack gets { format, content }', () => withModel(JSON.stringify(REPORT), async ({ asks, posts }) => {
  const db = fakeDb();
  const r = await runSteps(auto([
    { id: 'summary', type: 'agent', config: { prompt: 'Summarise it.' } },
    { id: 'post', type: 'slack', config: { channel_id: 'C1', channel: 'reports', text: '{{steps.summary.output}}', format: 'report' } },
  ]), null, { stage: 'scheduled', ctx: { supabase: db, workspaceId: 'ws', runId: 'run-1', writeAllInLoop: true, seedData: seed } });
  assert.equal(r.failed, undefined);
  assert.equal(asks.length, 1, 'one model call: the AI step itself writes the JSON');
  assert.match(sys(asks[0]), /report layout[\s\S]*ONE JSON object/);
  assert.doesNotMatch(sys(asks[0]), /Use Slack's markup only/);
  assert.equal(posts[0].format, 'report');
  assert.equal(posts[0].content.title, 'Daily usage');
  assert.equal(posts[0].runId, 'run-1');
  assert.equal(posts[0].stepId, 'post');
  // The document and the message's fallback are words, never JSON.
  assert.match(posts[0].text, /^\*Daily usage\*/);
  assert.doesNotMatch(db.inserted.find(x => x.table === 'documents').row.sections[0].body, /^\{/);
}));

test('invalid JSON from the AI step: one more try shapes the words, and when that fails too it posts plain text', () => withModel(['{"title": "Daily usage", "summary": "Pulls up 8%", ', 'not json either'], async ({ asks, posts }) => {
  await runSteps(auto([
    { id: 'summary', type: 'agent', config: { prompt: 'Summarise it.' } },
    { id: 'post', type: 'slack', config: { channel_id: 'C1', channel: 'reports', text: '{{steps.summary.output}}', format: 'report' } },
  ]), null, { stage: 'scheduled', ctx: { supabase: fakeDb(), workspaceId: 'ws', writeAllInLoop: true, seedData: seed } });
  assert.equal(asks.length, 2);
  assert.equal(posts[0].format, undefined);
  assert.equal(posts[0].content, undefined);
  assert.equal(posts[0].text, 'Daily usage\nPulls up 8%');
}));

test('no layout: unchanged — Slack markup prose, and the handler gets no format', () => withModel('*Totals* 19 (+2)', async ({ asks, posts }) => {
  await runSteps(auto([
    { id: 'summary', type: 'agent', config: { prompt: 'Summarise it.' } },
    { id: 'post', type: 'slack', config: { channel_id: 'C1', channel: 'reports', text: '{{steps.summary.output}}' } },
  ]), null, { stage: 'scheduled', ctx: { supabase: fakeDb(), workspaceId: 'ws', writeAllInLoop: true, seedData: seed } });
  assert.match(sys(asks[0]), /posted in Slack/);
  assert.doesNotMatch(sys(asks[0]), /JSON/);
  assert.equal(posts[0].text, '*Totals* 19 (+2)');
  assert.equal(posts[0].format, undefined);
}));

test('words from an account brief (no JSON written): the Slack step shapes them with one call', () => withModel(JSON.stringify({ account: 'Northwind', owner: 'Sam', deal: 'Platform' }), async ({ asks, posts }) => {
  const brief = { id: 'd1', title: 'Northwind handoff', sections: [{ label: 'Why they bought', body: 'SSO and reporting.' }] };
  await runSteps(auto([{ id: 'post', type: 'slack', config: { channel_id: 'C1', channel: 'cs', format: 'handoff' } }]), brief, { stage: 'deal_closed_won', ctx: { supabase: fakeDb(), workspaceId: 'ws', runId: 'run-2', entityId: 'acc-1' } });
  assert.equal(asks.length, 1);
  assert.match(asks[0].messages[0].content, /SSO and reporting/);
  assert.equal(posts[0].format, 'handoff');
  assert.equal(posts[0].content.account, 'Northwind');
  assert.equal(posts[0].accountId, 'acc-1');
}));

test('an approval layout holds the sends after it: the run waits for Approve, with the run id on the buttons', () => withModel(JSON.stringify({ title: 'Send the renewal email', body: 'Goes to the CFO.' }), async ({ posts }) => {
  registerStepHandler('gmail_draft', async () => { throw new Error('must not draft before approval'); });
  const r = await runSteps(auto([
    { id: 'ask', type: 'slack', config: { channel_id: 'C1', channel: 'approvals', format: 'approval' } },
    { id: 'mail', type: 'gmail', config: { to: 'cfo@northwind.example', subject: 'Renewal', body: 'Hi' } },
  ]), { id: 'd1', title: 'Renewal', sections: [{ label: 'Draft', body: 'Hi, about the renewal…' }] }, { stage: 'x', ctx: { supabase: fakeDb(), workspaceId: 'ws', runId: 'run-3' } });
  assert.equal(posts[0].format, 'approval');
  assert.equal(posts[0].runId, 'run-3');
  assert.equal(r.paused, true);
  assert.equal(r.index, 1);
}));

// A RevBox job's box delivery to Slack: the destination's layout (or the delivery step's).
function boxDb(delivery) {
  const tables = {
    workspace_members: [{ workspace_id: 'ws', user_id: 'owner', role: 'admin' }],
    revboxes: [{ id: 'box', workspace_id: 'ws', owner_id: 'owner', shared: true, name: 'CS', objective: 'Keep CS ahead.', blocks: [], delivery }],
    revbox_members: [], revbox_context: [], documents: [], agent_routines: [],
  };
  class Query {
    constructor(table) { this.table = table; this.filters = []; }
    select() { return this; } order() { return this; } limit() { return this; } not() { return this; } contains() { return this; } is() { return this; }
    eq(k, v) { this.filters.push(r => r[k] === v); return this; }
    neq(k, v) { this.filters.push(r => r[k] !== v); return this; }
    in(k, vs) { this.filters.push(r => vs.includes(r[k])); return this; }
    insert(v) { this.insertValue = v; return this; }
    update() { return this; } upsert() { return this; }
    result(single) {
      let values = (tables[this.table] ??= []).filter(r => this.filters.every(f => f(r)));
      if (this.insertValue) { const row = { id: `${this.table}-x`, ...this.insertValue }; tables[this.table].push(row); values = [row]; }
      return { data: structuredClone(single ? values[0] ?? null : values), error: null };
    }
    maybeSingle() { return Promise.resolve(this.result(true)); }
    single() { return this.maybeSingle(); }
    then(ok, bad) { return Promise.resolve(this.result(false)).then(ok, bad); }
  }
  return { tables, from: t => new Query(t) };
}

test('box delivery to Slack posts the destination\'s layout; an approval layout is never used there', () => withModel(JSON.stringify(REPORT), async ({ asks, posts }) => {
  const sb = boxDb([{ id: 'd-s', kind: 'slack', target: 'C0CS', channel: 'cs', format: 'report' }, { id: 'd-a', kind: 'slack', target: 'C0AP', channel: 'ap', format: 'approval' }]);
  const r = await runSteps({ id: 'r1', name: 'Daily usage', user_id: 'owner', revbox_id: 'box', steps: [
    { id: 'summary', type: 'agent', config: { prompt: 'Summarise it.' } },
    { id: 'box_delivery', type: 'revbox_delivery', config: {} },
  ] }, null, { stage: 'scheduled', ctx: { supabase: sb, workspaceId: 'ws', runId: 'run-4', writeAllInLoop: true, seedData: seed } });
  assert.equal(r.delivered, 'revbox_delivery:2/2');
  assert.match(sys(asks[0]), /report layout/);
  assert.equal(posts[0].format, 'report');
  assert.equal(posts[0].content.title, 'Daily usage');
  assert.equal(posts[0].revboxId, 'box');
  assert.equal(posts[1].format, undefined, 'approval is not a box-delivery layout');
  assert.match(posts[1].text, /Daily usage/);
}));
