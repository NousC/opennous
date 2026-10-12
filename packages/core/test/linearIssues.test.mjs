// Send an Insights topic to Linear (GET-825): one issue per topic, a link back to the topic, a
// customer request per insight on the account that said it, and every send mirrored back into the
// graph. Linear is mocked as a GraphQL function; the database is the worker's fakeDb.
//
// Run: pnpm --filter @nous/core build && node --test packages/core/test/linearIssues.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeDb } from '../../../apps/worker/tests/fakeDb.mjs';
import {
  buildLinearIssueInput, linearCustomerNeedBody, linearPriority, topicUrl, sendTopicToLinear,
} from '../dist/services/linearIssues.js';

const WS = 'ws-1';
const KEY = 'feature|tag-qr';
const APP = 'https://app.example.com';

const item = (id, company_id, statement, quote, speaker = 'Rowan Vale') => ({
  id, workspace_id: WS, source: 'external', category: 'product', subtype: 'feature', lane: 'product',
  tag_ids: ['tag-qr'], company_id, contact_id: null, speaker_id: null, speaker, statement, quote,
  occurred_at: '2026-09-30T10:00:00Z', source_ref: `source://granola/${id}`,
});

const seed = (extra = {}) => ({
  insight_items: [
    item('i1', 'co-harbor', 'Wants QR codes on the printed menu.', 'we need a QR code on every table'),
    item('i2', 'co-fern', 'Asked for QR ordering.', null, 'Wren Hollis'),
    item('i3', 'co-harbor', 'QR codes should open the booking page.', 'can it go straight to booking'),
    // Another topic: never part of this issue.
    { ...item('i9', 'co-fern', 'CSV export is broken.', null), subtype: 'bug', tag_ids: ['tag-csv'] },
  ],
  insight_tags: [{ id: 'tag-qr', workspace_id: WS, name: 'QR codes', definition: null, aliases: [], origin: 'model', retired_at: null }],
  insight_rows: [{ id: 'r1', workspace_id: WS, subtype: 'feature', tag_id: 'tag-qr', headline: 'Customers want QR codes on tables', problems: [], receipt_ids: [], item_count: 3, account_count: 2, summarized_at: null }],
  insight_topic_state: [{ workspace_id: WS, topic_key: KEY, status: 'new', priority: 'high', notes: '', updated_by: null, updated_at: '2026-09-30T10:00:00Z' }],
  claims: [
    { entity_id: 'co-harbor', workspace_id: WS, property: 'name', value: 'Harborline', invalid_at: null },
    { entity_id: 'co-fern', workspace_id: WS, property: 'name', value: 'Fernpoint', invalid_at: null },
  ],
  companies: [
    { id: 'co-harbor', workspace_id: WS, domain: 'harborline.example' },
    { id: 'co-fern', workspace_id: WS, domain: 'fernpoint.example' },
  ],
  linear_issue_links: [],
  observations: [],
  ...extra,
});

/** A Linear stand-in: answers by operation name and records every call. */
function fakeLinear({ existingIssueForUrl = null, customersDisabled = false, failAttachment = false, failUpsertFor = null, failNeedAfter = null } = {}) {
  const calls = [];
  let n = 0;
  const gql = async (query, variables = {}) => {
    const op = /(?:mutation|query)\s+(\w+)/.exec(query)?.[1];
    calls.push({ op, variables });
    switch (op) {
      case 'AttachmentsForUrl':
        return { attachmentsForURL: { nodes: existingIssueForUrl ? [{ issue: existingIssueForUrl }] : [] } };
      case 'IssueCreate':
        return { issueCreate: { success: true, issue: { id: 'lin-1', identifier: 'PRD-12', url: 'https://linear.app/acme/issue/PRD-12' } } };
      case 'AttachmentCreate':
        if (failAttachment) throw Object.assign(new Error('Linear is down'), { code: 'linear_graphql' });
        return { attachmentCreate: { success: true } };
      case 'CustomerUpsert':
        if (customersDisabled) throw Object.assign(new Error('Customers are not enabled'), { code: 'linear_graphql' });
        if (failUpsertFor === variables.input.externalId) throw Object.assign(new Error('domain conflict'), { code: 'linear_graphql' });
        return { customerUpsert: { success: true, customer: { id: `cust-${variables.input.externalId}` } } };
      case 'CustomerNeedCreate':
        if (customersDisabled) throw Object.assign(new Error('Customers are not enabled'), { code: 'linear_graphql' });
        if (failNeedAfter != null && n >= failNeedAfter) throw Object.assign(new Error('Linear is down'), { code: 'linear_graphql' });
        return { customerNeedCreate: { success: true, need: { id: `need-${++n}` } } };
      default:
        throw new Error(`unexpected op ${op}`);
    }
  };
  return { gql, calls, ops: () => calls.map((c) => c.op) };
}

