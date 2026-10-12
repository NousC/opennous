// HubSpot property history → observations. Fixture shape copied from a live batch-read
// with propertiesWithHistory (scripts/hubspot-profile.mjs, seeded portal, 2026-09-09).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  dealHistoryFacts, contactHistoryFacts, buildStageIndex, hubspotPipelineToCrm,
} from '../dist/integrations/crm/index.js';

const PIPELINE = hubspotPipelineToCrm({
  id: 'default', label: 'Sales Pipeline',
  stages: [
    { id: 'appointmentscheduled', label: 'Appointment Scheduled', displayOrder: 0, metadata: { isClosed: 'false', probability: '0.2' } },
    { id: 'contractsent',         label: 'Contract Sent',         displayOrder: 1, metadata: { isClosed: 'false', probability: '0.9' } },
    { id: 'closedwon',            label: 'Closed Won',            displayOrder: 2, metadata: { isClosed: 'true',  probability: '1.0' } },
  ],
});
const IDX = buildStageIndex([PIPELINE]);

// Newest first, as HubSpot returns it.
const DEAL_HISTORY = {
  dealstage: [
    { timestamp: '2026-09-10T00:19:18.754Z', value: 'closedwon',            sourceType: 'INTEGRATION' },
    { timestamp: '2026-09-10T00:19:18.346Z', value: 'contractsent',         sourceType: 'INTEGRATION' },
    { timestamp: '2026-09-10T00:19:15.672Z', value: 'appointmentscheduled', sourceType: 'INTEGRATION' },
  ],
  amount:    [{ timestamp: '2026-09-10T00:19:15.672Z', value: '42000', sourceType: 'INTEGRATION' }],
  closedate: [
    { timestamp: '2026-09-12T00:00:00.000Z', value: '2026-11-30T00:00:00.000Z', sourceType: 'CRM_UI' },
    { timestamp: '2026-09-10T00:19:15.672Z', value: '2026-10-15T00:00:00.000Z', sourceType: 'INTEGRATION' },
  ],
};

test('stage history becomes dated `stage` facts with the LABEL as value and the id in raw', () => {
  const facts = dealHistoryFacts('100000000001', DEAL_HISTORY, IDX);
  const stages = facts.filter(f => f.property === 'stage');
  assert.equal(stages.length, 3);
  assert.deepEqual(stages.map(f => f.value), ['Closed Won', 'Contract Sent', 'Appointment Scheduled']);
  assert.equal(stages[0].raw.stage_id, 'closedwon');
  assert.equal(stages[0].raw.status, 'won');
  assert.equal(stages[1].raw.status, 'open');
  assert.equal(stages[0].observedAt, '2026-09-10T00:19:18.754Z');
});

test('external ids are unique per (deal, property, timestamp) so re-syncs are idempotent', () => {
  const facts = dealHistoryFacts('100000000001', DEAL_HISTORY, IDX);
  const ids = facts.map(f => f.externalId);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.includes('hubspot:deal:100000000001:dealstage:2026-09-10T00:19:18.754Z'));
  assert.ok(ids.includes('hubspot:deal:100000000001:closedate:2026-09-12T00:00:00.000Z'));
});

test('amount is numeric, close-date slips are kept as separate dated facts', () => {
  const facts = dealHistoryFacts('d1', DEAL_HISTORY, IDX);
  const amount = facts.find(f => f.property === 'value');
  assert.equal(amount.value, 42000);
  const closes = facts.filter(f => f.property === 'close_date');
  assert.equal(closes.length, 2);
  assert.equal(closes[0].value, '2026-11-30T00:00:00.000Z');
});

test('an unknown stage id falls back to the raw id rather than dropping the change', () => {
  const facts = dealHistoryFacts('d1', { dealstage: [{ timestamp: '2026-01-01T00:00:00Z', value: '9999999' }] }, IDX);
  assert.equal(facts[0].value, '9999999');
  assert.equal(facts[0].raw.status, null);
});

test('no index at all still yields stage facts by id', () => {
  const facts = dealHistoryFacts('d1', DEAL_HISTORY, null);
  assert.equal(facts.filter(f => f.property === 'stage')[0].value, 'closedwon');
});

test('empty, missing, and malformed history entries are tolerated', () => {
  assert.deepEqual(dealHistoryFacts('d1', null, IDX), []);
  assert.deepEqual(dealHistoryFacts('d1', {}, IDX), []);
  const facts = dealHistoryFacts('d1', {
    dealstage: [{ value: 'closedwon' }],                                     // no timestamp
    amount: [{ timestamp: '2026-01-01T00:00:00Z', value: 'not-a-number' }],  // NaN
    closedate: [{ timestamp: '2026-01-01T00:00:00Z', value: '' }],          // empty
  }, IDX);
  assert.deepEqual(facts, []);
});

test('contact lifecycle history becomes dated lifecycle_stage facts', () => {
  const facts = contactHistoryFacts('200000000002', {
    lifecyclestage: [
      { timestamp: '2026-09-10T00:20:00.000Z', value: 'customer', sourceType: 'DEALS' },
      { timestamp: '2026-08-30T22:46:46.470Z', value: 'lead',     sourceType: 'API' },
    ],
    hs_lead_status: [{ timestamp: '2026-09-01T00:00:00.000Z', value: 'IN_PROGRESS' }],
  });
  assert.deepEqual(facts.map(f => [f.property, f.value]), [
    ['lifecycle_stage', 'customer'], ['lifecycle_stage', 'lead'], ['lead_status', 'IN_PROGRESS'],
  ]);
  assert.equal(facts[0].externalId, 'hubspot:contact:200000000002:lifecyclestage:2026-09-10T00:20:00.000Z');
});
