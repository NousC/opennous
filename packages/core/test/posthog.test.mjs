// PostHog as a source (GET-751): where a project lives, how a webhook delivery and a usage row
// are read, how users roll up into accounts, and the "When a PostHog event fires" runner.
//
// Run: pnpm --filter @nous/core build && node --test packages/core/test/posthog.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  posthogApiBase, posthogProjectId, posthogEventList, posthogSettings, posthogDestination,
  parsePostHogDelivery, slimProperties, posthogUsageQuery, parseUsageRows, rollUpByDomain,
  companyUsageFacts, personUsageFacts,
} from '../dist/integrations/posthog.js';
import { posthogEventSignal, posthogEventVars, posthogEventText } from '../dist/services/posthogTrigger.mjs';
import { processPostHogEvents } from '../dist/services/automationRun.mjs';

test('a pasted host resolves to the REST host, ingest hosts and regions included', () => {
  assert.equal(posthogApiBase(''), 'https://us.posthog.com');
  assert.equal(posthogApiBase('us'), 'https://us.posthog.com');
  assert.equal(posthogApiBase('EU'), 'https://eu.posthog.com');
  assert.equal(posthogApiBase('https://us.i.posthog.com'), 'https://us.posthog.com');
  assert.equal(posthogApiBase('https://eu.posthog.com/project/12345/insights'), 'https://eu.posthog.com');
  assert.equal(posthogApiBase('app.posthog.com'), 'https://us.posthog.com');
  assert.equal(posthogApiBase('https://analytics.harborline.example'), 'https://analytics.harborline.example');
});

test('a host that could point our key anywhere private is refused', () => {
  for (const bad of ['http://us.posthog.com', '10.0.0.4', 'https://169.254.169.254', 'localhost', 'https://posthog.internal',
    'https://posthog.local', 'https://ph.harborline.example:8443', 'https://[::1]', 'not a host', 'https://ph']) {
    assert.equal(posthogApiBase(bad), null, bad);
  }
});

test('a project id from the number or the address', () => {
  assert.equal(posthogProjectId('12345'), '12345');
  assert.equal(posthogProjectId(' https://us.posthog.com/project/678/web '), '678');
  assert.equal(posthogProjectId('abc'), null);
  assert.equal(posthogProjectId(''), null);
});

test('key events: split, trimmed, de-duplicated, capped at ten, and no quotes', () => {
  assert.deepEqual(posthogEventList('report_created, invite_sent ,report_created,,'), ['report_created', 'invite_sent']);
  assert.equal(posthogEventList(Array.from({ length: 14 }, (_, i) => `e${i}`)).length, 10);
  assert.deepEqual(posthogEventList("ok, it's, back\\slash"), ['ok']);
});

