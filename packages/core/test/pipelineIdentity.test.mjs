// Pipeline identity: which pipeline is "the pipeline", and how a deal learns which one it is in.
// Pure tests of the picker and the stage index, the two definitions every reader relies on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickPrimaryPipeline, primaryPipelineRef, buildStageIndex, hubspotPipelineToCrm } from '../dist/integrations/crm/index.js';

// An invented portal shape: primary is `default` but NOT first by display order once
// the list is re-sorted, names carry stray whitespace, and two pipelines share a displayOrder.
const raw = [
  { id: '815000004',  label: 'Enterprise Pipeline', displayOrder: 2, stages: [{ id: 'ent-1', label: 'Inbound/Lead', displayOrder: 0, metadata: { probability: '0.2' } }] },
  { id: 'default',    label: ' Main Pipeline',      displayOrder: 0, stages: [
    { id: 'sp-1', label: 'Walkthrough Set', displayOrder: 1, metadata: { probability: '0.3', isClosed: 'false' } },
    { id: 'sp-won', label: 'Closed Won', displayOrder: 7, metadata: { probability: '1.0', isClosed: 'true' } },
  ] },
  { id: '1290000071', label: 'Expansion pipeline ', displayOrder: 3, stages: [{ id: 'exp-won', label: 'Won', displayOrder: 2, metadata: { probability: '0.9' } }] },
];
const pipelines = raw.map(hubspotPipelineToCrm);

test('pickPrimaryPipeline: HubSpot picks `default` wherever it sits in the list', () => {
  assert.equal(pickPrimaryPipeline('hubspot', pipelines)?.id, 'default');
  assert.equal(primaryPipelineRef('hubspot', pipelines), 'default');
});

test('pickPrimaryPipeline: without a `default`, HubSpot falls back to the first; other providers always take the first', () => {
  const noDefault = pipelines.filter(p => p.id !== 'default');
  assert.equal(pickPrimaryPipeline('hubspot', noDefault)?.id, '815000004');
  assert.equal(pickPrimaryPipeline('attio', pipelines)?.id, '815000004');
  assert.equal(pickPrimaryPipeline('pipedrive', [])?.id, undefined);
  assert.equal(primaryPipelineRef('pipedrive', []), null);
});

test('buildStageIndex: a stage id resolves to its pipeline id, not just its label', () => {
  const index = buildStageIndex(pipelines);
  assert.equal(index.get('sp-1')?.pipelineId, 'default');
  assert.equal(index.get('ent-1')?.pipelineId, '815000004');
  assert.equal(index.get('exp-won')?.pipelineId, '1290000071');
  // The name still comes through, whitespace and all: readers must key on the id.
  assert.equal(index.get('exp-won')?.pipelineName, 'Expansion pipeline ');
});

test('buildStageIndex: a Won stage with no closed flag is NOT won by the provider verdict (the live Expansion pipeline shape)', () => {
  const index = buildStageIndex(pipelines);
  assert.equal(index.get('exp-won')?.isWon, false);
  assert.equal(index.get('sp-won')?.isWon, true);
});
