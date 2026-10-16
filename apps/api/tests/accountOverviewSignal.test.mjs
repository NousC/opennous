// The Accounts table's Latest signal (GET-894): POST /api/account-overview sends each account's
// latest signal with its kind's label, its tone (the pill's colour) and the line that says what was
// said, so the browser never shows a bare kind or an extraction tag. The tone mapping itself is
// pinned in packages/core/test/signalTone.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accountOverviewRows } from '../src/routes/api/accountOverview.mjs';

test('each account row carries the latest signal as label, tone and text', () => {
  const rows = accountOverviewRows([
    { id: 'a1', deal_count: 2, won_deals: 0, lost_deals: 0, latest_signal: { kind: 'churn_risk', title: null, content: 'Moving to a cheaper vendor after renewal.', quote: 'we will switch', at: '2026-10-14T10:00:00Z', entity_id: 'e1', claim_property: 'note.a' } },
    { id: 'a2', deal_count: 0, won_deals: 0, lost_deals: 0, latest_signal: { kind: 'expansion_signal', title: 'Reporting', content: null, quote: 'we want the reporting module', at: null } },
    { id: 'a3', deal_count: 1, won_deals: 1, lost_deals: 0, latest_signal: null },
  ]);
  assert.deepEqual(rows.map(r => r.latest_signal && [r.latest_signal.label, r.latest_signal.tone, r.latest_signal.text]), [
    ['Churn risk', 'red', 'Moving to a cheaper vendor after renewal.'],
    ['Expansion signal', 'green', 'we want the reporting module'],
    null,
  ]);
  // The rest of the row is untouched.
  assert.equal(rows[0].deal_count, 2);
  assert.equal(rows[0].latest_signal.kind, 'churn_risk');
  assert.equal(rows[0].latest_signal.at, '2026-10-14T10:00:00Z');
});

test('an overview from before the migration (kind and title only) still reads', () => {
  const [row] = accountOverviewRows([{ id: 'a1', latest_signal: { kind: 'budget_discussed', title: 'Monthly Cost Need', at: null } }]);
  assert.deepEqual([row.latest_signal.label, row.latest_signal.tone, row.latest_signal.text], ['Budget discussed', 'purple', 'Monthly Cost Need']);
});
