// Product insights say what kind of feedback they are (GET-775): a bug, a feature request, an
// improvement to something that exists, or praise. Customer feedback on our features used to be
// filed as the customer's pain; it now lands here, typed, so product can filter it.
//
// Run: pnpm --filter @nous/core build && node --test packages/core/test/insightKind.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildInsightExtractionPrompt, upsertInsightItems, normalizeInsightKind, parseInsightsJson } from '../dist/db/insights.js';

test('the model cannot assign a finding to arbitrary person or company IDs', () => {
  const [item] = parseInsightsJson(JSON.stringify([{ category: 'product', content: 'Needs field permissions.',
    quote: 'We need field permissions.', speaker: 'Dana', contactId: 'untrusted-person', companyId: 'untrusted-company' }]));
  assert.equal(item.contactId, undefined);
  assert.equal(item.companyId, undefined);
});

test('checked source adapters preserve the precise person/account on insight rows', async () => {
  const db = fakeSupabase();
  await upsertInsightItems(db, 'ws', [{ source: 'external', category: 'product', statement: 'Users need field permissions.',
    contact_id: 'person', company_id: 'account' }]);
  assert.equal(db.writes[0][0].contact_id, 'person');
  assert.equal(db.writes[0][0].company_id, 'account');
});

test('the insight prompt asks a product insight for its kind', () => {
  const p = buildInsightExtractionPrompt('transcript', { attendees: ['Dana Reyes'], workspaceContext: 'We sell a context graph.' });
  assert.match(p, /"kind"/);
  assert.match(p, /bug/); assert.match(p, /request/); assert.match(p, /improvement/); assert.match(p, /praise/);
});

test('kinds are a closed set; anything else is no kind', () => {
  assert.equal(normalizeInsightKind('Feature Request'), 'request');
  assert.equal(normalizeInsightKind('bug'), 'bug');
  assert.equal(normalizeInsightKind('improvement'), 'improvement');
  assert.equal(normalizeInsightKind('nonsense'), null);
  assert.equal(normalizeInsightKind(undefined), null);
});

function fakeSupabase({ missingKindColumn = false } = {}) {
  const writes = [];
  return {
    writes,
    from() {
      return {
        upsert(rows) {
          writes.push(rows);
          const hasKind = rows.some(r => 'kind' in r);
          const error = missingKindColumn && hasKind ? { code: 'PGRST204', message: "Could not find the 'kind' column" } : null;
          return { select: () => Promise.resolve({ data: error ? null : rows.map((r, i) => ({ id: `i${i}` })), error }) };
        },
      };
    },
  };
}

const ITEM = { source: 'external', category: 'product', statement: 'Users want to edit the summary prompt themselves.', kind: 'request' };

test('the kind is stored with the insight', async () => {
  const sb = fakeSupabase();
  await upsertInsightItems(sb, 'ws', [ITEM]);
  assert.equal(sb.writes[0][0].kind, 'request');
});

test('before the column exists, the insight is still stored, without its kind', async () => {
  const sb = fakeSupabase({ missingKindColumn: true });
  const n = await upsertInsightItems(sb, 'ws', [ITEM]);
  assert.equal(n, 1);
  assert.equal(sb.writes.length, 2, 'retried once');
  assert.equal('kind' in sb.writes[1][0], false);
});