test('settings prefer the plain copies subscribe stored, and default the signup event', () => {
  const r = posthogSettings({ host: 'eu', project_id: '9', key_events: 'signed_up, report_created' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.settings, { apiBase: 'https://eu.posthog.com', projectId: '9', signupEvent: 'signed_up', keyEvents: ['report_created'] });
  const stored = posthogSettings({ host: 'ciphertext', project_id: 'ciphertext', posthog_api_base: 'https://us.posthog.com', posthog_project_id: '42' });
  assert.equal(stored.ok && stored.settings.projectId, '42');
  assert.deepEqual(posthogSettings({ host: 'us' }), { ok: false, reason: 'posthog_project_id_missing' });
});

test('the destination is PostHog\'s webhook template, filtered to the chosen events, with our secret', () => {
  const d = posthogDestination('https://api.example/inbound/posthog/ws1', 's3cret', ['signed_up', 'report_created']);
  assert.equal(d.template_id, 'template-webhook');
  assert.equal(d.type, 'destination');
  assert.equal(d.inputs.url.value, 'https://api.example/inbound/posthog/ws1');
  assert.equal(d.inputs.headers.value['X-Nous-Secret'], 's3cret');
  assert.deepEqual(d.filters.events.map(e => e.id), ['signed_up', 'report_created']);
});

const delivery = {
  event: {
    uuid: '0190-abc', event: 'signed_up', distinct_id: 'u1', timestamp: '2026-10-18T09:30:00.000Z',
    properties: { plan: 'team', seats: 4, $current_url: 'https://app.example/signup', nested: { a: 1 }, $set: { email: 'ignored@harborline.example' } },
  },
  person: { id: 'p1', name: 'Sorrel Pike', properties: { email: 'Sorrel@Harborline.example', name: 'Sorrel Pike' } },
};

test('a delivery is read as the event, its person and the customer\'s own short properties', () => {
  const ev = parsePostHogDelivery(delivery);
  assert.equal(ev.uuid, '0190-abc');
  assert.equal(ev.name, 'signed_up');
  assert.equal(ev.email, 'sorrel@harborline.example');
  assert.equal(ev.fullName, 'Sorrel Pike');
  assert.equal(ev.occurredAt, '2026-10-18T09:30:00.000Z');
  assert.deepEqual(ev.properties, { plan: 'team', seats: 4 });
});

test('no email anywhere is an event we cannot file; no uuid or name is not an event', () => {
  assert.equal(parsePostHogDelivery({ event: { uuid: 'x', event: 'pageview', properties: {} }, person: { properties: {} } }).email, null);
  assert.equal(parsePostHogDelivery({ event: { uuid: 'x', properties: {} } }), null);
  assert.equal(parsePostHogDelivery({}), null);
  assert.equal(parsePostHogDelivery({ event: { uuid: 'x', event: 'e', properties: {} }, person: { properties: { email: 'not-an-email' } } }).email, null);
});

test('properties are capped in count and length', () => {
  const many = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`k${i}`, 'v'.repeat(500)]));
  const slim = slimProperties(many);
  assert.equal(Object.keys(slim).length, 20);
  assert.equal(slim.k0.length, 200);
});

test('the usage query counts each key event in its own column and only reads 60 days', () => {
  const q = posthogUsageQuery(['report_created', 'invite_sent']);
  assert.match(q, /countIf\(event = 'report_created' AND timestamp >= now\(\) - INTERVAL 30 DAY\) AS k0/);
  assert.match(q, /minIf\(timestamp, event = 'invite_sent'\) AS f1/);
  assert.match(q, /INTERVAL 60 DAY/);
  assert.doesNotMatch(posthogUsageQuery([]), /k0/);
});

const rows = [
  ['sorrel@harborline.example', '2026-10-17 12:00:00', 12, 3, 140, 90, 9, '2026-09-01T10:00:00Z', 0, '1970-01-01 00:00:00'],
  ['wren@harborline.example', '2026-09-02T10:00:00Z', 0, 0, 0, 40, 0, '2026-08-25T10:00:00Z', 0, '1970-01-01T00:00:00Z'],
  ['ash@fernpoint.example', '2026-10-18T08:00:00Z', 20, 5, 300, 310, 0, '1970-01-01T00:00:00Z', 2, '2026-10-10T00:00:00Z'],
  ['solo.founder@gmail.com', '2026-10-18T08:00:00Z', 4, 1, 20, 0, 0, null, 0, null],
  ['', '2026-10-18T08:00:00Z', 1, 1, 1, 0, 0, null, 0, null],
];

test('usage rows read per user, with UTC times, "never" for an epoch, and no company for free mail', () => {
  const users = parseUsageRows(rows, ['report_created', 'invite_sent']);
  assert.equal(users.length, 4);
  assert.equal(users[0].lastSeen, '2026-10-17T12:00:00.000Z');
  assert.deepEqual(users[0].keyEvents.invite_sent, { count30d: 0, firstSeen: null });
  assert.equal(users[0].keyEvents.report_created.firstSeen, '2026-09-01T10:00:00.000Z');
  assert.equal(users[3].domain, null);
});