// ── Pure pieces ─────────────────────────────────────────────────────────────

test('priority maps topic priority onto Linear (0 none, 1 urgent … 4 low)', () => {
  assert.equal(linearPriority('urgent'), 1);
  assert.equal(linearPriority('high'), 2);
  assert.equal(linearPriority('medium'), 3);
  assert.equal(linearPriority('low'), 4);
  assert.equal(linearPriority(null), 0);
});

test('topicUrl points at the topic page, key encoded, and names the workspace', () => {
  assert.equal(topicUrl(APP, WS, KEY), 'https://app.example.com/insights/feature%7Ctag-qr?ws=ws-1');
  assert.equal(topicUrl('https://app.example.com/', WS, KEY), 'https://app.example.com/insights/feature%7Ctag-qr?ws=ws-1');
  // Untagged topics share a key across workspaces; the link back must not.
  assert.notEqual(topicUrl(APP, 'ws-a', 'bug|none'), topicUrl(APP, 'ws-b', 'bug|none'));
});

test('the issue carries the topic title, quotes, accounts, priority and the link back; no revenue', () => {
  const input = buildLinearIssueInput({
    teamId: 'team-1', url: topicUrl(APP, WS, KEY), subtypeLabel: 'Feature request', title: 'QR codes',
    headline: 'Customers want QR codes on tables', priority: 'high',
    items: [
      { statement: 'Wants QR codes on the printed menu.', quote: 'we need a QR code on every table', speaker: 'Rowan Vale', company: 'Harborline', occurred_at: '2026-09-30T10:00:00Z' },
      { statement: 'Asked for QR ordering.', quote: null, speaker: 'Wren Hollis', company: 'Fernpoint', occurred_at: '2026-09-29T10:00:00Z' },
    ],
  });
  assert.equal(input.teamId, 'team-1');
  assert.equal(input.title, 'Feature request: QR codes');
  assert.equal(input.priority, 2);
  assert.match(input.description, /Customers want QR codes on tables/);
  assert.match(input.description, /we need a QR code on every table/);
  assert.match(input.description, /Harborline/);
  assert.match(input.description, /2 accounts/);
  assert.match(input.description, /https:\/\/app\.example\.com\/insights\/feature%7Ctag-qr/);
  assert.doesNotMatch(input.description, /revenue|deal|ICP|\$/i);
});

test('a topic with no tag is titled by its headline', () => {
  const input = buildLinearIssueInput({ teamId: 't', url: 'u', subtypeLabel: 'Bug', title: null, headline: 'Exports fail on large files', priority: null, items: [] });
  assert.equal(input.title, 'Bug: Exports fail on large files');
  assert.equal(input.priority, 0);
});

test('a customer request body is the insight, its quote and who said it', () => {
  const body = linearCustomerNeedBody({ statement: 'Wants QR codes.', quote: 'we need a QR code', speaker: 'Rowan Vale', occurred_at: '2026-09-30T10:00:00Z' });
  assert.match(body, /Wants QR codes\./);
  assert.match(body, /we need a QR code/);
  assert.match(body, /Rowan Vale/);
  assert.match(body, /Sep 30, 2026/);
});

// ── The send ────────────────────────────────────────────────────────────────

