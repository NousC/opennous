// PostHog errors and friction as Product insights (GET-751): how a row is read and cleaned, what
// counts as one issue, what is worth an insight, and the sentence the board shows.
//
// Run: pnpm --filter @nous/core build && node --test packages/core/test/posthogIssues.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseIssueRows, issuesFor, issueStatement, normalizePath, sanitizeIssueMessage, posthogIssuesQuery } from '../dist/integrations/posthog.js';

test('the query reads both exception shapes and only the last 7 days of issue events', () => {
  const q = posthogIssuesQuery();
  assert.match(q, /\$exception_types/);
  assert.match(q, /\$exception_type\)/);
  assert.match(q, /INTERVAL 7 DAY/);
  assert.match(q, /event IN \('\$exception', '\$rageclick', '\$dead_click'\)/);
});

test('a page is a place: record ids and numbers fold into :id, query strings go', () => {
  assert.equal(normalizePath('/accounts/ba1513d8-07bf-4290-a6dc-ae2b6babf294?tab=intel'), '/accounts/:id');
  assert.equal(normalizePath('/deals/4821/notes#x'), '/deals/:id/notes');
  assert.equal(normalizePath(''), null);
});

test('an error message keeps the error and loses who it was about', () => {
  assert.equal(sanitizeIssueMessage('No contact sorrel@harborline.example (id 7f3c2a10-1111-4222-8333-444455556666) row 1234567 at https://x.example/a'),
    'No contact <email> (id <id>) row <n> at <url>');
});

const rows = parseIssueRows([
  ['Sorrel@Harborline.example', '$exception', 'TypeError', 'Failed to fetch', '/automations', 2, '2026-10-20T08:00:00Z'],
  ['wren@harborline.example', '$exception', 'TypeError', 'Failed to fetch', '/automations', 1, '2026-10-19T08:00:00Z'],
  ['wren@harborline.example', '$rageclick', '', '', '/integrations', 3, '2026-10-19T09:00:00Z'],
  ['ash@harborline.example', '$rageclick', '', '', '/integrations', 1, '2026-10-18T09:00:00Z'],
  ['ash@harborline.example', '$dead_click', '', '', '/tasks', 4, '2026-10-18T09:00:00Z'],
  ['nobody', '$exception', 'X', 'y', '/', 9, null],
  ['ash@harborline.example', '$pageview', '', '', '/', 9, null],
]);

test('rows are read per user, cleaned, and anything that is not an issue is dropped', () => {
  assert.equal(rows.length, 5);
  assert.equal(rows[0].email, 'sorrel@harborline.example');
  assert.equal(rows[0].lastAt, '2026-10-20T08:00:00.000Z');
});

test('the same error on the same page is one issue across people; only what is worth reading stays', () => {
  const issues = issuesFor(rows);
  assert.deepEqual(issues.map(i => [i.event, i.path, i.count, i.emails.length]), [['$exception', '/automations', 3, 2]],
    'rage clicks 4 < 5, dead clicks 4 < 10');
  const more = issuesFor([...rows, { ...rows[2], n: 1 }]);
  assert.ok(more.some(i => i.event === '$rageclick' && i.count === 5));
});

test('the sentence says what, where, how often and by how many', () => {
  const [bug] = issuesFor(rows);
  assert.equal(issueStatement(bug), 'Error in the product on /automations: TypeError: Failed to fetch. 3 times by 2 people in the last 7 days (PostHog).');
  assert.equal(issueStatement({ event: '$rageclick', path: '/integrations', count: 5, emails: ['a', 'b'] }),
    'People clicked over and over on /integrations, 5 times by 2 people in the last 7 days (PostHog).');
  assert.equal(issueStatement({ event: '$dead_click', path: null, count: 12, emails: ['a'] }),
    'Clicks that did nothing, 12 times by 1 person in the last 7 days (PostHog).');
});