test('users roll up per work domain: active now, active before, last used, key events by user', () => {
  const byDomain = Object.fromEntries(rollUpByDomain(parseUsageRows(rows, ['report_created', 'invite_sent'])).map(c => [c.domain, c]));
  assert.deepEqual(Object.keys(byDomain).sort(), ['fernpoint.example', 'harborline.example']);
  const h = byDomain['harborline.example'];
  assert.equal(h.totalUsers, 2);
  assert.equal(h.activeUsers30d, 1);
  assert.equal(h.activeUsersPrev30d, 2);
  assert.equal(h.usage30d, 140);
  assert.equal(h.lastUsedAt, '2026-10-17T12:00:00.000Z');
  assert.deepEqual(h.keyEvents.report_created, { count30d: 9, users30d: 1, firstSeen: '2026-08-25T10:00:00.000Z' });
  const facts = Object.fromEntries(companyUsageFacts(h));
  assert.equal(facts['cs.active_users_30d'], 1);
  assert.equal(facts['cs.total_users'], 2);
  assert.equal(facts['cs.last_used_at'], '2026-10-17T12:00:00.000Z');
  assert.equal(Object.fromEntries(personUsageFacts(parseUsageRows(rows, [])[0]))['product.key_events'], null);
  assert.equal(Object.fromEntries(personUsageFacts(parseUsageRows(rows, [])[0]))['product.user'], true);
  assert.equal(Object.fromEntries(personUsageFacts(parseUsageRows(rows, [])[1]))['product.user'], false, 'not active in 30 days');
});

const row = { id: 'obs-1', entity_id: 'person-1', observed_at: '2026-10-18T09:30:00Z', value: { name: 'report_created', properties: { plan: 'team' } }, raw: { account_id: 'acct-1' } };

test('an event as the run\'s signal and its variables', () => {
  const s = posthogEventSignal(row);
  assert.equal(s.kind, 'posthog_event');
  assert.equal(s.account_id, 'acct-1');
  assert.equal(s.entity_id, 'person-1');
  assert.equal(s.content, 'report_created (plan: team)');
  assert.deepEqual(posthogEventVars({ name: 'report_created', properties: { plan: 'team', seats: 4 } }), { 'event.name': 'report_created', 'event.properties': 'plan: team\nseats: 4' });
  assert.deepEqual(posthogEventVars(null), {});
  assert.equal(posthogEventText('x', {}), 'x');
});

/** The routines query, as the runner builds it: from().select().eq().or() awaited. */
function routinesDb(routines) {
  const q = { select: () => q, eq: () => q, or: () => q, then: (ok) => ok({ data: routines, error: null }) };
  return { from: () => q };
}

test('each watched event runs each automation once per matching event, primary and `also` triggers alike', async () => {
  const routines = [
    { id: 'r1', name: 'Signup welcome', workspace_id: 'ws1', trigger_kind: 'posthog_event', trigger_config: { event: 'signed_up', also: [{ kind: 'posthog_event', config: { event: 'report_created' } }] } },
  ];
  const asked = [];
  const ran = [];
  const out = await processPostHogEvents({
    supabase: routinesDb(routines),
    readEvents: async (_s, ws, cfg) => { asked.push([ws, cfg.event]); return { ok: true, events: cfg.event === 'signed_up' ? [row, { ...row, id: 'obs-2' }] : [] }; },
    runOne: async (_s, ws, a, r) => { ran.push([a.trigger_config.event, r.id]); return true; },
  });
  assert.deepEqual(asked, [['ws1', 'signed_up'], ['ws1', 'report_created']]);
  assert.deepEqual(ran, [['signed_up', 'obs-1'], ['signed_up', 'obs-2']]);
  assert.equal(out.ran, 2);
});

test('a reader that fails skips that trigger and runs nothing', async () => {
  const out = await processPostHogEvents({
    supabase: routinesDb([{ id: 'r1', name: 'x', workspace_id: 'ws1', trigger_kind: 'posthog_event', trigger_config: {} }]),
    readEvents: async () => ({ ok: false, reason: 'posthog_trigger_not_set' }),
    runOne: async () => { throw new Error('must not run'); },
  });
  assert.equal(out.ran, 0);
});