test('first send creates the issue, links back, adds one request per insight and mirrors everything', async () => {
  const db = fakeDb(seed());
  const linear = fakeLinear();
  const out = await sendTopicToLinear(db, { workspaceId: WS, topicKey: KEY, teamId: 'team-1', gql: linear.gql, appUrl: APP, userId: 'u-1' });

  assert.equal(out.created, true);
  assert.equal(out.issue.identifier, 'PRD-12');
  assert.equal(out.requests_added, 3);
  assert.equal(out.accounts, 2);

  const create = linear.calls.find((c) => c.op === 'IssueCreate');
  assert.equal(create.variables.input.teamId, 'team-1');
  assert.equal(create.variables.input.title, 'Feature request: QR codes');
  const attach = linear.calls.find((c) => c.op === 'AttachmentCreate');
  assert.equal(attach.variables.input.issueId, 'lin-1');
  assert.equal(attach.variables.input.url, 'https://app.example.com/insights/feature%7Ctag-qr?ws=ws-1');

  // Customers: domain + our id, nothing else. No revenue, size or tier, and no name: Linear matches
  // by domain, and a name would rename a customer the team already keeps there.
  const upserts = linear.calls.filter((c) => c.op === 'CustomerUpsert').map((c) => c.variables.input);
  assert.deepEqual(upserts.map((u) => u.externalId).sort(), ['co-fern', 'co-harbor']);
  for (const u of upserts) assert.deepEqual(Object.keys(u).sort(), ['domains', 'externalId']);
  const needs = linear.calls.filter((c) => c.op === 'CustomerNeedCreate').map((c) => c.variables.input);
  assert.equal(needs.length, 3);
  assert.ok(needs.every((n) => n.issueId === 'lin-1' && n.customerId?.startsWith('cust-')));

  // The other topic's insight never went to Linear.
  assert.ok(!needs.some((n) => /CSV/.test(n.body)));

  // Mirrored: the link, the topic state, one graph event per account.
  const link = db.tables.linear_issue_links[0];
  assert.equal(link.topic_key, KEY);
  assert.equal(link.linear_issue_id, 'lin-1');
  assert.equal(link.identifier, 'PRD-12');
  assert.deepEqual([...link.sent_item_ids].sort(), ['i1', 'i2', 'i3']);
  assert.equal(db.tables.insight_topic_state[0].status, 'aware');
  const events = db.tables.observations.filter((o) => o.property === 'product.linear_issue');
  assert.deepEqual(events.map((e) => e.entity_id).sort(), ['co-fern', 'co-harbor']);
  assert.equal(events[0].source, 'linear');
  assert.equal(events[0].value.identifier, 'PRD-12');
  assert.equal(events[0].value.topic_key, KEY);
});

test('sending again files no second issue and only adds insights Linear has not seen', async () => {
  const db = fakeDb(seed({
    linear_issue_links: [{ workspace_id: WS, topic_key: KEY, status: 'linked', linear_issue_id: 'lin-1', identifier: 'PRD-12', url: 'https://linear.app/acme/issue/PRD-12', team_id: 'team-1', sent_item_ids: ['i1', 'i2'] }],
  }));
  const linear = fakeLinear();
  const out = await sendTopicToLinear(db, { workspaceId: WS, topicKey: KEY, teamId: 'team-1', gql: linear.gql, appUrl: APP, userId: 'u-1' });

  assert.equal(out.created, false);
  assert.ok(!linear.ops().includes('IssueCreate'));
  const needs = linear.calls.filter((c) => c.op === 'CustomerNeedCreate');
  assert.equal(needs.length, 1);
  assert.match(needs[0].variables.input.body, /booking/);
  assert.deepEqual([...db.tables.linear_issue_links[0].sent_item_ids].sort(), ['i1', 'i2', 'i3']);
});

test('an issue already linked to the topic in Linear is reused, not duplicated', async () => {
  const db = fakeDb(seed());
  const linear = fakeLinear({ existingIssueForUrl: { id: 'lin-7', identifier: 'PRD-7', url: 'https://linear.app/acme/issue/PRD-7' } });
  const out = await sendTopicToLinear(db, { workspaceId: WS, topicKey: KEY, teamId: 'team-1', gql: linear.gql, appUrl: APP, userId: 'u-1' });
  assert.equal(out.created, false);
  assert.equal(out.issue.identifier, 'PRD-7');
  assert.ok(!linear.ops().includes('IssueCreate'));
  assert.equal(db.tables.linear_issue_links[0].linear_issue_id, 'lin-7');
});

test('Customer Requests switched off in Linear: the issue still lands, requests are skipped and said so', async () => {
  const db = fakeDb(seed());
  const linear = fakeLinear({ customersDisabled: true });
  const out = await sendTopicToLinear(db, { workspaceId: WS, topicKey: KEY, teamId: 'team-1', gql: linear.gql, appUrl: APP, userId: 'u-1' });
  assert.equal(out.created, true);
  assert.equal(out.requests_added, 0);
  assert.equal(out.requests_skipped, 'customers_unavailable');
  // Nothing was sent as a request, so nothing is marked sent: a later send can still add them.
  assert.deepEqual(db.tables.linear_issue_links[0].sent_item_ids, []);
});

test('a topic already past "new" keeps its status', async () => {
  const db = fakeDb(seed({
    insight_topic_state: [{ workspace_id: WS, topic_key: KEY, status: 'in_progress', priority: null, notes: '', updated_by: null, updated_at: 'x' }],
  }));
  await sendTopicToLinear(db, { workspaceId: WS, topicKey: KEY, teamId: 'team-1', gql: fakeLinear().gql, appUrl: APP, userId: 'u-1' });
  assert.equal(db.tables.insight_topic_state[0].status, 'in_progress');
});

