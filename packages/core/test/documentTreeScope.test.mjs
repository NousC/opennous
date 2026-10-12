// Pages is a reports index, not a filing cabinet (GET-349).
//
// Nearly every document in prod is about one account, most of them call summaries — and that is from
// a short backfill. At a full year it becomes thousands of call pages against a handful of reports.
//
// The filter is structural on purpose: a report is the only kind with no subject, so
// `subject_entity_id IS NULL` already means "about the workspace" and a new document kind cannot
// quietly appear in the wrong index. These tests pin that, and pin that nothing is destroyed.
//
// Run: node --test packages/core/test/documentTreeScope.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { documentTree } from '../dist/db/documents.js';

const DOCS = [
  { id: 'r1', kind: 'report', cadence: 'weekly', title: 'Weekly revenue', subject_entity_id: null },
  { id: 'r2', kind: 'report', cadence: null, title: 'Win/loss', subject_entity_id: null },
  { id: 'o1', kind: 'plan', title: 'GTM plan', subject_entity_id: null },
  { id: 'c1', kind: 'call', title: 'Acme QBR', subject_entity_id: 'co1' },
  { id: 'c2', kind: 'call', title: 'Acme training', subject_entity_id: 'co1' },
  { id: 'b1', kind: 'brief', title: 'Acme brief', subject_entity_id: 'co1' },
];

/** Minimal stub: documents come from the fixture, every relationship query is empty. */
function db(docs) {
  const q = (rows) => {
    const self = {
      select: () => self, eq: () => self, neq: () => self, in: () => self, is: () => self,
      like: () => self, or: () => self, order: () => self, limit: () => Promise.resolve({ data: rows, error: null }),
      range: () => Promise.resolve({ data: rows, error: null }),
      then: (res) => res({ data: rows, error: null }),
    };
    return self;
  };
  return { from: (t) => q(t === 'documents' ? docs : []) };
}

test('workspaceOnly keeps the reports and drops everything with a subject', async () => {
  const tree = await documentTree(db(DOCS), 'ws', { workspaceOnly: true });
  const reports = Object.values(tree.reports).flat().map(d => d.id).sort();
  assert.deepEqual(reports, ['r1', 'r2']);
  assert.deepEqual(tree.other.map(d => d.id), ['o1'], 'a workspace-scoped plan has no subject, so it stays');
  assert.equal(tree.accounts.length, 0, 'no account folders in a reports index');
});

test('without the flag nothing changes', async () => {
  // The filter is opt-in, so every other caller of documentTree is untouched by this.
  const tree = await documentTree(db(DOCS), 'ws');
  const shown = [...Object.values(tree.reports).flat(), ...tree.other,
    ...tree.accounts.flatMap(a => [...a.documents, ...a.calls])].map(d => d.id).sort();
  assert.deepEqual(shown, ['b1', 'c1', 'c2', 'o1', 'r1', 'r2']);
});

test('the rule is the subject, not a list of kinds', async () => {
  // A kind nobody has invented yet must land correctly without anyone updating this filter. That
  // is the whole reason the rule is structural.
  const docs = [
    { id: 'x1', kind: 'some_future_kind', title: 'About one account', subject_entity_id: 'co1' },
    { id: 'x2', kind: 'some_future_kind', title: 'About the workspace', subject_entity_id: null },
  ];
  const tree = await documentTree(db(docs), 'ws', { workspaceOnly: true });
  const shown = [...Object.values(tree.reports).flat(), ...tree.other].map(d => d.id);
  assert.deepEqual(shown, ['x2']);
  assert.equal(tree.accounts.length, 0);
});

test('an empty workspace does not throw', async () => {
  const tree = await documentTree(db([]), 'ws', { workspaceOnly: true });
  assert.equal(tree.accounts.length, 0);
  assert.equal(Object.values(tree.reports).flat().length, 0);
});
