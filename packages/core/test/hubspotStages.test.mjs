// HubSpot pipeline stage handling. Fixture shapes are copied from a live portal
// (scripts/hubspot-profile.mjs, 2026-09-09), including the trap that motivates the
// first test: metadata values arrive as STRINGS.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hubspotPipelineToCrm, buildStageIndex, dealStatusFromStage } from '../dist/integrations/crm/index.js';

const RAW = {
  id: 'default', label: 'Sales Pipeline', displayOrder: 0,
  stages: [
    { id: 'closedlost',           label: 'Closed Lost',           displayOrder: 6, metadata: { isClosed: 'true',  probability: '0.0' } },
    { id: 'appointmentscheduled', label: 'Appointment Scheduled', displayOrder: 0, metadata: { isClosed: 'false', probability: '0.2' } },
    { id: 'closedwon',            label: 'Closed Won',            displayOrder: 5, metadata: { isClosed: 'true',  probability: '1.0' } },
    { id: 'contractsent',         label: 'Contract Sent',         displayOrder: 4, metadata: { isClosed: 'false', probability: '0.9' } },
    { id: '1234567',              label: 'Renewal Pending',       displayOrder: 3, metadata: { isClosed: 'false', probability: '0.6' } },
  ],
};

test('string "false" isClosed is NOT treated as closed', () => {
  const p = hubspotPipelineToCrm(RAW);
  const open = p.stages.filter(s => !s.isWon && !s.isLost);
  assert.equal(open.length, 3);
  assert.deepEqual(open.map(s => s.label), ['Appointment Scheduled', 'Renewal Pending', 'Contract Sent']);
});

test('won and lost come from isClosed + probability, not from the label', () => {
  const p = hubspotPipelineToCrm(RAW);
  const won = p.stages.find(s => s.isWon);
  const lost = p.stages.find(s => s.isLost);
  assert.equal(won.external_ref, 'closedwon');
  assert.equal(lost.external_ref, 'closedlost');
  // A high-probability OPEN stage is not won.
  assert.equal(p.stages.find(s => s.external_ref === 'contractsent').isWon, undefined);
});

test('stages are ordered by displayOrder, and order is re-indexed from 0', () => {
  const p = hubspotPipelineToCrm(RAW);
  assert.deepEqual(p.stages.map(s => s.order), [0, 1, 2, 3, 4]);
  assert.equal(p.stages[0].label, 'Appointment Scheduled');
  assert.equal(p.stages[4].label, 'Closed Lost');
});

test('numeric custom stage ids survive as strings', () => {
  const p = hubspotPipelineToCrm(RAW);
  assert.equal(p.stages.find(s => s.label === 'Renewal Pending').external_ref, '1234567');
});

test('stage index resolves a deal stage id to label + verdict', () => {
  const idx = buildStageIndex([hubspotPipelineToCrm(RAW)]);
  assert.equal(idx.get('closedwon').label, 'Closed Won');
  assert.equal(idx.get('closedwon').pipelineName, 'Sales Pipeline');
  assert.equal(dealStatusFromStage('closedwon', idx), 'won');
  assert.equal(dealStatusFromStage('closedlost', idx), 'lost');
  assert.equal(dealStatusFromStage('1234567', idx), 'open');
});

test('an unknown stage id yields null so the caller can fall back to text', () => {
  const idx = buildStageIndex([hubspotPipelineToCrm(RAW)]);
  assert.equal(dealStatusFromStage('not-a-stage', idx), null);
  assert.equal(dealStatusFromStage(null, idx), null);
});

test('missing metadata is tolerated', () => {
  const p = hubspotPipelineToCrm({ id: 'x', label: 'X', stages: [{ id: 's1', label: 'One' }] });
  assert.equal(p.stages.length, 1);
  assert.equal(p.stages[0].isWon, undefined);
  assert.equal(p.stages[0].isLost, undefined);
});
