import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { hasSupabase } from './helpers.mjs';
import {
  getSupabaseClient,
  logActivity,
  resolveEntityPredictions,
} from '@nous/core';

// Event-driven outcome resolution: a won/lost activity resolves the entity's
// open icp_fit prediction immediately (no nightly poll). Covers (1) the core
// resolveEntityPredictions() unit and (2) that logActivity() wires it up.
// Runs against the real DB in a throwaway team/workspace that cascade-deletes.

const run = hasSupabase ? test : (n, _f) => test(n, { skip: 'no SUPABASE env' }, () => {});

let workspaceId = null;
let teamId = null;

before(async () => {
  if (!hasSupabase) return;
  const supabase = getSupabaseClient();
  const { data: team } = await supabase
    .from('teams').insert({ name: `zz-outcome-test-${Date.now()}` }).select('id').single();
  teamId = team.id;
  const { data: ws } = await supabase
    .from('workspaces').insert({ name: `zz-outcome-test-${Date.now()}`, team_id: teamId }).select('id').single();
  workspaceId = ws.id;
});

after(async () => {
  if (!hasSupabase) return;
  const supabase = getSupabaseClient();
  if (workspaceId) await supabase.from('workspaces').delete().eq('id', workspaceId);
  if (teamId) await supabase.from('teams').delete().eq('id', teamId);
});

// Create a person entity + one OPEN icp_fit prediction for it.
async function stakeOpenPrediction(supabase, { score = 70, stage = 'interested' } = {}) {
  const { data: ent } = await supabase
    .from('entities').insert({ workspace_id: workspaceId, type: 'person', status: 'active' }).select('id').single();
  const { data: pred } = await supabase
    .from('predictions')
    .insert({
      workspace_id: workspaceId,
      entity_id: ent.id,
      kind: 'icp_fit',
      predicted_value: { score, fit: score >= 70, reason: 'test' },
      predicted_confidence: score / 100,
      feature_snapshot: { pipeline_stage: { value: stage } },
      model_version: 'scorecard',
      predicted_at: new Date().toISOString(),
    })
    .select('id, entity_id')
    .single();
  return { entityId: ent.id, predictionId: pred.id };
}

run('core — a deal_won observation resolves the open prediction as won', async () => {
  const supabase = getSupabaseClient();
  const { entityId, predictionId } = await stakeOpenPrediction(supabase);

  // Record a closed-won observation directly (what logActivity would write).
  await supabase.from('observations').insert({
    workspace_id: workspaceId, entity_id: entityId,
    kind: 'event', property: 'interaction.deal_won', value: { amount: 1200 },
    source: 'manual', method: 'connector', observed_at: new Date().toISOString(),
  });

  const resolved = await resolveEntityPredictions(supabase, { workspaceId, entityId });
  assert.equal(resolved.length, 1, 'one prediction resolved');
  assert.equal(resolved[0].disposition, 'won', 'disposition is won');

  const { data: row } = await supabase
    .from('predictions').select('resolved_at, outcome_value').eq('id', predictionId).single();
  assert.ok(row.resolved_at, 'resolved_at set');
  assert.equal(row.outcome_value.disposition, 'won', 'outcome_value persisted won');
  assert.equal(row.outcome_value.revenue, 1200, 'revenue captured');
});

run('core — a deal_lost observation resolves a qualified prediction as lost', async () => {
  const supabase = getSupabaseClient();
  const { entityId, predictionId } = await stakeOpenPrediction(supabase, { stage: 'evaluating' });

  await supabase.from('observations').insert({
    workspace_id: workspaceId, entity_id: entityId,
    kind: 'event', property: 'interaction.deal_lost', value: {},
    source: 'manual', method: 'connector', observed_at: new Date().toISOString(),
  });

  const resolved = await resolveEntityPredictions(supabase, { workspaceId, entityId });
  assert.equal(resolved.length, 1, 'one prediction resolved');
  assert.equal(resolved[0].disposition, 'lost', 'disposition is lost');

  const { data: row } = await supabase
    .from('predictions').select('resolved_at, outcome_value').eq('id', predictionId).single();
  assert.ok(row.resolved_at, 'resolved_at set');
  assert.equal(row.outcome_value.disposition, 'lost', 'outcome_value persisted lost');
});

run('core — an open prediction with no win/loss event stays open (not timed out)', async () => {
  const supabase = getSupabaseClient();
  const { entityId, predictionId } = await stakeOpenPrediction(supabase);

  // A mere reply must NOT resolve the prediction on the event path — only the
  // nightly backstop times things out. resolveEntityPredictions(requireWindow:false).
  await supabase.from('observations').insert({
    workspace_id: workspaceId, entity_id: entityId,
    kind: 'event', property: 'interaction.email_reply', value: {},
    source: 'manual', method: 'connector', observed_at: new Date().toISOString(),
  });

  const resolved = await resolveEntityPredictions(supabase, { workspaceId, entityId });
  assert.equal(resolved.length, 0, 'reply alone does not resolve');

  const { data: row } = await supabase
    .from('predictions').select('resolved_at').eq('id', predictionId).single();
  assert.equal(row.resolved_at, null, 'still open');
});

run('wiring — logActivity(deal_won) resolves the prediction via its event hook', async () => {
  const supabase = getSupabaseClient();
  const { entityId, predictionId } = await stakeOpenPrediction(supabase);

  // contactId must equal entityId (migration convention) so the hook scopes right.
  await logActivity(supabase, {
    workspaceId, contactId: entityId, entityId,
    type: 'deal_won', source: 'manual',
    externalId: `test_won_${entityId}`,
  });

  // The hook is fire-and-forget; poll briefly for the resolution to land.
  let resolvedAt = null;
  for (let i = 0; i < 20 && !resolvedAt; i++) {
    const { data: row } = await supabase
      .from('predictions').select('resolved_at, outcome_value').eq('id', predictionId).single();
    resolvedAt = row?.resolved_at ?? null;
    if (!resolvedAt) await new Promise(r => setTimeout(r, 150));
  }
  assert.ok(resolvedAt, 'logActivity(deal_won) resolved the prediction within the poll window');
});