test('an unknown topic is refused before anything reaches Linear', async () => {
  const db = fakeDb(seed());
  const linear = fakeLinear();
  await assert.rejects(
    sendTopicToLinear(db, { workspaceId: WS, topicKey: 'feature|tag-nope', teamId: 'team-1', gql: linear.gql, appUrl: APP, userId: 'u-1' }),
    (e) => e.code === 'topic_not_found',
  );
  assert.equal(linear.calls.length, 0);
});

// ── Failure and concurrency (fresh-context review) ──────────────────────────

const send = (db, linear, extra = {}) => sendTopicToLinear(db, { workspaceId: WS, topicKey: KEY, teamId: 'team-1', gql: linear.gql, appUrl: APP, userId: 'u-1', ...extra });

test('the issue is linked the moment it exists: a failure after that never files a second issue', async () => {
  const db = fakeDb(seed());
  await assert.rejects(send(db, fakeLinear({ failAttachment: true })));
  const link = db.tables.linear_issue_links[0];
  assert.equal(link.status, 'linked');
  assert.equal(link.linear_issue_id, 'lin-1');
  const again = fakeLinear();
  const out = await send(db, again);
  assert.equal(out.created, false);
  assert.ok(!again.ops().includes('IssueCreate'));
});

test('requests already filed stay marked sent when a later one fails, so a retry never repeats them', async () => {
  const db = fakeDb(seed());
  const out = await send(db, fakeLinear({ failNeedAfter: 1 }));
  assert.equal(out.requests_added, 1);
  assert.equal(db.tables.linear_issue_links[0].sent_item_ids.length, 1);
  const retry = fakeLinear();
  await send(db, retry);
  assert.equal(retry.calls.filter((c) => c.op === 'CustomerNeedCreate').length, 2);
  assert.equal(db.tables.linear_issue_links[0].sent_item_ids.length, 3);
});

test('a send already under way for the topic turns the second one away before Linear is called', async () => {
  const db = fakeDb(seed({
    linear_issue_links: [{ workspace_id: WS, topic_key: KEY, status: 'pending', claimed_at: new Date().toISOString(), sent_item_ids: [] }],
  }));
  const linear = fakeLinear();
  await assert.rejects(send(db, linear), (e) => e.code === 'send_in_progress');
  assert.equal(linear.calls.length, 0);
});

test('a claim left behind by a crashed send is taken over after two minutes', async () => {
  const db = fakeDb(seed({
    linear_issue_links: [{ workspace_id: WS, topic_key: KEY, status: 'pending', claimed_at: new Date(Date.now() - 10 * 60_000).toISOString(), sent_item_ids: [] }],
  }));
  const out = await send(db, fakeLinear());
  assert.equal(out.created, true);
  assert.equal(db.tables.linear_issue_links[0].status, 'linked');
});

test('a send that fails before any issue exists lets go of its claim', async () => {
  const db = fakeDb(seed());
  const linear = fakeLinear();
  const broken = async (q, v) => { if (/IssueCreate/.test(q)) throw Object.assign(new Error('down'), { code: 'linear_graphql' }); return linear.gql(q, v); };
  await assert.rejects(sendTopicToLinear(db, { workspaceId: WS, topicKey: KEY, teamId: 'team-1', gql: broken, appUrl: APP }));
  assert.equal(db.tables.linear_issue_links.length, 0);
});

test('one customer Linear will not take is skipped alone; its request still lands, without a customer', async () => {
  const db = fakeDb(seed());
  const linear = fakeLinear({ failUpsertFor: 'co-fern' });
  const out = await send(db, linear);
  assert.equal(out.requests_added, 3);
  assert.equal(out.requests_skipped, null);
  const needs = linear.calls.filter((c) => c.op === 'CustomerNeedCreate').map((c) => c.variables.input);
  assert.equal(needs.filter((n) => !n.customerId).length, 1);
});

test('a member who can only see some accounts sends only those accounts', async () => {
  const db = fakeDb(seed());
  const linear = fakeLinear();
  const out = await send(db, linear, { visibleCompanyIds: new Set(['co-harbor']) });
  assert.equal(out.accounts, 1);
  const create = linear.calls.find((c) => c.op === 'IssueCreate');
  assert.doesNotMatch(create.variables.input.description, /Fernpoint|Wren Hollis/);
  assert.equal(linear.calls.filter((c) => c.op === 'CustomerNeedCreate').length, 2);
});
