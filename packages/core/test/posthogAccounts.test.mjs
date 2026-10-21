// Which account a PostHog user belongs to (GET-751): their company group first, then their work
// email, then the company PostHog has on them. A free-mail user with none has no account here.
//
// Run: pnpm --filter @nous/core build && node --test packages/core/test/posthogAccounts.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { usageAccountOf, rollUpByAccount, companyGroupIndex, parseGroupRows, posthogGroupsQuery, posthogUsageQuery, parseUsageRows, parsePostHogDelivery, hostOf } from '../dist/integrations/posthog.js';

const user = (over) => ({ email: 'a@harborline.example', domain: 'harborline.example', lastSeen: null, activeDays30d: 3, activeDays7d: 1, events30d: 10, eventsPrev30d: 0, keyEvents: {}, fullName: null, companyHint: null, groupKey: null, ...over });
const groups = new Map([['org_1', { name: 'Fernpoint', domain: 'fernpoint.example' }], ['org_2', { name: null, domain: null }]]);

test('a company group wins, then the work email, then the company on the person', () => {
  assert.deepEqual(usageAccountOf(user({ email: 'sam@gmail.com', domain: null, groupKey: 'org_1' }), groups), { key: 'group:org_1', name: 'Fernpoint', domain: 'fernpoint.example' });
  assert.deepEqual(usageAccountOf(user({ companyHint: 'Harborline Inc' }), groups), { key: 'domain:harborline.example', name: 'Harborline Inc', domain: 'harborline.example' });
  assert.deepEqual(usageAccountOf(user({ email: 'sam@gmail.com', domain: null, companyHint: 'Lumen Labs' }), groups), { key: 'name:lumen labs', name: 'Lumen Labs', domain: null });
  assert.equal(usageAccountOf(user({ email: 'sam@gmail.com', domain: null, groupKey: 'org_2' }), groups), null, 'a group with nothing to go on is no account');
  assert.equal(usageAccountOf(user({ email: 'sam@gmail.com', domain: null })), null);
});

test('users roll up per account: a free-mail user in a company group counts on that company', () => {
  const rows = rollUpByAccount([
    user({ email: 'sam@gmail.com', domain: null, groupKey: 'org_1' }),
    user({ email: 'kit@fernpoint.example', domain: 'fernpoint.example', groupKey: 'org_1' }),
    user({ email: 'jo@gmail.com', domain: null }),
  ], (u) => usageAccountOf(u, groups));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].key, 'group:org_1');
  assert.equal(rows[0].totalUsers, 2);
  assert.equal(rows[0].name, 'Fernpoint');
});

test('the company group type is found by its name', () => {
  assert.equal(companyGroupIndex([{ group_type: 'project', group_type_index: 0 }, { group_type: 'company', group_type_index: 1 }]), 1);
  assert.equal(companyGroupIndex([{ group_type: 'organization', group_type_index: 0 }]), 0);
  assert.equal(companyGroupIndex([{ group_type: 'project', group_type_index: 0 }]), null);
  assert.equal(companyGroupIndex([]), null);
  assert.match(posthogGroupsQuery(1), /FROM groups WHERE index = 1/);
});

test('a group\'s site becomes its domain; a free-mail one does not', () => {
  const g = parseGroupRows([['org_1', 'Fernpoint', 'https://www.fernpoint.example/about'], ['org_3', 'Solo', 'gmail.com'], [null, 'x', 'y']]);
  assert.deepEqual(g.get('org_1'), { name: 'Fernpoint', domain: 'fernpoint.example' });
  assert.deepEqual(g.get('org_3'), { name: 'Solo', domain: null });
  assert.equal(g.size, 2);
  assert.equal(hostOf('not a site'), null);
});

test('the usage query reads the name, the company and the group after the key events', () => {
  const q = posthogUsageQuery(['report_created'], { groupIndex: 1 });
  assert.match(q, /AS f0,\n  max\(toString\(person\.properties\.name\)\) AS full_name/);
  assert.match(q, /max\(\$group_1\) AS grp/);
  assert.doesNotMatch(posthogUsageQuery([]), /\$group_/);
  const [u] = parseUsageRows([['sam@gmail.com', '2026-10-20T10:00:00Z', 3, 1, 10, 0, 2, '2026-10-01T00:00:00Z', 'Sam Reyes', 'Lumen Labs', 'org_1']], ['report_created']);
  assert.equal(u.fullName, 'Sam Reyes');
  assert.equal(u.companyHint, 'Lumen Labs');
  assert.equal(u.groupKey, 'org_1');
  assert.equal(u.keyEvents.report_created.count30d, 2);
});

test('a signup carries the company the product put on the person', () => {
  const ev = parsePostHogDelivery({ event: { uuid: 'u', event: 'signed_up', properties: {} }, person: { properties: { email: 'sam@gmail.com', company_name: 'Lumen Labs', website: 'https://lumen.example' } } });
  assert.equal(ev.companyName, 'Lumen Labs');
  assert.equal(ev.companyDomain, 'lumen.example');
});

import { posthogEventNamesQuery, parseEventNames } from '../dist/integrations/posthog.js';

test('the events to pick from: the project\'s own, most frequent first, never PostHog\'s', () => {
  assert.match(posthogEventNamesQuery(), /NOT startsWith\(event, '\$'\)/);
  assert.deepEqual(parseEventNames([['account_record_opened', 13, 2], ["it's", 1, 1], ['invite_sent', '2', '2']]),
    [{ name: 'account_record_opened', count: 13, people: 2 }, { name: 'invite_sent', count: 2, people: 2 }]);
});
