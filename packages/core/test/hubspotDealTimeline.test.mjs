// Deal stage timeline from history observations, and the commerce value normaliser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  dealStageHops, dealStageOccupancies, dealStageRegressions, commerceRecordToValue,
} from '../dist/integrations/crm/index.js';

const D = (days) => new Date(Date.UTC(2026, 0, 1) + days * 864e5).toISOString();
const NOW = Date.UTC(2026, 0, 1) + 100 * 864e5;

// Observations as the claim engine stores them: label in value, id + verdict in raw.
const OBS = [
  { value: 'Contract Sent',         observed_at: D(60), raw: { stage_id: 'contractsent',         status: 'open' } },
  { value: 'Appointment Scheduled', observed_at: D(0),  raw: { stage_id: 'appointmentscheduled', status: 'open' } },
  { value: 'Qualified To Buy',      observed_at: D(10), raw: { stage_id: 'qualifiedtobuy',       status: 'open' } },
  { value: 'Closed Won',            observed_at: D(75), raw: { stage_id: 'closedwon',            status: 'won' } },
];

test('hops are chronological regardless of input order', () => {
  const hops = dealStageHops(OBS);
  assert.deepEqual(hops.map(h => h.label), ['Appointment Scheduled', 'Qualified To Buy', 'Contract Sent', 'Closed Won']);
  assert.equal(hops[3].status, 'won');
});

test('occupancy is days between hops; the closed stage is not an occupancy', () => {
  const occ = dealStageOccupancies(dealStageHops(OBS), { now: NOW });
  assert.deepEqual(occ.map(o => [o.label, Math.round(o.days), o.censored]), [
    ['Appointment Scheduled', 10, false],
    ['Qualified To Buy',      50, false],
    ['Contract Sent',         15, false],
  ]);
});

test('an open deal is censored at the last stage: time-so-far, flagged as a lower bound', () => {
  const occ = dealStageOccupancies(dealStageHops(OBS.slice(0, 3)), { now: NOW });
  const last = occ[occ.length - 1];
  assert.equal(last.label, 'Contract Sent');
  assert.equal(Math.round(last.days), 40);
  assert.equal(last.censored, true);
});

test('a lost deal stops the timeline too', () => {
  const lost = [...OBS.slice(0, 3), { value: 'Closed Lost', observed_at: D(70), raw: { stage_id: 'closedlost', status: 'lost' } }];
  const occ = dealStageOccupancies(dealStageHops(lost), { now: NOW });
  assert.equal(occ.length, 3);
  assert.equal(Math.round(occ[2].days), 10);
});

test('regressions count backwards moves against the pipeline order', () => {
  const order = ['appointmentscheduled', 'qualifiedtobuy', 'presentationscheduled', 'contractsent', 'closedwon'];
  const slipped = dealStageHops([
    { value: 'a', observed_at: D(0),  raw: { stage_id: 'appointmentscheduled', status: 'open' } },
    { value: 'c', observed_at: D(5),  raw: { stage_id: 'contractsent',         status: 'open' } },
    { value: 'q', observed_at: D(9),  raw: { stage_id: 'qualifiedtobuy',       status: 'open' } },   // back
    { value: 'c', observed_at: D(20), raw: { stage_id: 'contractsent',         status: 'open' } },
    { value: 'p', observed_at: D(25), raw: { stage_id: 'presentationscheduled', status: 'open' } },  // back
  ]);
  assert.equal(dealStageRegressions(slipped, order), 2);
  assert.equal(dealStageRegressions(dealStageHops(OBS), order), 0);
});

test('malformed observations are skipped, duplicate timestamps keep the last', () => {
  const hops = dealStageHops([
    { value: 'x', observed_at: 'not-a-date', raw: {} },
    { value: '',  observed_at: D(1), raw: {} },
    { value: 'first',  observed_at: D(2), raw: { stage_id: 'a' } },
    { value: 'second', observed_at: D(2), raw: { stage_id: 'b' } },
  ]);
  assert.deepEqual(hops.map(h => h.label), ['second']);
  assert.equal(hops[0].status, 'open');
});

test('commerce: numbers coerced, name/amount normalised per object', () => {
  const li = commerceRecordToValue('line_items', { id: '9', properties: { name: 'Pro seat', quantity: '4', price: '250', hs_sku: 'PRO', hs_lastmodifieddate: 'x', empty: '' } });
  assert.equal(li.quantity, 4);
  assert.equal(li.amount, 1000);
  assert.equal(li.name, 'Pro seat');
  assert.equal(li.hubspot_id, '9');
  assert.equal('hs_lastmodifieddate' in li, false);
  assert.equal('empty' in li, false);

  const inv = commerceRecordToValue('invoices', { id: '1', properties: { hs_invoice_number: 'INV-7', hs_amount_billed: '1200.50', hs_invoice_status: 'paid' } });
  assert.equal(inv.name, 'INV-7');
  assert.equal(inv.amount, 1200.5);

  const sub = commerceRecordToValue('subscriptions', { id: '2', properties: { hs_name: 'Growth plan', hs_next_payment_amount: '499' } });
  assert.equal(sub.name, 'Growth plan');
  assert.equal(sub.amount, 499);
});
