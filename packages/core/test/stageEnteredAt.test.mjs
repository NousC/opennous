// "Time in stage" counts from when the deal ENTERED its stage, not from the last CRM edit.
// The sync re-writes the current stage on every touch of the deal, dated to the touch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stageEnteredAt } from '../dist/integrations/crm/index.js';

const obs = (value, observed_at, stage_id) => ({ value, observed_at, raw: stage_id ? { stage_id } : null });

test('re-writes of the same stage do not reset the clock (a dealership deal)', () => {
  const rows = [
    obs(' First Call', '2026-06-10T15:00:00Z'),
    obs('Walkthrough Set', '2026-09-15T14:00:00Z'),
    obs('Walkthrough Done', '2026-09-15T14:05:00Z'),
    obs('Proposal (Approved)', '2026-09-15T19:00:00Z'),
    obs('Proposal (Approved)', '2026-09-18T20:00:00Z'),
    obs('Proposal (Approved)', '2026-09-25T15:30:00Z'),
    obs('Proposal (Approved)', '2026-09-25T15:30:00Z'),   // the same touch written twice
  ];
  assert.equal(stageEnteredAt(rows), '2026-09-15T19:00:00Z');
});

test('order of the rows does not matter, and label spacing or case is the same stage', () => {
  const rows = [
    obs('Proposal (Approved) ', '2026-10-01T00:00:00Z'),
    obs(' First Call', '2026-06-01T00:00:00Z'),
    obs('proposal (approved)', '2026-09-22T00:00:00Z'),
    obs('First Call', '2026-06-20T00:00:00Z'),
  ];
  assert.equal(stageEnteredAt(rows), '2026-09-22T00:00:00Z');
});

test('a deal that went back to a stage it held before counts from the return, not the first visit', () => {
  const rows = [
    obs('Negotiation', '2026-05-01T00:00:00Z', 's3'),
    obs('Demo', '2026-06-01T00:00:00Z', 's2'),
    obs('Negotiation', '2026-07-01T00:00:00Z', 's3'),
    obs('Negotiation', '2026-08-01T00:00:00Z', 's3'),
  ];
  assert.equal(stageEnteredAt(rows), '2026-07-01T00:00:00Z');
});

test('a renamed stage with the same id is still the same stage', () => {
  const rows = [obs('Demo', '2026-06-01T00:00:00Z', 's2'), obs('Demo scheduled', '2026-06-10T00:00:00Z', 's2')];
  assert.equal(stageEnteredAt(rows), '2026-06-01T00:00:00Z');
});

test('one row, or none', () => {
  assert.equal(stageEnteredAt([obs('Demo', '2026-06-01T00:00:00Z')]), '2026-06-01T00:00:00Z');
  assert.equal(stageEnteredAt([]), null);
});
